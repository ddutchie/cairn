/**
 * Read-only queries for the mobile MVP screens.
 * All queries exclude tombstoned (deleted_at) and archived rows.
 */

import { getDb } from "./index";

/** Client-generated collision-free id (mirrors desktop nanoid(12) scheme). */
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
function genId(len = 12): string {
  let out = "";
  for (let i = 0; i < len; i++) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return out;
}

/** The workspace id for a project (AI writes inherit the project's workspace). */
function workspaceIdForProject(projectId: string): string {
  const row = getDb().getFirstSync<{ workspace_id: string }>(
    "SELECT workspace_id FROM projects WHERE id = ?",
    projectId,
  );
  return row?.workspace_id ?? "";
}

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
 * Move a card to a different column. Plain UPDATE so capture triggers stage it
 * for sync. Mirrors the desktop moveCard's column change (order left as-is).
 */
export function moveCardToColumn(cardId: string, columnId: string): void {
  const now = new Date().toISOString();
  getDb().runSync(
    `UPDATE task_cards SET column_id = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    columnId,
    now,
    cardId,
  );
}

function plainText(md: string): string {
  return md.replace(/[#*_`>[\]()!-]/g, "").replace(/\s+/g, " ").trim();
}

/** Find a note by exact title within a project (for ensure_note upsert). */
export function findNoteByTitle(projectId: string, title: string): NoteRow | null {
  return (
    getDb().getFirstSync<NoteRow>(
      `SELECT id, project_id, title, content, folder, updated_at FROM notes
       WHERE ${LIVE} AND type='note' AND project_id = ? AND title = ? LIMIT 1`,
      projectId,
      title,
    ) ?? null
  );
}

/** Create a note. Returns its id. Plain INSERT so capture triggers stage it. */
export function createNote(projectId: string, title: string, content: string, folder = ""): string {
  const id = genId();
  const now = new Date().toISOString();
  getDb().runSync(
    `INSERT INTO notes (id, project_id, workspace_id, title, content, content_text, folder, type, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'note', ?, ?, 0)`,
    id,
    projectId,
    workspaceIdForProject(projectId),
    title,
    content,
    plainText(content),
    folder,
    now,
    now,
  );
  return id;
}

/** Create-or-update a note by title within a project. Returns its id. */
export function ensureNote(projectId: string, title: string, content: string, folder = ""): string {
  const existing = findNoteByTitle(projectId, title);
  if (existing) {
    updateNote(existing.id, title, content);
    return existing.id;
  }
  return createNote(projectId, title, content, folder);
}

/** Append text to a note's body. */
export function appendToNote(noteId: string, text: string): boolean {
  const note = getNote(noteId);
  if (!note) return false;
  const next = `${note.content ?? ""}${note.content ? "\n\n" : ""}${text}`;
  updateNote(noteId, note.title, next);
  return true;
}

/** Replace an exact substring in a note's body. Returns false if not found. */
export function patchNote(noteId: string, oldString: string, newString: string): boolean {
  const note = getNote(noteId);
  if (!note || !note.content || !note.content.includes(oldString)) return false;
  updateNote(noteId, note.title, note.content.replace(oldString, newString));
  return true;
}

/** Create a task card in a column. Returns its id. */
export function createTask(projectId: string, columnId: string, title: string, opts?: { description?: string; priority?: string }): string {
  const id = genId();
  const now = new Date().toISOString();
  getDb().runSync(
    `INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, description, priority, "order", created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)`,
    id,
    columnId,
    projectId,
    workspaceIdForProject(projectId),
    title,
    opts?.description ?? null,
    opts?.priority ?? "medium",
    now,
    now,
  );
  return id;
}

/** Update a task card's fields (title/description/priority). */
export function updateTask(cardId: string, patch: { title?: string; description?: string; priority?: string }): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined) { sets.push("title = ?"); vals.push(patch.title); }
  if (patch.description !== undefined) { sets.push("description = ?"); vals.push(patch.description); }
  if (patch.priority !== undefined) { sets.push("priority = ?"); vals.push(patch.priority); }
  if (sets.length === 0) return;
  sets.push("updated_at = ?"); vals.push(new Date().toISOString());
  sets.push("version = version + 1");
  vals.push(cardId);
  getDb().runSync(`UPDATE task_cards SET ${sets.join(", ")} WHERE id = ?`, ...(vals as never[]));
}

