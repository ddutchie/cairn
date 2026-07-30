import path from "path";
import fs from "fs";
import matter from "gray-matter";
import type Database from "better-sqlite3";
import * as q from "./db/queries";
import { newId } from "./db/utils";
import { toSlug, stripMarkdown } from "./shared/text-utils";
import { DEFAULT_COLUMNS } from "./db/defaults";
import {
  readExistingFrontmatter,
  notesDir,
  projectNotesDir,
  noteDir,
  resolveNoteFilePath,
  findNoteFilePath,
  NoteFileData as NoteData,
  writeNoteFile,
  deleteNoteFile,
  deleteProjectNotesDir,
  renameProjectNotesDir,
  parseNoteFile,
  pruneEmptyDirsUpTo,
  CAIRN_FRONTMATTER_KEYS
} from "./shared/notes-io";

export {
  toSlug,
  stripMarkdown,
  readExistingFrontmatter,
  notesDir,
  projectNotesDir,
  noteDir,
  resolveNoteFilePath,
  findNoteFilePath,
  NoteData,
  writeNoteFile,
  deleteNoteFile,
  deleteProjectNotesDir,
  renameProjectNotesDir,
  parseNoteFile,
  pruneEmptyDirsUpTo
};


// ── Startup sync ──────────────────────────────
//
// Walks the entire notes directory on startup and reconciles .md files with
// SQLite. Two cases are handled:
//
//  1. Note missing from SQLite → always import (crash recovery).
//  2. Note present in SQLite but .md is newer → overwrite SQLite content.
//     Detects notes edited in an external editor while Cairn was closed.
//     Uses frontmatter updatedAt as primary signal; falls back to file mtime
//     (with a 2-second buffer for filesystem precision differences).
//
// Also cleans up any stale *.md.tmp files left by a crash during an atomic write.

export function syncNotesFromDisk(db: Database.Database, workspacePath: string, workspaceId?: string): void {
  const root = notesDir(workspacePath);
  if (!fs.existsSync(root)) return;
  cleanStaleTmpFiles(root);
  // Auto-create projects for any top-level folders (and loose root .md files)
  // that don't yet have a matching project in the DB. This is what lets a user
  // point Cairn at an existing Obsidian vault — or copy a folder of notes into
  // the workspace — and have projects + notes appear. Best-effort: if there is
  // no workspace yet (first-run onboarding, before createWorkspace), the import
  // is a no-op and notes are picked up on the next scan once the workspace
  // exists. See importVaultProjects.
  try {
    importVaultProjects(db, workspacePath, workspaceId);
  } catch (err) {
    console.error("[sync] importVaultProjects failed:", err);
  }
  syncDir(db, root, workspacePath);
}

/**
 * Resolve the set of folder slugs already owned by a LIVE (non-archived)
 * project. Shared by importVaultProjects (to decide which folders still need a
 * project) and adoptExternalNoteFile (to resolve a file's owning project) so the
 * two can never disagree about what "already exists" — a divergence there would
 * let a folder whose slug matches an ARCHIVED project be skipped by the import
 * yet fail adoption, silently dropping every note in it.
 */
function activeProjectsBySlug(
  db: Database.Database,
): Map<string, { id: string; name: string; workspace_id: string }> {
  const rows = db.prepare(
    "SELECT id, name, workspace_id FROM projects WHERE archived_at IS NULL",
  ).all() as { id: string; name: string; workspace_id: string }[];
  const bySlug = new Map<string, { id: string; name: string; workspace_id: string }>();
  for (const r of rows) {
    // First writer wins on a slug collision (stable, arbitrary but deterministic).
    const slug = toSlug(r.name);
    if (!bySlug.has(slug)) bySlug.set(slug, r);
  }
  return bySlug;
}

/**
 * Discover projects from folders on disk and create them in the DB.
 *
 * Cairn stores each project's notes under `<workspace>/<toSlug(project.name)>/`.
 * Historically the scan could only import a `.md` file if a project with the
 * matching folder slug already existed — so pointing Cairn at an Obsidian vault
 * (or copying a folder of notes in) imported nothing, because no project rows
 * existed for those folders.
 *
 * This pass closes that gap. For the resolved workspace it will:
 *
 *   1. Create a project for every top-level folder that contains at least one
 *      `.md` file (recursively), UNLESS a LIVE project with that slug already
 *      exists. The project's name is the folder's on-disk name.
 *   2. Create a single catch-all project (named after the workspace/vault
 *      folder) for loose `.md` files that live directly in the vault root, if
 *      any exist and no project already owns the root slug.
 *
 * Skips dot-directories (`.obsidian`, `.git`, `.trash`) and the known
 * infrastructure folders (`assets`, `attachments`). Idempotent — folders that
 * already map to a project are left untouched, so it is safe to run on every
 * boot and inside the file watcher.
 *
 * `workspaceId` — the workspace the discovered projects belong to. Callers that
 * know the active workspace (rescan IPC, file watcher) should pass it so that in
 * a multi-workspace install the projects attach to the RIGHT workspace, not just
 * the oldest. When omitted (first-run onboarding, where exactly one workspace
 * exists) it falls back to the oldest workspace.
 *
 * Returns the number of projects created.
 */
