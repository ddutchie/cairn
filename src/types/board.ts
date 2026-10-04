/** Board columns and task cards. */

import type { ID, Priority, ColumnType } from "../../shared/types/domain";

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
