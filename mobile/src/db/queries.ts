/**
 * Read-only queries for the mobile MVP screens.
 * All queries exclude tombstoned (deleted_at) and archived rows.
 */

import { getDb } from "./index";
import { inspectConflict, cleanConflictTitle } from "@cairn/shared/sync/conflict";

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
  tag_ids: string;
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
  tag_ids: string;
  order: number;
}

export interface TagRow {
  id: string;
  name: string;
  color: string;
}

/** Parse a JSON `tag_ids` column into an id array (tolerant of bad data). */
function parseIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Resolve an array of tag ids to full tag rows (name + colour), skipping unknowns. */
export function tagsForIds(tagIds: string[]): TagRow[] {
  if (tagIds.length === 0) return [];
  const db = getDb();
  const placeholders = tagIds.map(() => "?").join(",");
  const rows = db.getAllSync<TagRow>(
    `SELECT id, name, color FROM tags WHERE deleted_at IS NULL AND id IN (${placeholders})`,
    ...(tagIds as never[]),
  );
  // Preserve the stored order.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return tagIds.map((id) => byId.get(id)).filter((r): r is TagRow => !!r);
}

/** Tags attached to a note, resolved from its tag_ids JSON. */
export function tagsForNote(note: { tag_ids: string }): TagRow[] {
  return tagsForIds(parseIds(note.tag_ids));
}

/** Tags attached to a card, resolved from its tag_ids JSON. */
export function tagsForCard(card: { tag_ids: string }): TagRow[] {
  return tagsForIds(parseIds(card.tag_ids));
}

const LIVE = "deleted_at IS NULL AND archived_at IS NULL";

/**
 * SQL fragment excluding conflict-copy note rows (id like `..._conflict_...`).
 * Conflict copies are surfaced separately via listConflictCopies() so they
 * don't clutter the normal note lists / counts.
 */
const NOT_CONFLICT = `id NOT LIKE '%\\_conflict\\_%' ESCAPE '\\'`;

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
      `SELECT COUNT(*) c FROM notes WHERE ${LIVE} AND type='note' AND ${NOT_CONFLICT} AND project_id = ?`,
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
      `SELECT id, project_id, title, content, folder, tag_ids, updated_at FROM notes
       WHERE ${LIVE} AND type = 'note' AND ${NOT_CONFLICT} AND project_id = ? ORDER BY updated_at DESC`,
      projectId,
    );
  }
  return db.getAllSync<NoteRow>(
    `SELECT id, project_id, title, content, folder, tag_ids, updated_at FROM notes
     WHERE ${LIVE} AND type = 'note' AND ${NOT_CONFLICT} ORDER BY updated_at DESC`,
  );
}

