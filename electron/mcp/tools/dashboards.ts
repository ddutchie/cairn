/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import { newId, ts } from "../../db/utils";
import { Snapshot, insertNotification } from "../db";

export function create_dashboard(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { projectId, title, html } = args;
  const project = snap.projects.find((pr) => pr.id === projectId);
  if (!project) return { error: "Project not found" };
  const now = ts();
  const noteId = newId();
  db.prepare(`
    INSERT INTO notes (id, project_id, workspace_id, title, content, content_text,
      tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', 0, 'dashboard', ?, ?)
  `).run(noteId, projectId, project.workspaceId, title, html ?? "", "", now, now);
  insertNotification(db, "create_dashboard", "Dashboard created", `"${title}" added to ${project.name}`);
  return { id: noteId, title, createdAt: now };
}

export function update_dashboard(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { noteId, title, html } = args;
  const note = snap.notes.find((n) => n.id === noteId);
  if (!note) return { error: "Dashboard not found" };
  const now = ts();
  db.prepare(`UPDATE notes SET title = COALESCE(?, title), content = COALESCE(?, content), updated_at = ? WHERE id = ?`)
    .run(title ?? null, html ?? null, now, noteId);
  insertNotification(db, "update_dashboard", "Dashboard updated", `"${title ?? note.title}" was updated`);
  return { id: noteId, title: title ?? note.title, updatedAt: now };
}
