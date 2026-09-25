/**
 * Renderer side of the change feed (see electron/db/change-feed-queries.ts).
 *
 * Holds this window's cursor into the feed and turns a changeset into a
 * synthetic entity snapshot (current store rows with the changed ones swapped
 * in / removed, re-sorted exactly like the snapshot SQL) so it can go through
 * the same merge path as a full snapshot — own-write guards, "what's new"
 * marks and identity-preserving reconcile all apply unchanged.
 */

import type { Workspace, Project, Note, BoardColumn, TaskCard, Tag } from "@/types";
import type { ChangeSet, ChangeFeedEntity } from "../../electron/db/change-feed-queries";

export type { ChangeSet };

/** Tables whose changes should refresh the knowledge graph. */
export const GRAPH_TABLES = new Set([
  "projects", "notes", "task_cards", "tags", "idea_flows", "idea_flow_nodes", "idea_flow_edges", "relationship_cache",
]);

let cursor: { feedId: string | null; seq: number | null } = { feedId: null, seq: null };

/**
 * Emitted after the store has processed a db:changed event. Components that
 * reload their own data (flow view, dashboards, conflict dialog) subscribe here
 * instead of raw `db:changed`, so they only reload when a table they show
 * actually changed. `reset` = the store fell back to a full snapshot (treat as
 * "everything may have changed").
 */
export interface ChangeFeedEvent {
  reset: boolean;
  /** Tables with any change (including this window's own writes). */
  touched: string[];
  /** Tables changed by something other than this window. */
  externalTouched: string[];
}
const feedListeners = new Set<(e: ChangeFeedEvent) => void>();

export function onChangeFeed(cb: (e: ChangeFeedEvent) => void): () => void {
  feedListeners.add(cb);
  return () => { feedListeners.delete(cb); };
}

export function emitChangeFeed(e: ChangeFeedEvent): void {
  for (const cb of feedListeners) {
    try { cb(e); } catch (err) { console.error("[change-feed] listener failed", err); }
  }
}

/** True if the event may have changed any of `tables` (always true on reset). */
export function feedTouches(e: ChangeFeedEvent, tables: readonly string[], external = false): boolean {
  if (e.reset) return true;
  const set = external ? e.externalTouched : e.touched;
  return set.some((t) => tables.includes(t));
}

export function getChangeFeedCursor() {
  return cursor;
}

export function setChangeFeedCursor(feedId: string, seq: number): void {
  cursor = { feedId, seq };
}

/** Point the cursor at the current feed head (call right before reading a full snapshot). */
export async function initChangeFeedCursor(): Promise<void> {
  const api = typeof window !== "undefined" ? window.electron?.changes : undefined;
  if (!api) return;
  try {
    const res = await api.get({ since: null, feedId: null });
    if (res) setChangeFeedCursor(res.feedId, res.head);
  } catch {
    // Older main process / feed unavailable: stay uninitialised → full refreshes.
    cursor = { feedId: null, seq: null };
  }
}

export interface EntityArrays {
  workspaces: Workspace[];
  projects: Project[];
  notes: Note[];
  columns: BoardColumn[];
  cards: TaskCard[];
  tags: Tag[];
}

const asc = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

// Mirrors the ORDER BY of each snapshot query (tags have none: keep position,
// append new rows). Array.prototype.sort is stable, so ties keep store order.
const SORTERS: { [K in ChangeFeedEntity]?: (a: EntityArrays[K][number], b: EntityArrays[K][number]) => number } = {
  workspaces: (a, b) => asc(a.createdAt, b.createdAt),
  projects: (a, b) => asc(a.createdAt, b.createdAt),
  notes: (a, b) => asc(b.updatedAt, a.updatedAt),
  columns: (a, b) => asc(a.order, b.order),
  cards: (a, b) => asc(a.order, b.order),
};

function patch<T extends { id: string }>(
  current: T[],
  upserts: unknown[] | undefined,
  removed: string[] | undefined,
  sorter: ((a: T, b: T) => number) | undefined,
): T[] {
  if (!upserts?.length && !removed?.length) return current;
  const incoming = new Map((upserts as T[] | undefined ?? []).map((r) => [r.id, r]));
  const drop = new Set(removed ?? []);
  const next: T[] = [];
  for (const row of current) {
    if (drop.has(row.id)) continue;
    const replacement = incoming.get(row.id);
    if (replacement) {
      next.push(replacement);
      incoming.delete(row.id);
    } else {
      next.push(row);
    }
  }
  for (const row of incoming.values()) next.push(row);
  return sorter ? next.sort(sorter) : next;
}

/** Current store rows with the changeset applied, in snapshot order. */
export function applyChangesetToArrays(current: EntityArrays, cs: ChangeSet): EntityArrays {
  const u = cs.upserts, r = cs.removed;
  return {
    workspaces: patch(current.workspaces, u.workspaces, r.workspaces, SORTERS.workspaces),
    projects: patch(current.projects, u.projects, r.projects, SORTERS.projects),
    notes: patch(current.notes, u.notes, r.notes, SORTERS.notes),
    columns: patch(current.columns, u.columns, r.columns, SORTERS.columns),
    cards: patch(current.cards, u.cards, r.cards, SORTERS.cards),
    tags: patch(current.tags, u.tags, r.tags, undefined),
  };
}
