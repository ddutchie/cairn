/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import { newId, ts } from "../../db/utils";
import {
  Snapshot,
  j,
  j2,
  toCard,
  getCardVersion,
  insertNotification,
  resolveTagNames
} from "../db";

export function get_task(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const card = snap.cards.find((c) => c.id === args.cardId);
  if (!card) return { error: "Task not found" };
  const col = snap.columns.find((c) => c.id === card.columnId);
  return {
    id: card.id, title: card.title, description: card.description,
    priority: card.priority, dueDate: card.dueDate,
    columnId: card.columnId, columnName: col?.name ?? "Unknown", columnType: col?.type ?? "custom",
    linkedNoteIds: card.linkedNoteIds, blockedByIds: card.blockedByIds ?? [],
    projectId: card.projectId, createdAt: card.createdAt, updatedAt: card.updatedAt, version: (card as any).version ?? 0,
  };
}

export function search_tasks(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { query, projectId, columnType, limit = 10 } = args;
  const qr = String(query).toLowerCase();
  return snap.cards
    .filter((c) => {
      if (c.archivedAt) return false;
      if (projectId && c.projectId !== projectId) return false;
      if (columnType) {
        const col = snap.columns.find((col) => col.id === c.columnId);
        if (col?.type !== columnType) return false;
      }
      return c.title.toLowerCase().includes(qr) || (c.description ?? "").toLowerCase().includes(qr);
    })
    .slice(0, limit)
    .map((c) => {
      const col = snap.columns.find((col) => col.id === c.columnId);
      return { id: c.id, title: c.title, description: c.description, columnId: c.columnId,
        columnName: col?.name ?? "Unknown", columnType: col?.type ?? "custom",
        priority: c.priority, dueDate: c.dueDate, projectId: c.projectId };
    });
}

export function create_task(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { columnId, projectId, description, priority = "medium", dueDate, tagIds, tagNames } = args;
  const title = (args.title as string | null | undefined)?.trim();
  if (!title) return { error: "Task title is required" };
  const col = snap.columns.find((c) => c.id === columnId);
  if (!col) return { error: "Column not found" };
  const now = ts();
  const cardId = newId();
  const order = snap.cards.filter((c) => c.columnId === columnId).length;
  
  const resolvedFromNameIds = resolveTagNames(db, col.workspaceId, tagNames);
  let resolvedTagIds = Array.isArray(tagIds) ? tagIds as string[] : [];
  if (resolvedFromNameIds.length > 0) {
    resolvedTagIds = Array.from(new Set([...resolvedTagIds, ...resolvedFromNameIds]));
  }
  db.prepare(`
    INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, description,
      tag_ids, priority, due_date, linked_note_ids, "order", created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)
  `).run(cardId, columnId, projectId, col.workspaceId, title, description ?? null, j(resolvedTagIds), priority, dueDate ?? null, order, now, now);
  const taskProject = snap.projects.find((pr) => pr.id === projectId);
  insertNotification(db, "create_task", "Task created", `"${title}" added to ${taskProject?.name ?? projectId}`);
  return { id: cardId, title, columnId, createdAt: now };
}

