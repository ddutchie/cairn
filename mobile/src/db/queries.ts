/**
 * Read-only queries for the mobile MVP screens.
 * All queries exclude tombstoned (deleted_at) and archived rows.
 */

import { getDb } from "./index";

export interface NoteRow {
  id: string;
  project_id: string;
  title: string;
  content: string | null;
  folder: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  icon: string | null;
}

export interface ColumnRow {
  id: string;
  project_id: string;
  name: string;
  order: number;
}

export interface CardRow {
  id: string;
  column_id: string;
  project_id: string;
  title: string;
  description: string | null;
  priority: string;
  order: number;
}

const LIVE = "deleted_at IS NULL AND archived_at IS NULL";

export function listProjects(): ProjectRow[] {
  return getDb().getAllSync<ProjectRow>(
    `SELECT id, name, icon FROM projects WHERE ${LIVE} ORDER BY name`,
  );
}

export function getProject(id: string): ProjectRow | null {
  return (
    getDb().getFirstSync<ProjectRow>(
      `SELECT id, name, icon FROM projects WHERE id = ? AND ${LIVE}`,
      id,
    ) ?? null
  );
}

/** Note + card counts per project, for the projects list. */
export interface ProjectSummary extends ProjectRow {
  noteCount: number;
  cardCount: number;
}

export function listProjectSummaries(): ProjectSummary[] {
  const db = getDb();
  const projects = listProjects();
  return projects.map((p) => {
    const n = db.getFirstSync<{ c: number }>(
      `SELECT COUNT(*) c FROM notes WHERE ${LIVE} AND type='note' AND project_id = ?`,
      p.id,
    );
    const c = db.getFirstSync<{ c: number }>(
      `SELECT COUNT(*) c FROM task_cards WHERE ${LIVE} AND project_id = ?`,
      p.id,
    );
    return { ...p, noteCount: n?.c ?? 0, cardCount: c?.c ?? 0 };
  });
}

/** Distinct folders within a project (empty string = project root). */
export function listFolders(projectId: string): string[] {
  const rows = getDb().getAllSync<{ folder: string }>(
    `SELECT DISTINCT folder FROM notes WHERE ${LIVE} AND type='note' AND project_id = ? ORDER BY folder`,
    projectId,
  );
  return rows.map((r) => r.folder ?? "");
}

export function listNotes(projectId?: string): NoteRow[] {
  const db = getDb();
  if (projectId) {
    return db.getAllSync<NoteRow>(
      `SELECT id, project_id, title, content, folder, updated_at FROM notes
       WHERE ${LIVE} AND type = 'note' AND project_id = ? ORDER BY updated_at DESC`,
      projectId,
    );
  }
  return db.getAllSync<NoteRow>(
    `SELECT id, project_id, title, content, folder, updated_at FROM notes
     WHERE ${LIVE} AND type = 'note' ORDER BY updated_at DESC`,
  );
}

export function getNote(id: string): NoteRow | null {
  return (
    getDb().getFirstSync<NoteRow>(
      `SELECT id, project_id, title, content, folder, updated_at FROM notes WHERE id = ?`,
      id,
    ) ?? null
  );
}

export function listColumns(projectId: string): ColumnRow[] {
  return getDb().getAllSync<ColumnRow>(
    `SELECT id, project_id, name, "order" FROM board_columns
     WHERE deleted_at IS NULL AND project_id = ? ORDER BY "order"`,
    projectId,
  );
}

export function listCards(projectId: string): CardRow[] {
  return getDb().getAllSync<CardRow>(
    `SELECT id, column_id, project_id, title, description, priority, "order" FROM task_cards
     WHERE ${LIVE} AND project_id = ? ORDER BY "order"`,
    projectId,
  );
}

export function searchNotes(query: string): NoteRow[] {
  const q = `%${query}%`;
  return getDb().getAllSync<NoteRow>(
    `SELECT id, project_id, title, content, folder, updated_at FROM notes
     WHERE ${LIVE} AND type = 'note' AND (title LIKE ? OR content_text LIKE ?)
     ORDER BY updated_at DESC LIMIT 50`,
    q,
    q,
  );
}

/**
 * Update a note's title/body locally. A plain UPDATE so the capture triggers
 * stage the change into sync_pending; syncNow() drains + publishes it.
 * content_text is kept as a plain-text mirror for search (matches desktop).
 */
export function updateNote(id: string, title: string, content: string): void {
  const now = new Date().toISOString();
  const contentText = content.replace(/[#*_`>[\]()!-]/g, "").replace(/\s+/g, " ").trim();
  getDb().runSync(
    `UPDATE notes SET title = ?, content = ?, content_text = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
    title,
    content,
    contentText,
    now,
    id,
  );
}
