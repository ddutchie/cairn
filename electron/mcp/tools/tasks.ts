/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import * as q from "../../db/queries";
import { newId } from "../../db/utils";
import { executeSearchTasks, executeListOverdueTasks, executeListTasksDue } from "../../shared/read-tools-pure";
import {
  Snapshot,
  getCardVersion,
  insertNotification,
  lockNote,
  resolveTagNames,
  unlockNote,
  writeNoteFile
} from "../db";

export function get_task(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const card = snap.cards.find((c) => c.id === args.cardId);
  if (!card) return { error: "Task not found" };
  const col = snap.columns.find((c) => c.id === card.columnId);
  const blockingCardIds = snap.cards
    .filter((c) => Array.isArray(c.blockedByIds) && c.blockedByIds.includes(card.id))
    .map((c) => c.id);
  return {
    id: card.id, title: card.title, description: card.description,
    priority: card.priority, dueDate: card.dueDate,
    columnId: card.columnId, columnName: col?.name ?? "Unknown", columnType: col?.type ?? "custom",
    linkedNoteIds: card.linkedNoteIds, blockedByIds: card.blockedByIds ?? [],
    blockingCardIds,
    projectId: card.projectId, createdAt: card.createdAt, updatedAt: card.updatedAt,
    version: getCardVersion(db, card.id) ?? 0,
  };
}

export function search_tasks(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  return executeSearchTasks(snap, args);
}

export function create_task(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { columnId, projectId, description, priority = "medium", dueDate, tagIds, tagNames } = args;
  const title = (args.title as string | null | undefined)?.trim();
  if (!title) return { error: "Task title is required" };
  const col = snap.columns.find((c) => c.id === columnId);
  if (!col) return { error: "Column not found" };
  const cardId = newId();
  const order = snap.cards.filter((c) => c.columnId === columnId).length;

  const resolvedFromNameIds = resolveTagNames(db, col.workspaceId, tagNames);
  let resolvedTagIds = Array.isArray(tagIds) ? tagIds as string[] : [];
  if (resolvedFromNameIds.length > 0) {
    resolvedTagIds = Array.from(new Set([...resolvedTagIds, ...resolvedFromNameIds]));
  }
  const card = q.createCard(db, {
    id: cardId,
    columnId: columnId as string,
    projectId: projectId as string,
    workspaceId: col.workspaceId as string,
    title: title as string,
    description: description,
    priority: priority as string,
    dueDate: dueDate,
    tagIds: resolvedTagIds,
    order,
  });
  const taskProject = snap.projects.find((pr) => pr.id === projectId);
  insertNotification(db, "create_task", "Task created", `"${title}" added to ${taskProject?.name ?? projectId}`, { type: "task", id: card.id });
  return card;
}

export function bulk_update_task_status(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { cardIds, targetColumnId } = args as { cardIds: string[]; targetColumnId: string };
  const col = snap.columns.find((c) => c.id === targetColumnId);
  if (!col) return { error: "Column not found" };
  if (!Array.isArray(cardIds) || cardIds.length === 0) return { error: "cardIds must be a non-empty array" };
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const id of cardIds) {
    const card = snap.cards.find((c) => c.id === id);
    if (!card) {
      results.push({ id, ok: false, error: "Task not found" });
    } else if (card.projectId !== col.projectId) {
      // A column belongs to exactly one project — moving a card across
      // projects would orphan it against a column not in its board.
      results.push({ id, ok: false, error: "Card is in a different project than the target column" });
    } else {
      q.updateCard(db, id, { columnId: targetColumnId });
      results.push({ id, ok: true });
    }
  }
  // When moving to a done column, clear all successfully-moved IDs from
  // any other task's blocked_by_ids.
  if (col.type === "done") {
    const movedIds = results.filter((r) => r.ok).map((r) => r.id);
    if (movedIds.length > 0) {
      q.clearBlockersFromAll(db, movedIds);
    }
  }
  const moved = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (moved > 0) insertNotification(db, "bulk_update_task_status", "Tasks moved", `${moved} task${moved === 1 ? "" : "s"} → ${col.name}`);
  return { moved, failed, targetColumnId, targetColumnName: col.name };
}