export function importVaultProjects(
  db: Database.Database,
  workspacePath: string,
  workspaceId?: string,
): number {
  const root = notesDir(workspacePath);
  if (!fs.existsSync(root)) return 0;

  // Resolve the workspace to attach new projects to. Prefer the caller-supplied
  // id; otherwise fall back to the oldest (primary) workspace. If none exists yet
  // (onboarding runs the first scan BEFORE createWorkspace), we can't create
  // projects — bail; the next scan after the workspace exists picks it all up.
  let wsId = workspaceId;
  if (!wsId) {
    const wsRow = db.prepare(
      "SELECT id FROM workspaces ORDER BY created_at LIMIT 1",
    ).get() as { id?: string } | undefined;
    wsId = wsRow?.id;
  } else {
    // Validate the supplied id actually exists (defensive — a stale id would
    // create orphaned projects). Fall back to oldest if not.
    const exists = db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(wsId);
    if (!exists) {
      const wsRow = db.prepare(
        "SELECT id FROM workspaces ORDER BY created_at LIMIT 1",
      ).get() as { id?: string } | undefined;
      wsId = wsRow?.id;
    }
  }
  if (!wsId) return 0;

  const SKIP_DIRS = new Set(["assets", "attachments"]);
  // Live-project slugs only — must match adoptExternalNoteFile's resolution set.
  const existingSlugs = new Set(activeProjectsBySlug(db).keys());

  let created = 0;
  let hasLooseRootMd = false;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue; // .obsidian, .git, .trash, etc.
    const fp = path.join(root, entry);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fp);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      // Legacy `notes/` handling mirrors syncDir: only treat it as a project
      // folder when it's part of an Obsidian vault or has direct .md files.
      if (entry === "notes" && !isImportableNotesFolder(workspacePath)) continue;
      const slug = toSlug(entry);
      // Slug check BEFORE the (recursive) dirHasMarkdown walk: a folder that
      // already maps to a project must not pay for a full subtree scan on every
      // boot / file-add event.
      if (existingSlugs.has(slug)) continue;
      if (!dirHasMarkdown(fp)) continue; // empty of notes — not a project
      ensureProject(db, wsId, entry);
      existingSlugs.add(slug);
      created++;
    } else if (entry.endsWith(".md") && !entry.endsWith(".md.tmp")) {
      hasLooseRootMd = true;
    }
  }

  // Loose .md files directly in the vault root → catch-all project named after
  // the vault folder. Only create it if such files exist and no project already
  // claims the root slug. (If a top-level folder already slugs to the vault name,
  // its project owns the slug and the loose files fold into it — documented in
  // docs/obsidian-vaults.md.)
  if (hasLooseRootMd) {
    const vaultName = path.basename(root) || "Notes";
    const slug = toSlug(vaultName);
    if (!existingSlugs.has(slug)) {
      ensureProject(db, wsId, vaultName);
      existingSlugs.add(slug);
      created++;
    }
  }

  return created;
}

/** True if a root `notes/` folder should be scanned as a project (vault or has direct .md). */
function isImportableNotesFolder(workspacePath: string): boolean {
  if (fs.existsSync(path.join(workspacePath, ".obsidian"))) return true;
  const notesPath = path.join(workspacePath, "notes");
  try {
    return fs.readdirSync(notesPath).some(
      (e) => e.endsWith(".md") && fs.lstatSync(path.join(notesPath, e)).isFile(),
    );
  } catch {
    return false;
  }
}