// ── Aggregate context tools (mirror desktop read-tools-pure) ────────────────

/**
 * Workspace orientation — projects (with their columns) + tags. Mirrors the
 * desktop get_cairn_context so the agent can get IDs + structure in one call.
 */
export function getCairnContext(): unknown {
  const db = getDb();
  const projects = db.getAllSync<{ id: string; name: string; icon: string | null }>(
    `SELECT id, name, icon FROM projects WHERE ${LIVE} ORDER BY name`,
  );
  const tags = db.getAllSync<{ id: string; name: string; color: string }>(
    "SELECT id, name, color FROM tags WHERE deleted_at IS NULL ORDER BY name",
  );
  return {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      columns: db.getAllSync<{ id: string; name: string; type: string }>(
        `SELECT id, name, type FROM board_columns WHERE deleted_at IS NULL AND project_id = ? ORDER BY "order"`,
        p.id,
      ),
    })),
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
  };
}

/**
 * Rich single-call project summary — project + columns, noteCount, pinned notes
 * (with truncated content), open tasks grouped by column, recent activity.
 * Mirrors the desktop get_project_context_pack so the mobile agent can produce
 * an equally rich project summary.
 */
export function getProjectContextPack(projectId: string): unknown {
  const db = getDb();
  const project = db.getFirstSync<{ id: string; name: string; description: string | null; status: string; priority: string; due_date: string | null }>(
    `SELECT id, name, description, status, priority, due_date FROM projects WHERE id = ? AND ${LIVE}`,
    projectId,
  );
  if (!project) return { error: "Project not found" };

  const columns = db.getAllSync<{ id: string; name: string; type: string }>(
    `SELECT id, name, type FROM board_columns WHERE deleted_at IS NULL AND project_id = ? ORDER BY "order"`,
    projectId,
  );

  const notes = db.getAllSync<NoteRow & { is_pinned: number }>(
    `SELECT id, project_id, title, content, folder, updated_at, is_pinned FROM notes
     WHERE ${LIVE} AND type='note' AND project_id = ? ORDER BY updated_at DESC`,
    projectId,
  );

  const pinnedNotes = notes
    .filter((n) => n.is_pinned)
    .map((n) => {
      const content = n.content ?? "";
      const truncated = content.length > 1000 ? content.slice(0, 1000) + "\n\n... (truncated, use get_note)" : content;
      return { id: n.id, title: n.title, folder: n.folder ?? "", content: truncated };
    });

  const cards = db.getAllSync<CardRow & { due_date: string | null; updated_at: string }>(
    `SELECT id, column_id, project_id, title, description, priority, "order", due_date, updated_at FROM task_cards
     WHERE ${LIVE} AND project_id = ?`,
    projectId,
  );

  const openTasks = columns
    .filter((c) => c.type !== "done")
    .map((col) => ({
      columnType: col.type,
      columnId: col.id,
      tasks: cards
        .filter((c) => c.column_id === col.id)
        .map((c) => {
          const desc = c.description ?? "";
          const t: Record<string, unknown> = { id: c.id, title: c.title, priority: c.priority };
          if (desc) t.description = desc.length > 400 ? desc.slice(0, 400) + "\n... (truncated, use get_note)" : desc;
          if (c.due_date) t.dueDate = c.due_date;
          return t;
        }),
    }))
    .filter((col) => col.tasks.length > 0);

  const recentActivity = [
    ...notes.map((n) => ({ type: "note" as const, id: n.id, title: n.title, updatedAt: n.updated_at })),
    ...cards.map((c) => ({ type: "card" as const, id: c.id, title: c.title, updatedAt: c.updated_at })),
  ]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 10)
    .map(({ type, id, title }) => ({ type, id, title }));

  const proj: Record<string, unknown> = { id: project.id, name: project.name };
  if (project.description) proj.description = project.description;
  if (project.status && project.status !== "active") proj.status = project.status;
  if (project.priority && project.priority !== "medium") proj.priority = project.priority;
  if (project.due_date) proj.dueDate = project.due_date;
  proj.columns = columns;

  return { project: proj, noteCount: notes.length, pinnedNotes, openTasks, recentActivity };
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
