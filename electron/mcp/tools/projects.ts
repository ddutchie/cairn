/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import * as q from "../../db/queries";
import { newId } from "../../db/utils";
import { DEFAULT_COLUMNS } from "../../db/defaults";
import { Snapshot, insertNotification } from "../db";
import { renameProjectNotesDir, deleteProjectNotesDir } from "../../shared/notes-io";

export function upsert_project(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  if (args.projectId) {
    // ── update path ──────────────────────────────────────────────────────
    const project = snap.projects.find((p) => p.id === args.projectId);
    if (!project) return { error: "Project not found" };
    const patch: Parameters<typeof q.updateProject>[2] = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.description !== undefined) patch.description = args.description;
    if (args.status !== undefined) patch.status = args.status;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.icon !== undefined) patch.icon = args.icon;
    const updatedProject = q.updateProject(db, args.projectId as string, patch);
    // Relocate the on-disk notes directory when the name (slug) changed, so the
    // .md files follow the rename instead of being orphaned under the old slug.
    if (updatedProject && project.name !== updatedProject.name) {
      renameProjectNotesDir(workspacePath, project.name, updatedProject.name);
    }
    insertNotification(db, "upsert_project", "Project updated", `"${args.name ?? project.name}" was updated`);
    return updatedProject;
  } else {
    // ── create path ──────────────────────────────────────────────────────
    const workspace = snap.workspaces.find((w) => w.id === args.workspaceId);
    if (!workspace) return { error: "Workspace not found" };
    if (!args.name) return { error: "name is required when creating a project" };
    const projectId = newId();
    const createdProject = q.createProject(db, {
      id: projectId,
      workspaceId: args.workspaceId as string,
      name: args.name as string,
      description: args.description,
      icon: args.icon,
      status: args.status ?? "active",
      priority: args.priority ?? "medium",
    });
    const columns = DEFAULT_COLUMNS.map((col) => {
      const colId = newId();
      return q.createColumn(db, {
        id: colId,
        projectId,
        workspaceId: args.workspaceId as string,
        name: col.name,
        type: col.type,
        order: col.order,
      });
    });
    insertNotification(db, "upsert_project", "Project created", `"${args.name}" was created`);
    return { project: createdProject, columns };
  }
}

export function delete_project(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };
  // Delete the DB rows first, then remove the notes folder — but only if no
  // surviving project still shares this name's slug. The folder is keyed by
  // the project NAME slug (not the id) and names are not unique, so blindly
  // deleting it would destroy a same-named duplicate's .md files (data loss).
  q.deleteProject(db, args.projectId as string);
  // Scope survivors to this project's workspace — a same-named project in
  // another workspace lives in a different folder tree and must not block this
  // delete.
  const survivorNames = q.getProjects(db, project.workspaceId).map((p) => p.name);
  deleteProjectNotesDir(workspacePath, project.name, survivorNames);
  insertNotification(db, "delete_project", "Project deleted", `"${project.name}" was deleted`);
  return { deleted: true, id: args.projectId, name: project.name };
}
