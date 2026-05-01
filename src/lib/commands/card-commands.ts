/**
 * Cairn — Card (task) undo/redo commands
 */

import type { TaskCard, Note, ID } from "@/types";
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
