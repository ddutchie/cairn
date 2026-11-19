/** addNoteAttendee must not replace a note's calendar-meeting link with a fresh meeting while that meeting hasn't synced yet. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import BetterSqlite3 from "../../../vitest-sqlite-shim.cjs";
import type Database from "better-sqlite3";
import { MOBILE_SCHEMA_SQL, MOBILE_TRIGGERS_SQL } from "./schema";

const h = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("./index", () => ({
  getActiveSource: () => "ws1",
  getDb: () => ({ getFirstSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).get(...p) ?? null }),
}));
vi.mock("./expo-sync-db", () => ({ createExpoSyncDb: () => h.db }));
vi.mock("@/sync/write-signal", () => ({ notifyLocalWrite: () => {} }));
vi.mock("./queries", () => ({ updateNote: () => {} }));

const { addNoteAttendee } = await import("./people");

beforeEach(() => {
  h.db = new (BetterSqlite3 as unknown as new (f: string) => Database.Database)(":memory:");
  h.db.exec(MOBILE_SCHEMA_SQL);
  h.db.exec(MOBILE_TRIGGERS_SQL);
  const now = "2026-11-18T10:00:00.000Z";
  h.db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws1', 'W', ?, ?)").run(now, now);
  h.db.prepare("INSERT INTO people (id, workspace_id, name, aliases, emails, created_at, updated_at) VALUES ('ana', 'ws1', 'Ana Ruiz', '[]', '[]', ?, ?)").run(now, now);
});

describe("addNoteAttendee", () => {
  it("refuses, retryably, when the note's meeting row hasn't synced", () => {
    h.db.prepare("INSERT INTO notes (id, project_id, workspace_id, title, content, meeting_id, created_at, updated_at) VALUES ('n1', 'p1', 'ws1', 'Sync', 'x', 'cal:future', ?, ?)").run("2026-11-18T10:00:00.000Z", "2026-11-18T10:00:00.000Z");
    expect(() => addNoteAttendee("n1", "ana")).toThrow(/hasn't synced/);
    expect(h.db.prepare("SELECT meeting_id AS m FROM notes WHERE id='n1'").get()).toEqual({ m: "cal:future" });
  });
});
