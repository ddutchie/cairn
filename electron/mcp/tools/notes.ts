/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import { newId, ts } from "../../db/utils";
import { stripMarkdown } from "../../shared/text-utils";
import {
  Snapshot,
  insertNotification,
  lockNote,
  unlockNote,
  getNoteVersion,
  writeNoteFile,
  deleteNoteFile,
  j
} from "../db";

export function get_note(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const note = snap.notes.find((n) => n.id === args.noteId);
  if (!note) return { error: "Note not found" };
  return {
    id: note.id, title: note.title, content: note.content,
    projectId: note.projectId, isPinned: note.isPinned,
    linkedNoteIds: note.linkedNoteIds, linkedCardIds: note.linkedCardIds,
    updatedAt: note.updatedAt, version: (note as any).version ?? 0,
  };
}

export function search_notes(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { query, projectId, limit = 10 } = args;
  const qr = String(query).toLowerCase();
  return snap.notes
    .filter((n) => {
      if (n.archivedAt) return false;
      if (projectId && n.projectId !== projectId) return false;
      return n.title.toLowerCase().includes(qr) || n.contentText.toLowerCase().includes(qr);
    })
    .slice(0, limit)
    .map((n) => ({ id: n.id, title: n.title, snippet: n.contentText.slice(0, 200), projectId: n.projectId, updatedAt: n.updatedAt }));
}

