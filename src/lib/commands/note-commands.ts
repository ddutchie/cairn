/**
 * Cairn — Note undo/redo commands
 *
 * Each factory captures the before/after state needed to reverse the
 * operation. Commands call IPC and update the Zustand store directly
 * rather than going through slice actions, to avoid double-pushing to
 * the history stack.
 */

import type { Note, ID } from "@/types";
import type { Command } from "@/lib/history";
import { historyManager } from "@/lib/history";
import { ipc } from "@/store/ipc";
import { now } from "@/lib/utils";
import type { CairnStore } from "@/store";

// ── Internal tagged command type for coalescing ────────────────────────────────

interface UpdateNoteCmd extends Command {
  _tag: "updateNote";
  _id: string;
  _pushedAt: number;
  _newPatch: Partial<Note>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type StoreSet = (fn: (s: CairnStore) => Partial<CairnStore>) => void;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type StoreGet = () => CairnStore;

// ── Command factories ──────────────────────────────────────────────────────────

export function makeCreateNoteCmd(
  note: Note,
  set: StoreSet,
): Command {
  return {
    label: `Create note "${note.title}"`,
    async undo() {
      set((s) => ({
        notes: s.notes.filter((n) => n.id !== note.id),
        cards: s.cards.map((c) => ({
          ...c,
          linkedNoteIds: c.linkedNoteIds.filter((id) => id !== note.id),
        })),
      }));
      ipc((e) => e.note.delete(note.id));
    },
    async redo() {
      set((s) => ({ notes: [...s.notes, note] }));
      ipc((e) => e.note.create(note));
    },
  };
}

/**
 * Push an UpdateNote command with 2s coalescing: rapid consecutive edits
 * to the same note merge into a single undo step.
 */
export function pushUpdateNoteCmd(
  noteId: ID,
  prevPatch: Partial<Note>,
  newPatch: Partial<Note>,
  set: StoreSet,
): void {
  const COALESCE_MS = 2000;

  const coalesced = historyManager.coalesceUpdate(
    "updateNote",
    noteId,
    COALESCE_MS,
    (existing) => {
      (existing as UpdateNoteCmd)._newPatch = newPatch;
    },
  );
  if (coalesced) return;

  const cmd: UpdateNoteCmd = {
    label: `Edit note`,
    _tag: "updateNote",
    _id: noteId,
    _pushedAt: Date.now(),
    _newPatch: newPatch,
    async undo() {
      set((s) => ({
        notes: s.notes.map((n) =>
          n.id === noteId ? { ...n, ...prevPatch, updatedAt: now() } : n,
        ),
      }));
      ipc((e) => e.note.update(noteId, prevPatch));
    },
    async redo() {
      set((s) => ({
        notes: s.notes.map((n) =>
          n.id === noteId ? { ...n, ...this._newPatch, updatedAt: now() } : n,
        ),
      }));
      ipc((e) => e.note.update(noteId, this._newPatch));
    },
  };

  historyManager.push(cmd);
}

export function makeDeleteNoteCmd(
  savedNote: Note,
  set: StoreSet,
): Command {
  return {
    label: `Delete note "${savedNote.title}"`,
    async undo() {
      set((s) => ({ notes: [...s.notes, savedNote] }));
      ipc((e) => e.note.create(savedNote));
    },
    async redo() {
      set((s) => ({
        notes: s.notes.filter((n) => n.id !== savedNote.id),
        cards: s.cards.map((c) => ({
          ...c,
          linkedNoteIds: c.linkedNoteIds.filter((id) => id !== savedNote.id),
        })),
      }));
      ipc((e) => e.note.delete(savedNote.id));
    },
  };
}

export function makeArchiveNoteCmd(
  noteId: ID,
  archivedAt: string,
  set: StoreSet,
): Command {
  return {
    label: `Archive note`,
    async undo() {
      set((s) => ({
        notes: s.notes.map((n) =>
          n.id === noteId ? { ...n, archivedAt: undefined, updatedAt: now() } : n,
        ),
      }));
      ipc((e) => e.note.update(noteId, { archivedAt: null }));
    },
    async redo() {
      set((s) => ({
        notes: s.notes.map((n) =>
          n.id === noteId ? { ...n, archivedAt, updatedAt: now() } : n,
        ),
      }));
      ipc((e) => e.note.update(noteId, { archivedAt }));
    },
  };
}

export function makeMoveNoteCmd(
  noteId: ID,
  prevProjectId: ID,
  prevWorkspaceId: ID,
  targetProjectId: ID,
  targetWorkspaceId: ID,
  targetProjectName: string,
  set: StoreSet,
): Command {
  return {
    label: `Move note to "${targetProjectName}"`,
    async undo() {
      set((s) => ({
        notes: s.notes.map((n) =>
          n.id === noteId
            ? { ...n, projectId: prevProjectId, workspaceId: prevWorkspaceId, updatedAt: now() }
            : n,
        ),
      }));
      ipc((e) => e.note.update(noteId, { projectId: prevProjectId }));
    },
    async redo() {
      set((s) => ({
        notes: s.notes.map((n) =>
          n.id === noteId
            ? { ...n, projectId: targetProjectId, workspaceId: targetWorkspaceId, updatedAt: now() }
            : n,
        ),
      }));
      ipc((e) => e.note.update(noteId, { projectId: targetProjectId }));
    },
  };
}

export function makeRestoreNoteCmd(
  noteId: ID,
  set: StoreSet,
): Command {
  return {
    label: `Restore note`,
    async undo() {
      const archivedAt = now();
      set((s) => ({
        notes: s.notes.map((n) =>
          n.id === noteId ? { ...n, archivedAt, updatedAt: now() } : n
        ),
      }));
      ipc((e) => e.note.update(noteId, { archivedAt }));
    },
    async redo() {
      set((s) => ({
        notes: s.notes.map((n) =>
          n.id === noteId ? { ...n, archivedAt: undefined, updatedAt: now() } : n
        ),
      }));
      ipc((e) => e.note.update(noteId, { archivedAt: null }));
    },
  };
}

export function makeLinkNoteToCardCmd(
  noteId: ID,
  cardId: ID,
  prevNoteLinkedCardIds: ID[],
  prevCardLinkedNoteIds: ID[],
  set: StoreSet,
): Command {
  return {
    label: `Link note to task`,
    async undo() {
      set((s) => ({
        notes: s.notes.map((n) =>
          n.id === noteId ? { ...n, linkedCardIds: prevNoteLinkedCardIds, updatedAt: now() } : n
        ),
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, linkedNoteIds: prevCardLinkedNoteIds, updatedAt: now() } : c
        ),
      }));
      ipc((e) => e.note.update(noteId, { linkedCardIds: prevNoteLinkedCardIds }));
      ipc((e) => e.card.update(cardId, { linkedNoteIds: prevCardLinkedNoteIds }));
    },
    async redo() {
      const newNoteLinkedCardIds = Array.from(new Set([...prevNoteLinkedCardIds, cardId]));
      const newCardLinkedNoteIds = Array.from(new Set([...prevCardLinkedNoteIds, noteId]));
      set((s) => ({
        notes: s.notes.map((n) =>
          n.id === noteId ? { ...n, linkedCardIds: newNoteLinkedCardIds, updatedAt: now() } : n
        ),
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, linkedNoteIds: newCardLinkedNoteIds, updatedAt: now() } : c
        ),
      }));
      ipc((e) => e.note.update(noteId, { linkedCardIds: newNoteLinkedCardIds }));
      ipc((e) => e.card.update(cardId, { linkedNoteIds: newCardLinkedNoteIds }));
    },
  };
}


