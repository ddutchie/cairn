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
    folder: (note.folder as string) ?? "",
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
      let updatedNote: any;
      db.transaction(() => {
        updatedNote = q.updateNote(db, existing.id, {
          ...(content !== undefined ? { content, contentText: stripMarkdown(content as string) } : {}),
          ...(ensureResolvedTagIds ? { tagIds: ensureResolvedTagIds } : {}),
          ...(ensureResolvedIsPinned !== undefined ? { isPinned: ensureResolvedIsPinned } : {}),
          ...(ensureFolder !== undefined ? { folder: ensureFolder } : {}),
        });
        insertNotification(db, "update_note", "Note updated", `"${title}" was updated (ensure_note)`);
      })();
      writeNoteFile(workspacePath, {
        id: existing.id, projectId, workspaceId: existing.workspaceId as string,
        title: existing.title as string, content: updatedNote.content,
        tagIds: updatedNote.tagIds, linkedNoteIds: updatedNote.linkedNoteIds,
        linkedCardIds: updatedNote.linkedCardIds, isPinned: updatedNote.isPinned,
        folder: updatedNote.folder,
        createdAt: existing.createdAt as string, updatedAt: updatedNote.updatedAt,
        archivedAt: existing.archivedAt as string | undefined,
        projectName: project.name,
      });
      return { id: existing.id, title, folder: updatedNote.folder, action: "updated", updatedAt: updatedNote.updatedAt };
    } else {
      const newTagIds = ensureResolvedTagIds ?? [];
      const newIsPinned = ensureResolvedIsPinned ?? false;
      const newFolder = ensureFolder ?? "";
      const markdown = (content as string | undefined) ?? "";
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

export function rename_note(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  const { noteId, newTitle } = args;
  if (!newTitle || typeof newTitle !== "string") return { error: "newTitle is required and must be a string" };
  const note = snap.notes.find((n) => n.id === noteId);
  if (!note) return { error: "Note not found" };
  const project = snap.projects.find((p) => p.id === note.projectId);

  const updatedNote = db.transaction(() => {
    // 1. Update the note itself in DB
    const u = q.updateNote(db, noteId, { title: newTitle });

    // 2. Rewrite wikilinks inside other notes in DB
    const oldLink = `[[${note.title}]]`;
    const newLink = `[[${newTitle}]]`;
    for (const otherNote of snap.notes) {
      if (otherNote.id === noteId) continue;
      if (otherNote.content && otherNote.content.includes(oldLink)) {
        const newContent = otherNote.content.split(oldLink).join(newLink);
        q.updateNote(db, otherNote.id, { content: newContent, contentText: stripMarkdown(newContent) });
        const otherProj = snap.projects.find((p) => p.id === otherNote.projectId);
        writeNoteFile(workspacePath, {
          id: otherNote.id,
          projectId: otherNote.projectId,
          workspaceId: otherNote.workspaceId as string,
          title: otherNote.title as string,
          content: newContent,
          tagIds: otherNote.tagIds as string[],
          linkedNoteIds: otherNote.linkedNoteIds as string[],
          linkedCardIds: otherNote.linkedCardIds as string[],
          isPinned: otherNote.isPinned as boolean,
          folder: (otherNote.folder as string) ?? "",
          createdAt: otherNote.createdAt as string,
          updatedAt: new Date().toISOString(),
          archivedAt: otherNote.archivedAt as string | undefined,
          projectName: otherProj?.name ?? otherNote.projectId as string,
        });
      }
    }
    return u;
  })();

  // 3. Write note file to disk (writeNoteFile renames/moves the path dynamically if title changes)
  writeNoteFile(workspacePath, {
    id: note.id,
    projectId: note.projectId,
    workspaceId: note.workspaceId as string,
    title: newTitle,
    content: updatedNote?.content ?? note.content as string,
    tagIds: note.tagIds as string[],
    linkedNoteIds: note.linkedNoteIds as string[],
    linkedCardIds: note.linkedCardIds as string[],
    isPinned: note.isPinned as boolean,
    folder: (note.folder as string) ?? "",
    createdAt: note.createdAt as string,
    updatedAt: updatedNote?.updatedAt ?? new Date().toISOString(),
    archivedAt: note.archivedAt as string | undefined,
    projectName: project?.name ?? note.projectId as string,
  });

  insertNotification(db, "update_note", "Note renamed", `"${note.title}" renamed to "${newTitle}"`);
  return { id: note.id, title: newTitle, action: "renamed", updatedAt: updatedNote?.updatedAt };
}

export function bulk_move_notes(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  const { noteIds, folder } = args;
  if (!Array.isArray(noteIds) || noteIds.length === 0) return { error: "noteIds must be a non-empty array" };
  const targetFolder = typeof folder === "string" ? folder : "";
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];

  for (const noteId of noteIds) {
    const note = snap.notes.find((n) => n.id === noteId);
    if (!note) {
      results.push({ id: noteId, ok: false, error: "Note not found" });
      continue;
    }
    lockNote(db, noteId);
    try {
      const project = snap.projects.find((p) => p.id === note.projectId);
      const updatedNote = q.updateNote(db, noteId, { folder: targetFolder });
      writeNoteFile(workspacePath, {
        id: note.id,
        projectId: note.projectId,
        workspaceId: note.workspaceId as string,
        title: note.title as string,
        content: note.content as string,
        tagIds: note.tagIds as string[],
        linkedNoteIds: note.linkedNoteIds as string[],
        linkedCardIds: note.linkedCardIds as string[],
        isPinned: note.isPinned as boolean,
        folder: targetFolder,
        createdAt: note.createdAt as string,
        updatedAt: updatedNote?.updatedAt ?? new Date().toISOString(),
        archivedAt: note.archivedAt as string | undefined,
        projectName: project?.name ?? note.projectId as string,
      });
      results.push({ id: noteId, ok: true });
    } finally {
      unlockNote(db, noteId);
    }
  }

  const moved = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (moved > 0) {
    insertNotification(db, "bulk_move_notes", "Notes moved", `${moved} note${moved === 1 ? "" : "s"} moved to "${targetFolder || "root"}"`);
  }
  return { moved, failed, folder: targetFolder };
}

export function list_folders(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { projectId } = args;
  const project = snap.projects.find((p) => p.id === projectId);
  if (!project) return { error: "Project not found" };

  const rows = db.prepare("SELECT DISTINCT folder FROM notes WHERE project_id = ? AND archived_at IS NULL").all(projectId) as Array<{ folder: string }>;
  const folders = Array.from(new Set(rows.map((r) => r.folder).filter((f) => typeof f === "string" && f.trim() !== "")));
  return { projectId, folders };
}
