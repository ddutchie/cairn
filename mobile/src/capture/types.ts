/**
 * Shared shapes for "capture that files itself": raw text goes in, a validated
 * `CaptureProposal` comes out, and the user confirms it with one tap. Pure types
 * only — no framework imports, so everything under `src/capture/*.ts` that is
 * not marked impure stays unit-testable in plain Node.
 */

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const COLUMN_TYPES = ["backlog", "todo", "in_progress", "review", "done"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface CaptureColumn {
  id: string;
  name: string;
  type: string;
}

export interface CaptureProject {
  id: string;
  name: string;
  columns: CaptureColumn[];
}

/** An existing note that looks related to the captured text. */
export interface CaptureCandidate {
  noteId: string;
  title: string;
  projectId: string;
  /** Blended similarity, higher is closer (0–1 after ranking). */
  rank: number;
}

export interface ProjectScore {
  projectId: string;
  score: number;
}

export interface CaptureContext {
  projects: CaptureProject[];
  /** Existing tag names, so the model reuses them instead of inventing near-duplicates. */
  tags: string[];
  candidates: CaptureCandidate[];
  projectScores: ProjectScore[];
  /** Most recently active project, the destination when nothing ranks. */
  recentProjectId: string | null;
  /** Local date, YYYY-MM-DD, so "tomorrow" / "friday" resolve to a real date. */
  today: string;
}

export interface CaptureTaskDraft {
  title: string;
  description?: string;
  priority?: Priority;
  /** YYYY-MM-DD */
  dueDate?: string;
  columnType?: ColumnType;
}

export interface CaptureNoteDraft {
  title: string;
  body: string;
}

export interface CaptureProposal {
  projectId: string;
  note: CaptureNoteDraft | null;
  tasks: CaptureTaskDraft[];
  tagNames: string[];
  /** Existing notes to link to the created items (validated against candidates). */
  linkNoteIds: string[];
  /** One short line shown on the confirm card: why it was filed here. */
  reason: string;
  source: "ai" | "fallback";
}