export function bulk_update_task_status(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { cardIds, targetColumnId } = args as { cardIds: string[]; targetColumnId: string };
  const col = snap.columns.find((c) => c.id === targetColumnId);
  if (!col) return { error: "Column not found" };
  if (!Array.isArray(cardIds) || cardIds.length === 0) return { error: "cardIds must be a non-empty array" };
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  const now = ts();
  for (const id of cardIds) {
    const card = snap.cards.find((c) => c.id === id);
    if (!card) {
      results.push({ id, ok: false, error: "Task not found" });
    } else {
      db.prepare(`UPDATE task_cards SET column_id = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(targetColumnId, now, id);
      results.push({ id, ok: true });
    }
  }
  // When moving to a done column, clear all successfully-moved IDs from
  // any other task's blocked_by_ids.
  if (col.type === "done") {
    const movedIds = results.filter((r) => r.ok).map((r) => r.id);
    if (movedIds.length > 0) {
      const affected = db.prepare(
        "SELECT id, blocked_by_ids FROM task_cards WHERE blocked_by_ids != '[]'"
      ).all() as { id: string; blocked_by_ids: string }[];
      for (const row of affected) {
        if (movedIds.includes(row.id)) continue; // skip the tasks we just moved
        const ids: string[] = j2(row.blocked_by_ids);
        const cleaned = ids.filter((bid) => !movedIds.includes(bid));
        if (cleaned.length !== ids.length) {
          db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?")
            .run(j(cleaned), now, row.id);
        }
      }
    }
  }
  const moved = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (moved > 0) insertNotification(db, "bulk_update_task_status", "Tasks moved", `${moved} task${moved === 1 ? "" : "s"} → ${col.name}`);
  return { moved, failed, targetColumnId, targetColumnName: col.name };
}

export function link_note_to_task(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { noteId, cardId } = args;
  const note = snap.notes.find((n) => n.id === noteId);
  const card = snap.cards.find((c) => c.id === cardId);
  if (!note) return { error: "Note not found" };
  if (!card) return { error: "Card not found" };
  const newCardIds = j(Array.from(new Set([...(note.linkedCardIds as string[]), cardId])));
  const newNoteIds = j(Array.from(new Set([...(card.linkedNoteIds as string[]), noteId])));
  const now = ts();
  db.prepare(`UPDATE notes SET linked_card_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(newCardIds, now, noteId);
  db.prepare(`UPDATE task_cards SET linked_note_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(newNoteIds, now, cardId);
  insertNotification(db, "link_note_to_task", "Note linked to task", `"${note.title}" linked to "${card.title}"`);
  return { noteId, cardId, linked: true };
}

export function delete_task(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const card = snap.cards.find((c) => c.id === args.cardId);
  if (!card) return { error: "Task not found" };
  // Clean up this card's ID from any other card's blocked_by_ids
  const now = ts();
  const affected = db.prepare(
    "SELECT id, blocked_by_ids FROM task_cards WHERE blocked_by_ids != '[]' AND id != ?"
  ).all(args.cardId) as { id: string; blocked_by_ids: string }[];
  for (const row of affected) {
    const ids: string[] = j2(row.blocked_by_ids);
    if (ids.includes(args.cardId as string)) {
      const updated = ids.filter((bid) => bid !== args.cardId);
      db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ? WHERE id = ?")
        .run(j(updated), now, row.id);
    }
  }
  db.prepare("DELETE FROM task_cards WHERE id = ?").run(args.cardId);
  insertNotification(db, "delete_task", "Task deleted", `"${card.title}" was deleted`);
  return { deleted: true, id: args.cardId, title: card.title };
}

export function list_ready_tasks(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  // Cards that are active, not in a done column, and all blockers are resolved
  const projectFilter = args.projectId ? "AND tc.project_id = ?" : "";
  const params = args.projectId ? [args.projectId] : [];
  const candidates = db.prepare(`
    SELECT tc.*, bc.type as col_type, bc.name as col_name
    FROM task_cards tc
    JOIN board_columns bc ON tc.column_id = bc.id
    WHERE tc.archived_at IS NULL AND bc.type != 'done' ${projectFilter}
    ORDER BY tc."order"
  `).all(...params) as Array<{
    id: string; title: string; description: string; priority: string;
    due_date: string; column_id: string; project_id: string;
    blocked_by_ids: string; col_type: string; col_name: string;
  }>;
  // Build a lookup for blocker resolution
  const allProjectIds = [...new Set(candidates.map((c) => c.project_id))];
  const allCards = allProjectIds.flatMap((pid) =>
    db.prepare(`SELECT tc.id, tc.archived_at, tc.blocked_by_ids, bc.type as col_type
      FROM task_cards tc JOIN board_columns bc ON tc.column_id = bc.id WHERE tc.project_id = ?`
    ).all(pid) as Array<{ id: string; archived_at: string | null; col_type: string }>
  );
  const cardLookup = new Map(allCards.map((c) => [c.id, c]));
  function isResolvedMcp(blockerId: string): boolean {
    const b = cardLookup.get(blockerId);
    if (!b) return true;
    return b.archived_at !== null || b.col_type === "done";
  }
  const ready = candidates.filter((c) => {
    const ids: string[] = j2(c.blocked_by_ids);
    return ids.length === 0 || ids.every(isResolvedMcp);
  });
  return ready.map((c) => ({
    id: c.id, title: c.title, priority: c.priority, dueDate: c.due_date,
    columnId: c.column_id, columnName: c.col_name, projectId: c.project_id,
    blockedByIds: j2(c.blocked_by_ids),
  }));
}

export function update_task(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { cardId, title, description, priority, dueDate, columnId, tagIds, tagNames, assignee,
          archived, blockedBy, unblockFrom,
          expectedVersion: taskExpectedVersion } = args;

  // Must query DB directly for archived cards not in snap
  const _rawCard = snap.cards.find((c) => c.id === cardId)
    ?? (() => { const r = db.prepare("SELECT * FROM task_cards WHERE id = ?").get(cardId); return r ? toCard(r) : undefined; })();
  const card = _rawCard;
  if (!card) return { error: "Task not found" };

  if (taskExpectedVersion !== undefined) {
    const currentVersion = getCardVersion(db, cardId as string);
    if (currentVersion !== null && currentVersion !== (taskExpectedVersion as number)) {
      return { error: `Version conflict: task has been modified (expected v${taskExpectedVersion as number}, got v${currentVersion}). Fetch the latest state before retrying.` };
    }
  }

  // ── archive / restore ──────────────────────────────────────────────────
  if (archived === true) {
    if (card.archivedAt) return { error: "Task is already archived" };
    const now = ts();
    db.prepare("UPDATE task_cards SET archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(now, now, cardId);
    insertNotification(db, "update_task", "Task archived", `"${card.title}" was archived`);
    return { ok: true, cardId, archivedAt: now };
  }
  if (archived === false) {
    // Must query DB directly — archived cards are filtered from snap
    const row = db.prepare("SELECT * FROM task_cards WHERE id = ?").get(cardId) as Record<string, unknown> | undefined;
    if (!row) return { error: "Task not found" };
    if (!row.archived_at) return { error: "Task is not archived" };
    const now = ts();
    db.prepare("UPDATE task_cards SET archived_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(now, cardId);
    insertNotification(db, "update_task", "Task restored", `"${row.title as string}" was restored`);
    return { ok: true, cardId, title: row.title };
  }

  // ── block / unblock ────────────────────────────────────────────────────
  if (blockedBy !== undefined) {
    const blocker = snap.cards.find((c) => c.id === blockedBy);
    if (!blocker) return { error: "Blocker task not found" };
    if (card.projectId !== blocker.projectId) return { error: "Cards must be in the same project" };
    if (cardId === blockedBy) return { error: "A card cannot block itself" };
    // Circular dep check
    const projectCards = snap.cards.filter((c) => c.projectId === card.projectId);
    const cardMap = new Map(projectCards.map((c) => [c.id, c]));
    function canReachMcp(from: string, target: string, visited = new Set<string>()): boolean {
      if (from === target) return true;
      if (visited.has(from)) return false;
      visited.add(from);
      const node = cardMap.get(from);
      if (!node) return false;
      return (node.blockedByIds ?? []).some((bid: string) => canReachMcp(bid, target, visited));
    }
    if (canReachMcp(blockedBy as string, cardId as string, new Set())) {
      return { error: "Circular dependency detected" };
    }
    const nowB = ts();
    const row = db.prepare("SELECT blocked_by_ids FROM task_cards WHERE id = ?").get(cardId) as { blocked_by_ids: string } | undefined;
    if (!row) return { error: "Task not found in DB" };
    const ids: string[] = j2(row.blocked_by_ids);
    if (!ids.includes(blockedBy as string)) {
      ids.push(blockedBy as string);
      db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(j(ids), nowB, cardId);
    }
    insertNotification(db, "update_task", "Task blocked", `"${card.title}" is now blocked by "${blocker.title}"`);
    return { cardId, blockerCardId: blockedBy, blocked: true };
  }
  if (unblockFrom !== undefined) {
    const nowU = ts();
    const rowU = db.prepare("SELECT blocked_by_ids FROM task_cards WHERE id = ?").get(cardId) as { blocked_by_ids: string } | undefined;
    if (!rowU) return { error: "Task not found in DB" };
    const idsU: string[] = j2(rowU.blocked_by_ids);
    const updatedIds = idsU.filter((id) => id !== unblockFrom);
    db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(j(updatedIds), nowU, cardId);
    return { cardId, blockerCardId: unblockFrom, unblocked: true };
  }

  // ── field update ───────────────────────────────────────────────────────
  const now = ts();
  // assignee uses CASE WHEN instead of COALESCE so it can be explicitly cleared to NULL
  // by passing an empty string. Sentinel 1 = "update assignee"; 0 = "leave unchanged".
  const assigneeSentinel = assignee !== undefined ? 1 : 0;
  const assigneeValue    = assignee !== undefined ? (assignee || null) : null;

  // Resolve tag names to IDs
  let finalTagIds = tagIds != null ? (Array.isArray(tagIds) ? (tagIds as string[]) : [tagIds as string]) : null;
  const resolvedFromNameIds = resolveTagNames(db, card.workspaceId, tagNames);
  if (resolvedFromNameIds.length > 0) {
    const baseTags = finalTagIds ?? (card.tagIds as string[] ?? []);
    finalTagIds = Array.from(new Set([...baseTags, ...resolvedFromNameIds]));
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE task_cards SET
        column_id   = COALESCE(?, column_id),
        title       = COALESCE(?, title),
        description = COALESCE(?, description),
        priority    = COALESCE(?, priority),
        due_date    = COALESCE(?, due_date),
        tag_ids     = COALESCE(?, tag_ids),
        assignee    = CASE WHEN ? = 1 THEN ? ELSE assignee END,
        updated_at  = ?,
        version     = version + 1
      WHERE id = ?
    `).run(
      columnId ?? null, title ?? null, description ?? null,
      priority ?? null, dueDate ?? null,
      finalTagIds != null ? j(finalTagIds) : null,
      assigneeSentinel, assigneeValue,
      now, cardId
    );
    insertNotification(db, "update_task", "Task updated", `"${title ?? card.title}" was updated`);
  })();
  // When moving to a done column, clear this card from other tasks' blocked_by_ids
  if (columnId !== undefined) {
    const targetCol = snap.columns.find((c) => c.id === columnId);
    if (targetCol?.type === "done") {
      const affected = db.prepare(
        "SELECT id, blocked_by_ids FROM task_cards WHERE blocked_by_ids != '[]' AND id != ?"
      ).all(cardId) as { id: string; blocked_by_ids: string }[];
      for (const row of affected) {
        const ids: string[] = j2(row.blocked_by_ids);
        if (ids.includes(cardId as string)) {
          db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?")
            .run(j(ids.filter((bid) => bid !== cardId)), now, row.id);
        }
      }
    }
  }
  const updated = db.prepare("SELECT * FROM task_cards WHERE id = ?").get(cardId) as Record<string, unknown> | undefined;
  return updated ?? { error: "Task not found after update" };
}
