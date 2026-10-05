/**
 * Board columns and task cards — shared by the renderer, the Electron main
 * process and the typed IPC contract (`shared/ipc/contract.ts`).
 *
 * Optional fields arrive as `null` (not absent) when the column is NULL; see
 * the note in `./workspace.ts`.
 */

import type { ID, Priority, ColumnType } from "./domain";

// ── Board Column ──────────────────────────────

export interface BoardColumn {
  id: ID;
  projectId: ID;
  workspaceId: ID;
  name: string;
  type: ColumnType;
  order: number;
  cardLimit?: number;
  createdAt: string;
  updatedAt: string;
}

// ── Task Card ─────────────────────────────────
export interface TaskCard {
  id: ID;
  columnId: ID;
  projectId: ID;
  workspaceId: ID;
  title: string;
  description?: string;
  tagIds: ID[];
  priority: Priority;
  dueDate?: string;
  /** Note IDs this card is linked to */
  linkedNoteIds: ID[];
  /** Card IDs (same project) that block this card from being started */
  blockedByIds: ID[];
  order: number;
  assignee?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** When the card entered a done-type column (cleared if it leaves). Set by a DB trigger. */
  completedAt?: string;
  /** Monotonically incrementing write counter for optimistic concurrency. */
  version: number;
}

// ── IPC inputs ────────────────────────────────
export interface ColumnCreateInput {
  id: ID;
  projectId: ID;
  workspaceId: ID;
  name: string;
  type?: ColumnType;
  order?: number;
}

export type ColumnPatch = Partial<{ name: string; order: number; cardLimit: number }>;

export interface CardCreateInput {
  id: ID;
  columnId: ID;
  projectId: ID;
  workspaceId: ID;
  title: string;
  description?: string;
  priority?: Priority;
  dueDate?: string;
  order?: number;
  tagIds?: ID[];
  assignee?: string;
}

/** `archivedAt: null` restores an archived card; `assignee: null` clears it. */
export type CardPatch = Partial<{
  columnId: ID;
  title: string;
  description: string;
  priority: Priority;
  dueDate: string;
  tagIds: ID[];
  linkedNoteIds: ID[];
  blockedByIds: ID[];
  order: number;
  assignee: string | null;
  archivedAt: string | null;
}>;
