/**
 * Cairn — MCP notification poller
 *
 * Polls the SQLite WAL file mtime every 1 s to detect writes by the MCP server.
 * On change: fires `db:changed` to the renderer and checks for new MCP notifications.
 */

import { BrowserWindow, Notification } from "electron";
import fs from "fs";
import type Database from "better-sqlite3";
import { getUnreadMcpNotifications, markMcpNotificationsRead, getActiveMcpWrites } from "../db/queries";

export interface McpPollerOptions {
  db: Database.Database;
  dbPath: string;
  win: BrowserWindow;
  updateBadge: (count: number) => void;
  onDbChanged: () => void;
}

export interface McpPoller {
  /** Reset the accumulated unread count to zero (call when the badge is cleared). */
  resetCount: () => void;
}

export function startMcpNotificationPoller({
  db,
  dbPath,
  win,
  updateBadge,
  onDbChanged,
}: McpPollerOptions): McpPoller {
  const walPath = dbPath + "-wal";
  let lastMtime = 0;
  // Accumulated unread count — incremented on new notifications, reset via resetCount()
  let unreadCount = 0;
  // Previous snapshot of MCP-locked note IDs — diff each poll to fire started/ended events
  let prevLocked = new Set<string>();

  try {
    lastMtime = fs.statSync(fs.existsSync(walPath) ? walPath : dbPath).mtimeMs;
  } catch { /* db not yet created */ }

  function sendToWin(channel: string, payload: unknown): void {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function check() {
    try {
      const target = fs.existsSync(walPath) ? walPath : dbPath;
      const mtime = fs.statSync(target).mtimeMs;
      if (mtime > lastMtime) {
        lastMtime = mtime;
        onDbChanged();

        const unread = getUnreadMcpNotifications(db);
        for (const n of unread) {
          if (Notification.isSupported()) {
            new Notification({ title: n.title, body: n.body, silent: false }).show();
          }
        }
        if (unread.length > 0) {
          unreadCount += unread.length;
          updateBadge(unreadCount);
          markMcpNotificationsRead(db);
        }
      }

      // Diff mcp_active_writes on every tick (independent of WAL mtime) so the
      // renderer gets started/ended events promptly even if the write completes
      // within the same WAL flush window.
      const currentLocked = getActiveMcpWrites(db);
      for (const noteId of currentLocked) {
        if (!prevLocked.has(noteId)) {
          sendToWin("note:aiWriteStarted", { noteId });
        }
      }
      for (const noteId of prevLocked) {
        if (!currentLocked.has(noteId)) {
          sendToWin("note:aiWriteEnded", { noteId });
        }
      }
      prevLocked = currentLocked;
    } catch { /* db file not yet created */ }
  }

  setInterval(check, 1000);

  return {
    resetCount: () => { unreadCount = 0; },
  };
}
