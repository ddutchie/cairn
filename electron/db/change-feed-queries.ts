/**
 * Cairn — change feed (migration v56).
 *
 * Every INSERT/UPDATE/DELETE on a UI-visible table appends a row to
 * `change_feed` via triggers, whichever process made the write (the Electron
 * main process, the standalone `cairn-mcp` binary, the sync engine, the file
 * watcher). The renderer keeps a cursor into the feed and, on `db:changed`,
 * asks for just the rows that changed since then instead of re-reading the
 * whole workspace snapshot.
 *
 * Two kinds of tracked table:
 *   - SNAPSHOT tables mirror the renderer store (workspaces, projects, notes,
 *     columns, cards, tags). Changes carry ids; `getChangesSince` returns the
 *     changed rows (with the exact filters of the snapshot queries) and the ids
 *     that no longer pass them (deleted / tombstoned).
 *   - SIGNAL tables (Idea Flow + relationship_cache) only report "touched" so
 *     listeners that reload themselves (flow view, graph) still refresh. Their
 *     triggers coalesce a burst into one feed row (see schema v56).
 *
 * "Own" attribution: `recordOwnWrite` is called by the IPC registry around every
 * renderer-initiated `db:*` write with the sender's webContents id. Changes in
 * that seq range are reported back to that same window as own (it already holds
 * them optimistically), and as external to every other window. A write from
 * another process that commits *during* an own handler would be misattributed as
 * own for that one window — a narrow window (handlers are synchronous SQLite
 * calls) and the row still converges on its next change.
 */

import type Database from "better-sqlite3";
import { toWorkspace, toProject, toNote, toColumn, toCard, toTag, type DbRow } from "../host-shared/db-mappers";

/** Store key → table + snapshot filter + mapper. Filters MUST match getFullSnapshot's queries. */
const SNAPSHOT_ENTITIES = {
  workspaces: { table: "workspaces", where: "", map: toWorkspace },
  projects: { table: "projects", where: "", map: toProject },
  notes: { table: "notes", where: "deleted_at IS NULL AND ", map: toNote },
  columns: { table: "board_columns", where: "", map: toColumn },
  cards: { table: "task_cards", where: "deleted_at IS NULL AND ", map: toCard },
  tags: { table: "tags", where: "", map: toTag },
} as const;

export type ChangeFeedEntity = keyof typeof SNAPSHOT_ENTITIES;

const TABLE_TO_ENTITY = new Map<string, ChangeFeedEntity>(
  (Object.keys(SNAPSHOT_ENTITIES) as ChangeFeedEntity[]).map((k) => [SNAPSHOT_ENTITIES[k].table, k]),
);

/** Tables whose changes carry ids and are delivered as rows. */
export const CHANGE_FEED_SNAPSHOT_TABLES = [...TABLE_TO_ENTITY.keys()];
/** Tables whose changes are reported only as "touched" (coalesced per burst). */
export const CHANGE_FEED_SIGNAL_TABLES = ["idea_flows", "idea_flow_nodes", "idea_flow_edges", "relationship_cache"];

/** Past this many changed rows, a full snapshot is cheaper than a changeset. */
const MAX_CHANGESET_ROWS = 2000;
/** Rows retained after pruning (a renderer further behind gets a full reset). */
const FEED_RETAIN = 10_000;
/** Prune only once the feed exceeds this many rows. */
const FEED_PRUNE_AT = 12_000;

export interface ChangeSet {
  /** Identifies the DB handle; a mismatch (workspace swap) forces a reset. */
  feedId: string;
  /** New cursor. */
  head: number;
  /** True when the caller must fall back to a full snapshot. */
  reset: boolean;
  /** Tables with any change in the range. */
  touched: string[];
  /** Tables with a change NOT made by the calling window. */
  externalTouched: string[];
  /** External changes that still pass the snapshot filters (upsert these). */
  upserts: Partial<Record<ChangeFeedEntity, unknown[]>>;
  /** External changes whose row no longer passes the snapshot filters (remove). */
  removed: Partial<Record<ChangeFeedEntity, string[]>>;
}

interface FeedMeta {
  id: string;
  /** Highest seq removed by pruning; a cursor below it has a gap. */
  prunedThrough: number;
  /** [lo, hi] seq ranges written by a renderer window, keyed by its sender id. */
  ownRanges: Array<{ lo: number; hi: number; sender: number }>;
}

const metaByDb = new WeakMap<Database.Database, FeedMeta>();

