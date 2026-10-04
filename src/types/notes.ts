/** Notes and dashboards. */

import type { ID } from "../../shared/types/domain";

// ── Note ─────────────────────────────────────
export type NoteType = "note" | "dashboard" | "template";

export interface Note {
  id: ID;
  projectId: ID;
  workspaceId: ID;
  title: string;
  /** Raw markdown (type=note) or HTML string (type=dashboard) */
  content?: string;
  /**
   * Short plain-text EXCERPT of the body (≤200 chars) for previews — not a
   * full mirror. Search full text via `noteSearchText()` (src/lib/note-text).
   */
  contentText: string;
  tagIds: ID[];
  /** Backlink references: note IDs this note mentions */
  linkedNoteIds: ID[];
  /** Task cards this note is linked to */
  linkedCardIds: ID[];
  isPinned: boolean;
  type: NoteType;
  /**
   * Slash-separated subfolder path within the project notes directory.
   * Empty string means the note is in the project root.
   * e.g. "Design/Typography" → notes/<project-slug>/design/typography/<note>.md
   */
  folder: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** Monotonically incrementing write counter. Used for optimistic-concurrency
   * checks by MCP tools that accept an optional expectedVersion argument. */
  version: number;
}
