/**
 * Cairn — MCP notification poller
 *
 * Polls the SQLite WAL file mtime every 1 s to detect writes by the MCP server.
 * On change: fires `db:changed` to the renderer and checks for new MCP notifications.
 *
 * The unread badge is DB-backed (`read = 0` rows). Notifications are NOT auto-marked
 * read here — they persist unread until the user dismisses them in the in-app
 * notification center (so the badge + list stay accurate). Native OS toasts still
 * fire for NEW notifications while the app is unfocused, deduped by notification id
 * so the same row isn't re-toasted on every WAL tick. The unread count is broadcast
 * to the renderer whenever it changes (focused or not) so the sidebar bell stays live.
 */

import { BrowserWindow, Notification } from "electron";
import fs from "fs";
import type Database from "better-sqlite3";
import { getUnreadMcpNotifications, getActiveMcpWrites, pruneMcpNotifications } from "../db/queries";
import { countPendingApprovals } from "../db/approval-queries";

export interface McpPollerOptions {
  /** Live getter — the handle is swapped by `reinitialise()` on workspace change. */
  getDb: () => Database.Database;
  /** Live getter — the DB path changes with the workspace. */
  getDbPath: () => string;
  win: BrowserWindow;
  updateBadge: (count: number) => void;
  onDbChanged: () => void;
}

export interface McpPoller {
  /** No-op for backward compatibility — the unread count is DB-derived now. */
  resetCount: () => void;
}

export function startMcpNotificationPoller({
  getDb,
  getDbPath,
  win,
  updateBadge,
  onDbChanged,
}: McpPollerOptions): McpPoller {
  let dbPath = getDbPath();
  let walPath = dbPath + "-wal";
  let lastMtime = 0;
  // Notification ids already shown as an OS toast (dedupe across WAL ticks).
  const toastedIds = new Set<string>();
  // Last unread count we broadcast — only push on change.
  let lastUnread = -1;
  // Previous snapshot of MCP-locked note IDs — diff each poll to fire started/ended events
  let prevLocked = new Set<string>();
  // Retention guard — prune old notifications at most once a day.
  let lastPruneTs = 0;
  const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

  try {
    lastMtime = fs.statSync(fs.existsSync(walPath) ? walPath : dbPath).mtimeMs;
  } catch { /* db not yet created */ }

  function sendToWin(channel: string, payload: unknown): void {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function pushUnread(count: number): void {
    // Dock/tray badge = combined attention (notifications + pending approvals),
    // so a parked approval never silently disappears even if notifications were
    // marked read. The renderer bell gets the notifications-only count.
    let approvalCount = 0;
    try { approvalCount = countPendingApprovals(getDb()); } catch { /* db transient */ }
    updateBadge(count + approvalCount);
    if (count !== lastUnread) {
      lastUnread = count;
      sendToWin("mcp:unread-count", count);
    }
  }

  function check() {
    const db = getDb();
    // The workspace can be swapped in place (`reinitialise()`), which points us
    // at a different cairn.db. Re-target the WAL watch and re-baseline the mtime
    // so the first tick after a swap isn't misread as "changed" (or, worse, so
    // we don't keep watching the abandoned workspace's WAL forever).
    const currentPath = getDbPath();
    if (currentPath !== dbPath) {
      dbPath = currentPath;
      walPath = dbPath + "-wal";
      lastMtime = 0;
      prevLocked = new Set<string>();
      try {
        lastMtime = fs.statSync(fs.existsSync(walPath) ? walPath : dbPath).mtimeMs;
      } catch { /* db not yet created */ }
    }
    // Retention: prune old notifications once a day (30d / 1000 rows cap).
    if (Date.now() - lastPruneTs >= PRUNE_INTERVAL_MS) {
      lastPruneTs = Date.now();
      try { pruneMcpNotifications(db); } catch { /* best-effort */ }
    }
    try {
      const target = fs.existsSync(walPath) ? walPath : dbPath;
      const mtime = fs.statSync(target).mtimeMs;
      if (mtime > lastMtime) {
        lastMtime = mtime;
        onDbChanged();

        const unread = getUnreadMcpNotifications(db);
        const appFocused = !win.isDestroyed() && win.isFocused();
        // Toast NEW notifications only while the app is unfocused (the user can
        // already see the badge/inbox in-app when focused).
        if (!appFocused && Notification.isSupported()) {
          for (const n of unread) {
            if (toastedIds.has(n.id)) continue;
            toastedIds.add(n.id);
            new Notification({ title: n.title, body: n.body, silent: false }).show();
          }
        } else {
          // While focused, remember the ids so they don't toast later on focus loss.
          for (const n of unread) toastedIds.add(n.id);
        }
        // Forget ids that are no longer unread (read or pruned) so the dedupe
        // set can't grow for the whole session.
        const unreadIds = new Set(unread.map((n) => n.id));
        for (const id of toastedIds) if (!unreadIds.has(id)) toastedIds.delete(id);
        pushUnread(unread.length);
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
    resetCount: () => { /* no-op — count is DB-derived */ },
  };
}
