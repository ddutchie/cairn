/**
 * Notes slice — CRUD, archive/restore, move, link.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { Note, ID, NoteType } from "@/types";
import { id, now } from "@/lib/utils";
import { ipc } from "../ipc";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface NotesSlice {
  notes: Note[];

  createNote: (projectId: ID, title: string, type?: NoteType) => Note;
  updateNote: (id: ID, patch: Partial<Note>) => void;
  deleteNote: (id: ID) => void;
  archiveNote: (id: ID) => void;
  restoreNote: (id: ID) => void;
  moveNoteToProject: (noteId: ID, targetProjectId: ID) => void;
  linkNoteToCard: (noteId: ID, cardId: ID) => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createNotesSlice: StateCreator<CairnStore, [], [], NotesSlice> = (
  set,
  get
) => ({
  notes: [],

  createNote(projectId, title, type = "note") {
    const proj = get().projects.find((p) => p.id === projectId);
    const note: Note = {
      id: id(),
      projectId,
      workspaceId: proj?.workspaceId ?? "",
      title,
      content: "",
      contentText: "",
      tagIds: [],
      linkedNoteIds: [],
      linkedCardIds: [],
      isPinned: false,
      type,
      createdAt: now(),
      updatedAt: now(),
    };
    set((s) => ({ notes: [...s.notes, note] }));
    get().persist();
    ipc((e) => e.note.create(note));
    return note;
  },

  updateNote(noteId, patch) {
    set((s) => ({
      notes: s.notes.map((n) =>
        n.id === noteId ? { ...n, ...patch, updatedAt: now() } : n
      ),
    }));
    get().persist();
    ipc((e) => e.note.update(noteId, patch));
  },

  deleteNote(noteId) {
    set((s) => ({
      notes: s.notes.filter((n) => n.id !== noteId),
      cards: s.cards.map((c) => ({
        ...c,
        linkedNoteIds: c.linkedNoteIds.filter((nId) => nId !== noteId),
      })),
    }));
    get().persist();
    ipc((e) => e.note.delete(noteId));
  },

  archiveNote(noteId) {
    const archivedAt = now();
    set((s) => ({
      notes: s.notes.map((n) =>
        n.id === noteId ? { ...n, archivedAt, updatedAt: now() } : n
      ),
    }));
    get().persist();
    ipc((e) => e.note.update(noteId, { archivedAt }));
  },

  restoreNote(noteId) {
    set((s) => ({
      notes: s.notes.map((n) =>
        n.id === noteId ? { ...n, archivedAt: undefined, updatedAt: now() } : n
      ),
    }));
    get().persist();
    ipc((e) => e.note.update(noteId, { archivedAt: null }));
  },

  moveNoteToProject(noteId, targetProjectId) {
    const targetProject = get().projects.find((p) => p.id === targetProjectId);
    if (!targetProject) return;
    set((s) => ({
      notes: s.notes.map((n) =>
        n.id === noteId
          ? {
              ...n,
              projectId: targetProjectId,
              workspaceId: targetProject.workspaceId,
              updatedAt: now(),
            }
          : n
      ),
    }));
    get().persist();
    ipc((e) => e.note.update(noteId, { projectId: targetProjectId }));
  },

  linkNoteToCard(noteId, cardId) {
    set((s) => ({
      notes: s.notes.map((n) =>
        n.id === noteId
          ? {
              ...n,
              linkedCardIds: Array.from(new Set([...n.linkedCardIds, cardId])),
              updatedAt: now(),
            }
          : n
      ),
      cards: s.cards.map((c) =>
        c.id === cardId
          ? {
              ...c,
              linkedNoteIds: Array.from(new Set([...c.linkedNoteIds, noteId])),
              updatedAt: now(),
            }
          : c
      ),
    }));
    get().persist();
    const note = get().notes.find((n) => n.id === noteId);
    const card = get().cards.find((c) => c.id === cardId);
    if (note) ipc((e) => e.note.update(noteId, { linkedCardIds: note.linkedCardIds }));
    if (card) ipc((e) => e.card.update(cardId, { linkedNoteIds: card.linkedNoteIds }));
  },
});
