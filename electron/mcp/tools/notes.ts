/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import * as q from "../../db/queries";
import { newId } from "../../db/utils";
import { stripMarkdown, normalizeNoteTitle } from "../../shared/text-utils";
import { executeSearchNotes } from "../../shared/read-tools-pure";
import {
  Snapshot,
  insertNotification,
  lockNote,
  unlockNote,
  getNoteVersion,
  writeNoteFile,
  deleteNoteFile,
  resolveTagNames
} from "../db";
import { traceTool } from "../../lib/tool-trace";

export function get_note(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const note = snap.notes.find((n) => n.id === args.noteId);
  if (!note) return { error: "Note not found" };
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    projectId: note.projectId,
    isPinned: note.isPinned,
    // `linkedNoteIds` / `linkedCardIds` are part of the documented get_note
    // contract — always emitted, even when empty.
    linkedNoteIds: note.linkedNoteIds,
    linkedCardIds: note.linkedCardIds,
    updatedAt: note.updatedAt,
    version: getNoteVersion(db, note.id) ?? 0,
  };
}

export function search_notes(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  return executeSearchNotes(snap, args);
}

export function ensure_note(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  // Idempotent: finds a note by title+projectId and updates it, or creates it.
  // Prevents duplicate notes when agents re-run (e.g. syncing a README).
  const { projectId, title, content, tagIds: ensureTagIds, tagNames, isPinned: ensureIsPinned } = args;
  const project = snap.projects.find((p) => p.id === projectId);
  if (!project) return { error: "Project not found" };
  const matchTitle = normalizeNoteTitle(title as string);
  const existing = snap.notes.find(
    (n) => !n.archivedAt && n.projectId === projectId && normalizeNoteTitle(n.title as string) === matchTitle
  );
  traceTool("lookup", {
    toolName: "ensure_note",
    requestedTitle: typeof title === "string" ? title : "",
    matchedId: existing?.id ?? "none",
  });
  const markdown = (content as string | undefined) ?? "";

  const resolvedFromNameIds = resolveTagNames(db, project.workspaceId, tagNames);
  let ensureResolvedTagIds = Array.isArray(ensureTagIds) ? ensureTagIds as string[] : undefined;
  if (resolvedFromNameIds.length > 0) {
    ensureResolvedTagIds = Array.from(new Set([...(ensureResolvedTagIds ?? []), ...resolvedFromNameIds]));
  }
  const ensureResolvedIsPinned = typeof ensureIsPinned === "boolean" ? ensureIsPinned : undefined;
  const ensureFolder = typeof args.folder === "string" ? args.folder : undefined;
  const ensureNoteId = existing?.id ?? newId();
  lockNote(db, ensureNoteId);
  try {
    if (existing) {
      const updatedFolder = ensureFolder ?? (existing.folder as string) ?? "";
      db.transaction(() => {
        q.updateNote(db, existing.id, {
          content: markdown,
          contentText: stripMarkdown(markdown),
          ...(ensureResolvedTagIds ? { tagIds: ensureResolvedTagIds } : {}),
          ...(ensureResolvedIsPinned !== undefined ? { isPinned: ensureResolvedIsPinned } : {}),
          ...(ensureFolder !== undefined ? { folder: ensureFolder } : {}),
        });
        insertNotification(db, "update_note", "Note updated", `"${title}" was updated (ensure_note)`);
      })();
      writeNoteFile(workspacePath, {
        id: existing.id, projectId, workspaceId: existing.workspaceId as string,
        title: existing.title as string, content: markdown,
        tagIds: ensureResolvedTagIds ?? existing.tagIds as string[], linkedNoteIds: existing.linkedNoteIds as string[],
        linkedCardIds: existing.linkedCardIds as string[], isPinned: ensureResolvedIsPinned ?? existing.isPinned as boolean,
        folder: updatedFolder,
        createdAt: existing.createdAt as string, updatedAt: new Date().toISOString(),
        archivedAt: existing.archivedAt as string | undefined,
        projectName: project.name,
      });
      return { id: existing.id, title, action: "updated", updatedAt: new Date().toISOString() };
    } else {
      const newTagIds = ensureResolvedTagIds ?? [];
      const newIsPinned = ensureResolvedIsPinned ?? false;
      const newFolder = ensureFolder ?? "";
      const note = db.transaction(() => {
        const n = q.createNote(db, {
          id: ensureNoteId,
          projectId: projectId as string,
          workspaceId: project.workspaceId as string,
          title: title as string,
          content: markdown,
          contentText: stripMarkdown(markdown),
          tagIds: newTagIds,
          isPinned: newIsPinned,
          folder: newFolder,
          type: "note",
        });
        insertNotification(db, "create_note", "Note created", `"${title}" added to ${project.name}${newFolder ? ` (${newFolder})` : ""} (ensure_note)`);
        return n;
      })();
      writeNoteFile(workspacePath, {
        id: ensureNoteId, projectId, workspaceId: project.workspaceId, title, content: markdown,
        tagIds: newTagIds, linkedNoteIds: [], linkedCardIds: [], isPinned: newIsPinned,
        folder: newFolder, createdAt: note.createdAt, updatedAt: note.updatedAt, projectName: project.name,
      });
      return { id: ensureNoteId, title, folder: newFolder, action: "created", createdAt: note.createdAt };
    }
  } finally {
    unlockNote(db, ensureNoteId);
  }
}

