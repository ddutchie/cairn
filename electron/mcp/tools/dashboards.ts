/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import * as q from "../../db/queries";
import { newId } from "../../db/utils";
import { Snapshot, insertNotification } from "../db";

export function create_dashboard(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { projectId, title, html } = args;
  const project = snap.projects.find((pr) => pr.id === projectId);
  if (!project) return { error: "Project not found" };
  const noteId = newId();
  const note = q.createNote(db, {
    id: noteId,
    projectId: projectId as string,
    workspaceId: project.workspaceId as string,
    title: title as string,
    content: (html as string) ?? "",
    contentText: "",
    type: "dashboard",
  });
  insertNotification(db, "create_dashboard", "Dashboard created", `"${title}" added to ${project.name}`);
  return { id: noteId, title, createdAt: note.createdAt };
}

export function update_dashboard(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { noteId, title, html } = args;
  const note = snap.notes.find((n) => n.id === noteId);
  if (!note) return { error: "Dashboard not found" };
  const patch: Parameters<typeof q.updateNote>[2] = {};
  if (title !== undefined) patch.title = title;
  if (html !== undefined) { patch.content = html; patch.contentText = ""; }
  q.updateNote(db, noteId as string, patch);
  insertNotification(db, "update_dashboard", "Dashboard updated", `"${title ?? note.title}" was updated`);
  return { id: noteId, title: (title as string) ?? note.title, updatedAt: note.updatedAt };
}
