/**
 * Unsaved note edits, kept on this device until the user saves or discards.
 *
 * The note editor is explicit-save, so without this an edit was lost if the
 * user swiped back, or iOS killed the app in the background before Save. Drafts
 * live in the device-local meta DB (never synced): they are this phone's
 * in-progress typing, not workspace data. Keyed by workspace and note id, so
 * resetting a workspace's local copy can clear its drafts too.
 */

import { deleteMetaPrefix, getMeta, setMeta } from "@/db";

export interface NoteDraft {
  title: string;
  body: string;
  /** ISO time the draft was last written. */
  savedAt: string;
}

/** Key/value store the drafts live in; injectable for tests. */
export interface DraftStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  deletePrefix(prefix: string): void;
}

const metaStore: DraftStore = { get: getMeta, set: setMeta, deletePrefix: deleteMetaPrefix };

function workspacePrefix(workspaceId: string): string {
  return `note_draft.${workspaceId}.`;
}

function draftKey(workspaceId: string, noteId: string): string {
  return `${workspacePrefix(workspaceId)}${noteId}`;
}

export function loadNoteDraft(workspaceId: string, noteId: string, store: DraftStore = metaStore): NoteDraft | null {
  const raw = store.get(draftKey(workspaceId, noteId));
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<NoteDraft>;
    if (typeof d.title !== "string" || typeof d.body !== "string") return null;
    return { title: d.title, body: d.body, savedAt: typeof d.savedAt === "string" ? d.savedAt : "" };
  } catch {
    return null;
  }
}

export function saveNoteDraft(
  workspaceId: string,
  noteId: string,
  draft: { title: string; body: string },
  store: DraftStore = metaStore,
): void {
  const value: NoteDraft = { title: draft.title, body: draft.body, savedAt: new Date().toISOString() };
  store.set(draftKey(workspaceId, noteId), JSON.stringify(value));
}

/** An empty value reads as "no draft". */
export function clearNoteDraft(workspaceId: string, noteId: string, store: DraftStore = metaStore): void {
  const key = draftKey(workspaceId, noteId);
  if (!store.get(key)) return; // nothing stored: skip the write
  store.set(key, "");
}

/** Drop every draft for a workspace (its local copy is being reset). */
export function clearWorkspaceDrafts(workspaceId: string, store: DraftStore = metaStore): void {
  store.deletePrefix(workspacePrefix(workspaceId));
}

/** True when the draft would change the note (an identical draft isn't worth restoring). */
export function draftDiffers(draft: NoteDraft, note: { title: string | null; content: string | null }): boolean {
  return draft.title !== (note.title ?? "") || draft.body !== (note.content ?? "");
}
