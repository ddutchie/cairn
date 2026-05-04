/**
 * Cairn — SQLite query helpers
 *
 * All reads return TypeScript domain types (from src/types/index.ts).
 * JSON columns are parsed on read and serialised on write.
 *
 * Naming: snake_case columns → camelCase fields in returned objects.
 */

import type Database from "better-sqlite3";
import { ts, newId } from "./utils";

/** Re-export for callers that only need a new ID without importing utils directly. */
export { newId as generateId };

// ── tiny helpers ──────────────────────────────

function j(v: unknown): string {
  return JSON.stringify(v ?? []);
}
function p(v: string | null | undefined): unknown[] {
  if (!v) return [];
  try { return JSON.parse(v); } catch { return []; }
}
function b(v: number | null | undefined): boolean {
  return v === 1;
}

// ── Row → domain type mappers ─────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toWorkspace(row: any) {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | undefined,
    icon: row.icon as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toProject(row: any) {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    description: row.description as string | undefined,
    icon: row.icon as string | undefined,
    status: row.status as string,
    priority: row.priority as string,
    dueDate: row.due_date as string | undefined,
    tagIds: p(row.tag_ids) as string[],
    codeDirectory: row.code_directory as string | null ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCodingAgent(row: any) {
  return {
    id: row.id as string,
    name: row.name as string,
    binaryPath: row.binary_path as string,
    args: row.args as string,
    isDefault: row.is_default === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toNote(row: any) {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string,
    content: (row.content ?? "") as string,
    contentText: (row.content_text ?? "") as string,
    tagIds: p(row.tag_ids) as string[],
    linkedNoteIds: p(row.linked_note_ids) as string[],
    linkedCardIds: p(row.linked_card_ids) as string[],
    isPinned: b(row.is_pinned),
    type: (row.type ?? "note") as "note" | "dashboard",
    folder: (row.folder ?? "") as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toColumn(row: any) {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    type: row.type as string,
    order: row.order as number,
    cardLimit: row.card_limit as number | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCard(row: any) {
  return {
    id: row.id as string,
    columnId: row.column_id as string,
    projectId: row.project_id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    tagIds: p(row.tag_ids) as string[],
    priority: row.priority as string,
    dueDate: row.due_date as string | undefined,
    linkedNoteIds: p(row.linked_note_ids) as string[],
    blockedByIds: p(row.blocked_by_ids) as string[],
    order: row.order as number,
    assignee: row.assignee as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: row.archived_at as string | undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTag(row: any) {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    color: row.color as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toChatThread(row: any) {
  return {
    id: row.id as string,
    scope: row.scope as string,
    workspaceId: row.workspace_id as string,
    projectId: row.project_id as string | undefined,
    title: row.title as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toChatMessage(row: any) {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    role: row.role as string,
    content: row.content as string,
    contextRefs: row.context_refs ? JSON.parse(row.context_refs) : undefined,
    createdAt: row.created_at as string,
  };
}

// ── Workspace ─────────────────────────────────

export function getAllWorkspaces(db: Database.Database) {
  return db.prepare("SELECT * FROM workspaces ORDER BY created_at").all().map(toWorkspace);
}

export function createWorkspace(db: Database.Database, ws: { id: string; name: string; description?: string; icon?: string }) {
  const now = ts();
  db.prepare(`
    INSERT INTO workspaces (id, name, description, icon, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ws.id, ws.name, ws.description ?? null, ws.icon ?? null, now, now);
  return toWorkspace(db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ws.id));
}

export function updateWorkspace(db: Database.Database, id: string, patch: { name?: string; description?: string; icon?: string }) {
  const now = ts();
  db.prepare(`
    UPDATE workspaces SET name = COALESCE(?, name), description = COALESCE(?, description),
    icon = COALESCE(?, icon), updated_at = ? WHERE id = ?
  `).run(patch.name ?? null, patch.description ?? null, patch.icon ?? null, now, id);
  return toWorkspace(db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id));
}

// ── Projects ──────────────────────────────────

export function getProjects(db: Database.Database, workspaceId?: string) {
  const rows = workspaceId
    ? db.prepare("SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at").all(workspaceId)
    : db.prepare("SELECT * FROM projects ORDER BY created_at").all();
  return rows.map(toProject);
}

export function createProject(db: Database.Database, p: {
  id: string; workspaceId: string; name: string;
  description?: string; icon?: string; status?: string; priority?: string;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO projects (id, workspace_id, name, description, icon, status, priority, tag_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
  `).run(p.id, p.workspaceId, p.name, p.description ?? null, p.icon ?? null,
         p.status ?? "active", p.priority ?? "medium", now, now);
  return toProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(p.id));
}

export function updateProject(db: Database.Database, id: string, patch: Partial<{
  name: string; description: string; icon: string; status: string;
  priority: string; dueDate: string; tagIds: string[]; archivedAt: string;
  codeDirectory: string | null;
}>) {
  const now = ts();
  // codeDirectory is nullable — use a sentinel to distinguish "not provided" from "set to null"
  const hasCodeDir = Object.prototype.hasOwnProperty.call(patch, "codeDirectory");
  db.prepare(`
    UPDATE projects SET
      name           = COALESCE(?, name),
      description    = COALESCE(?, description),
      icon           = COALESCE(?, icon),
      status         = COALESCE(?, status),
      priority       = COALESCE(?, priority),
      due_date       = COALESCE(?, due_date),
      tag_ids        = COALESCE(?, tag_ids),
      archived_at    = COALESCE(?, archived_at),
      code_directory = ${hasCodeDir ? "?" : "code_directory"},
      updated_at     = ?
    WHERE id = ?
  `).run(
    patch.name ?? null, patch.description ?? null, patch.icon ?? null,
    patch.status ?? null, patch.priority ?? null, patch.dueDate ?? null,
    patch.tagIds ? j(patch.tagIds) : null,
    patch.archivedAt ?? null,
    ...(hasCodeDir ? [patch.codeDirectory ?? null] : []),
    now, id,
  );
  return toProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id));
}

export function deleteProject(db: Database.Database, id: string) {
  // Cascade: delete cards, columns, notes (caller deletes .md files first)
  db.prepare("DELETE FROM task_cards WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM board_columns WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM notes WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export function getProjectById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  return row ? toProject(row) : null;
}

// ── Notes ─────────────────────────────────────

export function getNotes(db: Database.Database, projectId?: string) {
  const rows = projectId
    ? db.prepare("SELECT * FROM notes WHERE project_id = ? ORDER BY updated_at DESC").all(projectId)
    : db.prepare("SELECT * FROM notes ORDER BY updated_at DESC").all();
  return rows.map(toNote);
}

export function createNote(db: Database.Database, n: {
  id: string; projectId: string; workspaceId: string; title: string;
  content?: string; contentText?: string; type?: "note" | "dashboard";
  tagIds?: string[]; isPinned?: boolean; folder?: string;
}) {
  const now = ts();
  const content = n.content ?? "";
  const contentText = n.contentText ?? content;
  const type = n.type ?? "note";
  const tagIds = JSON.stringify(n.tagIds ?? []);
  const isPinned = n.isPinned ? 1 : 0;
  const folder = n.folder ?? "";
  db.prepare(`
    INSERT INTO notes (id, project_id, workspace_id, title, content, content_text,
      tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, folder, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?)
  `).run(n.id, n.projectId, n.workspaceId, n.title, content, contentText, tagIds, isPinned, type, folder, now, now);
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(n.id));
}

export function updateNote(db: Database.Database, id: string, patch: Partial<{
  title: string; content: string; contentText: string;
  tagIds: string[]; linkedNoteIds: string[]; linkedCardIds: string[];
  isPinned: boolean; archivedAt: string; type: "note" | "dashboard"; folder: string;
}>) {
  const now = ts();
  db.prepare(`
    UPDATE notes SET
      title           = COALESCE(?, title),
      content         = COALESCE(?, content),
      content_text    = COALESCE(?, content_text),
      tag_ids         = COALESCE(?, tag_ids),
      linked_note_ids = COALESCE(?, linked_note_ids),
      linked_card_ids = COALESCE(?, linked_card_ids),
      is_pinned       = COALESCE(?, is_pinned),
      archived_at     = COALESCE(?, archived_at),
      type            = COALESCE(?, type),
      folder          = COALESCE(?, folder),
      updated_at      = ?
    WHERE id = ?
  `).run(
    patch.title ?? null,
    patch.content !== undefined ? patch.content : null,
    patch.contentText !== undefined ? patch.contentText : null,
    patch.tagIds ? j(patch.tagIds) : null,
    patch.linkedNoteIds ? j(patch.linkedNoteIds) : null,
    patch.linkedCardIds ? j(patch.linkedCardIds) : null,
    patch.isPinned !== undefined ? (patch.isPinned ? 1 : 0) : null,
    patch.archivedAt ?? null,
    patch.type ?? null,
    patch.folder !== undefined ? patch.folder : null,
    now, id,
  );
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
}

export function deleteNote(db: Database.Database, id: string) {
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
}

export function getNoteById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  return row ? toNote(row) : null;
}

/**
 * Move a note to a different folder (or root when folder="").
 * Uses a direct SET rather than COALESCE so an empty string is not silently
 * ignored the way a NULL patch.folder would be in updateNote().
 */
export function moveNoteFolder(db: Database.Database, id: string, folder: string) {
  const now = ts();
  db.prepare("UPDATE notes SET folder = ?, updated_at = ? WHERE id = ?").run(folder, now, id);
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
}

/**
 * Explicitly clear archived_at for a note (cannot use COALESCE for NULL clears).
 */
export function restoreNote(db: Database.Database, id: string) {
  const now = ts();
  db.prepare("UPDATE notes SET archived_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
}

// ── Board Columns ─────────────────────────────

export function getColumns(db: Database.Database, projectId?: string) {
  const rows = projectId
    ? db.prepare(`SELECT * FROM board_columns WHERE project_id = ? ORDER BY "order"`).all(projectId)
    : db.prepare(`SELECT * FROM board_columns ORDER BY "order"`).all();
  return rows.map(toColumn);
}

export function createColumn(db: Database.Database, c: {
  id: string; projectId: string; workspaceId: string;
  name: string; type?: string; order?: number;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO board_columns (id, project_id, workspace_id, name, type, "order", created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c.id, c.projectId, c.workspaceId, c.name, c.type ?? "custom", c.order ?? 0, now, now);
  return toColumn(db.prepare("SELECT * FROM board_columns WHERE id = ?").get(c.id));
}

export function updateColumn(db: Database.Database, id: string, patch: Partial<{ name: string; order: number; cardLimit: number }>) {
  const now = ts();
  db.prepare(`
    UPDATE board_columns SET
      name       = COALESCE(?, name),
      "order"    = COALESCE(?, "order"),
      card_limit = COALESCE(?, card_limit),
      updated_at = ?
    WHERE id = ?
  `).run(patch.name ?? null, patch.order ?? null, patch.cardLimit ?? null, now, id);
  return toColumn(db.prepare("SELECT * FROM board_columns WHERE id = ?").get(id));
}

export function deleteColumn(db: Database.Database, id: string) {
  db.prepare("DELETE FROM task_cards WHERE column_id = ?").run(id);
  db.prepare("DELETE FROM board_columns WHERE id = ?").run(id);
}

// ── Task Cards ────────────────────────────────

export function getCards(db: Database.Database, opts?: { projectId?: string; columnId?: string }) {
  let rows;
  if (opts?.columnId) {
    rows = db.prepare(`SELECT * FROM task_cards WHERE column_id = ? ORDER BY "order"`).all(opts.columnId);
  } else if (opts?.projectId) {
    rows = db.prepare(`SELECT * FROM task_cards WHERE project_id = ? ORDER BY "order"`).all(opts.projectId);
  } else {
    rows = db.prepare(`SELECT * FROM task_cards ORDER BY "order"`).all();
  }
  return rows.map(toCard);
}

export function createCard(db: Database.Database, c: {
  id: string; columnId: string; projectId: string; workspaceId: string;
  title: string; description?: string; priority?: string; dueDate?: string;
  order?: number; tagIds?: string[]; assignee?: string;
}) {
  const now = ts();
  const tagIds = JSON.stringify(c.tagIds ?? []);
  db.prepare(`
    INSERT INTO task_cards
      (id, column_id, project_id, workspace_id, title, description, tag_ids,
       priority, due_date, linked_note_ids, blocked_by_ids, "order", assignee, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?)
  `).run(c.id, c.columnId, c.projectId, c.workspaceId, c.title,
         c.description ?? null, tagIds, c.priority ?? "medium", c.dueDate ?? null,
         c.order ?? 0, c.assignee ?? null, now, now);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(c.id));
}

export function updateCard(db: Database.Database, id: string, patch: Partial<{
  columnId: string; title: string; description: string; priority: string;
  dueDate: string; tagIds: string[]; linkedNoteIds: string[]; blockedByIds: string[];
  order: number; assignee: string; archivedAt: string;
}>) {
  const now = ts();
  db.prepare(`
    UPDATE task_cards SET
      column_id       = COALESCE(?, column_id),
      title           = COALESCE(?, title),
      description     = COALESCE(?, description),
      priority        = COALESCE(?, priority),
      due_date        = COALESCE(?, due_date),
      tag_ids         = COALESCE(?, tag_ids),
      linked_note_ids = COALESCE(?, linked_note_ids),
      blocked_by_ids  = COALESCE(?, blocked_by_ids),
      "order"         = COALESCE(?, "order"),
      assignee        = COALESCE(?, assignee),
      archived_at     = COALESCE(?, archived_at),
      updated_at      = ?
    WHERE id = ?
  `).run(
    patch.columnId ?? null, patch.title ?? null, patch.description ?? null,
    patch.priority ?? null, patch.dueDate ?? null,
    patch.tagIds ? j(patch.tagIds) : null,
    patch.linkedNoteIds ? j(patch.linkedNoteIds) : null,
    patch.blockedByIds ? j(patch.blockedByIds) : null,
    patch.order ?? null, patch.assignee ?? null, patch.archivedAt ?? null,
    now, id,
  );
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id));
}

export function deleteCard(db: Database.Database, id: string) {
  // Remove this card from any other card's blocked_by_ids before deleting
  const affected = db.prepare(
    "SELECT id, blocked_by_ids FROM task_cards WHERE blocked_by_ids != '[]' AND id != ?"
  ).all(id) as { id: string; blocked_by_ids: string }[];
  const now = ts();
  for (const row of affected) {
    const ids = p(row.blocked_by_ids) as string[];
    if (ids.includes(id)) {
      const updated = ids.filter((bid) => bid !== id);
      db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ? WHERE id = ?")
        .run(j(updated), now, row.id);
    }
  }
  db.prepare("DELETE FROM task_cards WHERE id = ?").run(id);
}

export function getCardById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id);
  return row ? toCard(row) : null;
}

/**
 * Explicitly clear archived_at for a card (cannot use COALESCE for NULL clears).
 */
export function restoreCard(db: Database.Database, id: string) {
  const now = ts();
  db.prepare("UPDATE task_cards SET archived_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id));
}

/**
 * Explicitly clear due_date for a card.
 */
export function clearCardDueDate(db: Database.Database, id: string) {
  const now = ts();
  db.prepare("UPDATE task_cards SET due_date = NULL, updated_at = ? WHERE id = ?").run(now, id);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id));
}

/**
 * Add a blocker to a card's blocked_by_ids. Caller must verify no circular dep first.
 */
export function addCardBlocker(db: Database.Database, cardId: string, blockerCardId: string) {
  const now = ts();
  const row = db.prepare("SELECT blocked_by_ids FROM task_cards WHERE id = ?").get(cardId) as { blocked_by_ids: string } | undefined;
  if (!row) throw new Error(`Card ${cardId} not found`);
  const ids = p(row.blocked_by_ids) as string[];
  if (!ids.includes(blockerCardId)) {
    ids.push(blockerCardId);
    db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ? WHERE id = ?").run(j(ids), now, cardId);
  }
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(cardId));
}

