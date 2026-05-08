import type { StateCreator } from "zustand";
import type { AppStore } from "../index";
import type { BoardColumn, TaskCard } from "../../../src/types/index";
import * as queries from "../../db/queries";
import { customAlphabet } from "nanoid/non-secure";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 12);
const now = () => new Date().toISOString();

export interface BoardSlice {
  columns: BoardColumn[];
  cards: TaskCard[];
  loadBoard: (projectId: string) => Promise<void>;
  moveCard: (cardId: string, targetColumnId: string) => Promise<void>;
  createCard: (
    projectId: string,
    workspaceId: string,
    columnId: string,
    title: string,
    priority?: TaskCard["priority"]
  ) => Promise<void>;
  updateCard: (
    cardId: string,
    patch: Partial<Pick<TaskCard, "title" | "description" | "priority" | "dueDate" | "assignee">>
  ) => Promise<void>;
}

export const createBoardSlice: StateCreator<AppStore, [], [], BoardSlice> = (set, get) => ({
  columns: [],
  cards: [],

  loadBoard: async (projectId) => {
    const [columns, cards] = await Promise.all([
      queries.getColumns(projectId),
      queries.getCards(projectId),
    ]);
    set({ columns, cards });
  },

  moveCard: async (cardId, targetColumnId) => {
    const timestamp = now();
    // Optimistic update
    set((state) => ({
      cards: state.cards.map((c) =>
        c.id === cardId ? { ...c, columnId: targetColumnId, updatedAt: timestamp } : c
      ),
    }));
    await queries.moveCard(cardId, targetColumnId, timestamp);
  },

  createCard: async (projectId, workspaceId, columnId, title, priority = "medium") => {
    const timestamp = now();
    const existingInColumn = get().cards.filter((c) => c.columnId === columnId);
    const card: TaskCard = {
      id: nanoid(),
      columnId,
      projectId,
      workspaceId,
      title,
      priority,
      tagIds: [],
      linkedNoteIds: [],
      blockedByIds: [],
      order: existingInColumn.length,
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    // Optimistic update
    set((state) => ({ cards: [...state.cards, card] }));
    await queries.createCard(card);
  },

  updateCard: async (cardId, patch) => {
    const timestamp = now();
    // Optimistic update
    set((state) => ({
      cards: state.cards.map((c) =>
        c.id === cardId ? { ...c, ...patch, updatedAt: timestamp } : c
      ),
    }));
    await queries.updateCard(cardId, patch, timestamp);
  },
});
