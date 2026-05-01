/**
 * Cairn — Card (task) undo/redo commands
 */

import type { TaskCard, BoardColumn, ID } from "@/types";
import type { Command } from "@/lib/history";
import { ipc } from "@/store/ipc";
import { now } from "@/lib/utils";
import type { CairnStore } from "@/store";

type StoreSet = (fn: (s: CairnStore) => Partial<CairnStore>) => void;
type StoreGet = () => CairnStore;

// ── Command factories ──────────────────────────────────────────────────────────

export function makeCreateCardCmd(
  card: TaskCard,
  set: StoreSet,
): Command {
  return {
    label: `Create task "${card.title}"`,
    async undo() {
      set((s) => ({
        cards: s.cards.filter((c) => c.id !== card.id),
        notes: s.notes.map((n) => ({
          ...n,
          linkedCardIds: n.linkedCardIds.filter((id) => id !== card.id),
        })),
      }));
      ipc((e) => e.card.delete(card.id));
    },
    async redo() {
      set((s) => ({ cards: [...s.cards, card] }));
      ipc((e) => e.card.create(card));
    },
  };
}

export function makeUpdateCardCmd(
  cardId: ID,
  prevPatch: Partial<TaskCard>,
  newPatch: Partial<TaskCard>,
  set: StoreSet,
): Command {
  return {
    label: `Update task`,
    async undo() {
      set((s) => ({
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, ...prevPatch, updatedAt: now() } : c,
        ),
      }));
      ipc((e) => e.card.update(cardId, prevPatch));
    },
    async redo() {
      set((s) => ({
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, ...newPatch, updatedAt: now() } : c,
        ),
      }));
      ipc((e) => e.card.update(cardId, newPatch));
    },
  };
}

export function makeMoveCardCmd(
  cardId: ID,
  prevColumnId: ID,
  prevOrder: number,
  targetColumnId: ID,
  targetIndex: number,
  targetColumnName: string,
  get: StoreGet,
  set: StoreSet,
): Command {
  return {
    label: `Move task to "${targetColumnName}"`,
    async undo() {
      // Restore: put card back in prevColumnId at prevOrder
      const cards = get().cards;
      const card = cards.find((c) => c.id === cardId);
      if (!card) return;

      const oldColCards = cards
        .filter((c) => c.columnId === targetColumnId && c.id !== cardId)
        .sort((a, b) => a.order - b.order)
        .map((c, i) => ({ ...c, order: i }));

      const prevColCards = cards
        .filter((c) => c.columnId === prevColumnId && c.id !== cardId)
        .sort((a, b) => a.order - b.order);
      prevColCards.splice(prevOrder, 0, { ...card, columnId: prevColumnId, updatedAt: now() });
      const reindexedPrev = prevColCards.map((c, i) => ({ ...c, order: i }));

      const untouched = cards.filter(
        (c) => c.columnId !== prevColumnId && c.columnId !== targetColumnId,
      );
      const isSame = prevColumnId === targetColumnId;
      set(() => ({
        cards: isSame ? [...untouched, ...reindexedPrev] : [...untouched, ...oldColCards, ...reindexedPrev],
      }));
      ipc((e) => e.card.update(cardId, { columnId: prevColumnId, order: prevOrder }));
    },
    async redo() {
      const cards = get().cards;
      const card = cards.find((c) => c.id === cardId);
      if (!card) return;

      const oldColCards = cards
        .filter((c) => c.columnId === card.columnId && c.id !== cardId)
        .sort((a, b) => a.order - b.order)
        .map((c, i) => ({ ...c, order: i }));

      const newColCards = cards
        .filter((c) => c.columnId === targetColumnId && c.id !== cardId)
        .sort((a, b) => a.order - b.order);
      newColCards.splice(targetIndex, 0, { ...card, columnId: targetColumnId, updatedAt: now() });
      const reindexedNew = newColCards.map((c, i) => ({ ...c, order: i }));

      const untouched = cards.filter(
        (c) => c.columnId !== card.columnId && c.columnId !== targetColumnId,
      );
      const isSame = card.columnId === targetColumnId;
      set(() => ({
        cards: isSame ? [...untouched, ...reindexedNew] : [...untouched, ...oldColCards, ...reindexedNew],
      }));
      ipc((e) => e.card.update(cardId, { columnId: targetColumnId, order: targetIndex }));
    },
  };
}