function meta(db: Database.Database): FeedMeta {
  let m = metaByDb.get(db);
  if (!m) {
    m = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, prunedThrough: 0, ownRanges: [] };
    metaByDb.set(db, m);
  }
  return m;
}

/** Last seq ever assigned (survives deletes — AUTOINCREMENT never reuses). 0 if the feed is absent. */
export function changeFeedHead(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'change_feed'").get() as { seq?: number } | undefined;
    return Number(row?.seq ?? 0);
  } catch {
    return 0;
  }
}

/** Remember that the seq range (lo, hi] was written by renderer window `sender`. */
export function recordOwnWrite(db: Database.Database, lo: number, hi: number, sender: number): void {
  if (hi <= lo) return;
  const m = meta(db);
  m.ownRanges.push({ lo, hi, sender });
  // Bounded: ranges older than the retained feed can never be queried again.
  const floor = hi - FEED_RETAIN;
  if (m.ownRanges.length > 256 || m.ownRanges[0].hi < floor) {
    m.ownRanges = m.ownRanges.filter((r) => r.hi >= floor).slice(-256);
  }
}

/** Trim the feed to FEED_RETAIN rows once it grows past FEED_PRUNE_AT. Cheap no-op otherwise. */
export function pruneChangeFeed(db: Database.Database): void {
  const head = changeFeedHead(db);
  if (head <= FEED_PRUNE_AT) return;
  const tail = db.prepare("SELECT MIN(seq) AS s FROM change_feed").get() as { s: number | null };
  if (tail.s == null || head - tail.s < FEED_PRUNE_AT) return;
  const cut = head - FEED_RETAIN;
  db.prepare("DELETE FROM change_feed WHERE seq <= ?").run(cut);
  const m = meta(db);
  m.prunedThrough = Math.max(m.prunedThrough, cut);
}

function emptySet(feedId: string, head: number, reset: boolean): ChangeSet {
  return { feedId, head, reset, touched: [], externalTouched: [], upserts: {}, removed: {} };
}

/**
 * Changes after cursor `since` for renderer window `sender`.
 * `since === null` just returns the current head (cursor initialisation).
 */
export function getChangesSince(
  db: Database.Database,
  since: number | null,
  feedId: string | null,
  sender: number | undefined,
): ChangeSet {
  const m = meta(db);
  const head = changeFeedHead(db);
  if (since == null) return emptySet(m.id, head, false);
  if (feedId !== m.id || since > head || since < m.prunedThrough) return emptySet(m.id, head, true);
  if (since === head) return emptySet(m.id, head, false);

  const rows = db
    .prepare("SELECT seq, entity, entity_id FROM change_feed WHERE seq > ? AND seq <= ? ORDER BY seq")
    .all(since, head) as Array<{ seq: number; entity: string; entity_id: string }>;
  if (rows.length > MAX_CHANGESET_ROWS) return emptySet(m.id, head, true);

  const isOwn = (seq: number) =>
    sender !== undefined && m.ownRanges.some((r) => r.sender === sender && seq > r.lo && seq <= r.hi);

  const touched = new Set<string>();
  const externalTouched = new Set<string>();
  const externalIds = new Map<ChangeFeedEntity, Set<string>>();
  for (const r of rows) {
    touched.add(r.entity);
    if (isOwn(r.seq)) continue;
    externalTouched.add(r.entity);
    const entity = TABLE_TO_ENTITY.get(r.entity);
    if (!entity || !r.entity_id) continue;
    let ids = externalIds.get(entity);
    if (!ids) externalIds.set(entity, (ids = new Set()));
    ids.add(r.entity_id);
  }

  const out = emptySet(m.id, head, false);
  out.touched = [...touched];
  out.externalTouched = [...externalTouched];
  for (const [entity, idSet] of externalIds) {
    const spec = SNAPSHOT_ENTITIES[entity];
    const ids = [...idSet];
    const found: unknown[] = [];
    const foundIds = new Set<string>();
    // Chunk to stay under SQLite's bound-parameter limit.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const got = db
        .prepare(`SELECT * FROM ${spec.table} WHERE ${spec.where}id IN (${placeholders})`)
        .all(...chunk) as DbRow[];
      for (const row of got) {
        foundIds.add(row.id as string);
        found.push(spec.map(row));
      }
    }
    if (found.length) out.upserts[entity] = found;
    const gone = ids.filter((id) => !foundIds.has(id));
    if (gone.length) out.removed[entity] = gone;
  }
  return out;
}
