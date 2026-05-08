import type { StateCreator } from "zustand";
import type { AppStore } from "../index";
import type { Note } from "../../../src/types/index";
import * as queries from "../../db/queries";

const now = () => new Date().toISOString();

export interface NotesSlice {
  notes: Note[];
  activeNote: Note | null;
  loadNotes: (projectId: string) => Promise<void>;
  loadNote: (noteId: string) => Promise<void>;
  updateNote: (noteId: string, patch: Partial<Pick<Note, "title" | "content" | "contentText">>) => Promise<void>;
  clearActiveNote: () => void;
}

export const createNotesSlice: StateCreator<AppStore, [], [], NotesSlice> = (set) => ({
  notes: [],
  activeNote: null,

  loadNotes: async (projectId) => {
    const notes = await queries.getNotes(projectId);
    set({ notes });
  },

  loadNote: async (noteId) => {
    const note = await queries.getNote(noteId);
    set({ activeNote: note });
  },

  updateNote: async (noteId, patch) => {
    const timestamp = now();
    // Optimistic update
    set((state) => ({
      notes: state.notes.map((n) =>
        n.id === noteId ? { ...n, ...patch, updatedAt: timestamp } : n
      ),
      activeNote:
        state.activeNote?.id === noteId
          ? { ...state.activeNote, ...patch, updatedAt: timestamp }
          : state.activeNote,
    }));
    await queries.updateNote(noteId, patch, timestamp);
  },

  clearActiveNote: () => set({ activeNote: null }),
});