export function makeDeleteCardCmd(
  savedCard: TaskCard,
  set: StoreSet,
): Command {
  return {
    label: `Delete task "${savedCard.title}"`,
    async undo() {
      set((s) => ({ cards: [...s.cards, savedCard] }));
      ipc((e) => e.card.create(savedCard));
    },
    async redo() {
      set((s) => ({
        cards: s.cards.filter((c) => c.id !== savedCard.id),
        notes: s.notes.map((n) => ({
          ...n,
          linkedCardIds: n.linkedCardIds.filter((id) => id !== savedCard.id),
        })),
      }));
      ipc((e) => e.card.delete(savedCard.id));
    },
  };
}

export function makeArchiveCardCmd(
  cardId: ID,
  archivedAt: string,
  set: StoreSet,
): Command {
  return {
    label: `Archive task`,
    async undo() {
      set((s) => ({
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, archivedAt: undefined, updatedAt: now() } : c,
        ),
      }));
      ipc((e) => e.card.update(cardId, { archivedAt: null }));
    },
    async redo() {
      set((s) => ({
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, archivedAt, updatedAt: now() } : c,
        ),
      }));
      ipc((e) => e.card.update(cardId, { archivedAt }));
    },
  };
}

export function makeDuplicateCardCmd(
  newCard: TaskCard,
  set: StoreSet,
): Command {
  return {
    label: `Duplicate task "${newCard.title}"`,
    async undo() {
      set((s) => ({ cards: s.cards.filter((c) => c.id !== newCard.id) }));
      ipc((e) => e.card.delete(newCard.id));
    },
    async redo() {
      set((s) => ({ cards: [...s.cards, newCard] }));
      ipc((e) => e.card.create(newCard));
    },
  };
}

export function makeUnlinkNoteFromCardCmd(
  noteId: ID,
  cardId: ID,
  prevCardLinkedNoteIds: ID[],
  prevNoteLinkedCardIds: ID[],
  set: StoreSet,
): Command {
  return {
    label: `Unlink note from task`,
    async undo() {
      set((s) => ({
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, linkedNoteIds: prevCardLinkedNoteIds, updatedAt: now() } : c,
        ),
        notes: s.notes.map((n) =>
          n.id === noteId ? { ...n, linkedCardIds: prevNoteLinkedCardIds, updatedAt: now() } : n,
        ),
      }));
      ipc((e) => e.card.update(cardId, { linkedNoteIds: prevCardLinkedNoteIds }));
      ipc((e) => e.note.update(noteId, { linkedCardIds: prevNoteLinkedCardIds }));
    },
    async redo() {
      const newCardLinkedNoteIds = prevCardLinkedNoteIds.filter((id) => id !== noteId);
      const newNoteLinkedCardIds = prevNoteLinkedCardIds.filter((id) => id !== cardId);
      set((s) => ({
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, linkedNoteIds: newCardLinkedNoteIds, updatedAt: now() } : c,
        ),
        notes: s.notes.map((n) =>
          n.id === noteId ? { ...n, linkedCardIds: newNoteLinkedCardIds, updatedAt: now() } : n,
        ),
      }));
      ipc((e) => e.card.update(cardId, { linkedNoteIds: newCardLinkedNoteIds }));
      ipc((e) => e.note.update(noteId, { linkedCardIds: newNoteLinkedCardIds }));
    },
  };
}

// ── Column commands ────────────────────────────────────────────────────────────

export function makeCreateColumnCmd(
  col: BoardColumn,
  set: StoreSet,
): Command {
  return {
    label: `Create column "${col.name}"`,
    async undo() {
      set((s) => ({
        columns: s.columns.filter((c) => c.id !== col.id),
        cards: s.cards.filter((c) => c.columnId !== col.id),
      }));
      ipc((e) => (e.column as { delete: (id: string) => Promise<unknown> }).delete(col.id));
    },
    async redo() {
      set((s) => ({ columns: [...s.columns, col] }));
      ipc((e) => e.column.create(col));
    },
  };
}

export function makeUpdateColumnCmd(
  colId: ID,
  prevPatch: Partial<BoardColumn>,
  newPatch: Partial<BoardColumn>,
  set: StoreSet,
): Command {
  return {
    label: `Rename column`,
    async undo() {
      set((s) => ({
        columns: s.columns.map((c) =>
          c.id === colId ? { ...c, ...prevPatch, updatedAt: now() } : c
        ),
      }));
      ipc((e) => e.column.update(colId, prevPatch));
    },
    async redo() {
      set((s) => ({
        columns: s.columns.map((c) =>
          c.id === colId ? { ...c, ...newPatch, updatedAt: now() } : c
        ),
      }));
      ipc((e) => e.column.update(colId, newPatch));
    },
  };
}

