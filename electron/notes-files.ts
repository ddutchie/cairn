/**
 * Cairn — Note file I/O
 *
 * Writes notes as Markdown files with YAML frontmatter inside the workspace
 * folder. The directory structure is:
 *
 *   <workspacePath>/
 *     notes/
 *       <project-slug>/
 *         <Note Title>.md                    (root — no folder)
 *         <folder-segment>/
 *           <sub-segment>/
 *             <Note Title>.md               (in subfolder)
 *
 * The note `id` lives in the YAML frontmatter as the stable identifier.
 * Filenames are human-readable slugs derived from the title.
 * The `folder` frontmatter field stores the original (unslugged) path, e.g.
 * "Design/Typography", so the tree view can restore it exactly.
 *
 * Frontmatter fields:
 *   id, projectId, workspaceId, title, folder, tagIds, linkedNoteIds,
 *   linkedCardIds, isPinned, createdAt, updatedAt, archivedAt
 *
 * The markdown body (below the frontmatter) is the note content.
 */

import path from "path";
import fs from "fs";
import matter from "gray-matter";
import type Database from "better-sqlite3";
import * as q from "./db/queries";
import { generateId } from "./db/queries";
import { toSlug, stripMarkdown } from "./shared/text-utils";

export { toSlug, stripMarkdown };

// ── Cairn-owned frontmatter keys ──────────────
// Only these keys are managed by Cairn. All other frontmatter fields
// (Obsidian tags, aliases, cssclass, date, publish, etc.) are preserved
// on every write cycle.

const CAIRN_FRONTMATTER_KEYS = new Set([
  "id", "projectId", "workspaceId", "title", "folder",
  "tagIds", "linkedNoteIds", "linkedCardIds",
  "isPinned", "createdAt", "updatedAt", "archivedAt",
]);

/**
 * Read the existing frontmatter from a file on disk, returning all
 * non-Cairn keys as a record. Returns {} if the file doesn't exist,
 * has no frontmatter, or is unreadable.
 */
export function readExistingFrontmatter(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const { data } = matter(fs.readFileSync(filePath, "utf-8"));
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!CAIRN_FRONTMATTER_KEYS.has(key)) {
        extra[key] = value;
      }
    }
    return extra;
  } catch {
    return {};
  }
}

// ── Path helpers ──────────────────────────────
// Notes live directly at <workspace>/<project-slug>/ (no intermediate `notes/` dir).
// This matches Obsidian's vault layout where top-level folders are projects.

export function notesDir(workspacePath: string): string {
  return workspacePath;
}

export function projectNotesDir(workspacePath: string, projectName: string): string {
  return path.join(workspacePath, toSlug(projectName));
}

/**
 * Returns the directory where a note with the given folder lives.
 * folder = ""           → <project-slug>/
 * folder = "A/B"        → <project-slug>/a/b/
 */
export function noteDir(workspacePath: string, projectName: string, folder: string): string {
  const base = projectNotesDir(workspacePath, projectName);
  if (!folder) return base;
  const segments = folder.split("/").filter(Boolean).map(toSlug);
  return path.join(base, ...segments);
}

/**
 * Resolve the file path for a note, given its title, project name, and folder.
 * If a file at <title>.md already exists with a *different* note ID in its
 * frontmatter, appends a short suffix to avoid collision:
 *   <title>-<shortId>.md
 */
export function resolveNoteFilePath(
  workspacePath: string,
  projectName: string,
  title: string,
  noteId: string,
  folder = "",
): string {
  const dir = noteDir(workspacePath, projectName, folder);
  const slug = toSlug(title);
  const candidate = path.join(dir, `${slug}.md`);

  if (!fs.existsSync(candidate)) return candidate;

  // File exists — check if it belongs to this note
  try {
    const { data } = matter(fs.readFileSync(candidate, "utf-8"));
    if (data.id === noteId) return candidate; // same note, reuse path
  } catch { /* unreadable — treat as collision */ }

  // Collision: append short ID suffix
  return path.join(dir, `${slug}-${noteId.slice(0, 6)}.md`);
}

/**
 * Find the current file path for a note by scanning the project folder
 * recursively for a file whose frontmatter `id` matches.
 * Returns null if not found.
 */
export function findNoteFilePath(
  workspacePath: string,
  projectName: string,
  noteId: string,
): string | null {
  const root = projectNotesDir(workspacePath, projectName);
  return findInDir(root, noteId);
}

function findInDir(dir: string, noteId: string): string | null {
  if (!fs.existsSync(dir)) return null;

  for (const entry of fs.readdirSync(dir)) {
    const fp = path.join(dir, entry);
    // Use lstatSync so symlinks are never followed — prevents infinite
    // recursion when a symlink inside the project folder points to an ancestor.
    const stat = fs.lstatSync(fp);
    if (stat.isDirectory()) {
      const found = findInDir(fp, noteId);
      if (found) return found;
    } else if (entry.endsWith(".md")) {
      try {
        const { data } = matter(fs.readFileSync(fp, "utf-8"));
        if (data.id === noteId) return fp;
      } catch { /* skip unreadable */ }
    }
  }
  return null;
}

