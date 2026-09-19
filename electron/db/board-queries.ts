/**
 * Cairn — board (columns + task cards) queries.
 *
 * Part of the `electron/db/queries.ts` per-domain split (cleanup Phase 4).
 * Re-exported from `./queries` so existing importers keep working unchanged.
 *
 * Governance: NEVER construct a Database here — these run on the
 * already-constructed handle passed in by the caller. See `./queries.ts`
 * header for the three ABI bootstrap sites.
 */

import type Database from "better-sqlite3";
import { ts } from "./utils";
import { toColumn, toCard, j, p, type DbRow } from "../shared/db-mappers";

// ── Board Columns ─────────────────────────────

export function getColumns(db: Database.Database, projectId?: string) {
  const rows = projectId
    ? db.prepare(`SELECT * FROM board_columns WHERE project_id = ? ORDER BY "order"`).all(projectId)
    : db.prepare(`SELECT * FROM board_columns ORDER BY "order"`).all();
  return rows.map((row) => toColumn(row as DbRow));
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
  return toColumn(db.prepare("SELECT * FROM board_columns WHERE id = ?").get(c.id) as DbRow);
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
  return toColumn(db.prepare("SELECT * FROM board_columns WHERE id = ?").get(id) as DbRow);
}

export function deleteColumn(db: Database.Database, id: string) {
  db.prepare("DELETE FROM task_cards WHERE column_id = ?").run(id);
  db.prepare("DELETE FROM board_columns WHERE id = ?").run(id);
}

// ── Task Cards ────────────────────────────────

export function getCards(db: Database.Database, opts?: { projectId?: string; columnId?: string }) {
  // Filter tombstones (deleted_at) — a card deleted on a peer keeps a tombstone
  // row so sync converges; it must not show on the board. (Same rationale as
  // getNotes.)
  let rows;
  if (opts?.columnId) {
    rows = db.prepare(`SELECT * FROM task_cards WHERE column_id = ? AND deleted_at IS NULL ORDER BY "order"`).all(opts.columnId);
  } else if (opts?.projectId) {
    rows = db.prepare(`SELECT * FROM task_cards WHERE project_id = ? AND deleted_at IS NULL ORDER BY "order"`).all(opts.projectId);
  } else {
    rows = db.prepare(`SELECT * FROM task_cards WHERE deleted_at IS NULL ORDER BY "order"`).all();
  }
  return rows.map((row) => toCard(row as DbRow));
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
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(c.id) as DbRow);
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
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id) as DbRow);
}

/**
 * Move a card to a different project (and its owning workspace), landing it in a
 * specific column of that project.
 *
 * Like moveNoteToProject, this uses a direct SET rather than updateCard()'s
 * COALESCE list, which has no project_id/workspace_id columns — so routing a
 * cross-project move through updateCard() silently dropped the project change,
 * leaving the row with a column_id in the new project but project_id still in
 * the old one. On the next board refresh / sync reconcile (both scope by
 * project_id) the card resurfaced in the source project.
 *
 * The destination workspace is resolved from the target project itself (not
 * trusted from the caller); the target column must belong to the target project.
 */
export function moveCardToProject(
  db: Database.Database,
  id: string,
  projectId: string,
  columnId: string,
  order: number,
) {
  const project = db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as
    | { workspace_id: string }
    | undefined;
  if (!project) throw new Error(`Target project not found: ${projectId}`);
  const column = db.prepare("SELECT project_id FROM board_columns WHERE id = ?").get(columnId) as
    | { project_id: string }
    | undefined;
  if (!column) throw new Error(`Target column not found: ${columnId}`);
  if (column.project_id !== projectId) {
    throw new Error(`Target column ${columnId} does not belong to project ${projectId}`);
  }
  const now = ts();
  db.prepare(
    `UPDATE task_cards SET project_id = ?, workspace_id = ?, column_id = ?, "order" = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
  ).run(projectId, project.workspace_id, columnId, order, now, id);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id) as DbRow);
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
  return row ? toCard(row as DbRow) : null;
}

/**
 * Explicitly clear archived_at for a card (cannot use COALESCE for NULL clears).
 */
export function restoreCard(db: Database.Database, id: string) {
  const now = ts();
  db.prepare("UPDATE task_cards SET archived_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(now, id);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id) as DbRow);
}

/**
 * Explicitly clear due_date for a card.
 */
export function clearCardDueDate(db: Database.Database, id: string) {
  const now = ts();
  db.prepare("UPDATE task_cards SET due_date = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(now, id);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id) as DbRow);
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
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(cardId) as DbRow);
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
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(cardId) as DbRow);
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
  `).all(...params).map((row) => toCard(row as DbRow));

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
