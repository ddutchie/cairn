/**
 * Note entity types shared by the renderer, the Electron main process and the
 * typed IPC contract (`shared/ipc/contract.ts`).
 */

import type { ID } from "./domain";

export type NoteType = "note" | "dashboard" | "template";

// A type alias (not an interface) so it stays assignable to Record<string, unknown>.
export type Note = {
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
  /** Set on a tombstoned (soft-deleted) row; live queries never return these. */
  deletedAt?: string;
  /** Monotonically incrementing write counter. Used for optimistic-concurrency
   * checks by MCP tools that accept an optional expectedVersion argument. */
  version: number;
};

/** A note's body, loaded on demand (the renderer store keeps metadata only). */
export interface NoteBody {
  id: string;
  content: string;
  version: number;
  updatedAt: string;
  /** Body as it was before unseen external changes ("what's new" baseline). */
  previousContent?: string;
  /** When the first unseen change landed (ISO). */
  changedAt?: string;
}

/** Fields accepted when creating a note (extra Note fields are ignored). */
export interface NoteCreateInput {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  content?: string;
  type?: NoteType;
  tagIds?: string[];
  isPinned?: boolean;
  folder?: string;
}

/** A partial note update. `archivedAt: null` restores an archived note. */
export type NotePatch = Partial<Omit<Note, "id" | "archivedAt">> & { archivedAt?: string | null };
