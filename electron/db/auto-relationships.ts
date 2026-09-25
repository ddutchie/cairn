/**
 * Cairn — auto-discovered relationships (relationship_cache, non-semantic).
 *
 * Four edge types, all stored canonically (source < target) except assignee:
 *   - wikilink:   a note's body contains [[Other Note Title]]
 *   - co-mention: a note's plain text contains another note/card title (≥5 chars)
 *   - keyword:    Jaccard similarity of two notes' word sets ≥ KEYWORD_THRESHOLD
 *   - assignee:   two cards share an assignee
 *
 * Two modes:
 *   - Full (no entityIds): recompute every pair in the workspace. O(notes²).
 *   - Incremental (entityIds): runs on every note/card save, synchronously on
 *     the Electron main process, so it must not scale with the workspace size.
 *     For each changed entity X it deletes X's rows and recomputes exactly the
 *     rows that can involve X: X's own outgoing links, keyword pairs (X, *),
 *     notes that mention or [[link]] X's title, and X's assignee pairs. Other
 *     notes' bodies are only read when they plausibly mention X's title.
 *
 * Known gap, shared with the old incremental pass: when two entities share a
 * title, only the last one (row order) is a link target, and a save doesn't
 * re-check which entity wins. Renaming onto or away from a shared title can
 * leave mention links on the wrong holder until the next full recompute.
 * Callers must pass every note whose body changed, e.g. notes a rename relinked.
 *
 * Keyword similarity needs every note's word set. Those are cached per
 * workspace as sorted 32-bit token hashes and kept fresh from the change feed
 * (which records every write to `notes`, from any process), so a save only
 * re-tokenises the notes that actually changed.
 */

import type Database from "better-sqlite3";
import { stripMarkdown } from "../host-shared/text-utils";
import { changeFeedHead } from "./change-feed-queries";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const KEYWORD_THRESHOLD = 0.15;
/** Titles shorter than this never form co-mention edges (too many false hits). */
const CO_MENTION_MIN_TITLE = 5;
/** Stay well under SQLite's bound-parameter limit. */
const ID_CHUNK = 500;

const STOP = new Set([
  "this","that","with","from","have","will","been","they","them","then",
  "when","what","which","into","over","your","more","also","some","just",
  "than","about","would","there","their","these","those",
]);