export function ensure_note(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  // Idempotent: finds a note by title+projectId and updates it, or creates it.
  // Prevents duplicate notes when agents re-run (e.g. syncing a README).
  const { projectId, title, content, tagIds: ensureTagIds, isPinned: ensureIsPinned } = args;
  const project = snap.projects.find((p) => p.id === projectId);
  if (!project) return { error: "Project not found" };
  const existing = snap.notes.find(
    (n) => !n.archivedAt && n.projectId === projectId && n.title === title
  );
  const now = ts();
  const markdown = (content as string | undefined) ?? "";
  const ensureResolvedTagIds = Array.isArray(ensureTagIds) ? ensureTagIds as string[] : undefined;
  const ensureResolvedIsPinned = typeof ensureIsPinned === "boolean" ? ensureIsPinned : undefined;
  const ensureFolder = typeof args.folder === "string" ? args.folder : undefined;
  const ensureNoteId = existing?.id ?? newId();
  lockNote(db, ensureNoteId);
  try {
    if (existing) {
      const tagIdsJson = ensureResolvedTagIds ? j(ensureResolvedTagIds) : null;
      const pinnedVal = ensureResolvedIsPinned !== undefined ? (ensureResolvedIsPinned ? 1 : 0) : null;
      const folderVal = ensureFolder !== undefined ? ensureFolder : null;
      const updatedFolder = ensureFolder ?? (existing.folder as string) ?? "";
      db.transaction(() => {
        db.prepare(`UPDATE notes SET content = ?, content_text = ?, tag_ids = COALESCE(?, tag_ids), is_pinned = COALESCE(?, is_pinned), folder = COALESCE(?, folder), updated_at = ?, version = version + 1 WHERE id = ?`)
          .run(markdown, stripMarkdown(markdown), tagIdsJson, pinnedVal, folderVal, now, existing.id);
        insertNotification(db, "update_note", "Note updated", `"${title}" was updated (ensure_note)`);
      })();
      writeNoteFile(workspacePath, {
        id: existing.id, projectId, workspaceId: existing.workspaceId as string,
        title: existing.title as string, content: markdown,
        tagIds: ensureResolvedTagIds ?? existing.tagIds as string[], linkedNoteIds: existing.linkedNoteIds as string[],
        linkedCardIds: existing.linkedCardIds as string[], isPinned: ensureResolvedIsPinned ?? existing.isPinned as boolean,
        folder: updatedFolder,
        createdAt: existing.createdAt as string, updatedAt: now,
        archivedAt: existing.archivedAt as string | undefined,
        projectName: project.name,
      });
      return { id: existing.id, title, action: "updated", updatedAt: now };
    } else {
      const newTagIds = ensureResolvedTagIds ?? [];
      const newIsPinned = ensureResolvedIsPinned ?? false;
      const newFolder = ensureFolder ?? "";
      db.transaction(() => {
        db.prepare(`
          INSERT INTO notes (id, project_id, workspace_id, title, content, content_text,
            tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, folder, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, 'note', ?, ?, ?)
        `).run(ensureNoteId, projectId, project.workspaceId, title, markdown, stripMarkdown(markdown), j(newTagIds), newIsPinned ? 1 : 0, newFolder, now, now);
        insertNotification(db, "create_note", "Note created", `"${title}" added to ${project.name}${newFolder ? ` (${newFolder})` : ""} (ensure_note)`);
      })();
      writeNoteFile(workspacePath, {
        id: ensureNoteId, projectId, workspaceId: project.workspaceId, title, content: markdown,
        tagIds: newTagIds, linkedNoteIds: [], linkedCardIds: [], isPinned: newIsPinned,
        folder: newFolder, createdAt: now, updatedAt: now, projectName: project.name,
      });
      return { id: ensureNoteId, title, folder: newFolder, action: "created", createdAt: now };
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
  const now = ts();
  const existingContent = (note.content as string) ?? "";
  const newContent = existingContent
    ? existingContent + (separator as string) + (appendContent as string)
    : (appendContent as string);
  lockNote(db, noteId as string);
  try {
    const proj = snap.projects.find((p) => p.id === note.projectId);
    db.transaction(() => {
      db.prepare(`UPDATE notes SET content = ?, content_text = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
        .run(newContent, stripMarkdown(newContent), now, noteId);
      insertNotification(db, "update_note", "Note updated", `Content appended to "${note.title}"`);
    })();
    writeNoteFile(workspacePath, {
      id: noteId, projectId: note.projectId as string, workspaceId: note.workspaceId as string,
      title: note.title as string, content: newContent,
      tagIds: note.tagIds as string[], linkedNoteIds: note.linkedNoteIds as string[],
      linkedCardIds: note.linkedCardIds as string[], isPinned: note.isPinned as boolean,
      createdAt: note.createdAt as string, updatedAt: now,
      archivedAt: note.archivedAt as string | undefined,
      projectName: proj?.name ?? note.projectId as string,
    });
    return { id: noteId, title: note.title, updatedAt: now, newLength: newContent.length };
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
  const now = ts();
  const newContent = all ? existing.split(oldString).join(replacement) : existing.replace(oldString, replacement);
  lockNote(db, noteId);
  try {
    const proj = snap.projects.find((p) => p.id === note.projectId);
    db.transaction(() => {
      db.prepare(`UPDATE notes SET content = ?, content_text = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
        .run(newContent, stripMarkdown(newContent), now, noteId);
      insertNotification(db, "update_note", "Note updated", `Patch applied to "${note.title}"`);
    })();
    writeNoteFile(workspacePath, {
      id: noteId, projectId: note.projectId as string, workspaceId: note.workspaceId as string,
      title: note.title as string, content: newContent,
      tagIds: note.tagIds as string[], linkedNoteIds: note.linkedNoteIds as string[],
      linkedCardIds: note.linkedCardIds as string[], isPinned: note.isPinned as boolean,
      createdAt: note.createdAt as string, updatedAt: now,
      archivedAt: note.archivedAt as string | undefined,
      projectName: proj?.name ?? note.projectId as string,
    });
    return { id: noteId, title: note.title, updatedAt: now, replacements: all ? count : 1 };
  } finally {
    unlockNote(db, noteId);
  }
}

export function delete_note(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  const note = snap.notes.find((n) => n.id === args.noteId);
  if (!note) return { error: "Note not found" };
  const delProj = snap.projects.find((pr) => pr.id === note.projectId);
  db.prepare("DELETE FROM notes WHERE id = ?").run(args.noteId);
  deleteNoteFile(workspacePath, delProj?.name ?? note.projectId as string, args.noteId as string);
  insertNotification(db, "delete_note", "Note deleted", `"${note.title}" was deleted`);
  return { deleted: true, id: args.noteId, title: note.title };
}
