/**
 * Cairn — SQLite query helpers (single source of truth for all SQL).
 *
 * All reads return TypeScript domain types (from src/types/index.ts).
 * JSON columns are parsed on read and serialised on write.
 *
 * Naming: snake_case columns → camelCase fields in returned objects.
 *
 * ── Governance ──────────────────────────────────────────────────────────────
 * This module is imported by BOTH the Electron main process and the esbuild-
 * bundled MCP server (see `electron/mcp/tools/codebase.ts`, `tags.ts`,
 * `projects.ts`, `notes.ts`, `tasks.ts`, `flow.ts`, `dashboards.ts`, `graph.ts`,
 * and `electron/mcp/db.ts`). It is safe to import from `mcp/tools/*` because the
 * only ABI-sensitive operation in better-sqlite3 is constructing the `Database`
 * instance — that happens once in `electron/mcp-server.ts:140`
 * (`new Database(dbPath, { nativeBinding: MCP_NATIVE_BINDING })`). All
 * `db.prepare(...).run(...)` calls here execute on that already-constructed
 * handle regardless of which TS file defines them.
 *
 * **Never** construct a `Database` instance in this file. The two bootstrap
 * sites are `electron/db/client.ts` (Electron ABI, `electron-native/<arch>/`)
 * and `electron/mcp-server.ts` (pkg Node 24 ABI, `pkg-native/<arch>/`). The
 * standalone `cairn-mcp` binary must run independently of the app (so agents
 * can read/write the workspace while Cairn is closed), which is why it ships
 * its own Node-ABI sqlite binary separate from the Electron one.
 *
 * For knowledge-graph traversal, see `electron/db/graph-queries.ts` which
 * exports `getKnowledgeGraph` and `getNeighbours` (also safe to import from
 * `mcp/tools/*` — see `electron/mcp/tools/graph.ts`).
 */

import type Database from "better-sqlite3";
import * as path from "path";
import { ts, newId } from "./utils";
import {
  j,
  p,
  toWorkspace,
  toProject,
  toCodingAgent,
  toMcpServer,
  toCustomService,
  toToolAttachment,
  toNote,
  toColumn,
  toCard,
  toTag,
  toChatThread,
  toChatMessage,
  toMcpNotification,
  toIdeaFlow,
  toIdeaFlowNode,
  toIdeaFlowEdge,
  type McpNotification
} from "../shared/db-mappers";

/** Re-export for callers that only need a new ID without importing utils directly. */
export { newId as generateId };

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
    INSERT INTO projects (id, workspace_id, name, description, icon, status, priority, tag_ids, project_settings, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '{}', ?, ?)
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

export function updateProjectSettings(db: Database.Database, projectId: string, patch: Record<string, unknown>) {
  const row = db.prepare("SELECT project_settings FROM projects WHERE id = ?").get(projectId) as { project_settings: string } | undefined;
  if (!row) return null;
  const existing: Record<string, unknown> = (() => {
    try { return JSON.parse(row.project_settings); } catch { return {}; }
  })();
  const merged = { ...existing, ...patch };
  for (const key of Object.keys(patch)) {
    if (patch[key] === null || patch[key] === undefined) {
      delete merged[key];
    }
  }
  const now = ts();
  db.prepare("UPDATE projects SET project_settings = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(merged), now, projectId,
  );
  return toProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId));
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
      tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, folder, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?, 0)
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
      updated_at      = ?,
      version         = version + 1
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

/**
 * Hard-delete a note. The row is physically removed (desktop live queries do
 * not filter tombstones, so a soft-delete would leak ghost notes into every
 * list/search). Delete-safety across sync is handled two ways:
 *   1. The AFTER DELETE capture trigger stages a `delete` op so peers tombstone.
 *   2. The .md file MUST be removed too (see callers), and the file-watcher
 *      records the id in a short-lived "recently deleted" set so a peer that
 *      re-materialises the orphan file on disk can't re-import it. See
 *      electron/file-watcher.ts suppressNextChange() (backed by suppressedNoteIds).
 */
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
  db.prepare("UPDATE notes SET folder = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(folder, now, id);
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
}

/**
 * Move a note to a different project (and its owning workspace).
 * Uses a direct SET rather than updateNote()'s COALESCE list, which has no
 * project_id/workspace_id columns at all — so a project move sent through
 * updateNote() was silently dropped, leaving the row (and its .md file) in the
 * old project and letting a DB refresh / file-watcher re-import / sync reconcile
 * resurface the note where it started. Callers must also move the .md file
 * (delete the old project's copy, write into the new one) — see the
 * db:note:moveToProject IPC handler.
 */
export function moveNoteToProject(db: Database.Database, id: string, projectId: string, workspaceId: string) {
  const now = ts();
  db.prepare(
    "UPDATE notes SET project_id = ?, workspace_id = ?, updated_at = ?, version = version + 1 WHERE id = ?",
  ).run(projectId, workspaceId, now, id);
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
}

/**
 * Explicitly clear archived_at for a note (cannot use COALESCE for NULL clears).
 */