/**
 * Remove a blocker from a card's blocked_by_ids.
 */
export function removeCardBlocker(db: Database.Database, cardId: string, blockerCardId: string) {
  const now = ts();
  const row = db.prepare("SELECT blocked_by_ids FROM task_cards WHERE id = ?").get(cardId) as { blocked_by_ids: string } | undefined;
  if (!row) throw new Error(`Card ${cardId} not found`);
  const ids = (p(row.blocked_by_ids) as string[]).filter((id) => id !== blockerCardId);
  db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ? WHERE id = ?").run(j(ids), now, cardId);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(cardId));
}

/**
 * Return active, non-done cards that have no pending blockers.
 * A card is "ready" when:
 *   - Not archived
 *   - Not in a column with type = 'done'
 *   - Every entry in blocked_by_ids refers to a card that is archived OR in a done column
 */
export function getReadyCards(db: Database.Database, projectId?: string) {
  const whereProject = projectId ? "AND tc.project_id = ?" : "";
  const params: string[] = projectId ? [projectId] : [];

  // All active non-done cards
  const candidates = db.prepare(`
    SELECT tc.* FROM task_cards tc
    JOIN board_columns bc ON tc.column_id = bc.id
    WHERE tc.archived_at IS NULL
      AND bc.type != 'done'
      ${whereProject}
    ORDER BY tc."order"
  `).all(...params).map(toCard);

  if (candidates.length === 0) return [];

  // Build a lookup of all project cards for blocker resolution
  const allProjectIds = [...new Set(candidates.map((c) => c.projectId))];
  const allCards = allProjectIds.flatMap((pid) =>
    (db.prepare(`
      SELECT tc.*, bc.type as col_type FROM task_cards tc
      JOIN board_columns bc ON tc.column_id = bc.id
      WHERE tc.project_id = ?
    `).all(pid) as Array<{ id: string; archived_at: string | null; col_type: string }>)
  );
  const cardMap = new Map(allCards.map((c) => [c.id, c]));

  function isResolved(blockerId: string): boolean {
    const blocker = cardMap.get(blockerId);
    if (!blocker) return true; // orphaned blocker → treat as resolved
    return blocker.archived_at !== null || blocker.col_type === "done";
  }

  return candidates.filter((card) =>
    card.blockedByIds.length === 0 || card.blockedByIds.every(isResolved)
  );
}