export function append_to_note(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  const { noteId, content: appendContent, separator = "\n\n", expectedVersion: appendExpectedVersion } = args;
  const note = snap.notes.find((n) => n.id === noteId);
  if (!note) return { error: "Note not found" };
  if (appendExpectedVersion !== undefined) {
    const currentVersion = getNoteVersion(db, noteId as string);
    if (currentVersion !== null && currentVersion !== (appendExpectedVersion as number)) {
      return { error: `Version conflict: note has been modified (expected v${appendExpectedVersion as number}, got v${currentVersion}). Fetch the latest content before retrying.` };
    }
  }
  const existingContent = (note.content as string) ?? "";
  const newContent = existingContent
    ? existingContent + (separator as string) + (appendContent as string)
    : (appendContent as string);
  lockNote(db, noteId as string);
  try {
    const proj = snap.projects.find((p) => p.id === note.projectId);
    const updated = db.transaction(() => {
      q.updateNote(db, noteId as string, {
        content: newContent,
        contentText: stripMarkdown(newContent),
      });
      insertNotification(db, "update_note", "Note updated", `Content appended to "${note.title}"`);
      return q.getNoteById(db, noteId as string);
    })();
    writeNoteFile(workspacePath, {
      id: noteId as string, projectId: note.projectId as string, workspaceId: note.workspaceId as string,
      title: note.title as string, content: newContent,
      tagIds: note.tagIds as string[], linkedNoteIds: note.linkedNoteIds as string[],
      linkedCardIds: note.linkedCardIds as string[], isPinned: note.isPinned as boolean,
      createdAt: note.createdAt as string, updatedAt: updated?.updatedAt ?? new Date().toISOString(),
      archivedAt: note.archivedAt as string | undefined,
      projectName: proj?.name ?? note.projectId as string,
    });
    return { id: noteId, title: note.title, updatedAt: updated?.updatedAt, newLength: newContent.length };
  } finally {
    unlockNote(db, noteId as string);
  }
}

export function patch_note(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  const { noteId, oldString, newString: replacement, replaceAll: all = false, expectedVersion: patchExpectedVersion } = args as {
    noteId: string; oldString: string; newString: string; replaceAll?: boolean; expectedVersion?: number;
  };
  const note = snap.notes.find((n) => n.id === noteId);
  if (!note) return { error: "Note not found" };
  if (patchExpectedVersion !== undefined) {
    const currentVersion = getNoteVersion(db, noteId);
    if (currentVersion !== null && currentVersion !== patchExpectedVersion) {
      return { error: `Version conflict: note has been modified (expected v${patchExpectedVersion}, got v${currentVersion}). Fetch the latest content before retrying.` };
    }
  }
  const existing = (note.content as string) ?? "";
  const count = existing.split(oldString).length - 1;
  if (count === 0) return { error: "oldString not found in note content" };
  if (count > 1 && !all) return { error: `oldString matches ${count} times — set replaceAll: true to replace all, or provide more surrounding context to make it unique` };
  const newContent = all ? existing.split(oldString).join(replacement) : existing.replace(oldString, replacement);
  lockNote(db, noteId);
  try {
    const proj = snap.projects.find((p) => p.id === note.projectId);
    const updated = db.transaction(() => {
      q.updateNote(db, noteId, {
        content: newContent,
        contentText: stripMarkdown(newContent),
      });
      insertNotification(db, "update_note", "Note updated", `Patch applied to "${note.title}"`);
      return q.getNoteById(db, noteId);
    })();
    writeNoteFile(workspacePath, {
      id: noteId, projectId: note.projectId as string, workspaceId: note.workspaceId as string,
      title: note.title as string, content: newContent,
      tagIds: note.tagIds as string[], linkedNoteIds: note.linkedNoteIds as string[],
      linkedCardIds: note.linkedCardIds as string[], isPinned: note.isPinned as boolean,
      createdAt: note.createdAt as string, updatedAt: updated?.updatedAt ?? new Date().toISOString(),
      archivedAt: note.archivedAt as string | undefined,
      projectName: proj?.name ?? note.projectId as string,
    });
    return { id: noteId, title: note.title, updatedAt: updated?.updatedAt, replacements: all ? count : 1 };
  } finally {
    unlockNote(db, noteId);
  }
}

export function delete_note(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  const note = snap.notes.find((n) => n.id === args.noteId);
  if (!note) return { error: "Note not found" };
  const delProj = snap.projects.find((pr) => pr.id === note.projectId);
  q.deleteNote(db, args.noteId as string);
  deleteNoteFile(workspacePath, delProj?.name ?? note.projectId as string, args.noteId as string);
  insertNotification(db, "delete_note", "Note deleted", `"${note.title}" was deleted`);
  return { deleted: true, id: args.noteId, title: note.title };
}
