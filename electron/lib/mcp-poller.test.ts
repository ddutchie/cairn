/**
 * MCP poller — workspace-swap unread-count test.
 *
 * When the app swaps its workspace folder in place (`reinitialise()`), the
 * poller re-targets its WAL watch and re-baselines `lastMtime` to the new
 * file's current mtime. Because the baseline then equals the current mtime, the
 * `mtime > lastMtime` "changed" branch does NOT fire until the next write — so
 * the badge must be refreshed to the new workspace's unread count eagerly on the
 * swap tick, not left showing the old workspace's until something writes.
 */

import { describe, it, expect, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "../db/schema";
import { startMcpNotificationPoller } from "./mcp-poller";

// electron's Notification/BrowserWindow aren't available in the node test env;
// the poller only touches Notification behind isSupported(), which we force off.
vi.mock("electron", () => ({
  BrowserWindow: class {},
  Notification: { isSupported: () => false },
}));

function seedDbWithUnread(dir: string, unreadCount: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "cairn.db");
  const db = new BetterSqlite3(dbPath);
  applySchema(db);
  const insert = db.prepare(
    "INSERT INTO mcp_notifications (id, tool, title, body, read, created_at) VALUES (?, ?, ?, ?, 0, ?)",
  );
  for (let i = 0; i < unreadCount; i++) {
    insert.run(`n${i}`, "ensure_note", `Title ${i}`, "body", new Date().toISOString());
  }
  db.close();
  return dbPath;
}

function fakeWin() {
  return {
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: { send: vi.fn() },
  } as unknown as import("electron").BrowserWindow;
}

describe("startMcpNotificationPoller — workspace swap", () => {
  it("pushes the NEW workspace's unread count on the swap tick, before any write", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-poller-"));
    try {
      // Workspace A: 1 unread. Workspace B: 3 unread.
      const dbPathA = seedDbWithUnread(path.join(tmp, "a"), 1);
      const dbPathB = seedDbWithUnread(path.join(tmp, "b"), 3);
      const dbA = new BetterSqlite3(dbPathA);
      const dbB = new BetterSqlite3(dbPathB);

      // Mutable binding, swapped like reinitialise() does.
      let activeDb: Database.Database = dbA;
      let activeDbPath = dbPathA;

      const updateBadge = vi.fn();
      const poller = startMcpNotificationPoller({
        getDb: () => activeDb,
        getDbPath: () => activeDbPath,
        win: fakeWin(),
        updateBadge,
        onDbChanged: () => {},
      });

      // Baseline: first real tick reflects workspace A (1 unread).
      poller.tick();
      expect(updateBadge).toHaveBeenLastCalledWith(1);

      // Swap to workspace B without writing to it.
      activeDb = dbB;
      activeDbPath = dbPathB;

      poller.tick();

      // Badge must now reflect B's 3 unread — pushed eagerly on the swap, not
      // deferred until the next write to B.
      expect(updateBadge).toHaveBeenLastCalledWith(3);

      dbA.close();
      dbB.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
