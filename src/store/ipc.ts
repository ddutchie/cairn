/**
 * Shared IPC helpers for Zustand store slices.
 *
 * All slices import from here instead of copy-pasting these three functions.
 *
 * All handlers now return IpcResult<T> = { data: T } | { error: string }.
 * The helpers here detect { error } responses and dispatch a cairn:ipc-error
 * CustomEvent so the app shell can surface a toast to the user.
 */

import { CairnEvents } from "@/lib/events";
import { ownWriteGuard } from "@/lib/history";

// ── Per-note own-write map ────────────────────────────────────────────────────
// Tracks the timestamp of the last own write per note ID so the db:changed
// handler in page.tsx can skip re-hydrating notes that were just written by
// the user (preventing optimistic state being overwritten by a stale snapshot).
// Window is 1.5 s — long enough to outlast a WAL poll cycle (1 s) but short
// enough not to suppress a legitimate MCP write to the same note immediately
// after a user keystroke.
const ownNoteWriteMap = new Map<string, number>();
const OWN_NOTE_WRITE_WINDOW_MS = 1500;

export function markOwnNoteWrite(noteId: string): void {
  ownNoteWriteMap.set(noteId, Date.now());
}

export function isOwnNoteWrite(noteId: string): boolean {
  const t = ownNoteWriteMap.get(noteId);
  return t !== undefined && Date.now() - t < OWN_NOTE_WRITE_WINDOW_MS;
}

// ── AI-written notes registry ─────────────────────────────────────────────────
// Tracks notes that are currently — or were very recently — written by the AI
// (the in-app chat executor or the standalone MCP server), as signalled by the
// note:aiWriteStarted / note:aiWriteEnded events.
//
// This is the inverse of the own-write guard: when the AI patches a note we
// MUST re-hydrate from SQLite and accept the snapshot content for that note,
// even though the surrounding chat IPC touched ownWriteGuard and even if the
// user typed in the note shortly before. Without this override the open editor
// never sees the AI's changes (both guards would suppress the snapshot).
//
// We keep a short tail window after the write ends so the db:changed event
// (broadcast once after the whole chat stream finishes) still counts the note
// as AI-written when it finally fires.
const aiNoteWriteMap = new Map<string, number>();
const AI_NOTE_WRITE_TAIL_MS = 5000;
const aiWritingNotes = new Set<string>();

export function markAiNoteWriteStarted(noteId: string): void {
  aiWritingNotes.add(noteId);
  aiNoteWriteMap.set(noteId, Date.now());
}

export function markAiNoteWriteEnded(noteId: string): void {
  aiWritingNotes.delete(noteId);
  aiNoteWriteMap.set(noteId, Date.now());
}

/** True if the note is actively or recently (within the tail window) AI-written. */
export function isAiNoteWrite(noteId: string): boolean {
  if (aiWritingNotes.has(noteId)) return true;
  const t = aiNoteWriteMap.get(noteId);
  return t !== undefined && Date.now() - t < AI_NOTE_WRITE_TAIL_MS;
}

/** True if any note is actively or recently AI-written (cheap pre-check). */
export function hasRecentAiNoteWrite(): boolean {
  if (aiWritingNotes.size > 0) return true;
  const now = Date.now();
  for (const t of aiNoteWriteMap.values()) {
    if (now - t < AI_NOTE_WRITE_TAIL_MS) return true;
  }
  return false;
}

export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.electron;
}

function handleResult(result: unknown): void {
  if (result && typeof result === "object" && "error" in result) {
    const message = (result as { error: string }).error;
    console.error("[cairn:ipc:error]", message);
    window.dispatchEvent(CairnEvents.ipcError(message));
  }
}

/**
 * Fire-and-forget IPC call.
 * Checks the response for { error } and dispatches a cairn:ipc-error event.
 */
export function ipc(
  fn: (e: NonNullable<Window["electron"]>) => Promise<unknown> | undefined
): void {
  if (!isElectron() || !window.electron) return;
  ownWriteGuard.touch();
  fn(window.electron)
    ?.then(handleResult)
    ?.catch?.((err: unknown) => {
      console.error("[cairn:ipc]", err);
    });
}

/**
 * Awaitable IPC call. Resolves to void on success or error (never rejects).
 * Checks the response for { error } and dispatches a cairn:ipc-error event.
 */
export function ipcAwait(
  fn: (e: NonNullable<Window["electron"]>) => Promise<unknown> | undefined
): Promise<void> {
  ownWriteGuard.touch();
  if (!isElectron() || !window.electron) return Promise.resolve();
  return (fn(window.electron) ?? Promise.resolve())
    .then((result) => { handleResult(result); })
    .catch((err: unknown) => {
      console.error("[cairn:ipc]", err);
    });
}

/**
 * Awaitable IPC call that returns the raw IpcResult<T>.
 * Use when the caller needs to inspect { error } (e.g. circular dep check).
 */
export async function ipcAwaitResult<T>(
  fn: (e: NonNullable<Window["electron"]>) => Promise<{ data: T } | { error: string } | undefined>
): Promise<{ data: T } | { error: string }> {
  ownWriteGuard.touch();
  if (!isElectron() || !window.electron) return { error: "Not in Electron" };
  try {
    const result = await (fn(window.electron) ?? Promise.resolve(undefined));
    return result ?? { error: "No response" };
  } catch (err) {
    return { error: String(err) };
  }
}
