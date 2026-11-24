/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import * as q from "../../db/queries";
import { newId } from "../../db/utils";
import { DEFAULT_COLUMNS } from "../../db/defaults";
import { Snapshot, insertNotification } from "../db";
import { addProjectLinks, removeProjectLinks, type ProjectLink } from "../../../shared/projects/links";
import { renameProjectNotesDir, deleteProjectNotesDir } from "../../host-shared/notes-io";

/** Apply addLinks / removeLinkIds to a link list; says which inputs were refused. */
function applyLinkArgs(current: ProjectLink[], args: Record<string, any>): { links: ProjectLink[]; rejected: string[]; changed: boolean } {
  const add = Array.isArray(args.addLinks) ? args.addLinks : [];
  const remove = Array.isArray(args.removeLinkIds) ? args.removeLinkIds.filter((x: unknown) => typeof x === "string") : [];
  if (!add.length && !remove.length) return { links: current, rejected: [], changed: false };
  const kept = removeProjectLinks(current, remove);
  const { links, rejected } = addProjectLinks(kept, add, newId);
  return { links, rejected, changed: true };
}

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
    const linkChange = applyLinkArgs(project.links ?? [], args);
    if (linkChange.changed) patch.links = linkChange.links;
    const updatedProject = q.updateProject(db, args.projectId as string, patch);
    // Relocate the on-disk notes directory when the name (slug) changed, so the
    // .md files follow the rename instead of being orphaned under the old slug.
    if (updatedProject && project.name !== updatedProject.name) {
      renameProjectNotesDir(workspacePath, project.name, updatedProject.name);
    }
    insertNotification(db, "upsert_project", "Project updated", `"${args.name ?? project.name}" was updated`);
    return linkChange.rejected.length ? { ...updatedProject, rejectedLinks: linkChange.rejected } : updatedProject;
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
    const linkChange = applyLinkArgs([], args);
    const withLinks = linkChange.changed ? q.updateProject(db, projectId, { links: linkChange.links }) : createdProject;
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
    return { project: withLinks, columns, ...(linkChange.rejected.length ? { rejectedLinks: linkChange.rejected } : {}) };
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
