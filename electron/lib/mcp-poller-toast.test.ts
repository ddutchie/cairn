/**
 * MCP poller — OS toast baseline.
 *
 * Unread notifications that already existed when the poller started (app
 * launch / update restart) must not be re-toasted; only rows that arrive
 * afterwards may.
 */

import { describe, it, expect, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "../db/schema";

const toasts: string[] = [];
vi.mock("electron", () => ({
  BrowserWindow: class {},
  Notification: class {
    static isSupported() { return true; }
    constructor(public opts: { title: string }) {}
    show() { toasts.push(this.opts.title); }
  },
}));

import { startMcpNotificationPoller } from "./mcp-poller";

describe("startMcpNotificationPoller — toast baseline", () => {
  it("does not toast the backlog that was unread at startup, only new rows", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-poller-toast-"));
    const dbPath = path.join(tmp, "cairn.db");
    const db = new BetterSqlite3(dbPath);
    applySchema(db);
    const insert = db.prepare(
      "INSERT INTO mcp_notifications (id, tool, title, body, read, created_at) VALUES (?, ?, ?, ?, 0, ?)",
    );
    for (let i = 0; i < 3; i++) insert.run(`old${i}`, "patch_note", `Old ${i}`, "body", new Date().toISOString());
    try {
      const win = {
        isDestroyed: () => false,
        isFocused: () => false,
        webContents: { send: vi.fn() },
      } as unknown as import("electron").BrowserWindow;
      const poller = startMcpNotificationPoller({
        getDb: () => db,
        getDbPath: () => dbPath,
        win,
        updateBadge: () => {},
        onDbChanged: () => {},
      });
      await new Promise((r) => setTimeout(r, 20));

      const bump = () => {
        const future = new Date(Date.now() + 5000 + toasts.length * 1000);
        for (const f of [dbPath, dbPath + "-wal"]) if (fs.existsSync(f)) fs.utimesSync(f, future, future);
      };

      // A write that only touches the database (backlog still present) → no toasts.
      bump();
      await poller.tick();
      expect(toasts).toEqual([]);

      // A genuinely new notification → exactly one toast.
      insert.run("new0", "patch_note", "New 0", "body", new Date().toISOString());
      bump();
      await poller.tick();
      expect(toasts).toEqual(["New 0"]);
    } finally {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
