/**
 * Unsaved note edits, kept on this device until the user saves or discards.
 *
 * The note editor is explicit-save, so without this an edit was lost if the
 * user swiped back, or iOS killed the app in the background before Save. Drafts
 * live in the device-local meta DB (never synced): they are this phone's
 * in-progress typing, not workspace data. Keyed by note id (nanoids are unique
 * across sources, so one table is fine).
 */

import { getMeta, setMeta } from "@/db";

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
}

const metaStore: DraftStore = { get: getMeta, set: setMeta };

function draftKey(noteId: string): string {
  return `note_draft.${noteId}`;
}

export function loadNoteDraft(noteId: string, store: DraftStore = metaStore): NoteDraft | null {
  const raw = store.get(draftKey(noteId));
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
  noteId: string,
  draft: { title: string; body: string },
  store: DraftStore = metaStore,
): void {
  const value: NoteDraft = { title: draft.title, body: draft.body, savedAt: new Date().toISOString() };
  store.set(draftKey(noteId), JSON.stringify(value));
}

/** Meta has no delete; an empty value reads as "no draft". */
export function clearNoteDraft(noteId: string, store: DraftStore = metaStore): void {
  if (!store.get(draftKey(noteId))) return; // nothing stored: skip the write
  store.set(draftKey(noteId), "");
}

/** True when the draft would change the note (an identical draft isn't worth restoring). */
export function draftDiffers(draft: NoteDraft, note: { title: string | null; content: string | null }): boolean {
  return draft.title !== (note.title ?? "") || draft.body !== (note.content ?? "");
}
