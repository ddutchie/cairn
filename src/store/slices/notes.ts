/**
 * Notes slice — CRUD, archive/restore, move, link.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { Note, ID, NoteType } from "@/types";
import { id, now } from "@/lib/utils";
import { ipc, isElectron, markOwnNoteWrite } from "../ipc";
import { historyManager } from "@/lib/history";
import {
  makeCreateNoteCmd,
  pushUpdateNoteCmd,
  makeDeleteNoteCmd,
  makeArchiveNoteCmd,
  makeMoveNoteCmd,
  makeRestoreNoteCmd,
  makeLinkNoteToCardCmd,
} from "@/lib/commands/note-commands";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface NotesSlice {
  notes: Note[];

  createNote: (projectId: ID, title: string, type?: NoteType, folder?: string, content?: string) => Note;
  updateNote: (id: ID, patch: Partial<Note>) => void;
  deleteNote: (id: ID) => void;
  archiveNote: (id: ID) => void;
  restoreNote: (id: ID) => void;
  moveNoteToProject: (noteId: ID, targetProjectId: ID) => void;
  /** Move a note to a subfolder within its current project. folder="" moves to root. */
  moveNoteToFolder: (noteId: ID, folder: string) => void;
  linkNoteToCard: (noteId: ID, cardId: ID) => void;
  /** Reveal the note's .md file in the OS file explorer. No-op outside Electron. */
  revealNote: (noteId: ID, projectId: ID) => void;
  /** Generate a PRD note via the AI. Returns { error } on failure. */
  generatePrd: (projectId: ID, title: string, requirements: string) => Promise<unknown>;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createNotesSlice: StateCreator<CairnStore, [], [], NotesSlice> = (
  set,
  get
) => ({
  notes: [],

  createNote(projectId, title, type = "note", folder = "", content = "") {
    const proj = get().projects.find((p) => p.id === projectId);
    const note: Note = {
      id: id(),
      projectId,
      workspaceId: proj?.workspaceId ?? "",
      title,
      content,
      contentText: content,
      tagIds: [],
      linkedNoteIds: [],
      linkedCardIds: [],
      isPinned: false,
      type,
      folder,
      createdAt: now(),
      updatedAt: now(),
      version: 0,
    };
    set((s) => ({ notes: [...s.notes, note] }));
    get().persist();
    markOwnNoteWrite(note.id);
    ipc((e) => e.note.create(note));
    historyManager.push(makeCreateNoteCmd(note, set));
    return note;
  },

  updateNote(noteId, patch) {
    const prev = get().notes.find((n) => n.id === noteId);
    const prevPatch = prev
      ? Object.fromEntries(Object.keys(patch).map((k) => [k, (prev as unknown as Record<string, unknown>)[k]])) as Partial<Note>
      : {} as Partial<Note>;
    set((s) => ({
      notes: s.notes.map((n) =>
        n.id === noteId ? { ...n, ...patch, updatedAt: now() } : n
      ),
    }));
    get().persist();
    markOwnNoteWrite(noteId);
    ipc((e) => e.note.update(noteId, patch));
    pushUpdateNoteCmd(noteId, prevPatch, patch, set);
  },

  deleteNote(noteId) {
    const savedNote = get().notes.find((n) => n.id === noteId);
    set((s) => ({
      notes: s.notes.filter((n) => n.id !== noteId),
      cards: s.cards.map((c) => ({
        ...c,
        linkedNoteIds: c.linkedNoteIds.filter((nId) => nId !== noteId),
      })),
    }));
    get().persist();
    markOwnNoteWrite(noteId);
    ipc((e) => e.note.delete(noteId));
    if (savedNote) historyManager.push(makeDeleteNoteCmd(savedNote, set));
  },

  archiveNote(noteId) {
    const archivedAt = now();
    set((s) => ({
      notes: s.notes.map((n) =>
        n.id === noteId ? { ...n, archivedAt, updatedAt: now() } : n
      ),
    }));
    get().persist();
    markOwnNoteWrite(noteId);
    ipc((e) => e.note.update(noteId, { archivedAt }));
    historyManager.push(makeArchiveNoteCmd(noteId, archivedAt, set));
  },

  restoreNote(noteId) {
    set((s) => ({
      notes: s.notes.map((n) =>
        n.id === noteId ? { ...n, archivedAt: undefined, updatedAt: now() } : n
      ),
    }));
    get().persist();
    markOwnNoteWrite(noteId);
    ipc((e) => e.note.update(noteId, { archivedAt: null }));
    historyManager.push(makeRestoreNoteCmd(noteId, set));
  },

  moveNoteToProject(noteId, targetProjectId) {
    const targetProject = get().projects.find((p) => p.id === targetProjectId);
    if (!targetProject) return;
    const note = get().notes.find((n) => n.id === noteId);
    const prevProjectId = note?.projectId ?? "";
    const prevWorkspaceId = note?.workspaceId ?? "";
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
    markOwnNoteWrite(noteId);
    ipc((e) => e.note.update(noteId, { projectId: targetProjectId }));
    historyManager.push(makeMoveNoteCmd(
      noteId, prevProjectId, prevWorkspaceId,
      targetProjectId, targetProject.workspaceId,
      targetProject.name, set,
    ));
  },

  moveNoteToFolder(noteId, folder) {
    set((s) => ({
      notes: s.notes.map((n) =>
        n.id === noteId ? { ...n, folder, updatedAt: now() } : n
      ),
    }));
    get().persist();
    markOwnNoteWrite(noteId);
    ipc((e) => e.note.moveToFolder(noteId, folder));
  },

  linkNoteToCard(noteId, cardId) {
    const prevNote = get().notes.find((n) => n.id === noteId);
    const prevCard = get().cards.find((c) => c.id === cardId);
    const prevNoteLinkedCardIds = prevNote?.linkedCardIds ?? [];
    const prevCardLinkedNoteIds = prevCard?.linkedNoteIds ?? [];
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
    if (note) { markOwnNoteWrite(noteId); ipc((e) => e.note.update(noteId, { linkedCardIds: note.linkedCardIds })); }
    if (card) ipc((e) => e.card.update(cardId, { linkedNoteIds: card.linkedNoteIds }));
    historyManager.push(makeLinkNoteToCardCmd(noteId, cardId, prevNoteLinkedCardIds, prevCardLinkedNoteIds, set));
  },

  revealNote(noteId, projectId) {
    if (!isElectron()) return;
    window.electron?.revealNote(noteId, projectId);
  },

  async generatePrd(projectId, title, requirements) {
    if (!isElectron() || !window.electron) return { error: "Not in Electron" };
    const { aiConfig } = get();
    try {
      return await window.electron.ai.generatePrd({
        projectId,
        title,
        requirements,
        config: {
          baseUrl: aiConfig.baseUrl || "https://api.openai.com",
          model: aiConfig.model || "gpt-4o-mini",
          apiKey: aiConfig.apiKey || "",
        },
      });
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : "Failed to generate PRD" };
    }
  },
});
