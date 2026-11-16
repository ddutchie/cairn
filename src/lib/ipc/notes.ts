/**
 * Typed client for notes (`db:note:*`). Every failure rejects with the
 * main-process message; off-Electron calls reject with `IpcUnavailableError`.
 *
 * Most note reads go through the store slices; this covers the direct
 * renderer call sites (search panels, backlink panes, lazy bodies).
 */
import type { NoteCreateInput, NotePatch } from "../../../shared/types/notes";
import { domainCall, electronCall, type ElectronApi } from "./client";

type NoteApi = NonNullable<ElectronApi["note"]>;
const note = <T>(fn: (api: NoteApi) => Promise<T>) => domainCall("note", fn);

export const noteClient = {
  list: (projectId?: string) => note((n) => n.list(projectId)),
  create: (input: NoteCreateInput) => note((n) => n.create(input)),
  update: (id: string, patch: NotePatch) => note((n) => n.update(id, patch)),
  delete: (id: string) => note((n) => n.delete(id)),
  moveToFolder: (id: string, folder: string) => note((n) => n.moveToFolder(id, folder)),
  moveToProject: (id: string, projectId: string, workspaceId?: string) =>
    note((n) => n.moveToProject(id, projectId, workspaceId)),
  /** Lazy bodies: the renderer store holds note metadata only (Electron). */
  bodies: (ids: string[]) => note((n) => n.bodies(ids)),
  search: (query: string, projectId?: string) => note((n) => n.search(query, projectId)),
  searchSnippets: (query: string, projectId?: string, limit?: number) =>
    note((n) => n.searchSnippets(query, projectId, limit)),
  backlinks: (noteId: string) => note((n) => n.backlinks(noteId)),
  /** The user has seen this note's "what's new" changes. */
  clearChangeMark: (id: string) => note((n) => n.clearChangeMark(id)),
};

/** Note-adjacent top-level bridge keys (export, assets, AI-write lock). */
export const noteFilesClient = {
  revealNote: (noteId: string, projectId: string) =>
    electronCall((e) => e.revealNote(noteId, projectId)),
  exportNotePdf: (
    title: string,
    html: string,
    options?: { theme?: "light" | "dark"; fontFamily?: string },
  ) => electronCall((e) => e.exportNotePdf(title, html, options)),
  exportMarkdown: (kind: "note" | "project", id: string) =>
    electronCall((e) => e.exportMarkdown(kind, id)),
  uploadAsset: (filename: string, data: ArrayBuffer) =>
    electronCall((e) => e.uploadAsset(filename, data)),
  revealAssets: () => electronCall((e) => e.revealAssets()),
  onAiWriteStarted: (cb: (payload: { noteId: string }) => void): (() => void) =>
    window.electron?.onAiWriteStarted?.(cb) ?? (() => {}),
  onAiWriteEnded: (cb: (payload: { noteId: string }) => void): (() => void) =>
    window.electron?.onAiWriteEnded?.(cb) ?? (() => {}),
};
