/**
 * Cairn — Note file I/O
 *
 * Writes notes as Markdown files with YAML frontmatter inside the workspace
 * folder. The directory structure is:
 *
 *   <workspacePath>/
 *     notes/
 *       <Project Name>/
 *         <Note Title>.md          (or <Note Title>-<shortId>.md on collision)
 *
 * The note `id` lives in the YAML frontmatter as the stable identifier.
 * Filenames are human-readable slugs derived from the title.
 *
 * Frontmatter fields:
 *   id, projectId, workspaceId, title, tagIds, linkedNoteIds,
 *   linkedCardIds, isPinned, createdAt, updatedAt, archivedAt
 *
 * The markdown body (below the frontmatter) is the note content.
 */

import path from "path";
import fs from "fs";
import matter from "gray-matter";
import type Database from "better-sqlite3";
import * as q from "./db/queries";
import { toSlug, stripMarkdown } from "./shared/text-utils";

export { toSlug, stripMarkdown };

// ── Path helpers ──────────────────────────────

export function notesDir(workspacePath: string): string {
  return path.join(workspacePath, "notes");
}

export function projectNotesDir(workspacePath: string, projectName: string): string {
  return path.join(notesDir(workspacePath), toSlug(projectName));
}

/**
 * Resolve the file path for a note, given its title and project name.
 * If a file at <title>.md already exists with a *different* note ID in its
 * frontmatter, appends a short suffix to avoid collision:
 *   <title>-<shortId>.md
 */
export function resolveNoteFilePath(
  workspacePath: string,
  projectName: string,
  title: string,
  noteId: string,
): string {
  const dir = projectNotesDir(workspacePath, projectName);
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
 * for a file whose frontmatter `id` matches. Returns null if not found.
 */
export function findNoteFilePath(
  workspacePath: string,
  projectName: string,
  noteId: string,
): string | null {
  const dir = projectNotesDir(workspacePath, projectName);
  if (!fs.existsSync(dir)) return null;

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const fp = path.join(dir, entry);
    try {
      const { data } = matter(fs.readFileSync(fp, "utf-8"));
      if (data.id === noteId) return fp;
    } catch { /* skip unreadable */ }
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
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** Resolved project name — used for folder naming */
  projectName?: string;
}

export function writeNoteFile(workspacePath: string, note: NoteData): void {
  const projectName = note.projectName ?? note.projectId;
  const dir = projectNotesDir(workspacePath, projectName);
  fs.mkdirSync(dir, { recursive: true });

  // If the note already has a file on disk (possibly with an old title),
  // remove it before writing the new one so we don't leave stale files.
  const existingPath = findNoteFilePath(workspacePath, projectName, note.id);
  const newPath = resolveNoteFilePath(workspacePath, projectName, note.title, note.id);

  if (existingPath && existingPath !== newPath) {
    // Title changed — delete old file, write new one
    try { fs.unlinkSync(existingPath); } catch { /* ignore */ }
  }

  const frontmatter: Record<string, unknown> = {
    id: note.id,
    projectId: note.projectId,
    workspaceId: note.workspaceId,
    title: note.title,
    tagIds: note.tagIds,
    linkedNoteIds: note.linkedNoteIds,
    linkedCardIds: note.linkedCardIds,
    isPinned: note.isPinned,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
  if (note.archivedAt) frontmatter.archivedAt = note.archivedAt;

  fs.writeFileSync(newPath, matter.stringify(note.content ?? "", frontmatter), "utf-8");
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
      createdAt: (data.createdAt as string) ?? new Date().toISOString(),
      updatedAt: (data.updatedAt as string) ?? new Date().toISOString(),
      archivedAt: data.archivedAt as string | undefined,
    };
  } catch {
    return null;
  }
}

// ── Upsert a parsed note into SQLite ──────────

export function upsertNoteFromFile(db: Database.Database, note: NoteData): void {
  const existing = db.prepare("SELECT id FROM notes WHERE id = ?").get(note.id);

  if (existing) {
    q.updateNote(db, note.id, {
      title: note.title,
      content: note.content,
      contentText: stripMarkdown(note.content),
      tagIds: note.tagIds,
      linkedNoteIds: note.linkedNoteIds,
      linkedCardIds: note.linkedCardIds,
      isPinned: note.isPinned,
      archivedAt: note.archivedAt,
    });
  } else {
    // Only insert if the referenced project exists
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(note.projectId);
    if (!project) return;

    q.createNote(db, {
      id: note.id,
      projectId: note.projectId,
      workspaceId: note.workspaceId,
      title: note.title,
      content: note.content,
      contentText: stripMarkdown(note.content),
    });

    q.updateNote(db, note.id, {
      tagIds: note.tagIds,
      linkedNoteIds: note.linkedNoteIds,
      linkedCardIds: note.linkedCardIds,
      isPinned: note.isPinned,
      archivedAt: note.archivedAt,
    });
  }
}


