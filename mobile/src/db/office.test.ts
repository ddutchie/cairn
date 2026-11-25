/** The phone's office mirror: buildOffice over the mobile SQLite rows. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import BetterSqlite3 from "../../../vitest-sqlite-shim.cjs";
import type Database from "better-sqlite3";
import { MOBILE_SCHEMA_SQL, MOBILE_TRIGGERS_SQL } from "./schema";

const h = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("./index", () => ({
  getDb: () => ({
    getAllSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).all(...p),
    getFirstSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).get(...p) ?? null,
    runSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).run(...p),
    withTransactionSync: (fn: () => void) => h.db.transaction(fn)(),
  }),
}));

const { loadOfficeData } = await import("./arcade");

const NOW = "2026-11-25T11:30:00.000Z";
const RECENT = "2026-11-24T10:00:00.000Z";

function seed() {
  const db = h.db;
  db.prepare(`INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'Home', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO projects (id, workspace_id, name, created_at, updated_at) VALUES ('p1', 'ws', 'Alpha', ?, ?), ('p2', 'ws', 'Beta', ?, ?)`).run(NOW, NOW, NOW, NOW);
  db.prepare(`INSERT INTO board_columns (id, project_id, workspace_id, name, type, "order", created_at, updated_at)
    VALUES ('todo', 'p1', 'ws', 'Todo', 'todo', 0, ?, ?), ('doing', 'p1', 'ws', 'Doing', 'in_progress', 1, ?, ?), ('done', 'p1', 'ws', 'Done', 'done', 2, ?, ?)`).run(NOW, NOW, NOW, NOW, NOW, NOW);
  db.prepare(`INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, priority, due_date, assignee, "order", created_at, updated_at)
    VALUES ('t1', 'todo', 'p1', 'ws', 'Past due', 'high', '2026-11-20', ' Sam ', 0, ?, ?)`).run(NOW, RECENT);
  db.prepare(`INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, priority, "order", created_at, updated_at)
    VALUES ('t2', 'doing', 'p1', 'ws', 'In progress', 'medium', 1, ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, priority, "order", created_at, updated_at)
    VALUES ('t3', 'done', 'p1', 'ws', 'Finished', 'low', 2, ?, ?)`).run(NOW, RECENT);
  db.prepare(`INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, "order", created_at, updated_at, archived_at)
    VALUES ('t4', 'todo', 'p1', 'ws', 'Archived', 3, ?, ?, ?)`).run(NOW, NOW, NOW);
  db.prepare(`INSERT INTO notes (id, project_id, workspace_id, title, is_pinned, updated_at, created_at)
    VALUES ('n1', 'p1', 'ws', 'Plan', 1, ?, ?), ('n2', 'p1', 'ws', '   ', 0, ?, ?)`).run(NOW, NOW, NOW, NOW);
}

beforeEach(() => {
  h.db = new (BetterSqlite3 as unknown as new (f: string) => Database.Database)(":memory:");
  h.db.exec(MOBILE_SCHEMA_SQL);
  h.db.exec(MOBILE_TRIGGERS_SQL);
  seed();
});

describe("loadOfficeData", () => {
  it("mirrors open cards with zones, assignees and due state", () => {
    const { office, workspaceId } = loadOfficeData(new Date(NOW));
    expect(workspaceId).toBe("ws");
    expect(office.demo).toBe(false);
    const p1 = office.projects.find((p) => p.id === "p1")!;
    expect(p1.cards.map((c) => c.id).sort()).toEqual(["t1", "t2"]);
    const t1 = p1.cards.find((c) => c.id === "t1")!;
    expect(t1).toMatchObject({ zone: "backlog", assignee: "SAM", overdue: true, dueKey: "2026-11-20" });
    expect(p1.cards.find((c) => c.id === "t2")).toMatchObject({ zone: "doing" });
    expect(p1.notes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("counts a recently-touched done card for the done board", () => {
    const { office } = loadOfficeData(new Date(NOW));
    expect(office.projects.find((p) => p.id === "p1")!.doneThisWeek).toBe(1);
    expect(office.projects.find((p) => p.id === "p1")!.doneTotal).toBe(1);
  });

  it("changes its fingerprint when the workspace changes", () => {
    const a = loadOfficeData(new Date(NOW)).fingerprint;
    h.db.prepare(`INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, "order", created_at, updated_at)
      VALUES ('t9', 'todo', 'p1', 'ws', 'New', 9, ?, ?)`).run(NOW, "2026-11-25T12:00:00.000Z");
    const b = loadOfficeData(new Date(NOW)).fingerprint;
    expect(b).not.toBe(a);
    expect(loadOfficeData(new Date(NOW)).fingerprint).toBe(b);
  });
});