/** Extract [[Title]] wikilink targets from markdown content (lowercased). */
function extractWikilinkTitles(content: string): string[] {
  const results: string[] = [];
  const re = /\[\[([^\][\n]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const title = m[1].trim();
    if (title.length > 0) results.push(title.toLowerCase());
  }
  return results;
}

/** Tokenise text into lowercase words, filter stop-words, min length 5. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !STOP.has(w));
}

/** 32-bit FNV-1a. Tokens are ASCII (see tokenise), so charCodeAt is a byte. */
function hashToken(w: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < w.length; i++) {
    h ^= w.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * A note's keyword set as sorted, de-duplicated token hashes. Far smaller than
 * a Set<string> to keep cached for every note, and two sorted arrays intersect
 * in one linear merge. A 32-bit collision between two different words counts
 * as one shared word, which can lift a pair just over KEYWORD_THRESHOLD; with
 * a few hundred words per note the odds are around one in ten million per pair.
 */
function noteTokenHashes(title: string, content: string): Int32Array {
  const words = new Set(tokenise((title || "") + " " + stripMarkdown(content || "")));
  const out = new Int32Array(words.size);
  let i = 0;
  for (const w of words) out[i++] = hashToken(w);
  out.sort();
  // Remove the (astronomically rare) duplicate hashes so sizes stay set sizes.
  let n = 0;
  for (let j = 0; j < out.length; j++) if (j === 0 || out[j] !== out[j - 1]) out[n++] = out[j];
  return n === out.length ? out : out.slice(0, n);
}

function jaccardSorted(a: Int32Array, b: Int32Array): number {
  let i = 0, j = 0, inter = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { inter++; i++; j++; }
    else if (a[i] < b[j]) i++;
    else j++;
  }
  const union = a.length + b.length - inter;
  return union === 0 ? 0 : inter / union;
}

function canonical(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function coMentionWeight(title: string): number {
  return Math.min(0.9, title.length / 20);
}

// ── Token cache ────────────────────────────────────────────────────────────────

interface TokenCache {
  /** change_feed head the cache is valid for. */
  head: number;
  byNote: Map<string, Int32Array>;
}

interface DbState {
  /** Whether the change_feed table exists (checked once per handle). */
  hasFeed: boolean;
  byWorkspace: Map<string, TokenCache>;
}

const dbStates = new WeakMap<Database.Database, DbState>();

function dbState(db: Database.Database): DbState {
  let st = dbStates.get(db);
  if (!st) {
    const hasFeed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'change_feed'").get();
    dbStates.set(db, (st = { hasFeed, byWorkspace: new Map() }));
  }
  return st;
}

/** Rows for `ids` (any order), fetched in bound-parameter-safe chunks. */
function notesByIds(db: Database.Database, ids: string[], columns: string): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    out.push(...db
      .prepare(`SELECT ${columns} FROM notes WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as Row[]);
  }
  return out;
}

/**
 * Token hashes for every live note in `liveNotes`, reusing cached entries for
 * notes the change feed shows as unchanged since the last call.
 */
function workspaceNoteTokens(
  db: Database.Database,
  workspaceId: string,
  liveNotes: Row[],
): Map<string, Int32Array> {
  let cache: TokenCache;
  const st = dbState(db);
  if (!st.hasFeed) {
    // No feed to invalidate from: never trust a cached entry.
    cache = { head: 0, byNote: new Map() };
  } else {
    cache = st.byWorkspace.get(workspaceId) ?? { head: -1, byNote: new Map() };
    st.byWorkspace.set(workspaceId, cache);

    const head = changeFeedHead(db);
    if (cache.head !== head) {
      const tail = (db.prepare("SELECT MIN(seq) AS s FROM change_feed").get() as { s: number | null }).s;
      // Rebuild when there's no usable cursor: first use, the feed moved
      // backwards, or pruning removed rows we never saw.
      if (cache.head < 0 || head < cache.head || (tail != null && tail > cache.head + 1)) {
        cache.byNote.clear();
      } else {
        const changed = db
          .prepare("SELECT DISTINCT entity_id FROM change_feed WHERE seq > ? AND entity = 'notes'")
          .all(cache.head) as { entity_id: string }[];
        for (const r of changed) cache.byNote.delete(r.entity_id);
      }
      cache.head = head;
    }
  }

  const live = new Set<string>();
  const missing: string[] = [];
  for (const n of liveNotes) {
    const id = n.id as string;
    live.add(id);
    if (!cache.byNote.has(id)) missing.push(id);
  }
  // Drop notes that were deleted, archived or moved out of this workspace.
  for (const id of cache.byNote.keys()) if (!live.has(id)) cache.byNote.delete(id);

  for (const r of notesByIds(db, missing, "id, title, content")) {
    cache.byNote.set(r.id as string, noteTokenHashes(r.title as string, r.content as string));
  }
  return cache.byNote;
}

/** Drop every cached token set (tests; a DB handle swap needs nothing — the cache is keyed by handle). */
export function resetAutoRelationshipCache(db: Database.Database): void {
  dbStates.delete(db);
}

// ── Shared statements ──────────────────────────────────────────────────────────

function statements(db: Database.Database) {
  const now = Math.floor(Date.now() / 1000);
  const upsertStmt = db.prepare(`
    INSERT INTO relationship_cache (source_id, target_id, type, weight, computed_at, source_section_title, target_section_title)
    VALUES (?, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(source_id, target_id, type) DO UPDATE SET
      weight = excluded.weight,
      computed_at = excluded.computed_at,
      source_section_title = NULL,
      target_section_title = NULL
  `);
  const deleteOld = db.prepare(`
    DELETE FROM relationship_cache
    WHERE (source_id = ? OR target_id = ?)
      AND type != 'semantic'
  `);
  return {
    upsert: (src: string, tgt: string, type: string, weight: number) => upsertStmt.run(src, tgt, type, weight, now),
    deleteOld: (id: string) => deleteOld.run(id, id),
  };
}

/** Title → id maps with the same last-wins precedence in both modes. */
function titleMaps(notes: Row[], cards: Row[]) {
  const noteTitleToId = new Map<string, string>(); // wikilink targets: notes only
  for (const n of notes) noteTitleToId.set((n.title as string).toLowerCase(), n.id as string);
  const titleMap = new Map<string, string>(noteTitleToId); // co-mention targets: notes then cards
  for (const c of cards) titleMap.set((c.title as string).toLowerCase(), c.id as string);
  return { noteTitleToId, titleMap };
}

/** Wikilink + co-mention edges out of one note's body. */
function emitOutgoingLinks(
  upsert: ReturnType<typeof statements>["upsert"],
  noteId: string,
  content: string,
  noteTitleToId: Map<string, string>,
  titleMap: Map<string, string>,
): void {
  for (const titleLower of extractWikilinkTitles(content)) {
    const targetId = noteTitleToId.get(titleLower);
    if (!targetId || targetId === noteId) continue;
    const [src, tgt] = canonical(noteId, targetId);
    upsert(src, tgt, "wikilink", 1.0);
  }
  const text = stripMarkdown(content).toLowerCase();
  for (const [title, targetId] of titleMap) {
    if (targetId === noteId) continue;
    if (title.length >= CO_MENTION_MIN_TITLE && text.includes(title)) {
      const [src, tgt] = canonical(noteId, targetId);
      upsert(src, tgt, "co-mention", coMentionWeight(title));
    }
  }
}

function assigneeKey(c: Row): string | null {
  return c.assignee ? (c.assignee as string).toLowerCase().trim() : null;
}

// ── Entry point ────────────────────────────────────────────────────────────────

export function computeAutoRelationships(
  db: Database.Database,
  workspaceId: string,
  entityIds?: string[]
): void {
  if (entityIds && entityIds.length > 0) computeIncremental(db, workspaceId, entityIds);
  else computeFull(db, workspaceId);
}

function liveCards(db: Database.Database, workspaceId: string): Row[] {
  // Row order (rowid) decides assignee pair orientation in both modes.
  return db.prepare(
    `SELECT id, title, assignee FROM task_cards
     WHERE workspace_id = ? AND archived_at IS NULL AND deleted_at IS NULL`
  ).all(workspaceId) as Row[];
}

function computeFull(db: Database.Database, workspaceId: string): void {
  const notes = db.prepare(
    `SELECT id, title, content FROM notes
     WHERE workspace_id = ? AND archived_at IS NULL AND deleted_at IS NULL`
  ).all(workspaceId) as Row[];
  const cards = liveCards(db, workspaceId);
  const { upsert, deleteOld } = statements(db);
  const { noteTitleToId, titleMap } = titleMaps(notes, cards);
  const tokens = workspaceNoteTokens(db, workspaceId, notes);

  db.transaction(() => {
    for (const n of notes) deleteOld(n.id as string);
    for (const c of cards) deleteOld(c.id as string);

    for (const n of notes) emitOutgoingLinks(upsert, n.id as string, (n.content as string) || "", noteTitleToId, titleMap);

    const ids = notes.map((n) => n.id as string);
    for (let i = 0; i < ids.length; i++) {
      const a = tokens.get(ids[i]);
      if (!a) continue; // hard-deleted by another process mid-pass
      for (let j = i + 1; j < ids.length; j++) {
        const b = tokens.get(ids[j]);
        if (!b) continue;
        const sim = jaccardSorted(a, b);
        if (sim >= KEYWORD_THRESHOLD) {
          const [src, tgt] = canonical(ids[i], ids[j]);
          upsert(src, tgt, "keyword", Math.round(sim * 100) / 100);
        }
      }
    }

    const byAssignee = new Map<string, string[]>();
    for (const c of cards) {
      const key = assigneeKey(c);
      if (!key) continue;
      let list = byAssignee.get(key);
      if (!list) byAssignee.set(key, (list = []));
      list.push(c.id as string);
    }
    for (const list of byAssignee.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) upsert(list[i], list[j], "assignee", 1.0);
      }
    }
  })();
}

/** More changed titles than this share one scan of every body instead of one query each. */
const MENTION_SCAN_BATCH = 20;
/** At most this many title words go into the SQL pre-filter. */
const MAX_PROBES = 3;

const LIVE_NOTES_SQL = `SELECT id, content FROM notes
     WHERE workspace_id = ? AND archived_at IS NULL AND deleted_at IS NULL`;

/**
 * Live notes whose body may mention `titleLower`, as plain text or inside
 * [[…]]. The SQL filter requires each probed word of the title in the raw body.
 * A stripped body only ever loses characters, so this is a superset of the real
 * matches, except when markup splits a word ("road**map**"). Callers check each
 * candidate against the stripped text exactly as the full pass does.
 *
 * LIKE folds case for ASCII only, so ASCII words are probed with LIKE and
 * words from caseless scripts (CJK, …) with an exact instr(). A title made only
 * of cased non-ASCII words ("Überblick Ärger") falls back to every body.
 */
function notesMentioning(db: Database.Database, workspaceId: string, titleLower: string): Row[] {
  const words = [...new Set(titleLower.split(/\s+/).filter((w) => w.length > 0))]
    .sort((a, b) => b.length - a.length);
  const clauses: string[] = [];
  const args: string[] = [];
  for (const w of words) {
    if (clauses.length >= MAX_PROBES) break;
    if (/^[\x20-\x7e]+$/.test(w)) {
      clauses.push("content LIKE ? ESCAPE '\\'");
      args.push(`%${w.replace(/[\\%_]/g, "\\$&")}%`);
    } else if (w.toUpperCase() === w.toLowerCase()) {
      clauses.push("instr(content, ?) > 0");
      args.push(w);
    }
  }
  const sql = clauses.length > 0 ? `${LIVE_NOTES_SQL} AND ${clauses.join(" AND ")}` : LIVE_NOTES_SQL;
  return db.prepare(sql).all(workspaceId, ...args) as Row[];
}

function computeIncremental(db: Database.Database, workspaceId: string, entityIds: string[]): void {
  // Titles only: bodies are read just for the changed notes and for notes
  // that plausibly mention a changed title.
  const notes = db.prepare(
    `SELECT id, title FROM notes
     WHERE workspace_id = ? AND archived_at IS NULL AND deleted_at IS NULL`
  ).all(workspaceId) as Row[];
  const cards = liveCards(db, workspaceId);

  const wanted = new Set(entityIds);
  const changedNotes = notes.filter((n) => wanted.has(n.id as string));
  const changedCards = cards.filter((c) => wanted.has(c.id as string));
  // Deleted / archived / other-workspace ids: nothing live to recompute.
  if (changedNotes.length + changedCards.length === 0) return;

  const { upsert, deleteOld } = statements(db);
  const { noteTitleToId, titleMap } = titleMaps(notes, cards);
  const tokens = changedNotes.length > 0 ? workspaceNoteTokens(db, workspaceId, notes) : null;

  const bodies = new Map<string, string>();
  for (const r of notesByIds(db, changedNotes.map((n) => n.id as string), "id, content")) {
    bodies.set(r.id as string, (r.content as string) || "");
  }

  // Changed entities whose title other notes can link to or mention.
  const targets = [...changedNotes, ...changedCards].flatMap((x) => {
    const id = x.id as string;
    const title = (x.title as string).toLowerCase();
    const coMention = titleMap.get(title) === id && title.length >= CO_MENTION_MIN_TITLE;
    const wikilink = noteTitleToId.get(title) === id;
    return coMention || wikilink ? [{ id, title, coMention, wikilink }] : [];
  });
  // A big batch (project merge, bulk MCP refresh) reads every body once rather
  // than running one filtered query per title.
  const everyBody = targets.length > MENTION_SCAN_BATCH
    ? db.prepare(LIVE_NOTES_SQL).all(workspaceId) as Row[]
    : null;

  db.transaction(() => {
    for (const n of changedNotes) deleteOld(n.id as string);
    for (const c of changedCards) deleteOld(c.id as string);

    // Outgoing links and keyword pairs of each changed note.
    for (const n of changedNotes) {
      const id = n.id as string;
      emitOutgoingLinks(upsert, id, bodies.get(id) ?? "", noteTitleToId, titleMap);
      const mine = tokens!.get(id);
      if (!mine) continue; // hard-deleted by another process mid-pass
      for (const other of notes) {
        const otherId = other.id as string;
        if (otherId === id) continue;
        // Two changed notes: emit the pair once, from the lower id.
        if (wanted.has(otherId) && otherId < id) continue;
        const theirs = tokens!.get(otherId);
        if (!theirs) continue;
        const sim = jaccardSorted(mine, theirs);
        if (sim >= KEYWORD_THRESHOLD) {
          const [src, tgt] = canonical(id, otherId);
          upsert(src, tgt, "keyword", Math.round(sim * 100) / 100);
        }
      }
    }

    // Incoming: other notes that mention or [[link]] a changed entity's title.
    const stripped = new Map<string, string>(); // per-call memo for the batch scan
    for (const t of targets) {
      for (const y of everyBody ?? notesMentioning(db, workspaceId, t.title)) {
        const yId = y.id as string;
        if (yId === t.id) continue;
        const content = (y.content as string) || "";
        const [src, tgt] = canonical(yId, t.id);
        if (t.wikilink && extractWikilinkTitles(content).includes(t.title)) {
          upsert(src, tgt, "wikilink", 1.0);
        }
        if (t.coMention) {
          let text = stripped.get(yId);
          if (text === undefined) stripped.set(yId, (text = stripMarkdown(content).toLowerCase()));
          if (text.includes(t.title)) upsert(src, tgt, "co-mention", coMentionWeight(t.title));
        }
      }
    }

    // Assignee pairs of each changed card, oriented by card row order like the full pass.
    if (changedCards.length > 0) {
      const order = new Map(cards.map((c, i) => [c.id as string, i]));
      for (const x of changedCards) {
        const key = assigneeKey(x);
        if (!key) continue;
        for (const other of cards) {
          if (other.id === x.id || assigneeKey(other) !== key) continue;
          const [first, second] = order.get(x.id as string)! < order.get(other.id as string)!
            ? [x.id as string, other.id as string]
            : [other.id as string, x.id as string];
          upsert(first, second, "assignee", 1.0);
        }
      }
    }
  })();
}
