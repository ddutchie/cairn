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
  /** Run one poll tick. Exposed for tests; the interval calls it. */
  tick: () => Promise<void> | void;
}

async function getMtimeAsync(walPath: string, dbPath: string): Promise<number> {
  try {
    const walStat = await fs.promises.stat(walPath);
    return walStat.mtimeMs;
  } catch {
    try {
      const dbStat = await fs.promises.stat(dbPath);
      return dbStat.mtimeMs;
    } catch {
      return 0;
    }
  }
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
  let inFlight = false;

  void getMtimeAsync(walPath, dbPath).then((mtime) => {
    if (lastMtime === 0) lastMtime = mtime;
  });

  function sendToWin(channel: string, payload: unknown): void {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function pushUnread(count: number): void {
    // Dock/tray badge = unread notifications. (The legacy DB approval inbox —
    // once also counted here — was retired with the pre-Cordis engines.)
    updateBadge(count);
    if (count !== lastUnread) {
      lastUnread = count;
      sendToWin("mcp:unread-count", count);
    }
  }

  async function check(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const db = getDb();
      // The workspace can be swapped in place (`reinitialise()`), which points us
      // at a different cairn.db. Re-target the WAL watch and re-baseline the mtime
      // so the first tick after a swap isn't misread as "changed" (or, worse, so
      // we don't keep watching the abandoned workspace's WAL forever).
      const currentPath = getDbPath();
      if (currentPath !== dbPath) {
        dbPath = currentPath;
        walPath = dbPath + "-wal";
        prevLocked = new Set<string>();
        // We re-baseline lastMtime to the new file's current mtime, so the
        // `mtime > lastMtime` branch below won't fire until the NEXT write to the
        // new workspace. Push its unread count now so the badge reflects the new
        // workspace immediately instead of showing the old one's until something
        // writes. Force a broadcast by resetting lastUnread first.
        lastUnread = -1;
        try { pushUnread(getUnreadMcpNotifications(db).length); } catch { /* db transient */ }
        lastMtime = await getMtimeAsync(walPath, dbPath);
      }
      // Retention: prune old notifications once a day (30d / 1000 rows cap).
      if (Date.now() - lastPruneTs >= PRUNE_INTERVAL_MS) {
        lastPruneTs = Date.now();
        try { pruneMcpNotifications(db); } catch { /* best-effort */ }
      }
      try {
        const mtime = await getMtimeAsync(walPath, dbPath);
        const mtimeChanged = mtime > lastMtime;
        if (mtimeChanged) {
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

        // Diff mcp_active_writes when mtime changed or active writes are tracked,
        // so the renderer gets started/ended events promptly without running
        // DB queries every second on an idle app.
        if (mtimeChanged || prevLocked.size > 0) {
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
        }
      } catch { /* db file not yet created */ }
    } finally {
      inFlight = false;
    }
  }

  const intervalId = setInterval(() => { void check(); }, 1000);
  if (typeof intervalId.unref === "function") intervalId.unref();

  return {
    resetCount: () => { /* no-op — count is DB-derived */ },
    tick: check,
  };
}
