/**
 * The entity snapshot the renderer hydrates from, and the incremental change
 * feed that keeps it current. Shared by the main-process queries, the typed
 * IPC contract and the renderer store.
 */

import type { BoardColumn, TaskCard } from "./board";
import type { Note } from "./notes";
import type { Project, Tag, Workspace } from "./workspace";

/** Every live entity the store holds. `notes` omit `content` in the renderer snapshot. */
export interface EntitySnapshot {
  workspaces: Workspace[];
  projects: Project[];
  notes: Note[];
  columns: BoardColumn[];
  cards: TaskCard[];
  tags: Tag[];
}

/** Snapshot key the change feed reports rows under. */
export type ChangeFeedEntity = keyof EntitySnapshot;

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