function applyNoteLinkChange(
  db: Database.Database,
  snap: Snapshot,
  workspacePath: string,
  args: { noteId: string; cardId: string },
  transform: {
    nextCardIds: (cur: string[]) => string[];
    nextNoteIds: (cur: string[]) => string[];
    notificationType: string;
    notificationMsg: (noteTitle: string, cardTitle: string) => string;
    resultKey: "linked" | "unlinked";
  }
) {
  const { noteId, cardId } = args;
  const note = snap.notes.find((n) => n.id === noteId);
  const card = snap.cards.find((c) => c.id === cardId);
  if (!note) return { error: "Note not found" };
  if (!card) return { error: "Card not found" };
  const newCardIds = transform.nextCardIds((note.linkedCardIds as string[]) ?? []);
  const newNoteIds = transform.nextNoteIds((card.linkedNoteIds as string[]) ?? []);
  const proj = snap.projects.find((p) => p.id === note.projectId);
  lockNote(db, noteId);
  let updatedNote: any;
  try {
    updatedNote = db.transaction(() => {
      const u = q.updateNote(db, noteId, { linkedCardIds: newCardIds });
      q.updateCard(db, cardId, { linkedNoteIds: newNoteIds });
      return u;
    })();
    // Must stay INSIDE the lock: writeNoteFile can relocate the .md (and unlink
    // the old path). The Electron file-watcher runs in a separate process, so its
    // only cross-process guard against treating that unlink as a delete is the
    // mcp_active_writes lock. Releasing the lock before this write (as this
    // function used to) let the watcher delete the note's DB row. See notes.ts —
    // every other note tool writes the file inside the lock for this reason.
    writeNoteFile(workspacePath, {
      id: noteId, projectId: note.projectId as string, workspaceId: note.workspaceId as string,
      title: note.title as string, content: updatedNote?.content ?? note.content as string,
      tagIds: note.tagIds as string[], linkedNoteIds: note.linkedNoteIds as string[],
      linkedCardIds: newCardIds, isPinned: note.isPinned as boolean,
      createdAt: note.createdAt as string, updatedAt: updatedNote?.updatedAt ?? new Date().toISOString(),
      archivedAt: note.archivedAt as string | undefined,
      projectName: proj?.name ?? note.projectId as string,
      folder: (note.folder as string) ?? "",
    });
  } finally {
    unlockNote(db, noteId);
  }
  insertNotification(
    db,
    transform.notificationType,
    transform.notificationType === "link_note_to_task" ? "Note linked to task" : "Note unlinked from task",
    transform.notificationMsg(note.title as string, card.title as string),
    { type: "task", id: cardId },
  );
  return { noteId, cardId, [transform.resultKey]: true };
}

export function link_note_to_task(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  return applyNoteLinkChange(db, snap, workspacePath, args as { noteId: string; cardId: string }, {
    nextCardIds: (cur) => Array.from(new Set([...cur, args.cardId as string])),
    nextNoteIds: (cur) => Array.from(new Set([...cur, args.noteId as string])),
    notificationType: "link_note_to_task",
    notificationMsg: (noteTitle, cardTitle) => `"${noteTitle}" linked to "${cardTitle}"`,
    resultKey: "linked",
  });
}

export function unlink_note_from_task(db: Database.Database, snap: Snapshot, workspacePath: string, args: Record<string, any>) {
  return applyNoteLinkChange(db, snap, workspacePath, args as { noteId: string; cardId: string }, {
    nextCardIds: (cur) => cur.filter((id) => id !== args.cardId as string),
    nextNoteIds: (cur) => cur.filter((id) => id !== args.noteId as string),
    notificationType: "unlink_note_from_task",
    notificationMsg: (noteTitle, cardTitle) => `"${noteTitle}" unlinked from "${cardTitle}"`,
    resultKey: "unlinked",
  });
}

export function delete_task(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const card = snap.cards.find((c) => c.id === args.cardId);
  if (!card) return { error: "Task not found" };
  q.deleteCard(db, args.cardId as string); // also cleans blocked_by_ids in other cards
  insertNotification(db, "delete_task", "Task deleted", `"${card.title}" was deleted`);
  return { deleted: true, id: args.cardId, title: card.title };
}

export function list_overdue_tasks(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  return executeListOverdueTasks(snap, args);
}

export function list_tasks_due(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  return executeListTasksDue(snap, args);
}

export function list_ready_tasks(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  // q.getReadyCards returns active non-done cards with no pending blockers.
  // We add columnName here (the query helper doesn't include it) so the MCP
  // surface keeps its existing return shape.
  const readyCards = q.getReadyCards(db, args.projectId as string | undefined);
  if (readyCards.length === 0) return [];
  // Resolve column names from the snapshot (cheap lookup, avoids a JOIN in queries.ts).
  const colNameById = new Map(snap.columns.map((c) => [c.id, c.name]));
  return readyCards.map((c) => {
    const out: Record<string, unknown> = {
      id: c.id,
      title: c.title,
      priority: c.priority,
      columnId: c.columnId,
      columnName: colNameById.get(c.columnId) ?? "Unknown",
      projectId: c.projectId,
    };
    // Ready tasks have no pending blockers by definition — omit empty arrays.
    if (c.dueDate) out.dueDate = c.dueDate;
    if (Array.isArray(c.blockedByIds) && c.blockedByIds.length > 0) out.blockedByIds = c.blockedByIds;
    return out;
  });
}