export function getNote(id: string): NoteRow | null {
  return (
    getDb().getFirstSync<NoteRow>(
      `SELECT id, project_id, title, content, folder, tag_ids, updated_at FROM notes WHERE id = ?`,
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
    `SELECT id, column_id, project_id, title, description, priority, tag_ids, "order" FROM task_cards
     WHERE ${LIVE} AND project_id = ? ORDER BY "order"`,
    projectId,
  );
}

/** Get a single card by id (for the card detail screen). */
export function getCard(id: string): CardRow | null {
  return (
    getDb().getFirstSync<CardRow>(
      `SELECT id, column_id, project_id, title, description, priority, tag_ids, "order" FROM task_cards WHERE id = ?`,
      id,
    ) ?? null
  );
}

export function searchNotes(query: string): NoteRow[] {
  const q = `%${query}%`;
  return getDb().getAllSync<NoteRow>(
    `SELECT id, project_id, title, content, folder, tag_ids, updated_at FROM notes
     WHERE ${LIVE} AND type = 'note' AND ${NOT_CONFLICT} AND (title LIKE ? OR content_text LIKE ?)
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
      `SELECT id, project_id, title, content, folder, tag_ids, updated_at FROM notes
       WHERE ${LIVE} AND type='note' AND project_id = ? AND title = ? LIMIT 1`,
      projectId,
      title,
    ) ?? null
  );
}

/** Resolve a note id by title across the whole workspace (case-insensitive) — for wikilinks. */
export function findNoteIdByTitle(title: string): string | null {
  const row = getDb().getFirstSync<{ id: string }>(
    `SELECT id FROM notes WHERE ${LIVE} AND type='note' AND lower(title) = lower(?) LIMIT 1`,
    title,
  );
  return row?.id ?? null;
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
    `SELECT id, project_id, title, content, folder, tag_ids, updated_at, is_pinned FROM notes
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
    `SELECT id, column_id, project_id, title, description, priority, tag_ids, "order", due_date, updated_at FROM task_cards
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

// ── Conflict copies ─────────────────────────────────────────────────────────

export interface ConflictCopy {
  /** The conflict-copy row id. */
  id: string;
  /** Clean title (suffix stripped). */
  title: string;
  content: string | null;
  projectId: string;
  folder: string;
  updatedAt: string;
  /** The device that produced the copy. */
  deviceId: string | null;
  /** The id of the original note this conflicts with (may be missing if deleted). */
  originalId: string | null;
  /** The current live original note (null if it was deleted). */
  original: NoteRow | null;
}

/**
 * All conflict-copy notes (body diverged during offline edits and were kept
 * rather than lost). Surfaced in the Conflicts UI for manual resolution.
 */
export function listConflictCopies(): ConflictCopy[] {
  const db = getDb();
  const rows = db.getAllSync<NoteRow>(
    `SELECT id, project_id, title, content, folder, tag_ids, updated_at FROM notes
     WHERE ${LIVE} AND type = 'note' AND id LIKE '%\\_conflict\\_%' ESCAPE '\\'
     ORDER BY updated_at DESC`,
  );
  return rows.map((r) => {
    const info = inspectConflict(r.id, r.title);
    return {
      id: r.id,
      title: cleanConflictTitle(r.title),
      content: r.content,
      projectId: r.project_id,
      folder: r.folder,
      updatedAt: r.updated_at,
      deviceId: info.deviceId,
      originalId: info.originalId,
      original: info.originalId ? getNote(info.originalId) : null,
    };
  });
}

/** Count of unresolved conflict copies — for the header badge. */
export function conflictCount(): number {
  const row = getDb().getFirstSync<{ c: number }>(
    `SELECT COUNT(*) c FROM notes
     WHERE ${LIVE} AND type = 'note' AND id LIKE '%\\_conflict\\_%' ESCAPE '\\'`,
  );
  return row?.c ?? 0;
}

/**
 * Resolve a conflict by keeping the CONFLICT-COPY's body: overwrite the
 * original note with the copy's content, then delete the copy. If the original
 * no longer exists, the copy is simply promoted (renamed to its clean title).
 * Plain writes so the capture triggers publish the resolution to peers.
 */
export function resolveConflictKeepCopy(copyId: string): void {
  const copy = getNote(copyId);
  if (!copy) return;
  const info = inspectConflict(copy.id, copy.title);
  const cleanTitle = cleanConflictTitle(copy.title);
  const original = info.originalId ? getNote(info.originalId) : null;

  if (original && !isTombstoned(original.id)) {
    updateNote(original.id, cleanTitle, copy.content ?? "");
    softDeleteNote(copy.id);
  } else {
    // No live original — just strip the conflict suffix so the copy stands in.
    updateNote(copy.id, cleanTitle, copy.content ?? "");
  }
}

/**
 * Resolve a conflict by keeping the ORIGINAL note as-is and discarding the
 * conflict copy (soft delete → tombstone syncs to peers).
 */
export function resolveConflictKeepOriginal(copyId: string): void {
  softDeleteNote(copyId);
}

/** Soft-delete a note (tombstone) so the deletion propagates via sync. */
export function softDeleteNote(id: string): void {
  const now = new Date().toISOString();
  getDb().runSync(
    `UPDATE notes SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    now,
    now,
    id,
  );
}

function isTombstoned(id: string): boolean {
  const row = getDb().getFirstSync<{ deleted_at: string | null }>(
    `SELECT deleted_at FROM notes WHERE id = ?`,
    id,
  );
  return !row || row.deleted_at != null;
}
