/** Notes, note export and assets. */

import { invokeContract, onIpcEvent } from "./ipc";
import type { NoteCreateInput, NotePatch } from "../../shared/types/notes";

export const notesApi = {
  // ── Notes ────────────────────────────────────
  note: {
    list:         (projectId?: string) => invokeContract("db:note:list", { projectId }),
    create:       (note: NoteCreateInput) => invokeContract("db:note:create", note),
    update:       (id: string, patch: NotePatch) => invokeContract("db:note:update", { id, patch }),
    delete:       (id: string) => invokeContract("db:note:delete", { id }),
    moveToFolder: (id: string, folder: string) => invokeContract("db:note:moveToFolder", { id, folder }),
    // workspaceId is derived from the target project by the handler; accepted for
    // backwards-compatible call sites but no longer required.
    moveToProject: (id: string, projectId: string, _workspaceId?: string) =>
      invokeContract("db:note:moveToProject", { id, projectId }),
    // Lazy bodies: the renderer store holds note metadata only (Electron).
    bodies: (ids: string[]) => invokeContract("db:note:bodies:get", { ids }),
    search: (query: string, projectId?: string) => invokeContract("db:note:search", { query, projectId }),
    backlinks: (noteId: string) => invokeContract("db:note:backlinks:list", { noteId }),
    /** The user has seen this note's "what's new" changes. */
    clearChangeMark: (id: string) => invokeContract("db:note:changeMark:clear", { id }),
  },

  // ── Reveal note in Finder / Explorer ─────────
  revealNote: (noteId: string, projectId: string) => invokeContract("app:revealNote", { noteId, projectId }),

  // ── Export note as PDF ────────────────────────
  exportNotePdf: (title: string, html: string, options?: { returnBuffer?: boolean; theme?: "light" | "dark"; fontFamily?: string }) =>
    invokeContract("app:exportNotePdf", { title, html, options }),

  // ── Export note / project as Markdown ─────────
  exportMarkdown: (kind: "note" | "project", id: string, options?: { returnText?: boolean }) =>
    invokeContract("app:exportMarkdown", { kind, id, returnText: options?.returnText }),

  // ── Asset upload (pasted images) ──────────────
  // data is an ArrayBuffer — Electron's structured-clone transfers it
  // natively without serialising to a JSON number array.
  uploadAsset: (filename: string, data: ArrayBuffer) => invokeContract("app:uploadAsset", { filename, data }),
  revealAssets: () => invokeContract("app:revealAssets"),

  // ── AI write lock events ──────────────────────
  // Fired by the main process when the in-app AI chat executor starts or
  // finishes writing to a note. The renderer uses these to show a read-only
  // indicator on the active note editor.
  onAiWriteStarted: (cb: (payload: { noteId: string }) => void) => onIpcEvent("note:aiWriteStarted", cb),
  onAiWriteEnded: (cb: (payload: { noteId: string }) => void) => onIpcEvent("note:aiWriteEnded", cb),
} as const;