/** Recursively test whether `dir` contains at least one `.md` file (ignoring dot-dirs). */
function dirHasMarkdown(dir: string): boolean {
  let items: string[];
  try {
    items = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const item of items) {
    if (item.startsWith(".")) continue;
    const fp = path.join(dir, item);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(fp);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (dirHasMarkdown(fp)) return true;
    } else if (item.endsWith(".md") && !item.endsWith(".md.tmp")) {
      return true;
    }
  }
  return false;
}

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
function cleanStaleTmpFiles(dir: string): void {
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

function syncDir(db: Database.Database, dir: string, workspacePath: string): void {
  // Known non-note directories to skip when scanning from workspace root
  const SKIP_DIRS = new Set(["assets", "attachments"]);

  for (const entry of fs.readdirSync(dir)) {
    // Skip dot-prefixed directories (.obsidian, .trash, .git, etc.)
    if (entry.startsWith(".")) continue;
    // Skip known infrastructure directories
    if (SKIP_DIRS.has(entry) && dir === workspacePath) continue;

    if (entry === "notes" && dir === workspacePath) {
      // If it's already an Obsidian vault (contains a .obsidian folder at root), do NOT skip notes/
      if (fs.existsSync(path.join(workspacePath, ".obsidian"))) {
        // Continue scanning notes/
      } else {
        // Skip only if it's a legacy notes/ directory (no direct .md files)
        const notesPath = path.join(workspacePath, "notes");
        try {
          const entries = fs.readdirSync(notesPath);
          const hasDirectMd = entries.some((e) => e.endsWith(".md") && fs.lstatSync(path.join(notesPath, e)).isFile());
          if (!hasDirectMd) {
            continue;
          }
        } catch {
          continue;
        }
      }
    }

    const fp = path.join(dir, entry);
    const stat = fs.lstatSync(fp);
    if (stat.isDirectory()) {
      syncDir(db, fp, workspacePath);
    } else if (entry.endsWith(".md")) {
      let note = parseNoteFile(fp);
      // Plain .md without Cairn frontmatter — adopt it in-place
      if (!note) note = adoptExternalNoteFile(db, workspacePath, fp);
      if (!note) continue;

      const row = db.prepare("SELECT updated_at FROM notes WHERE id = ?")
        .get(note.id) as { updated_at: string } | undefined;

      if (!row) {
        // Missing from SQLite — always import
        upsertNoteFromFile(db, note);
      } else {
        // Compare timestamps: import if file is demonstrably newer than DB row.
        // Primary: frontmatter updatedAt (written by Cairn on every save).
        const fileTs = new Date(note.updatedAt ?? note.createdAt).getTime();
        const dbTs   = new Date(row.updated_at).getTime();
        if (fileTs > dbTs) {
          upsertNoteFromFile(db, note);
        } else {
          // Fallback: if frontmatter timestamp didn't change (external editor
          // edited the body without touching frontmatter), use file mtime.
          // 2-second buffer avoids spurious overwrites from FS precision drift.
          const fileMtime = stat.mtimeMs;
          if (fileMtime > dbTs + 2000) {
            upsertNoteFromFile(db, note);
          }
        }
      }
    }
  }
}
// ── Upsert a parsed note into SQLite ──────────
//
// Uses INSERT OR IGNORE + UPDATE to avoid UNIQUE constraint errors when the
// file watcher fires on a file that was just written by the app itself.
// The SELECT+INSERT pattern had a race window; this is fully atomic.

/**
 * Attempt to adopt a plain .md file that was dropped into a project folder
 * from outside the app (no Cairn frontmatter).
 *
 * Resolves the project by matching the first path segment under `notes/` to a
 * project slug in the database. If a matching project is found, generates a new
 * note ID, writes Cairn frontmatter back to the file, then upserts into SQLite.
 *
 * Returns the adopted NoteData on success, or null if the file can't be adopted
 * (e.g. not inside a known project folder, or the file is unreadable).
 */
export function adoptExternalNoteFile(
  db: Database.Database,
  workspacePath: string,
  filePath: string,
): NoteData | null {
  try {
    const root = notesDir(workspacePath);
    const rel  = path.relative(root, filePath); // e.g. "my-project/sub/Note Title.md"
    const segments = rel.split(path.sep);
    if (segments.length < 1) return null;

    // A file directly in the vault root (segments === ["Note.md"]) has no owning
    // folder. It belongs to the catch-all project named after the vault folder
    // (created by importVaultProjects). Anything deeper is owned by its
    // top-level folder.
    const isRootFile = segments.length === 1;
    const projectSlug = isRootFile ? toSlug(path.basename(root) || "Notes") : segments[0];

    // Resolve the owning project via the SAME live-project slug map that
    // importVaultProjects uses — so a folder the import created (or skipped
    // because a live project already owns the slug) always resolves here, and
    // an ARCHIVED project's slug never shadows a real folder.
    const project = activeProjectsBySlug(db).get(projectSlug);
    if (!project) return null;

    // Read file content and any existing frontmatter (Obsidian fields, etc.)
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data: existingData, content } = matter(raw);

    // Title resolution: prefer existing frontmatter title (Obsidian convention),
    // then fall back to filename (strip .md extension).
    const filename = segments[segments.length - 1];
    const title = (typeof existingData.title === "string" && existingData.title.length > 0)
      ? existingData.title
      : path.basename(filename, ".md");

    // Derive subfolder from intermediate path segments (un-slugged as-is)
    const folderSegments = segments.slice(1, -1);
    const folder = folderSegments.join("/");

    const now  = new Date().toISOString();
    const id   = newId();

    // Resolve Obsidian tags → Cairn tag records
    let tagIds: string[] = [];
    if (Array.isArray(existingData.tags) && existingData.tags.length > 0) {
      tagIds = resolveObsidianTagsToCairn(db, project.workspace_id, existingData.tags as string[]);
    }

    const note: NoteData = {
      id,
      projectId:     project.id,
      workspaceId:   project.workspace_id,
      title,
      content,
      tagIds,
      linkedNoteIds: [],
      linkedCardIds: [],
      isPinned:      false,
      folder,
      createdAt:     now,
      updatedAt:     now,
      projectName:   project.name,
    };

    // Write Cairn frontmatter back IN-PLACE to the original file path.
    // We must NOT use writeNoteFile() here — that function resolves a new
    // slug-based path from the title, which would create a second file and
    // leave the original orphaned with no frontmatter.
    //
    // MERGE strategy: preserve all non-Cairn frontmatter keys (Obsidian
    // tags, aliases, cssclass, date, publish, custom properties, etc.)
    const existingExtra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(existingData)) {
      if (!CAIRN_FRONTMATTER_KEYS.has(key)) {
        existingExtra[key] = value;
      }
    }

    const cairnFields: Record<string, unknown> = {
      id,
      projectId:     project.id,
      workspaceId:   project.workspace_id,
      title,
      folder,
      tagIds,
      linkedNoteIds: [],
      linkedCardIds: [],
      isPinned:      false,
      createdAt:     now,
      updatedAt:     now,
    };

    // Non-Cairn keys first, then Cairn keys on top (Cairn always wins on conflict)
    const mergedFrontmatter = { ...existingExtra, ...cairnFields };
    fs.writeFileSync(filePath, matter.stringify(content, mergedFrontmatter), "utf-8");

    return note;
  } catch {
    return null;
  }
}

