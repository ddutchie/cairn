import {
  createNote,
  createTask,
  deleteCard,
  linkNoteToTask,
  listColumns,
  listProjects,
  softDeleteNote,
  tagNote,
  tagTask,
  updateTask,
} from "@/db/queries";
import { setMeta } from "@/db";
import { reindexNote } from "@/notes/embeddings";
import { columnIdFor } from "./proposal";
import type { CaptureProposal } from "./types";

/** Device-local (never synced) memory of the last project a capture was filed into. */
export const CAPTURE_RECENT_PROJECT_KEY = "capture_last_project";

export interface CommitResult {
  projectId: string;
  projectName: string;
  noteId: string | null;
  taskIds: string[];
}

/**
 * Write a confirmed proposal. Always creates NEW rows (never edits an existing
 * note body), and goes through the query functions so the sync capture triggers
 * stage everything. A project with no board columns can't hold tasks, so its
 * tasks become a checklist in the note instead of being dropped. If anything
 * throws midway, what was already created is rolled back (soft-deleted) before
 * rethrowing, so a failed capture never leaves half a filing behind.
 */
export function commitProposal(proposal: CaptureProposal): CommitResult {
  const project = listProjects().find((p) => p.id === proposal.projectId);
  if (!project) throw new Error("That project no longer exists.");

  const columns = listColumns(project.id);
  const board = { id: project.id, name: project.name, columns: columns.map((c) => ({ id: c.id, name: c.name, type: c.type })) };

  let note = proposal.note;
  let tasks = proposal.tasks;
  if (columns.length === 0 && tasks.length > 0) {
    const checklist = tasks.map((t) => `- [ ] ${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ""}`).join("\n");
    note = note ? { ...note, body: `${note.body}\n\n${checklist}` } : { title: tasks[0].title, body: checklist };
    tasks = [];
  }

  const result: CommitResult = { projectId: project.id, projectName: project.name, noteId: null, taskIds: [] };
  try {
    if (note) {
      const noteId = createNote(project.id, note.title.trim() || "Untitled", note.body);
      result.noteId = noteId;
      reindexNote(noteId).catch(() => {});
      if (proposal.tagNames.length > 0) tagNote(noteId, proposal.tagNames, "add");
    }
    for (const t of tasks) {
      const columnId = columnIdFor(board, t.columnType);
      if (!columnId) continue;
      const cardId = createTask(project.id, columnId, t.title, { description: t.description, priority: t.priority });
      result.taskIds.push(cardId);
      if (t.dueDate) updateTask(cardId, { dueDate: t.dueDate });
      if (proposal.tagNames.length > 0) tagTask(cardId, proposal.tagNames, "add");
      for (const linkId of proposal.linkNoteIds) linkNoteToTask(linkId, cardId);
      if (result.noteId) linkNoteToTask(result.noteId, cardId);
    }
    setMeta(CAPTURE_RECENT_PROJECT_KEY, project.id);
    return result;
  } catch (e) {
    undoCommit(result);
    throw e;
  }
}

/** Soft-delete everything a commit created (tombstones propagate through sync). */
export function undoCommit(result: Pick<CommitResult, "noteId" | "taskIds">): void {
  if (result.noteId) softDeleteNote(result.noteId);
  for (const id of result.taskIds) deleteCard(id);
}
