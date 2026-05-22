/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import { newId, ts } from "../../db/utils";
import { DEFAULT_COLUMNS } from "../../db/defaults";
import { insertNotification, Snapshot } from "../db";
import { toSlug } from "../../shared/text-utils";

export function upsert_project(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  if (args.projectId) {
    // ── update path ──────────────────────────────────────────────────────
    const project = snap.projects.find((p) => p.id === args.projectId);
    if (!project) return { error: "Project not found" };
    const now = ts();
    db.prepare(`
      UPDATE projects SET
        name        = COALESCE(?, name),
        description = COALESCE(?, description),
        status      = COALESCE(?, status),
        priority    = COALESCE(?, priority),
        icon        = COALESCE(?, icon),
        updated_at  = ?
      WHERE id = ?
    `).run(args.name ?? null, args.description ?? null, args.status ?? null, args.priority ?? null, args.icon ?? null, now, args.projectId);
    const updated = db.prepare("SELECT * FROM projects WHERE id = ?").get(args.projectId) as Record<string, unknown> | undefined;
    insertNotification(db, "upsert_project", "Project updated", `"${args.name ?? project.name}" was updated`);
    return updated ?? { error: "Project not found after update" };
  } else {
    // ── create path ──────────────────────────────────────────────────────
    const workspace = snap.workspaces.find((w) => w.id === args.workspaceId);
    if (!workspace) return { error: "Workspace not found" };
    if (!args.name) return { error: "name is required when creating a project" };
    const projectId = newId();
    const now = ts();
    db.prepare(`INSERT INTO projects (id, workspace_id, name, description, icon, status, priority, tag_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`)
      .run(projectId, args.workspaceId, args.name, args.description ?? null, args.icon ?? null,
        args.status ?? "active", args.priority ?? "medium", now, now);
    const columns = DEFAULT_COLUMNS.map((col) => {
      const colId = newId();
      db.prepare(`INSERT INTO board_columns (id, project_id, workspace_id, name, type, "order", created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(colId, projectId, args.workspaceId, col.name, col.type, col.order, now, now);
      return { id: colId, name: col.name, type: col.type };
    });
    insertNotification(db, "upsert_project", "Project created", `"${args.name}" was created`);
    return { projectId, name: args.name, columns };
  }
}

export function delete_project(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };
  // Delete notes dir
  const notesDir = path.join(workspacePath, toSlug(project.name));
  if (fs.existsSync(notesDir)) {
    try { fs.rmSync(notesDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  db.prepare("DELETE FROM task_cards WHERE project_id = ?").run(args.projectId);
  db.prepare("DELETE FROM board_columns WHERE project_id = ?").run(args.projectId);
  db.prepare("DELETE FROM notes WHERE project_id = ?").run(args.projectId);
  db.prepare("DELETE FROM projects WHERE id = ?").run(args.projectId);
  insertNotification(db, "delete_project", "Project deleted", `"${project.name}" was deleted`);
  return { deleted: true, id: args.projectId, name: project.name };
}