// ── Tags ──────────────────────────────────────

export function getTags(db: Database.Database, workspaceId?: string) {
  const rows = workspaceId
    ? db.prepare("SELECT * FROM tags WHERE workspace_id = ?").all(workspaceId)
    : db.prepare("SELECT * FROM tags").all();
  return rows.map(toTag);
}

export function createTag(db: Database.Database, t: { id: string; workspaceId: string; name: string; color: string }) {
  db.prepare("INSERT INTO tags (id, workspace_id, name, color) VALUES (?, ?, ?, ?)").run(t.id, t.workspaceId, t.name, t.color);
  return toTag(db.prepare("SELECT * FROM tags WHERE id = ?").get(t.id));
}

export function updateTag(db: Database.Database, id: string, patch: { name?: string; color?: string }) {
  db.prepare("UPDATE tags SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?")
    .run(patch.name ?? null, patch.color ?? null, id);
  return toTag(db.prepare("SELECT * FROM tags WHERE id = ?").get(id));
}

export function deleteTag(db: Database.Database, id: string) {
  db.prepare("DELETE FROM tags WHERE id = ?").run(id);
}

// ── Chat ──────────────────────────────────────

export function getChatThreads(db: Database.Database, workspaceId: string) {
  return db.prepare("SELECT * FROM chat_threads WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId).map(toChatThread);
}

export function upsertChatThread(db: Database.Database, t: {
  id: string; scope: string; workspaceId: string; projectId?: string; title?: string;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO chat_threads (id, scope, workspace_id, project_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
  `).run(t.id, t.scope, t.workspaceId, t.projectId ?? null, t.title ?? null, now, now);
  return toChatThread(db.prepare("SELECT * FROM chat_threads WHERE id = ?").get(t.id));
}

export function deleteChatThread(db: Database.Database, threadId: string) {
  db.prepare("DELETE FROM chat_messages WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM chat_threads WHERE id = ?").run(threadId);
}

export function getChatMessages(db: Database.Database, threadId: string) {
  return db.prepare("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at").all(threadId).map(toChatMessage);
}

export function addChatMessage(db: Database.Database, m: {
  id: string; threadId: string; role: string; content: string; contextRefs?: unknown;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO chat_messages (id, thread_id, role, content, context_refs, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(m.id, m.threadId, m.role, m.content, m.contextRefs ? JSON.stringify(m.contextRefs) : null, now);
  return toChatMessage(db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(m.id));
}

// ── MCP Notifications ─────────────────────────

export interface McpNotification {
  id: string;
  tool: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMcpNotification(row: any): McpNotification {
  return {
    id: row.id as string,
    tool: row.tool as string,
    title: row.title as string,
    body: row.body as string,
    read: b(row.read),
    createdAt: row.created_at as string,
  };
}

export function getUnreadMcpNotifications(db: Database.Database): McpNotification[] {
  return db.prepare("SELECT * FROM mcp_notifications WHERE read = 0 ORDER BY created_at ASC").all().map(toMcpNotification);
}

export function markMcpNotificationsRead(db: Database.Database): void {
  db.prepare("UPDATE mcp_notifications SET read = 1 WHERE read = 0").run();
}

export function insertMcpNotification(db: Database.Database, n: { id: string; tool: string; title: string; body: string }): void {
  db.prepare("INSERT INTO mcp_notifications (id, tool, title, body, read, created_at) VALUES (?, ?, ?, ?, 0, ?)").run(n.id, n.tool, n.title, n.body, ts());
}

// ── Idea Flow ─────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIdeaFlow(row: any) {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIdeaFlowNode(row: any) {
  return {
    id: row.id as string,
    flowId: row.flow_id as string,
    type: row.type as string,
    x: row.x as number,
    y: row.y as number,
    width: row.width as number | undefined,
    height: row.height as number | undefined,
    parentId: row.parent_id as string | undefined,
    data: (() => { try { return JSON.parse(row.data); } catch { return {}; } })(),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIdeaFlowEdge(row: any) {
  return {
    id: row.id as string,
    flowId: row.flow_id as string,
    sourceNodeId: row.source_node_id as string,
    targetNodeId: row.target_node_id as string,
    label: row.label as string | undefined,
    createdAt: row.created_at as string,
  };
}

/** Get or lazily create the single IdeaFlow for a project. */
export function getOrCreateFlow(db: Database.Database, projectId: string) {
  const existing = db.prepare("SELECT * FROM idea_flows WHERE project_id = ?").get(projectId);
  if (existing) return toIdeaFlow(existing);
  const now = ts();
  const id = newId();
  db.prepare("INSERT INTO idea_flows (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, projectId, now, now);
  return toIdeaFlow(db.prepare("SELECT * FROM idea_flows WHERE id = ?").get(id));
}

export function getFlowNodes(db: Database.Database, flowId: string) {
  return db.prepare("SELECT * FROM idea_flow_nodes WHERE flow_id = ? ORDER BY created_at")
    .all(flowId).map(toIdeaFlowNode);
}

export function getFlowEdges(db: Database.Database, flowId: string) {
  return db.prepare("SELECT * FROM idea_flow_edges WHERE flow_id = ? ORDER BY created_at")
    .all(flowId).map(toIdeaFlowEdge);
}

export function createFlowNode(db: Database.Database, n: {
  id: string; flowId: string; type: string;
  x: number; y: number; width?: number; height?: number;
  parentId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO idea_flow_nodes (id, flow_id, type, x, y, width, height, parent_id, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(n.id, n.flowId, n.type, n.x, n.y, n.width ?? null, n.height ?? null, n.parentId ?? null, JSON.stringify(n.data), now, now);
  return toIdeaFlowNode(db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(n.id));
}

export function updateFlowNode(db: Database.Database, id: string, patch: Partial<{
  x: number; y: number; width: number; height: number;
  parentId: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}>) {
  const now = ts();
  const existing = db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(id);
  if (!existing) throw new Error(`Flow node not found: ${id}`);
  const node = toIdeaFlowNode(existing);
  const newData = patch.data !== undefined
    ? JSON.stringify({ ...node.data, ...patch.data })
    : JSON.stringify(node.data);

  // parentId: null means explicitly clear it; undefined means don't touch it
  const parentIdValue = patch.parentId === null ? null
    : patch.parentId !== undefined ? patch.parentId
    : node.parentId ?? null;

  db.prepare(`
    UPDATE idea_flow_nodes SET
      x          = COALESCE(?, x),
      y          = COALESCE(?, y),
      width      = COALESCE(?, width),
      height     = COALESCE(?, height),
      parent_id  = ?,
      data       = ?,
      updated_at = ?
    WHERE id = ?
  `).run(patch.x ?? null, patch.y ?? null, patch.width ?? null, patch.height ?? null, parentIdValue, newData, now, id);
  return toIdeaFlowNode(db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(id));
}

export function deleteFlowNode(db: Database.Database, id: string) {
  // Edges referencing this node are cascade-deleted via FK
  db.prepare("DELETE FROM idea_flow_nodes WHERE id = ?").run(id);
}

export function createFlowEdge(db: Database.Database, e: {
  id: string; flowId: string; sourceNodeId: string; targetNodeId: string; label?: string;
}) {
  const now = ts();
  db.prepare(`
    INSERT OR IGNORE INTO idea_flow_edges (id, flow_id, source_node_id, target_node_id, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(e.id, e.flowId, e.sourceNodeId, e.targetNodeId, e.label ?? null, now);
  return toIdeaFlowEdge(db.prepare("SELECT * FROM idea_flow_edges WHERE id = ?").get(e.id));
}

export function deleteFlowEdge(db: Database.Database, id: string) {
  db.prepare("DELETE FROM idea_flow_edges WHERE id = ?").run(id);
}

/**
 * Returns the full resolved graph for a project — ready for the renderer and AI/MCP.
 * note_ref and task_ref nodes have their linked entity's data merged in as resolved* fields.
 */
export function getResolvedFlow(db: Database.Database, projectId: string) {
  const flow = getOrCreateFlow(db, projectId);
  const nodes = getFlowNodes(db, flow.id);
  const edges = getFlowEdges(db, flow.id);

  // Build a map of group positions for absolute coord computation
  const groupPositions = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    if (n.type === "group") groupPositions.set(n.id, { x: n.x, y: n.y });
  }

  const resolved = nodes.map((node) => {
    // Compute absolute position — children store relative coords in DB
    const parent = node.parentId ? groupPositions.get(node.parentId) : undefined;
    const absoluteX = parent ? parent.x + node.x : node.x;
    const absoluteY = parent ? parent.y + node.y : node.y;

    let base = { ...node, absoluteX, absoluteY };

    if (node.type === "note_ref" && node.data.noteId) {
      const noteRow = db.prepare("SELECT id, title, content_text FROM notes WHERE id = ?").get(node.data.noteId) as
        | { id: string; title: string; content_text: string } | undefined;
      if (noteRow) {
        base = { ...base, resolvedTitle: noteRow.title, resolvedSnippet: noteRow.content_text?.slice(0, 200) ?? "" } as typeof base & { resolvedTitle: string; resolvedSnippet: string };
      }
    }
    if (node.type === "task_ref" && node.data.cardId) {
      const cardRow = db.prepare(`
        SELECT tc.id, tc.title, tc.priority, bc.name as column_name
        FROM task_cards tc
        LEFT JOIN board_columns bc ON tc.column_id = bc.id
        WHERE tc.id = ?
      `).get(node.data.cardId) as
        | { id: string; title: string; priority: string; column_name: string } | undefined;
      if (cardRow) {
        base = { ...base, resolvedTitle: cardRow.title, resolvedPriority: cardRow.priority, resolvedColumnName: cardRow.column_name } as typeof base & { resolvedTitle: string; resolvedPriority: string; resolvedColumnName: string };
      }
    }
    return base;
  });

  // Spatial summary uses absolute coordinates
  const contentNodes = resolved.filter((n) => n.type !== "group");
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of contentNodes) {
    const w = n.width ?? 220;
    const h = n.height ?? 80;
    minX = Math.min(minX, n.absoluteX);
    minY = Math.min(minY, n.absoluteY);
    maxX = Math.max(maxX, n.absoluteX + w);
    maxY = Math.max(maxY, n.absoluteY + h);
  }
  const hasNodes = contentNodes.length > 0;

  // Per-group free slots: 40px padding from group top-left, stacked below existing children
  const groups = resolved.filter((n) => n.type === "group");
  const groupSlots: Record<string, { x: number; y: number }> = {};
  for (const g of groups) {
    const children = resolved.filter((n) => n.parentId === g.id);
    if (children.length === 0) {
      groupSlots[g.id] = { x: 40, y: 40 }; // relative to group
    } else {
      let childMaxY = -Infinity;
      for (const c of children) {
        childMaxY = Math.max(childMaxY, c.y + (c.height ?? 80));
      }
      groupSlots[g.id] = { x: 40, y: Math.round(childMaxY + 20) };
    }
  }

  const spatial = {
    bounds: hasNodes ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null,
    nextPosition: hasNodes ? { x: Math.round(minX), y: Math.round(maxY + 120) } : { x: 40, y: 40 },
    // Per-group suggested positions (relative to group top-left)
    groupSlots,
  };

  return {
    flowId: flow.id,
    projectId,
    nodes: resolved,
    edges,
    spatial,
  };
}

// ── Full snapshot (for MCP / AI chat) ────────

export function getFullSnapshot(db: Database.Database) {
  return {
    workspaces: getAllWorkspaces(db),
    projects: getProjects(db),
    notes: getNotes(db),
    columns: getColumns(db),
    cards: getCards(db),
    tags: getTags(db),
  };
}

// ── Seed guard ────────────────────────────────

export function hasData(db: Database.Database): boolean {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM workspaces").get() as { cnt: number };
  return row.cnt > 0;
}

// ── Search ────────────────────────────────────

export interface SearchNotesOpts {
  query: string;
  projectId?: string;
  workspaceId?: string;
  limit?: number;
}

export interface SearchTasksOpts {
  query: string;
  projectId?: string;
  workspaceId?: string;
  limit?: number;
}

export function searchNotes(db: Database.Database, opts: SearchNotesOpts) {
  const q = opts.query.toLowerCase();
  const limit = opts.limit ?? 10;
  return db
    .prepare(
      `SELECT * FROM notes
       WHERE archived_at IS NULL
         AND (? IS NULL OR project_id = ?)
         AND (lower(title) LIKE ? OR lower(content_text) LIKE ?)
       LIMIT ?`
    )
    .all(opts.projectId ?? null, opts.projectId ?? null, `%${q}%`, `%${q}%`, limit)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((row) => toNote(row as any));
}

export function searchTasks(db: Database.Database, opts: SearchTasksOpts) {
  const q = opts.query.toLowerCase();
  const limit = opts.limit ?? 10;
  return db
    .prepare(
      `SELECT * FROM task_cards
       WHERE archived_at IS NULL
         AND (? IS NULL OR project_id = ?)
         AND (lower(title) LIKE ? OR lower(description) LIKE ?)
       LIMIT ?`
    )
    .all(opts.projectId ?? null, opts.projectId ?? null, `%${q}%`, `%${q}%`, limit)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((row) => toCard(row as any));
}

// ── Coding Agents ─────────────────────────────────────────────────────────────

export function getCodingAgents(db: Database.Database) {
  return (db.prepare("SELECT * FROM coding_agents ORDER BY created_at").all() as any[])
    .map(toCodingAgent);
}

export function getCodingAgentById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM coding_agents WHERE id = ?").get(id);
  return row ? toCodingAgent(row) : null;
}

export function saveCodingAgent(
  db: Database.Database,
  agent: { id: string; name: string; binaryPath: string; args: string; isDefault: boolean },
) {
  const now = ts();
  db.prepare(`
    INSERT INTO coding_agents (id, name, binary_path, args, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name        = excluded.name,
      binary_path = excluded.binary_path,
      args        = excluded.args,
      is_default  = excluded.is_default,
      updated_at  = excluded.updated_at
  `).run(agent.id, agent.name, agent.binaryPath, agent.args, agent.isDefault ? 1 : 0, now, now);
  return getCodingAgentById(db, agent.id)!;
}

export function setDefaultCodingAgent(db: Database.Database, id: string) {
  const setDefault = db.transaction(() => {
    db.prepare("UPDATE coding_agents SET is_default = 0, updated_at = ?").run(ts());
    db.prepare("UPDATE coding_agents SET is_default = 1, updated_at = ? WHERE id = ?").run(ts(), id);
  });
  setDefault();
}

export function deleteCodingAgent(db: Database.Database, id: string) {
  db.prepare("DELETE FROM coding_agents WHERE id = ?").run(id);
}

export function setProjectCodeDirectory(db: Database.Database, projectId: string, path: string | null) {
  db.prepare("UPDATE projects SET code_directory = ?, updated_at = ? WHERE id = ?")
    .run(path ?? null, ts(), projectId);
}
