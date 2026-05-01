/**
 * Board slice — columns and task cards.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { BoardColumn, TaskCard, ID } from "@/types";
import { id, now } from "@/lib/utils";
import { ipc } from "../ipc";
import { historyManager } from "@/lib/history";
import {
  makeCreateCardCmd,
  makeUpdateCardCmd,
  makeMoveCardCmd,
  makeDeleteCardCmd,
  makeArchiveCardCmd,
  makeDuplicateCardCmd,
  makeUnlinkNoteFromCardCmd,
  makeCreateColumnCmd,
  makeUpdateColumnCmd,
  makeDeleteColumnCmd,
  makeReorderColumnsCmd,
  makeReorderCardsCmd,
  makeRestoreCardCmd,
  makeMoveCardToProjectCmd,
} from "@/lib/commands/card-commands";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface BoardSlice {
  columns: BoardColumn[];
  cards: TaskCard[];

  createColumn: (projectId: ID, name: string) => BoardColumn;
  updateColumn: (
    id: ID,
    patch: Partial<Pick<BoardColumn, "name" | "order" | "cardLimit">>
  ) => void;
  deleteColumn: (id: ID) => void;
  reorderColumns: (projectId: ID, columnIds: ID[]) => void;

  createCard: (
    columnId: ID,
    projectId: ID,
    title: string,
    extras?: { dueDate?: string; assignee?: string }
  ) => TaskCard;
  updateCard: (id: ID, patch: Partial<TaskCard>) => void;
  moveCard: (cardId: ID, targetColumnId: ID, targetIndex: number) => void;
  deleteCard: (id: ID) => void;
  reorderCards: (columnId: ID, cardIds: ID[]) => void;
  archiveCard: (id: ID) => void;
  restoreCard: (id: ID) => void;
  moveCardToProject: (cardId: ID, targetProjectId: ID) => void;
  duplicateCard: (id: ID) => TaskCard | null;
  unlinkNoteFromCard: (noteId: ID, cardId: ID) => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createBoardSlice: StateCreator<CairnStore, [], [], BoardSlice> = (
  set,
  get
) => ({
  columns: [],
  cards: [],

  // ── Columns ────────────────────────────────────
  createColumn(projectId, name) {
    const proj = get().projects.find((p) => p.id === projectId);
    const cols = get().columns.filter((c) => c.projectId === projectId);
    const col: BoardColumn = {
      id: id(),
      projectId,
      workspaceId: proj?.workspaceId ?? "",
      name,
      type: "custom",
      order: cols.length,
      createdAt: now(),
      updatedAt: now(),
    };
    set((s) => ({ columns: [...s.columns, col] }));
    get().persist();
    ipc((e) => e.column.create(col));
    historyManager.push(makeCreateColumnCmd(col, set));
    return col;
  },

  updateColumn(colId, patch) {
    const prev = get().columns.find((c) => c.id === colId);
    const prevPatch = prev
      ? Object.fromEntries(Object.keys(patch).map((k) => [k, (prev as unknown as Record<string, unknown>)[k]])) as Partial<BoardColumn>
      : {} as Partial<BoardColumn>;
    set((s) => ({
      columns: s.columns.map((c) =>
        c.id === colId ? { ...c, ...patch, updatedAt: now() } : c
      ),
    }));
    get().persist();
    ipc((e) => e.column.update(colId, patch));
    historyManager.push(makeUpdateColumnCmd(colId, prevPatch, patch, set));
  },

  deleteColumn(colId) {
    const col = get().columns.find((c) => c.id === colId);
    const deletedCards = get().cards.filter((c) => c.columnId === colId);
    set((s) => ({
      columns: s.columns.filter((c) => c.id !== colId),
      cards: s.cards.filter((c) => c.columnId !== colId),
    }));
    get().persist();
    ipc((e) => (e.column as { delete: (id: string) => Promise<unknown> }).delete(colId));
    if (col) historyManager.push(makeDeleteColumnCmd(col, deletedCards, set));
  },

  reorderColumns(projectId, columnIds) {
    const prevColumnIds = get().columns
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => a.order - b.order)
      .map((c) => c.id);
    set((s) => ({
      columns: s.columns.map((c) => {
        if (c.projectId !== projectId) return c;
        const newOrder = columnIds.indexOf(c.id);
        return newOrder >= 0 ? { ...c, order: newOrder, updatedAt: now() } : c;
      }),
    }));
    get().persist();
    columnIds.forEach((colId, order) => {
      ipc((e) => e.column.update(colId, { order }));
    });
    historyManager.push(makeReorderColumnsCmd(projectId, prevColumnIds, columnIds, set));
  },

  // ── Cards ──────────────────────────────────────
  createCard(columnId, projectId, title, extras) {
    const col = get().columns.find((c) => c.id === columnId);
    const cards = get().cards.filter((c) => c.columnId === columnId);
    const card: TaskCard = {
      id: id(),
      columnId,
      projectId,
      workspaceId: col?.workspaceId ?? "",
      title,
      tagIds: [],
      priority: "medium",
      linkedNoteIds: [],
      order: cards.length,
      createdAt: now(),
      updatedAt: now(),
      ...(extras?.dueDate ? { dueDate: extras.dueDate } : {}),
      ...(extras?.assignee ? { assignee: extras.assignee } : {}),
    };
    set((s) => ({ cards: [...s.cards, card] }));
    get().persist();
    ipc((e) => e.card.create(card));
    historyManager.push(makeCreateCardCmd(card, set));
    return card;
  },

  updateCard(cardId, patch) {
    const prev = get().cards.find((c) => c.id === cardId);
    const prevPatch = prev
      ? Object.fromEntries(Object.keys(patch).map((k) => [k, (prev as unknown as Record<string, unknown>)[k]])) as Partial<TaskCard>
      : {} as Partial<TaskCard>;
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId ? { ...c, ...patch, updatedAt: now() } : c
      ),
    }));
    get().persist();
    ipc((e) => e.card.update(cardId, patch));
    historyManager.push(makeUpdateCardCmd(cardId, prevPatch, patch, set));
  },

  moveCard(cardId, targetColumnId, targetIndex) {
    const cards = get().cards;
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    const prevColumnId = card.columnId;
    const prevOrder = card.order;

    const oldColCards = cards
      .filter((c) => c.columnId === card.columnId && c.id !== cardId)
      .sort((a, b) => a.order - b.order)
      .map((c, i) => ({ ...c, order: i }));

    const newColCards = cards
      .filter((c) => c.columnId === targetColumnId && c.id !== cardId)
      .sort((a, b) => a.order - b.order);

    newColCards.splice(targetIndex, 0, {
      ...card,
      columnId: targetColumnId,
      updatedAt: now(),
    });

    const reindexedNew = newColCards.map((c, i) => ({ ...c, order: i }));

    const untouched = cards.filter(
      (c) => c.columnId !== card.columnId && c.columnId !== targetColumnId
    );

    const isSameColumn = card.columnId === targetColumnId;

    set({
      cards: isSameColumn
        ? [...untouched, ...reindexedNew]
        : [...untouched, ...oldColCards, ...reindexedNew],
    });
    get().persist();
    ipc((e) =>
      e.card.update(cardId, { columnId: targetColumnId, order: targetIndex })
    );
    const targetCol = get().columns.find((c) => c.id === targetColumnId);
    historyManager.push(makeMoveCardCmd(
      cardId, prevColumnId, prevOrder,
      targetColumnId, targetIndex,
      targetCol?.name ?? "column",
      get, set,
    ));
  },

  deleteCard(cardId) {
    const savedCard = get().cards.find((c) => c.id === cardId);
    set((s) => ({
      cards: s.cards.filter((c) => c.id !== cardId),
      notes: s.notes.map((n) => ({
        ...n,
        linkedCardIds: n.linkedCardIds.filter((cId) => cId !== cardId),
      })),
    }));
    get().persist();
    ipc((e) => e.card.delete(cardId));
    if (savedCard) historyManager.push(makeDeleteCardCmd(savedCard, set));
  },

  reorderCards(columnId, cardIds) {
    const prevCardIds = get().cards
      .filter((c) => c.columnId === columnId)
      .sort((a, b) => a.order - b.order)
      .map((c) => c.id);
    set((s) => ({
      cards: s.cards.map((c) => {
        if (c.columnId !== columnId) return c;
        const newOrder = cardIds.indexOf(c.id);
        return newOrder >= 0 ? { ...c, order: newOrder } : c;
      }),
    }));
    get().persist();
    cardIds.forEach((cardId, order) => {
      ipc((e) => e.card.update(cardId, { order }));
    });
    historyManager.push(makeReorderCardsCmd(columnId, prevCardIds, cardIds, set));
  },

  archiveCard(cardId) {
    const archivedAt = now();
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId ? { ...c, archivedAt, updatedAt: now() } : c
      ),
    }));
    get().persist();
    ipc((e) => e.card.update(cardId, { archivedAt }));
    historyManager.push(makeArchiveCardCmd(cardId, archivedAt, set));
  },

  restoreCard(cardId) {
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId
          ? { ...c, archivedAt: undefined, updatedAt: now() }
          : c
      ),
    }));
    get().persist();
    ipc((e) => e.card.update(cardId, { archivedAt: null }));
    historyManager.push(makeRestoreCardCmd(cardId, set));
  },

  moveCardToProject(cardId, targetProjectId) {
    const state = get();
    const card = state.cards.find((c) => c.id === cardId);
    const targetProject = state.projects.find((p) => p.id === targetProjectId);
    if (!card || !targetProject) return;
    const targetColumns = state.columns
      .filter((c) => c.projectId === targetProjectId)
      .sort((a, b) => a.order - b.order);
    const targetColumn =
      targetColumns.find((c) => c.type === "backlog") ?? targetColumns[0];
    if (!targetColumn) return;
    const newOrder = state.cards.filter(
      (c) => c.columnId === targetColumn.id && !c.archivedAt
    ).length;
    const prevProjectId = card.projectId;
    const prevColumnId = card.columnId;
    const prevOrder = card.order;
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId
          ? {
              ...c,
              projectId: targetProjectId,
              workspaceId: targetProject.workspaceId,
              columnId: targetColumn.id,
              order: newOrder,
              updatedAt: now(),
            }
          : c
      ),
    }));
    get().persist();
    ipc((e) =>
      e.card.update(cardId, {
        projectId: targetProjectId,
        workspaceId: targetProject.workspaceId,
        columnId: targetColumn.id,
        order: newOrder,
      })
    );
    historyManager.push(makeMoveCardToProjectCmd(
      cardId, prevProjectId, prevColumnId, prevOrder,
      targetProjectId, targetColumn.id, newOrder, targetProject.workspaceId,
      set,
    ));
  },

  duplicateCard(cardId) {
    const card = get().cards.find((c) => c.id === cardId);
    if (!card) return null;
    const colCards = get().cards.filter(
      (c) => c.columnId === card.columnId && !c.archivedAt
    );
    const newCard: TaskCard = {
      ...card,
      id: id(),
      title: `${card.title} (copy)`,
      order: colCards.length,
      createdAt: now(),
      updatedAt: now(),
      linkedNoteIds: [],
    };
    set((s) => ({ cards: [...s.cards, newCard] }));
    get().persist();
    ipc((e) => e.card.create(newCard));
    historyManager.push(makeDuplicateCardCmd(newCard, set));
    return newCard;
  },

  unlinkNoteFromCard(noteId, cardId) {
    const prevCard = get().cards.find((c) => c.id === cardId);
    const prevNote = get().notes.find((n) => n.id === noteId);
    const prevCardLinkedNoteIds = prevCard?.linkedNoteIds ?? [];
    const prevNoteLinkedCardIds = prevNote?.linkedCardIds ?? [];
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId
          ? {
              ...c,
              linkedNoteIds: c.linkedNoteIds.filter((id) => id !== noteId),
              updatedAt: now(),
            }
          : c
      ),
      notes: s.notes.map((n) =>
        n.id === noteId
          ? {
              ...n,
              linkedCardIds: n.linkedCardIds.filter((id) => id !== cardId),
              updatedAt: now(),
            }
          : n
      ),
    }));
    get().persist();
    const card = get().cards.find((c) => c.id === cardId);
    const note = get().notes.find((n) => n.id === noteId);
    if (card)
      ipc((e) => e.card.update(cardId, { linkedNoteIds: card.linkedNoteIds }));
    if (note)
      ipc((e) => e.note.update(noteId, { linkedCardIds: note.linkedCardIds }));
    historyManager.push(makeUnlinkNoteFromCardCmd(
      noteId, cardId, prevCardLinkedNoteIds, prevNoteLinkedCardIds, set,
    ));
  },
});