export function restoreNote(db: Database.Database, id: string) {
  const now = ts();
  db.prepare("UPDATE notes SET archived_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(now, id);
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
  order: number; assignee: string | null; archivedAt: string;
}>) {
  const now = ts();
  // assignee uses CASE WHEN instead of COALESCE so it can be explicitly cleared to NULL.
  // Pass (1, null) when explicitly setting assignee; pass (0, null) when not touching it.
  const assigneeSentinel = "assignee" in patch ? 1 : 0;
  const assigneeValue    = "assignee" in patch ? (patch.assignee || null) : null;
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
      assignee        = CASE WHEN ? = 1 THEN ? ELSE assignee END,
      archived_at     = COALESCE(?, archived_at),
      updated_at      = ?,
      version         = version + 1
    WHERE id = ?
  `).run(
    patch.columnId ?? null, patch.title ?? null, patch.description ?? null,
    patch.priority ?? null, patch.dueDate ?? null,
    patch.tagIds ? j(patch.tagIds) : null,
    patch.linkedNoteIds ? j(patch.linkedNoteIds) : null,
    patch.blockedByIds ? j(patch.blockedByIds) : null,
    patch.order ?? null,
    assigneeSentinel, assigneeValue,
    patch.archivedAt ?? null,
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
      db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?")
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
  db.prepare("UPDATE task_cards SET archived_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(now, id);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id));
}

/**
 * Explicitly clear due_date for a card.
 */
export function clearCardDueDate(db: Database.Database, id: string) {
  const now = ts();
  db.prepare("UPDATE task_cards SET due_date = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(now, id);
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
    db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(j(ids), now, cardId);
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
  db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(j(ids), now, cardId);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(cardId));
}

/**
 * When a card (or a set of cards) moves to a done column, remove those card IDs
 * from every other task's blocked_by_ids so get_task no longer reports them as
 * pending blockers.
 */
export function clearBlockersFromAll(db: Database.Database, doneCardIds: string[]) {
  if (doneCardIds.length === 0) return;
  const now = ts();
  const affected = db.prepare(
    "SELECT id, blocked_by_ids FROM task_cards WHERE blocked_by_ids != '[]'"
  ).all() as { id: string; blocked_by_ids: string }[];
  for (const row of affected) {
    if (doneCardIds.includes(row.id)) continue; // skip the tasks we just moved
    const ids = p(row.blocked_by_ids) as string[];
    const cleaned = ids.filter((bid) => !doneCardIds.includes(bid));
    if (cleaned.length !== ids.length) {
      db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .run(j(cleaned), now, row.id);
    }
  }
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
  id: string; threadId: string; role: string; content: string; contextRefs?: unknown; toolCalls?: unknown; reasoning?: string;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO chat_messages (id, thread_id, role, content, context_refs, tool_calls, reasoning, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(m.id, m.threadId, m.role, m.content, m.contextRefs ? JSON.stringify(m.contextRefs) : null, m.toolCalls ? JSON.stringify(m.toolCalls) : null, m.reasoning ?? null, now);
  return toChatMessage(db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(m.id));
}

// ── MCP Notifications ─────────────────────────

export function getUnreadMcpNotifications(db: Database.Database): McpNotification[] {
  return db.prepare("SELECT * FROM mcp_notifications WHERE read = 0 ORDER BY created_at ASC").all().map(toMcpNotification);
}

export function markMcpNotificationsRead(db: Database.Database): void {
  db.prepare("UPDATE mcp_notifications SET read = 1 WHERE read = 0").run();
}

/**
 * Returns the set of note IDs currently being written by the MCP server process.
 * Used by mcp-poller to diff against the previous poll and fire aiWriteStarted/Ended events.
 * Returns an empty set if the table doesn't exist yet (e.g. pre-v11 DB).
 */
export function getActiveMcpWrites(db: Database.Database): Set<string> {
  try {
    const rows = db.prepare("SELECT note_id FROM mcp_active_writes").all() as { note_id: string }[];
    return new Set(rows.map((r) => r.note_id));
  } catch {
    return new Set();
  }
}

export function insertMcpNotification(db: Database.Database, n: { id: string; tool: string; title: string; body: string }): void {
  db.prepare("INSERT INTO mcp_notifications (id, tool, title, body, read, created_at) VALUES (?, ?, ?, ?, 0, ?)").run(n.id, n.tool, n.title, n.body, ts());
}

// ── Idea Flow ─────────────────────────────────

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
  return (db.prepare("SELECT * FROM coding_agents ORDER BY created_at").all() as unknown[])
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

// ── External Tools: MCP servers ───────────────────────────────────────────────

interface McpServerInput {
  id: string; workspaceId: string; name: string; description?: string;
  transport: "sse" | "http"; baseUrl: string; headers?: Record<string, string>;
  authMode?: "none" | "oauth"; oauthScope?: string;
  enabled: boolean; source: string; communityId?: string; version?: string;
  /** Raw (un-namespaced) tool names disabled for this server, workspace-wide. */
  disabledTools?: string[];
}

export function getMcpServers(db: Database.Database, workspaceId: string) {
  return (db.prepare("SELECT * FROM mcp_servers WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as unknown[])
    .map(toMcpServer);
}

export function getMcpServerById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id);
  return row ? toMcpServer(row) : null;
}

export function saveMcpServer(db: Database.Database, s: McpServerInput) {
  const now = ts();
  db.prepare(`
    INSERT INTO mcp_servers (id, workspace_id, name, description, transport, base_url, headers, auth_mode, oauth_scope, enabled, source, community_id, version, disabled_tools, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name        = excluded.name,
      description = excluded.description,
      transport   = excluded.transport,
      base_url    = excluded.base_url,
      headers     = excluded.headers,
      auth_mode   = excluded.auth_mode,
      oauth_scope = excluded.oauth_scope,
      enabled     = excluded.enabled,
      source      = excluded.source,
      community_id= excluded.community_id,
      version     = excluded.version,
      disabled_tools = excluded.disabled_tools,
      updated_at  = excluded.updated_at
  `).run(
    s.id, s.workspaceId, s.name, s.description ?? null, s.transport, s.baseUrl,
    j(s.headers ?? {}), s.authMode ?? "none", s.oauthScope ?? null,
    s.enabled ? 1 : 0, s.source, s.communityId ?? null, s.version ?? null,
    j(s.disabledTools ?? []), now, now,
  );
  return getMcpServerById(db, s.id)!;
}

export function deleteMcpServer(db: Database.Database, id: string) {
  db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  db.prepare("DELETE FROM tool_attachments WHERE tool_type = 'mcp' AND tool_id = ?").run(id);
}

// ── External Tools: custom HTTP services ──────────────────────────────────────

interface CustomServiceInput {
  id: string; workspaceId: string; name: string; description?: string;
  apiUrl: string; method: "GET" | "POST" | "PUT" | "DELETE"; headers?: Record<string, string>;
  toolDefinition: string; responseKeys?: string[]; apiKeyUrl?: string;
  enabled: boolean; source: string; communityId?: string; version?: string;
}

export function getCustomServices(db: Database.Database, workspaceId: string) {
  return (db.prepare("SELECT * FROM custom_services WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as unknown[])
    .map(toCustomService);
}

export function getCustomServiceById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM custom_services WHERE id = ?").get(id);
  return row ? toCustomService(row) : null;
}

export function saveCustomService(db: Database.Database, s: CustomServiceInput) {
  const now = ts();
  db.prepare(`
    INSERT INTO custom_services (id, workspace_id, name, description, api_url, method, headers, tool_definition, response_keys, api_key_url, enabled, source, community_id, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name            = excluded.name,
      description     = excluded.description,
      api_url         = excluded.api_url,
      method          = excluded.method,
      headers         = excluded.headers,
      tool_definition = excluded.tool_definition,
      response_keys   = excluded.response_keys,
      api_key_url     = excluded.api_key_url,
      enabled         = excluded.enabled,
      source          = excluded.source,
      community_id    = excluded.community_id,
      version         = excluded.version,
      updated_at      = excluded.updated_at
  `).run(
    s.id, s.workspaceId, s.name, s.description ?? null, s.apiUrl, s.method,
    j(s.headers ?? {}), s.toolDefinition, j(s.responseKeys ?? []), s.apiKeyUrl ?? null,
    s.enabled ? 1 : 0, s.source, s.communityId ?? null, s.version ?? null, now, now,
  );
  return getCustomServiceById(db, s.id)!;
}

export function deleteCustomService(db: Database.Database, id: string) {
  db.prepare("DELETE FROM custom_services WHERE id = ?").run(id);
  db.prepare("DELETE FROM tool_attachments WHERE tool_type = 'service' AND tool_id = ?").run(id);
}

// ── External Tools: per-project attachments ───────────────────────────────────

export function getToolAttachments(db: Database.Database, projectId: string) {
  return (db.prepare("SELECT * FROM tool_attachments WHERE project_id = ?").all(projectId) as unknown[])
    .map(toToolAttachment);
}

export function setToolAttachment(
  db: Database.Database,
  a: { projectId: string; toolType: "mcp" | "service"; toolId: string; enabled: boolean },
) {
  db.prepare(`
    INSERT INTO tool_attachments (project_id, tool_type, tool_id, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, tool_type, tool_id) DO UPDATE SET enabled = excluded.enabled
  `).run(a.projectId, a.toolType, a.toolId, a.enabled ? 1 : 0);
  return a;
}

export function clearToolAttachment(
  db: Database.Database,
  a: { projectId: string; toolType: "mcp" | "service"; toolId: string },
) {
  db.prepare("DELETE FROM tool_attachments WHERE project_id = ? AND tool_type = ? AND tool_id = ?")
    .run(a.projectId, a.toolType, a.toolId);
}

// ── Pi Agent Sessions ────────────────────────────────────────────────────────────────────

export interface PiSessionRow {
  id: string;
  projectId: string;
  taskTitle: string;
  taskId: string | null;
  cwd: string;
  mode: "plan" | "execute";
  planNoteId: string | null;
  status: "running" | "exited";
  spawnedAt: string;
  updatedAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPiSession(row: any): PiSessionRow {
  return {
    id:          row.id as string,
    projectId:   row.project_id as string,
    taskTitle:   row.task_title as string,
    taskId:      row.task_id as string | null,
    cwd:         row.cwd as string,
    mode:        (row.mode ?? "execute") as "plan" | "execute",
    planNoteId:  row.plan_note_id as string | null,
    status:      (row.status ?? "running") as "running" | "exited",
    spawnedAt:   row.spawned_at as string,
    updatedAt:   row.updated_at as string,
  };
}

export function createPiSession(
  db: Database.Database,
  session: { id: string; projectId: string; taskTitle: string; taskId?: string | null; cwd: string; mode: "plan" | "execute"; spawnedAt: string },
): PiSessionRow {
  const now = ts();
  db.prepare(`
    INSERT INTO pi_agent_sessions (id, project_id, task_title, task_id, cwd, mode, status, spawned_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(session.id, session.projectId, session.taskTitle, session.taskId ?? null, session.cwd, session.mode, session.spawnedAt, now);
  return getPiSessionById(db, session.id)!;
}

export function getPiSessionById(db: Database.Database, id: string): PiSessionRow | null {
  const row = db.prepare("SELECT * FROM pi_agent_sessions WHERE id = ?").get(id);
  return row ? toPiSession(row) : null;
}

export function getPiSessions(db: Database.Database, projectId: string): PiSessionRow[] {
  return (db.prepare("SELECT * FROM pi_agent_sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 50").all(projectId) as unknown[])
    .map(toPiSession);
}

export function updatePiSession(
  db: Database.Database,
  sessionId: string,
  patch: { mode?: "plan" | "execute"; planNoteId?: string | null; status?: "running" | "exited"; updatedAt?: string },
) {
  const now = patch.updatedAt ?? ts();
  if (patch.mode !== undefined) {
    db.prepare("UPDATE pi_agent_sessions SET mode = ?, updated_at = ? WHERE id = ?").run(patch.mode, now, sessionId);
  }
  if (patch.planNoteId !== undefined) {
    db.prepare("UPDATE pi_agent_sessions SET plan_note_id = ?, updated_at = ? WHERE id = ?").run(patch.planNoteId, now, sessionId);
  }
  if (patch.status !== undefined) {
    db.prepare("UPDATE pi_agent_sessions SET status = ?, updated_at = ? WHERE id = ?").run(patch.status, now, sessionId);
  }
  if (patch.mode === undefined && patch.planNoteId === undefined && patch.status === undefined) {
    db.prepare("UPDATE pi_agent_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
  }
}

export function deletePiSession(db: Database.Database, sessionId: string) {
  db.prepare("DELETE FROM pi_agent_sessions WHERE id = ?").run(sessionId);
}

// ── Pi Agent Messages ───────────────────────────────────────────────────────────────────

export interface PiMessageRow {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "error" | "system";
  content: string;
  reasoning: string | null;
  toolCalls: unknown[] | null;
  subagents: unknown[] | null;
  timestamp: string;
  order: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPiMessage(row: any): PiMessageRow {
  return {
    id:        row.id as string,
    sessionId: row.session_id as string,
    role:      row.role as "user" | "assistant" | "error" | "system",
    content:   row.content as string,
    reasoning: (row.reasoning as string | null) ?? null,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls as string) : null,
    subagents: row.subagents ? JSON.parse(row.subagents as string) : null,
    timestamp: row.timestamp as string,
    order:     row.order as number,
  };
}

export function upsertPiMessage(
  db: Database.Database,
  msg: { id: string; sessionId: string; role: "user" | "assistant" | "error" | "system"; content: string; reasoning?: string | null; toolCalls?: unknown[] | null; subagents?: unknown[] | null; timestamp: string; order: number },
) {
  db.prepare(`
    INSERT INTO pi_agent_messages (id, session_id, role, content, reasoning, tool_calls, subagents, timestamp, "order")
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content    = excluded.content,
      reasoning  = excluded.reasoning,
      tool_calls = excluded.tool_calls,
      subagents  = excluded.subagents
  `).run(
    msg.id, msg.sessionId, msg.role, msg.content,
    msg.reasoning ?? null,
    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    msg.subagents ? JSON.stringify(msg.subagents) : null,
    msg.timestamp, msg.order,
  );
}

export function savePiMessages(
  db: Database.Database,
  sessionId: string,
  messages: Array<{ id: string; role: "user" | "assistant" | "error" | "system"; content: string; reasoning?: string | null; toolCalls?: unknown[] | null; subagents?: unknown[] | null; timestamp: string }>,
) {
  const save = db.transaction(() => {
    db.prepare("DELETE FROM pi_agent_messages WHERE session_id = ?").run(sessionId);
    messages.forEach((msg, i) => {
      upsertPiMessage(db, { ...msg, sessionId, order: i });
    });
  });
  save();
}

export function getPiMessages(db: Database.Database, sessionId: string): PiMessageRow[] {
  return (db.prepare(`SELECT * FROM pi_agent_messages WHERE session_id = ? ORDER BY "order" ASC`).all(sessionId) as unknown[])
    .map(toPiMessage);
}

// ── Pi Agent LLM History ──────────────────────────────────────────────────────────────────

export interface LlmHistoryRow {
  role: string;
  content: string;
}

/**
 * Persist the full LLM message history for a session.
 *
 * Each message is serialised as JSON and stored in the `content` column so that
 * tool_calls (assistant→tool) and tool_call_id (tool result) are preserved across
 * restarts. The `role` column is kept for quick filtering without a JSON parse.
 */
export function saveLlmHistory(
  db: Database.Database,
  sessionId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: Array<Record<string, any>>,
) {
  const save = db.transaction(() => {
    db.prepare("DELETE FROM pi_agent_llm_history WHERE session_id = ?").run(sessionId);
    messages.forEach((msg, i) => {
      db.prepare(`INSERT INTO pi_agent_llm_history (session_id, "order", role, content) VALUES (?, ?, ?, ?)`)
        .run(sessionId, i, msg.role as string, JSON.stringify(msg));
    });
  });
  save();
}

/**
 * Restore the full LLM message history for a session.
 *
 * The `content` column contains a JSON-serialised AgentMessage object. We parse
 * it back out; if parsing fails (legacy plain-text rows) we fall back to a minimal
 * { role, content } shape so old sessions degrade gracefully.
 */
export function getLlmHistory(db: Database.Database, sessionId: string): LlmHistoryRow[] {
  const rows = db.prepare(`SELECT role, content FROM pi_agent_llm_history WHERE session_id = ? ORDER BY "order" ASC`).all(sessionId) as LlmHistoryRow[];
  return rows.map((row) => {
    try {
      const parsed = JSON.parse(row.content);
      if (parsed && typeof parsed === "object" && "role" in parsed) return parsed as LlmHistoryRow;
    } catch { /* legacy plain-text row — fall through */ }
    return row;
  });
}

// ── Codebase Semantic Indexing ─────────────────────────

export function getCodebaseFileByPath(db: Database.Database, filePath: string) {
  return db.prepare("SELECT * FROM codebase_files WHERE file_path = ?").get(filePath) as {
    id: string;
    root_path: string;
    file_path: string;
    hash: string;
    indexed_at: string;
  } | undefined;
}

export function upsertCodebaseFile(db: Database.Database, file: { id: string; rootPath: string; filePath: string; hash: string }) {
  const now = ts();
  db.prepare(`
    INSERT INTO codebase_files (id, root_path, file_path, hash, indexed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      hash = excluded.hash,
      indexed_at = excluded.indexed_at
  `).run(file.id, file.rootPath, file.filePath, file.hash, now);
  return db.prepare("SELECT * FROM codebase_files WHERE id = ?").get(file.id) as {
    id: string;
    root_path: string;
    file_path: string;
    hash: string;
    indexed_at: string;
  };
}

export function clearCodebaseFileData(db: Database.Database, fileId: string) {
  db.prepare("DELETE FROM codebase_symbols WHERE file_id = ?").run(fileId);
}

export function insertCodebaseSymbol(db: Database.Database, symbol: {
  id: string;
  fileId: string;
  name: string;
  kind: string;
  line: number;
  signature: string;
  docstring: string | null;
}) {
  db.prepare(`
    INSERT INTO codebase_symbols (id, file_id, name, kind, line, signature, docstring)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(symbol.id, symbol.fileId, symbol.name, symbol.kind, symbol.line, symbol.signature, symbol.docstring);
}

export function insertCodebaseRelation(db: Database.Database, relation: {
  sourceId: string;
  targetName: string;
  type: string;
}) {
  db.prepare(`
    INSERT OR IGNORE INTO codebase_relations (source_id, target_name, type)
    VALUES (?, ?, ?)
  `).run(relation.sourceId, relation.targetName, relation.type);
}

/**
 * Build the SQL fragment + params that scope a codebase query to `folder` (an
 * exact root/file match, or any file under it). The subtree match uses SQL LIKE,
 * so any LIKE metacharacters (`%`, `_`, and the `\` escape char) in the folder
 * path are escaped and an explicit `ESCAPE '\'` clause is emitted — otherwise a
 * path containing e.g. `_` would match sibling folders too. Assumes the caller
 * aliases the files table as `f`. Shared by every codebase read query.
 */
function codebaseScope(folder: string): { sql: string; params: string[] } {
  const normalized = path.resolve(folder);
  const escaped = normalized.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return {
    sql: `(f.root_path = ? OR f.file_path = ? OR f.file_path LIKE ? ESCAPE '\\')`,
    params: [normalized, normalized, `${escaped}${path.sep}%`],
  };
}

export function searchCodebaseSymbols(db: Database.Database, opts: { query: string; folder?: string; limit?: number }) {
  const q = opts.query.toLowerCase();
  const limit = opts.limit ?? 50;
  
  let sql = `
    SELECT s.*, f.file_path, f.root_path
    FROM codebase_symbols s
    JOIN codebase_files f ON s.file_id = f.id
    WHERE (lower(s.name) LIKE ? OR lower(s.signature) LIKE ? OR lower(s.docstring) LIKE ?)
  `;
  const params: unknown[] = [`%${q}%`, `%${q}%`, `%${q}%`];
  
  if (opts.folder) {
    const scope = codebaseScope(opts.folder);
    sql += ` AND ${scope.sql}`;
    params.push(...scope.params);
  }
  
  sql += ` ORDER BY s.name LIMIT ?`;
  params.push(limit);
  
  return db.prepare(sql).all(...params) as Array<{
    id: string;
    file_id: string;
    name: string;
    kind: string;
    line: number;
    signature: string;
    docstring: string | null;
    file_path: string;
    root_path: string;
  }>;
}

export function getCodebaseSymbolDefinition(db: Database.Database, name: string, folder?: string) {
  let sql = `
    SELECT s.*, f.file_path, f.root_path
    FROM codebase_symbols s
    JOIN codebase_files f ON s.file_id = f.id
    WHERE s.name = ?
  `;
  const params: unknown[] = [name];
  
  if (folder) {
    const scope = codebaseScope(folder);
    sql += ` AND ${scope.sql}`;
    params.push(...scope.params);
  }
  
  return db.prepare(sql).all(...params) as Array<{
    id: string;
    file_id: string;
    name: string;
    kind: string;
    line: number;
    signature: string;
    docstring: string | null;
    file_path: string;
    root_path: string;
  }>;
}

export function getCodebaseRelations(db: Database.Database, name: string, folder?: string) {
  let sql1 = `
    SELECT r.type, r.target_name, s.name as source_name, f.file_path as source_file
    FROM codebase_relations r
    JOIN codebase_symbols s ON r.source_id = s.id
    JOIN codebase_files f ON s.file_id = f.id
    WHERE s.name = ?
  `;
  const params1: unknown[] = [name];
  if (folder) {
    const scope = codebaseScope(folder);
    sql1 += ` AND ${scope.sql}`;
    params1.push(...scope.params);
  }
  const outgoing = db.prepare(sql1).all(...params1) as Array<{
    type: string;
    target_name: string;
    source_name: string;
    source_file: string;
  }>;

  let sql2 = `
    SELECT r.type, r.target_name, s.name as source_name, f.file_path as source_file
    FROM codebase_relations r
    JOIN codebase_symbols s ON r.source_id = s.id
    JOIN codebase_files f ON s.file_id = f.id
    WHERE r.target_name = ?
  `;
  const params2: unknown[] = [name];
  if (folder) {
    const scope = codebaseScope(folder);
    sql2 += ` AND ${scope.sql}`;
    params2.push(...scope.params);
  }
  const incoming = db.prepare(sql2).all(...params2) as Array<{
    type: string;
    target_name: string;
    source_name: string;
    source_file: string;
  }>;

  return { incoming, outgoing };
}

export function getCodebaseFileSymbols(db: Database.Database, filePath: string) {
  return db.prepare(`
    SELECT s.*, f.file_path, f.root_path
    FROM codebase_symbols s
    JOIN codebase_files f ON s.file_id = f.id
    WHERE f.file_path = ?
    ORDER BY s.line
  `).all(filePath) as Array<{
    id: string;
    file_id: string;
    name: string;
    kind: string;
    line: number;
    signature: string;
    docstring: string | null;
    file_path: string;
    root_path: string;
  }>;
}

export function deleteCodebaseRoot(db: Database.Database, rootPath: string) {
  db.prepare("DELETE FROM codebase_files WHERE root_path = ?").run(rootPath);
}

export function getCodebaseFilesByRoot(db: Database.Database, rootPath: string) {
  return db.prepare("SELECT * FROM codebase_files WHERE root_path = ?").all(rootPath) as Array<{
    id: string;
    root_path: string;
    file_path: string;
    hash: string;
    indexed_at: string;
  }>;
}

export function deleteCodebaseFile(db: Database.Database, fileId: string) {
  db.prepare("DELETE FROM codebase_files WHERE id = ?").run(fileId);
}

/**
 * Aggregate view of the codebase index for a given root folder — powers the
 * human-facing Architecture tab. Returns the indexed files (with per-file
 * symbol counts + relation edge counts), a symbol-kind breakdown, and headline
 * totals. `folder` matches a file's `root_path` OR any file under it, so an
 * indexed sub-tree is picked up regardless of the exact root string. All reads
 * hit the already-constructed db handle (no new Database).
 */
export function getCodebaseOverview(db: Database.Database, folder: string) {
  const normalized = path.resolve(folder);
  const { sql: scope, params: scopeParams } = codebaseScope(folder);

  const files = db.prepare(`
    SELECT
      f.id,
      f.file_path,
      f.root_path,
      f.indexed_at,
      (SELECT COUNT(*) FROM codebase_symbols s WHERE s.file_id = f.id) AS symbol_count,
      (SELECT COUNT(*) FROM codebase_relations r
         JOIN codebase_symbols s2 ON r.source_id = s2.id
        WHERE s2.file_id = f.id) AS relation_count
    FROM codebase_files f
    WHERE ${scope}
    ORDER BY f.file_path
  `).all(...scopeParams) as Array<{
    id: string;
    file_path: string;
    root_path: string;
    indexed_at: string;
    symbol_count: number;
    relation_count: number;
  }>;

  const kinds = db.prepare(`
    SELECT s.kind, COUNT(*) AS count
    FROM codebase_symbols s
    JOIN codebase_files f ON s.file_id = f.id
    WHERE ${scope}
    GROUP BY s.kind
    ORDER BY count DESC
  `).all(...scopeParams) as Array<{ kind: string; count: number }>;

  const totalSymbols = kinds.reduce((sum, k) => sum + k.count, 0);
  const totalRelations = files.reduce((sum, fl) => sum + fl.relation_count, 0);
  const roots = Array.from(new Set(files.map((fl) => fl.root_path)));
  const lastIndexedAt = files.reduce<string | null>(
    (max, fl) => (max == null || fl.indexed_at > max ? fl.indexed_at : max),
    null,
  );

  return {
    folder: normalized,
    roots,
    fileCount: files.length,
    totalSymbols,
    totalRelations,
    lastIndexedAt,
    kinds,
    files,
  };
}

/**
 * File-level dependency graph for the Architecture graph view. Resolves each
 * call/reference edge (source symbol → target symbol name) to the files that
 * define them, then aggregates a weighted, directed file→file edge (self-loops
 * within a file are dropped). Also returns the file nodes (with symbol counts)
 * so the renderer can lay out a module-dependency diagram, plus a lightweight
 * per-file symbol list for expand-in-place. Scoped like getCodebaseOverview.
 */
export function getCodebaseGraph(db: Database.Database, folder: string) {
  const normalized = path.resolve(folder);
  const { sql: scope, params: scopeParams } = codebaseScope(folder);

  const nodes = db.prepare(`
    SELECT
      f.id,
      f.file_path,
      f.root_path,
      (SELECT COUNT(*) FROM codebase_symbols s WHERE s.file_id = f.id) AS symbol_count
    FROM codebase_files f
    WHERE ${scope}
    ORDER BY f.file_path
  `).all(...scopeParams) as Array<{
    id: string; file_path: string; root_path: string; symbol_count: number;
  }>;

  // Directed, weighted file→file edges. A relation's source symbol lives in one
  // file (sf); its target NAME is resolved to the file that defines it (tf). To
  // avoid the graph exploding with false edges, we ONLY link target names that
  // are UNAMBIGUOUS — defined in exactly one file within scope. A name defined
  // in many files (e.g. `dispose`, `makeDb`) can't be attributed to a single
  // file, so linking it to all of them is noise; we drop those. Self-references
  // are excluded. Both endpoints must be in scope.
  const edges = db.prepare(`
    WITH scoped_syms AS (
      SELECT s.id, s.name, s.file_id
      FROM codebase_symbols s
      JOIN codebase_files f ON s.file_id = f.id
      WHERE ${scope}
    ),
    unambiguous AS (
      SELECT name FROM scoped_syms GROUP BY name HAVING COUNT(DISTINCT file_id) = 1
    )
    SELECT sf.id AS source, ts.file_id AS target, COUNT(*) AS weight
    FROM codebase_relations r
    JOIN scoped_syms ss ON r.source_id = ss.id
    JOIN codebase_files sf ON ss.file_id = sf.id
    JOIN scoped_syms ts ON ts.name = r.target_name
    WHERE r.target_name IN (SELECT name FROM unambiguous)
      AND ss.file_id != ts.file_id
    GROUP BY sf.id, ts.file_id
  `).all(...scopeParams) as Array<{
    source: string; target: string; weight: number;
  }>;

  return { folder: normalized, nodes, edges };
}

/**
 * Directory-aggregated MODULE graph for the Architecture overview (module map).
 * Rolls the de-noised file→file dependency graph up to "modules" — directory
 * paths truncated to `depth` segments (relative to the scoped root) — and
 * aggregates weighted inter-module edges (intra-module edges are dropped; they
 * become the module's internal cohesion count instead). Module size is the
 * total symbol count of its files.
 *
 * Grouping is done in JS (not SQL) so the strategy stays pluggable: today it's
 * directory-based; a future import-clustering strategy can slot in here without
 * touching the renderer. Reuses getCodebaseGraph for the (already unambiguous,
 * call-syntax-only) file edges.
 */
export function getCodebaseModuleGraph(
  db: Database.Database,
  folder: string,
  depth = 1,
) {
  const { folder: normalized, nodes: files, edges: fileEdges } = getCodebaseGraph(db, folder);
  const d = Math.max(1, Math.floor(depth));

  // Map a file → its module id (directory truncated to `depth` segments).
  const moduleOf = (filePath: string): string => {
    let rel = filePath;
    if (normalized && filePath.startsWith(normalized)) {
      rel = filePath.slice(normalized.length).replace(/^[/\\]/, "");
    }
    const parts = rel.split(/[/\\]/);
    if (parts.length <= 1) return "(root)";
    return parts.slice(0, -1).slice(0, d).join("/") || "(root)";
  };

  // Build module nodes: aggregate symbol + file counts.
  const modules = new Map<string, { id: string; label: string; fileCount: number; symbolCount: number; internalRefs: number }>();
  const fileModule = new Map<string, string>();
  for (const f of files) {
    const m = moduleOf(f.file_path);
    fileModule.set(f.id, m);
    const node = modules.get(m) ?? { id: m, label: m, fileCount: 0, symbolCount: 0, internalRefs: 0 };
    node.fileCount += 1;
    node.symbolCount += f.symbol_count;
    modules.set(m, node);
  }

  // Aggregate inter-module edges; count intra-module edges as cohesion.
  const edgeMap = new Map<string, { source: string; target: string; weight: number }>();
  for (const e of fileEdges) {
    const sm = fileModule.get(e.source), tm = fileModule.get(e.target);
    if (sm == null || tm == null) continue;
    if (sm === tm) {
      const node = modules.get(sm);
      if (node) node.internalRefs += e.weight;
      continue;
    }
    const key = `${sm}\u0000${tm}`;
    const agg = edgeMap.get(key) ?? { source: sm, target: tm, weight: 0 };
    agg.weight += e.weight;
    edgeMap.set(key, agg);
  }

  return {
    folder: normalized,
    depth: d,
    grouping: "directory" as const,
    nodes: Array.from(modules.values()).sort((a, b) => a.id.localeCompare(b.id)),
    edges: Array.from(edgeMap.values()),
  };
}

// ── Note Embeddings ───────────────────────────
// Vectors are stored as JSON-in-TEXT (sqlite-vec-bridge shape).
// Since v18, one note can have multiple rows — one per markdown section.
// All JSON-parse/serialize happens here; callers receive typed objects.

export interface NoteEmbeddingRecord {
  noteId: string;
  sectionIdx: number;
  sectionTitle: string;
  workspaceId: string;
  model: string;
  task: string;
  contentHash: string;
  vector: number[];
  embeddedAt: string;
  dimX: number | null;
  dimY: number | null;
  projStale: number;
}

interface NoteEmbeddingRow {
  note_id: string;
  section_idx: number;
  section_title: string;
  workspace_id: string;
  model: string;
  task: string;
  content_hash: string;
  vector: string;
  embedded_at: string;
  dim_x: number | null;
  dim_y: number | null;
  proj_stale: number;
}

function toNoteEmbedding(row: NoteEmbeddingRow): NoteEmbeddingRecord {
  return {
    noteId: row.note_id,
    sectionIdx: row.section_idx,
    sectionTitle: row.section_title,
    workspaceId: row.workspace_id,
    model: row.model,
    task: row.task,
    contentHash: row.content_hash,
    vector: JSON.parse(row.vector) as number[],
    embeddedAt: row.embedded_at,
    dimX: row.dim_x,
    dimY: row.dim_y,
    projStale: row.proj_stale,
  };
}

export function upsertNoteEmbedding(
  db: Database.Database,
  e: {
    noteId: string;
    sectionIdx: number;
    sectionTitle: string;
    workspaceId: string;
    model: string;
    task: string;
    contentHash: string;
    vector: number[];
  },
): void {
  const now = ts();
  db.prepare(`
    INSERT INTO note_embeddings
      (note_id, section_idx, section_title, workspace_id, model, task, content_hash, vector, embedded_at, proj_stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(note_id, section_idx) DO UPDATE SET
      section_title = excluded.section_title,
      workspace_id  = excluded.workspace_id,
      model         = excluded.model,
      task          = excluded.task,
      content_hash  = excluded.content_hash,
      vector        = excluded.vector,
      embedded_at   = excluded.embedded_at,
      proj_stale    = 1
  `).run(e.noteId, e.sectionIdx, e.sectionTitle, e.workspaceId, e.model, e.task, e.contentHash, JSON.stringify(e.vector), now);
}

export function deleteNoteEmbeddingSections(db: Database.Database, noteId: string, keepFromIdx?: number): void {
  if (keepFromIdx !== undefined) {
    db.prepare("DELETE FROM note_embeddings WHERE note_id = ? AND section_idx >= ?").run(noteId, keepFromIdx);
  } else {
    db.prepare("DELETE FROM note_embeddings WHERE note_id = ?").run(noteId);
  }
}

export function markEmbeddingProjectionFresh(db: Database.Database, noteId: string, x: number, y: number): void {
  db.prepare(`
    UPDATE note_embeddings SET dim_x = ?, dim_y = ?, proj_stale = 0 WHERE note_id = ?
  `).run(x, y, noteId);
}

export function markAllProjectionsStale(db: Database.Database, workspaceId: string): void {
  db.prepare("UPDATE note_embeddings SET proj_stale = 1 WHERE workspace_id = ?").run(workspaceId);
}

export interface NoteProjectionRow {
  noteId: string;
  dimX: number;
  dimY: number;
  projStale: number;
  embeddedAt: string;
  model: string;
}

export function getNoteProjections(
  db: Database.Database,
  workspaceId: string,
): { rows: NoteProjectionRow[]; anyStale: boolean } {
  const raw = db.prepare(`
    SELECT note_id, dim_x, dim_y, proj_stale, embedded_at, model
    FROM note_embeddings
    WHERE workspace_id = ? AND section_idx = 0
  `).all(workspaceId) as Array<{
    note_id: string;
    dim_x: number | null;
    dim_y: number | null;
    proj_stale: number;
    embedded_at: string;
    model: string;
  }>;
  let anyStale = false;
  const rows: NoteProjectionRow[] = [];
  for (const r of raw) {
    if (r.proj_stale) anyStale = true;
    if (r.dim_x === null || r.dim_y === null) continue;
    rows.push({
      noteId: r.note_id,
      dimX: r.dim_x,
      dimY: r.dim_y,
      projStale: r.proj_stale,
      embeddedAt: r.embedded_at,
      model: r.model,
    });
  }
  return { rows, anyStale };
}

export function getNoteEmbeddings(db: Database.Database, noteId: string): NoteEmbeddingRecord[] {
  const rows = db.prepare("SELECT * FROM note_embeddings WHERE note_id = ? ORDER BY section_idx").all(noteId) as NoteEmbeddingRow[];
  return rows.map(toNoteEmbedding);
}

export function getAllEmbeddingsForWorkspace(
  db: Database.Database,
  workspaceId: string,
  task: string,
): NoteEmbeddingRecord[] {
  const rows = db.prepare(
    "SELECT * FROM note_embeddings WHERE workspace_id = ? AND task = ? ORDER BY note_id, section_idx"
  ).all(workspaceId, task) as NoteEmbeddingRow[];
  return rows.map(toNoteEmbedding);
}

export function getStaleProjectionNoteIds(db: Database.Database, workspaceId: string): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT note_id FROM note_embeddings WHERE workspace_id = ? AND proj_stale = 1 AND task = 'search_document'"
  ).all(workspaceId) as Array<{ note_id: string }>;
  return rows.map((r) => r.note_id);
}

export function deleteNoteEmbedding(db: Database.Database, noteId: string): void {
  db.prepare("DELETE FROM note_embeddings WHERE note_id = ?").run(noteId);
}

export function pruneOrphanedClusteringRows(db: Database.Database): number {
  const info = db.prepare("DELETE FROM note_embeddings WHERE task = 'clustering'").run();
  return info.changes;
}

export function deleteWorkspaceEmbeddings(db: Database.Database, workspaceId: string): void {
  db.prepare("DELETE FROM note_embeddings WHERE workspace_id = ?").run(workspaceId);
}

// ── Task-card embeddings (task_embeddings) — parallel to note_embeddings ──────
// Same shape minus the graph-projection fields. Keyed by card_id.

export interface TaskEmbeddingRecord {
  cardId: string;
  sectionIdx: number;
  sectionTitle: string;
  workspaceId: string;
  model: string;
  task: string;
  contentHash: string;
  vector: number[];
  embeddedAt: string;
}
interface TaskEmbeddingRow {
  card_id: string;
  section_idx: number;
  section_title: string;
  workspace_id: string;
  model: string;
  task: string;
  content_hash: string;
  vector: string;
  embedded_at: string;
}
function toTaskEmbedding(row: TaskEmbeddingRow): TaskEmbeddingRecord {
  return {
    cardId: row.card_id,
    sectionIdx: row.section_idx,
    sectionTitle: row.section_title,
    workspaceId: row.workspace_id,
    model: row.model,
    task: row.task,
    contentHash: row.content_hash,
    vector: JSON.parse(row.vector) as number[],
    embeddedAt: row.embedded_at,
  };
}

/** Workspace-scoped card fetch for reindexing (mirrors fetchNotes' selection). */
export interface CardStub {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  archived_at: string | null;
}
export function fetchCardsForEmbedding(db: Database.Database, workspaceId: string, cardIds?: string[]): CardStub[] {
  if (cardIds?.length) {
    const placeholders = cardIds.map(() => "?").join(",");
    return db.prepare(
      `SELECT id, workspace_id, title, description, archived_at FROM task_cards
       WHERE workspace_id = ? AND id IN (${placeholders})`,
    ).all(workspaceId, ...cardIds) as CardStub[];
  }
  return db.prepare(
    `SELECT id, workspace_id, title, description, archived_at FROM task_cards
     WHERE workspace_id = ? AND archived_at IS NULL`,
  ).all(workspaceId) as CardStub[];
}

export function getCardEmbeddings(db: Database.Database, cardId: string): TaskEmbeddingRecord[] {
  const rows = db.prepare("SELECT * FROM task_embeddings WHERE card_id = ? ORDER BY section_idx").all(cardId) as TaskEmbeddingRow[];
  return rows.map(toTaskEmbedding);
}

export function getAllTaskEmbeddingsForWorkspace(db: Database.Database, workspaceId: string, task: string): TaskEmbeddingRecord[] {
  const rows = db.prepare(
    "SELECT * FROM task_embeddings WHERE workspace_id = ? AND task = ? ORDER BY card_id, section_idx",
  ).all(workspaceId, task) as TaskEmbeddingRow[];
  return rows.map(toTaskEmbedding);
}

export function upsertTaskEmbedding(
  db: Database.Database,
  e: {
    cardId: string;
    sectionIdx: number;
    sectionTitle: string;
    workspaceId: string;
    model: string;
    task: string;
    contentHash: string;
    vector: number[];
  },
): void {
  const now = ts();
  db.prepare(`
    INSERT INTO task_embeddings
      (card_id, section_idx, section_title, workspace_id, model, task, content_hash, vector, embedded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(card_id, section_idx) DO UPDATE SET
      section_title = excluded.section_title,
      workspace_id  = excluded.workspace_id,
      model         = excluded.model,
      task          = excluded.task,
      content_hash  = excluded.content_hash,
      vector        = excluded.vector,
      embedded_at   = excluded.embedded_at
  `).run(e.cardId, e.sectionIdx, e.sectionTitle, e.workspaceId, e.model, e.task, e.contentHash, JSON.stringify(e.vector), now);
}

export function deleteTaskEmbeddingSections(db: Database.Database, cardId: string, keepFromIdx?: number): void {
  if (keepFromIdx !== undefined) {
    db.prepare("DELETE FROM task_embeddings WHERE card_id = ? AND section_idx >= ?").run(cardId, keepFromIdx);
  } else {
    db.prepare("DELETE FROM task_embeddings WHERE card_id = ?").run(cardId);
  }
}
