/**
 * Hand-off for "open this note with the find bar prefilled" (global search
 * result → note). The note editor may not be mounted yet when a result is
 * picked, so the request is parked here and consumed by the editor for that
 * note; a window event nudges an editor that is already mounted.
 */
export const NOTE_FIND_EVENT = "cairn:note-find";

let pending: { noteId: string | null; query: string } | null = null;

/** Ask the editor showing `noteId` (or the active note when null) to open find. */
export function requestNoteFind(noteId: string | null, query = ""): void {
  pending = { noteId, query };
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NOTE_FIND_EVENT));
}

/** Take the parked request if it targets `noteId`. */
export function consumeNoteFind(noteId: string): { query: string } | null {
  if (!pending || (pending.noteId !== null && pending.noteId !== noteId)) return null;
  const { query } = pending;
  pending = null;
  return { query };
}