export function makeDeleteColumnCmd(
  col: BoardColumn,
  deletedCards: TaskCard[],
  set: StoreSet,
): Command {
  return {
    label: `Delete column "${col.name}"`,
    async undo() {
      set((s) => ({
        columns: [...s.columns, col],
        cards: [...s.cards, ...deletedCards],
      }));
      ipc((e) => e.column.create(col));
      for (const card of deletedCards) {
        ipc((e) => e.card.create(card));
      }
    },
    async redo() {
      set((s) => ({
        columns: s.columns.filter((c) => c.id !== col.id),
        cards: s.cards.filter((c) => c.columnId !== col.id),
      }));
      ipc((e) => (e.column as { delete: (id: string) => Promise<unknown> }).delete(col.id));
    },
  };
}

export function makeReorderColumnsCmd(
  projectId: ID,
  prevColumnIds: ID[],
  newColumnIds: ID[],
  set: StoreSet,
): Command {
  return {
    label: `Reorder columns`,
    async undo() {
      set((s) => ({
        columns: s.columns.map((c) => {
          if (c.projectId !== projectId) return c;
          const order = prevColumnIds.indexOf(c.id);
          return order >= 0 ? { ...c, order, updatedAt: now() } : c;
        }),
      }));
      prevColumnIds.forEach((colId, order) => {
        ipc((e) => e.column.update(colId, { order }));
      });
    },
    async redo() {
      set((s) => ({
        columns: s.columns.map((c) => {
          if (c.projectId !== projectId) return c;
          const order = newColumnIds.indexOf(c.id);
          return order >= 0 ? { ...c, order, updatedAt: now() } : c;
        }),
      }));
      newColumnIds.forEach((colId, order) => {
        ipc((e) => e.column.update(colId, { order }));
      });
    },
  };
}

export function makeReorderCardsCmd(
  columnId: ID,
  prevCardIds: ID[],
  newCardIds: ID[],
  set: StoreSet,
): Command {
  return {
    label: `Reorder tasks`,
    async undo() {
      set((s) => ({
        cards: s.cards.map((c) => {
          if (c.columnId !== columnId) return c;
          const order = prevCardIds.indexOf(c.id);
          return order >= 0 ? { ...c, order } : c;
        }),
      }));
      prevCardIds.forEach((cardId, order) => {
        ipc((e) => e.card.update(cardId, { order }));
      });
    },
    async redo() {
      set((s) => ({
        cards: s.cards.map((c) => {
          if (c.columnId !== columnId) return c;
          const order = newCardIds.indexOf(c.id);
          return order >= 0 ? { ...c, order } : c;
        }),
      }));
      newCardIds.forEach((cardId, order) => {
        ipc((e) => e.card.update(cardId, { order }));
      });
    },
  };
}

export function makeRestoreCardCmd(
  cardId: ID,
  set: StoreSet,
): Command {
  return {
    label: `Restore task`,
    async undo() {
      const archivedAt = now();
      set((s) => ({
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, archivedAt, updatedAt: now() } : c
        ),
      }));
      ipc((e) => e.card.update(cardId, { archivedAt }));
    },
    async redo() {
      set((s) => ({
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, archivedAt: undefined, updatedAt: now() } : c
        ),
      }));
      ipc((e) => e.card.update(cardId, { archivedAt: null }));
    },
  };
}

export function makeMoveCardToProjectCmd(
  cardId: ID,
  prevProjectId: ID,
  prevColumnId: ID,
  prevOrder: number,
  newProjectId: ID,
  newColumnId: ID,
  newOrder: number,
  newWorkspaceId: ID,
  set: StoreSet,
): Command {
  return {
    label: `Move task to project`,
    async undo() {
      set((s) => ({
        cards: s.cards.map((c) =>
          c.id === cardId
            ? { ...c, projectId: prevProjectId, columnId: prevColumnId, order: prevOrder, updatedAt: now() }
            : c
        ),
      }));
      ipc((e) => e.card.update(cardId, { projectId: prevProjectId, columnId: prevColumnId, order: prevOrder }));
    },
    async redo() {
      set((s) => ({
        cards: s.cards.map((c) =>
          c.id === cardId
            ? { ...c, projectId: newProjectId, workspaceId: newWorkspaceId, columnId: newColumnId, order: newOrder, updatedAt: now() }
            : c
        ),
      }));
      ipc((e) => e.card.update(cardId, { projectId: newProjectId, workspaceId: newWorkspaceId, columnId: newColumnId, order: newOrder }));
    },
  };
}