// ── Serialise note → .md file ─────────────────

export interface NoteData {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  content: string;
  contentText?: string;
  tagIds: string[];
  linkedNoteIds: string[];
  linkedCardIds: string[];
  isPinned: boolean;
  folder?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** Resolved project name — used for folder naming */
  projectName?: string;
}

export function writeNoteFile(workspacePath: string, note: NoteData): void {
  const projectName = note.projectName ?? note.projectId;
  const folder = note.folder ?? "";
  const dir = noteDir(workspacePath, projectName, folder);
  fs.mkdirSync(dir, { recursive: true });

  // If the note already has a file on disk (possibly with an old title or folder),
  // remove it before writing the new one so we don't leave stale files.
  const existingPath = findNoteFilePath(workspacePath, projectName, note.id);
  const newPath = resolveNoteFilePath(workspacePath, projectName, note.title, note.id, folder);

  if (existingPath && existingPath !== newPath) {
    // Title or folder changed — delete old file after the new one is safely written
    // (handled below — unlink happens after the atomic rename succeeds).
  }

  // Read existing non-Cairn frontmatter (Obsidian tags, aliases, cssclass, etc.)
  // from the current file on disk so we can preserve it through the write cycle.
  const existingExtra = readExistingFrontmatter(existingPath ?? newPath);

  const cairnFields: Record<string, unknown> = {
    id: note.id,
    projectId: note.projectId,
    workspaceId: note.workspaceId,
    title: note.title,
    folder,
    tagIds: note.tagIds,
    linkedNoteIds: note.linkedNoteIds,
    linkedCardIds: note.linkedCardIds,
    isPinned: note.isPinned,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
  if (note.archivedAt) cairnFields.archivedAt = note.archivedAt;

  // Merge: non-Cairn keys first, then Cairn keys on top (Cairn always wins).
  const frontmatter: Record<string, unknown> = { ...existingExtra, ...cairnFields };

  // Atomic write: write to a .tmp file first, then rename into place.
  // fs.renameSync on the same filesystem is atomic at the VFS level, so a
  // crash between the SQLite UPDATE and this call leaves a stale .tmp (cleaned
  // up by syncNotesFromDisk on next startup) rather than a half-written .md.
  const tmpPath = newPath + ".tmp";
  fs.writeFileSync(tmpPath, matter.stringify(note.content ?? "", frontmatter), "utf-8");
  fs.renameSync(tmpPath, newPath);

  // Now safe to remove the old file (rename already succeeded)
  if (existingPath && existingPath !== newPath) {
    try { fs.unlinkSync(existingPath); } catch { /* ignore */ }
  }
}

export function deleteNoteFile(
  workspacePath: string,
  projectName: string,
  noteId: string,
): void {
  const fp = findNoteFilePath(workspacePath, projectName, noteId);
  if (fp) {
    try { fs.unlinkSync(fp); } catch { /* ignore */ }
  }
}

/**
 * Delete the entire project notes folder (and all .md files inside it).
 * Called when a project is deleted.
 */
export function deleteProjectNotesDir(
  workspacePath: string,
  projectName: string,
): void {
  const dir = projectNotesDir(workspacePath, projectName);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Parse .md file → note data ────────────────

export function parseNoteFile(filePath: string): NoteData | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);

    // A valid Cairn note file must have at minimum an id and projectId
    if (typeof data.id !== "string" || typeof data.projectId !== "string") {
      return null;
    }

    return {
      id: data.id as string,
      projectId: data.projectId as string,
      workspaceId: (data.workspaceId as string) ?? "",
      title: (data.title as string) ?? path.basename(filePath, ".md"),
      content: content ?? "",
      tagIds: Array.isArray(data.tagIds) ? (data.tagIds as string[]) : [],
      linkedNoteIds: Array.isArray(data.linkedNoteIds) ? (data.linkedNoteIds as string[]) : [],
      linkedCardIds: Array.isArray(data.linkedCardIds) ? (data.linkedCardIds as string[]) : [],
      isPinned: data.isPinned === true,
      folder: typeof data.folder === "string" ? data.folder : "",
      createdAt: (data.createdAt as string) ?? new Date().toISOString(),
      updatedAt: (data.updatedAt as string) ?? new Date().toISOString(),
      archivedAt: data.archivedAt as string | undefined,
    };
  } catch {
    return null;
  }
}

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

export function syncNotesFromDisk(db: Database.Database, workspacePath: string): void {
  const root = notesDir(workspacePath);
  if (!fs.existsSync(root)) return;
  cleanStaleTmpFiles(root);
  syncDir(db, root, workspacePath);
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

    const projectSlug = segments[0];

    // Find the project whose slug matches the folder name
    const projects = db.prepare(
      "SELECT id, name, workspace_id FROM projects WHERE archived_at IS NULL"
    ).all() as { id: string; name: string; workspace_id: string }[];

    const project = projects.find((p) => toSlug(p.name) === projectSlug);
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
    const id   = generateId();

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
      const newTagId = generateId();
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


