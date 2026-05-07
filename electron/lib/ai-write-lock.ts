/**
 * Cairn — AI write lock
 *
 * Tracks which note IDs are currently being written by the in-app AI chat
 * executor. While a note is locked the renderer shows a read-only indicator
 * so the user knows not to edit that note.
 *
 * Usage (in chat-executor.ts):
 *   aiWriteLock.lock(noteId, win);
 *   try { ...write... } finally { aiWriteLock.unlock(noteId, win); }
 *
 * The MCP server path (separate process) is handled via the mcp_active_writes
 * SQLite table polled by mcp-poller.ts (Sync A3).
 */

import type { BrowserWindow } from "electron";

const activeWrites = new Set<string>();

function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

export const aiWriteLock = {
  /**
   * Mark noteId as being written by the AI and notify the renderer.
   * Safe to call multiple times for the same id (idempotent).
   */
  lock(noteId: string, win: BrowserWindow | null): void {
    if (!activeWrites.has(noteId)) {
      activeWrites.add(noteId);
      send(win, "note:aiWriteStarted", { noteId });
    }
  },

  /**
   * Mark noteId as no longer being written and notify the renderer.
   * Always call in a `finally` block to guarantee release.
   */
  unlock(noteId: string, win: BrowserWindow | null): void {
    if (activeWrites.has(noteId)) {
      activeWrites.delete(noteId);
      send(win, "note:aiWriteEnded", { noteId });
    }
  },

  /** Returns true if the note is currently being written by the AI. */
  isLocked(noteId: string): boolean {
    return activeWrites.has(noteId);
  },

  /** Snapshot of all currently locked note IDs (for debugging / tests). */
  lockedIds(): ReadonlySet<string> {
    return activeWrites;
  },
};
