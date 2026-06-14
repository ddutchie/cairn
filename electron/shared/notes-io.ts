/**
 * Cairn — Generic Note file I/O operations
 * Shared between the Electron process (notes-files.ts) and the MCP process (db.ts)
 * to avoid code duplication and format divergence.
 */

import path from "path";
import fs from "fs";
import matter from "gray-matter";
import { toSlug } from "./text-utils";

// ── Cairn-owned frontmatter keys ──────────────
// Only these keys are managed by Cairn. All other frontmatter fields
// (Obsidian tags, aliases, cssclass, date, publish, etc.) are preserved
// on every write cycle.
export const CAIRN_FRONTMATTER_KEYS = new Set([
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
    // Use lstatSync so symlinks are never followed
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

export interface NoteFileData {
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

export function writeNoteFile(workspacePath: string, note: NoteFileData): void {
  const projectName = note.projectName ?? note.projectId;
  const folder = note.folder ?? "";
  const dir = noteDir(workspacePath, projectName, folder);
  fs.mkdirSync(dir, { recursive: true });

  const existingPath = findNoteFilePath(workspacePath, projectName, note.id);
  const newPath = resolveNoteFilePath(workspacePath, projectName, note.title, note.id, folder);

  // Read existing non-Cairn frontmatter (Obsidian tags, aliases, cssclass, etc.)
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

export function parseNoteFile(filePath: string): NoteFileData | null {
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
