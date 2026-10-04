/** Project rows ↔ project note folders: create on demand and reconcile renames. */

import path from "path";
import fs from "fs";
import type Database from "better-sqlite3";
import * as q from "./db/queries";
import { newId } from "./db/utils";
import { toSlug } from "./host-shared/text-utils";
import { DEFAULT_COLUMNS } from "./db/defaults";
import { notesDir, renameProjectNotesDir, parseNoteFile } from "./host-shared/notes-io";

/**
 * Create a project (plus the default board columns) named `name` in `workspaceId`.
 * Returns the new project id. Callers are responsible for slug-uniqueness checks.
 *
 * The project row + all default columns are created in a single transaction, so
 * a failure partway through can never leave a project with a partial/empty board
 * (mirrors the db:project:create handler).
 */
export function ensureProject(db: Database.Database, workspaceId: string, name: string): string {
  const projectId = newId();
  db.transaction(() => {
    q.createProject(db, { id: projectId, workspaceId, name });
    for (const col of DEFAULT_COLUMNS) {
      q.createColumn(db, {
        id: newId(),
        projectId,
        workspaceId,
        name: col.name,
        type: col.type,
        order: col.order,
      });
    }
  })();
  console.log(`[sync] Auto-created project "${name}" from vault folder.`);
  return projectId;
}

/**
 * Reconcile project note directories on disk with current project names.
 *
 * A project's on-disk folder is derived from `toSlug(project.name)`. Renaming a
 * project used to update only the DB, leaving the `.md` files stranded under the
 * OLD slug (e.g. "Test Project" renamed to "Misc" but files still in
 * `<ws>/Test Project/`). Going forward, renames relocate the folder live (see
 * renameProjectNotesDir wired into the project-update handlers), but this heals
 * workspaces where a rename already happened before that fix.
 *
 * Strategy (name-agnostic — we don't need to know the old name):
 *   1. Map each top-level directory to the project that owns its notes, by
 *      reading the `projectId` from the first Cairn `.md` file found inside.
 *   2. If that directory's name != the project's expected slug, move it to the
 *      expected directory (merging if one already exists). Runs before
 *      syncNotesFromDisk so the relocated files are then imported/updated
 *      from their correct location.
 *
 * Idempotent and best-effort: a workspace already in sync is a no-op, and any
 * per-project failure is logged and skipped without aborting the others.
 * Returns the number of directories relocated.
 */
export function reconcileProjectFolders(db: Database.Database, workspacePath: string): number {
  const root = notesDir(workspacePath);
  if (!fs.existsSync(root)) return 0;

  // Expected slug → project name, for every project in the DB.
  const projects = q.getProjects(db) as { id: string; name: string }[];
  const expectedSlugById = new Map(projects.map((p) => [p.id, toSlug(p.name)]));
  const nameById = new Map(projects.map((p) => [p.id, p.name]));

  let moved = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue; // .obsidian, .git, .cairn-migrations.json
    const dir = path.join(root, entry);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Identify which project this directory belongs to via a contained note.
    const ownerProjectId = firstNoteProjectId(dir);
    if (!ownerProjectId) continue; // no Cairn notes here — not a project folder
    const expectedSlug = expectedSlugById.get(ownerProjectId);
    if (!expectedSlug || expectedSlug === entry) continue; // already correct

    const projectName = nameById.get(ownerProjectId)!;
    try {
      // renameProjectNotesDir works in terms of project NAMES → slugs; feed it
      // this directory's literal name as the "old name" and the project's real
      // name as the "new name" so it computes old=<entry> → new=<expectedSlug>.
      if (renameProjectNotesDir(workspacePath, entry, projectName)) {
        moved++;
        console.log(`[reconcile] Moved project notes "${entry}" → "${expectedSlug}" (project "${projectName}").`);
      }
    } catch (err) {
      console.error(`[reconcile] Failed to relocate "${entry}":`, err);
    }
  }
  return moved;
}

/** Read the `projectId` from the first Cairn `.md` file found under `dir` (recursive). */
function firstNoteProjectId(dir: string): string | null {
  let found: string | null = null;
  const walk = (d: string) => {
    if (found) return;
    let items: string[];
    try {
      items = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const item of items) {
      if (found) return;
      if (item.startsWith(".")) continue;
      const fp = path.join(d, item);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(fp);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(fp);
      } else if (item.endsWith(".md")) {
        const note = parseNoteFile(fp);
        if (note?.projectId) {
          found = note.projectId;
          return;
        }
      }
    }
  };
  walk(dir);
  return found;
}

/** Remove any *.md.tmp files left by a crash during an atomic write. */
export function cleanStaleTmpFiles(dir: string): void {
  try {
    for (const entry of fs.readdirSync(dir)) {
      const fp = path.join(dir, entry);
      try {
        const stat = fs.lstatSync(fp);
        if (stat.isDirectory()) {
          cleanStaleTmpFiles(fp);
        } else if (entry.endsWith(".md.tmp")) {
          fs.unlinkSync(fp);
        }
      } catch { /* skip unreadable entries */ }
    }
  } catch { /* root unreadable */ }
}
