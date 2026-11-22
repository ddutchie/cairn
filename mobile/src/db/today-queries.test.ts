/** The Today queries: open tasks due on or before a day, and meetings inside a day. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import BetterSqlite3 from "../../../vitest-sqlite-shim.cjs";
import type Database from "better-sqlite3";
import { MOBILE_SCHEMA_SQL, MOBILE_TRIGGERS_SQL } from "./schema";

const h = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("./index", () => ({
  getActiveSource: () => "ws1",
  getDb: () => ({
    getAllSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).all(...p),
    getFirstSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).get(...p) ?? null,
    runSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).run(...p),
  }),
}));
vi.mock("@/sync/write-signal", () => ({ notifyLocalWrite: () => {} }));

const { listOpenDueTasks, listMeetingsBetween } = await import("./queries");
const NOW = "2026-11-18T10:00:00.000Z";

const col = (id: string, type: string) =>
  h.db.prepare("INSERT INTO board_columns (id, project_id, workspace_id, name, type, created_at, updated_at) VALUES (?, 'p1', 'ws1', ?, ?, ?, ?)").run(id, id, type, NOW, NOW);
const card = (id: string, due: string | null, column: string, extra = "") =>
  h.db.prepare(`INSERT INTO task_cards (id, project_id, workspace_id, column_id, title, due_date, created_at, updated_at${extra ? ", archived_at" : ""}) VALUES (?, 'p1', 'ws1', ?, ?, ?, ?, ?${extra ? ", ?" : ""})`).run(...[id, column, id, due, NOW, NOW, ...(extra ? [extra] : [])]);
const meeting = (id: string, startsAt: string, deleted: string | null = null) =>
  h.db.prepare("INSERT INTO meetings (id, workspace_id, title, starts_at, created_at, updated_at, deleted_at) VALUES (?, 'ws1', ?, ?, ?, ?, ?)").run(id, id, startsAt, NOW, NOW, deleted);

beforeEach(() => {
  h.db = new (BetterSqlite3 as unknown as new (f: string) => Database.Database)(":memory:");
  h.db.exec(MOBILE_SCHEMA_SQL);
  h.db.exec(MOBILE_TRIGGERS_SQL);
  col("todo", "todo");
  col("done", "done");
});

describe("listOpenDueTasks", () => {
  it("returns open, dated, live tasks due on or before the day, oldest first", () => {
    card("late", "2026-11-20", "todo");
    card("today", "2026-11-22", "todo");
    card("iso", "2026-11-22T09:00:00.000Z", "todo");
    card("future", "2026-11-23", "todo");
    card("done", "2026-11-20", "done");
    card("nodue", null, "todo");
    card("arch", "2026-11-20", "todo", "2026-11-21");
    expect(listOpenDueTasks("2026-11-22").map((t) => t.id)).toEqual(["late", "today", "iso"]);
  });

  it("honours the limit", () => {
    card("a", "2026-11-20", "todo");
    card("b", "2026-11-21", "todo");
    expect(listOpenDueTasks("2026-11-22", 1).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("listMeetingsBetween", () => {
  it("keeps live meetings inside [start, end), earliest first", () => {
    meeting("late", "2026-11-22T15:00:00.000Z");
    meeting("early", "2026-11-22T08:00:00.000Z");
    meeting("edge", "2026-11-23T00:00:00.000Z");
    meeting("before", "2026-11-21T23:59:59.000Z");
    meeting("gone", "2026-11-22T09:00:00.000Z", NOW);
    expect(listMeetingsBetween("2026-11-22T00:00:00.000Z", "2026-11-23T00:00:00.000Z").map((m) => m.id)).toEqual(["early", "late"]);
  });
});