/**
 * Resolve Obsidian tag names to Cairn tag IDs.
 * Creates new tag records in the DB for any tag names that don't already exist.
 */
function resolveObsidianTagsToCairn(
  db: Database.Database,
  workspaceId: string,
  tagNames: string[],
): string[] {
  const resolvedIds: string[] = [];
  for (const rawName of tagNames) {
    const name = String(rawName).trim();
    if (!name) continue;
    const existing = db.prepare(
      "SELECT id FROM tags WHERE workspace_id = ? AND LOWER(name) = ?",
    ).get(workspaceId, name.toLowerCase()) as { id: string } | undefined;
    if (existing) {
      resolvedIds.push(existing.id);
    } else {
      const newTagId = newId();
      db.prepare(
        "INSERT INTO tags (id, workspace_id, name, color) VALUES (?, ?, ?, ?)",
      ).run(newTagId, workspaceId, name, "#6366f1");
      resolvedIds.push(newTagId);
    }
  }
  return resolvedIds;
}

export function upsertNoteFromFile(db: Database.Database, note: NoteData): void {
  // Only upsert if the referenced project exists
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(note.projectId);
  if (!project) return;

  const now = note.updatedAt ?? new Date().toISOString();
  const contentText = stripMarkdown(note.content);

  // INSERT OR IGNORE — no-op if the row already exists (avoids UNIQUE error)
  db.prepare(`
    INSERT OR IGNORE INTO notes
      (id, project_id, workspace_id, title, content, content_text,
       tag_ids, linked_note_ids, linked_card_ids, is_pinned, type,
       folder, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', 0, 'note', ?, ?, ?)
  `).run(
    note.id, note.projectId, note.workspaceId,
    note.title, note.content, contentText,
    JSON.stringify(note.tagIds ?? []),
    note.folder ?? "",
    note.createdAt ?? now, now,
  );

  // Always UPDATE — brings both new and existing rows up to date
  q.updateNote(db, note.id, {
    title: note.title,
    content: note.content,
    contentText,
    tagIds: note.tagIds,
    linkedNoteIds: note.linkedNoteIds,
    linkedCardIds: note.linkedCardIds,
    isPinned: note.isPinned,
    folder: note.folder,
    archivedAt: note.archivedAt,
  });
}


