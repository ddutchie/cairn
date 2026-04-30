/**
 * Cairn — MCP notification poller
 *
 * Polls the SQLite WAL file mtime every 1 s to detect writes by the MCP server.
 * On change: fires `db:changed` to the renderer and checks for new MCP notifications.
 */

import { BrowserWindow, Notification } from "electron";
import fs from "fs";
import type Database from "better-sqlite3";
import { getUnreadMcpNotifications, markMcpNotificationsRead } from "../db/queries";

export interface McpPollerOptions {
  db: Database.Database;
  dbPath: string;
  win: BrowserWindow;
  updateBadge: (count: number) => void;
  onDbChanged: () => void;
}

export function startMcpNotificationPoller({
  db,
  dbPath,
  win,
  updateBadge,
  onDbChanged,
}: McpPollerOptions): void {
  const walPath = dbPath + "-wal";
  let lastMtime = 0;
  let unreadCount = 0;

  try {
    lastMtime = fs.statSync(fs.existsSync(walPath) ? walPath : dbPath).mtimeMs;
  } catch { /* db not yet created */ }

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
    } catch { /* db file not yet created */ }
  }

  setInterval(check, 1000);
}