export function update_task(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const { cardId, title, description, priority, dueDate, columnId, tagIds, tagNames, assignee,
          archived, blockedBy, unblockFrom,
          expectedVersion: taskExpectedVersion } = args;

  // Must query DB directly for archived cards not in snap
  const _rawCard = snap.cards.find((c) => c.id === cardId)
    ?? q.getCardById(db, cardId as string);
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
    const updated = q.updateCard(db, cardId as string, {
      archivedAt: new Date().toISOString(),
    });
    // An archived blocker no longer blocks anything — clear its ID from every
    // other task's blocked_by_ids so get_task stops reporting a pending dep.
    q.clearBlockersFromAll(db, [cardId as string]);
    insertNotification(db, "update_task", "Task archived", `"${card.title}" was archived`, { type: "task", id: card.id });
    return updated;
  }
  if (archived === false) {
    // Must query DB directly — archived cards are filtered from snap
    const dbCard = q.getCardById(db, cardId as string);
    if (!dbCard) return { error: "Task not found" };
    // Some clients send archived=false as the default for an ordinary update.
    // Only treat it as a restore request when the card is actually archived.
    if (dbCard.archivedAt) {
      const updated = q.restoreCard(db, cardId as string);
      insertNotification(db, "update_task", "Task restored", `"${dbCard.title}" was restored`, { type: "task", id: dbCard.id });
      return updated;
    }
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
    const updated = q.addCardBlocker(db, cardId as string, blockedBy as string);
    insertNotification(db, "update_task", "Task blocked", `"${card.title}" is now blocked by "${blocker.title}"`, { type: "task", id: card.id });
    return {
      ...updated,
      cardId,
      blockerCardId: blockedBy,
      blocked: true,
    };
  }
  if (unblockFrom !== undefined) {
    const updated = q.removeCardBlocker(db, cardId as string, unblockFrom as string);
    return {
      ...updated,
      cardId,
      blockerCardId: unblockFrom,
      unblocked: true,
    };
  }

  // ── clear due date ─────────────────────────────────────────────────────
  if (dueDate === null) {
    db.transaction(() => {
      q.clearCardDueDate(db, cardId as string);
      q.updateCard(db, cardId as string, {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(columnId !== undefined ? { columnId } : {}),
        ...(assignee !== undefined ? { assignee: assignee as string | null } : {}),
      });
      insertNotification(db, "update_task", "Task updated", `"${title ?? card.title}" was updated`, { type: "task", id: card.id });
    })();
    const result = q.getCardById(db, cardId as string);
    // When moving to a done column, clear this card from other tasks' blocked_by_ids
    if (columnId !== undefined) {
      const targetCol = snap.columns.find((c) => c.id === columnId);
      if (targetCol?.type === "done") {
        q.clearBlockersFromAll(db, [cardId as string]);
      }
    }
    return result ?? { error: "Task not found after update" };
  }

  // ── field update ───────────────────────────────────────────────────────
  // Resolve tag names to IDs
  let finalTagIds = tagIds != null ? (Array.isArray(tagIds) ? (tagIds as string[]) : [tagIds as string]) : null;
  const resolvedFromNameIds = resolveTagNames(db, card.workspaceId, tagNames);
  if (resolvedFromNameIds.length > 0) {
    const baseTags = finalTagIds ?? (card.tagIds as string[] ?? []);
    finalTagIds = Array.from(new Set([...baseTags, ...resolvedFromNameIds]));
  }

  const patch: Parameters<typeof q.updateCard>[2] = {};
  if (columnId !== undefined) patch.columnId = columnId as string;
  if (title !== undefined) patch.title = title as string;
  if (description !== undefined) patch.description = description as string;
  if (priority !== undefined) patch.priority = priority as string;
  if (dueDate !== undefined) patch.dueDate = dueDate as string;
  if (finalTagIds !== null) patch.tagIds = finalTagIds;
  if (assignee !== undefined) patch.assignee = (assignee as string) || null;

  const updated = db.transaction(() => {
    const card = q.updateCard(db, cardId as string, patch);
    insertNotification(db, "update_task", "Task updated", `"${title ?? card.title}" was updated`, { type: "task", id: card.id });
    return card;
  })();

  // When moving to a done column, clear this card from other tasks' blocked_by_ids
  if (columnId !== undefined) {
    const targetCol = snap.columns.find((c) => c.id === columnId);
    if (targetCol?.type === "done") {
      q.clearBlockersFromAll(db, [cardId as string]);
    }
  }
  return updated ?? { error: "Task not found after update" };
}
