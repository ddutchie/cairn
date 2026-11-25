/** Task Force levels: live projects with open tasks, done columns and archived rows left out. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import BetterSqlite3 from "../../../vitest-sqlite-shim.cjs";
import type Database from "better-sqlite3";
import { MOBILE_SCHEMA_SQL } from "./schema";

const h = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("./index", () => ({
  getDb: () => ({ getAllSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).all(...p) }),
}));

const { listTaskForceLevels } = await import("./task-force");
const NOW = "2026-11-24T10:00:00.000Z";

function project(id: string, name: string, extra: { archived?: boolean; updated?: string } = {}) {
  h.db.prepare(`INSERT INTO projects (id, workspace_id, name, created_at, updated_at, archived_at) VALUES (?, 'ws', ?, ?, ?, ?)`)
    .run(id, name, NOW, extra.updated ?? NOW, extra.archived ? NOW : null);
  for (const type of ["todo", "done"])
    h.db.prepare(`INSERT INTO board_columns (id, project_id, workspace_id, name, type, "order", created_at, updated_at) VALUES (?, ?, 'ws', ?, ?, 0, ?, ?)`)
      .run(`${id}-${type}`, id, type, type, NOW, NOW);
}
function task(id: string, projectId: string, title: string, priority: string, col: "todo" | "done" = "todo") {
  h.db.prepare(`INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, priority, created_at, updated_at) VALUES (?, ?, ?, 'ws', ?, ?, ?, ?)`)
    .run(id, `${projectId}-${col}`, projectId, title, priority, NOW, NOW);
}
function note(id: string, projectId: string, title: string) {
  h.db.prepare(`INSERT INTO notes (id, project_id, workspace_id, title, created_at, updated_at) VALUES (?, ?, 'ws', ?, ?, ?)`)
    .run(id, projectId, title, NOW, NOW);
}

beforeEach(() => {
  h.db = new (BetterSqlite3 as unknown as new (f: string) => Database.Database)(":memory:");
  h.db.exec(MOBILE_SCHEMA_SQL);
});

describe("listTaskForceLevels", () => {
  it("turns projects with open tasks into levels, urgent first", () => {
    project("p1", "Garden", { updated: "2026-11-24T12:00:00.000Z" });
    task("t1", "p1", "Weed beds", "low");
    task("t2", "p1", "Fix fence", "urgent");
    task("t3", "p1", "Planted bulbs", "high", "done");
    task("t4", "p1", "Odd", "whenever");
    note("n1", "p1", "Planting plan");
    project("p2", "All done");
    task("t5", "p2", "Shipped", "high", "done");
    project("p3", "Old", { archived: true });
    task("t6", "p3", "Ignored", "low");

    const levels = listTaskForceLevels();
    expect(levels.map((l) => l.id)).toEqual(["p1"]);
    const [garden] = levels;
    expect(garden.name).toBe("Garden");
    expect(garden.notes).toEqual(["Planting plan"]);
    // Urgent leads; done-column tasks are left out; an unknown priority plays as medium.
    expect(garden.tasks[0]).toEqual({ title: "Fix fence", priority: "urgent" });
    expect(garden.tasks).toHaveLength(3);
    expect(garden.tasks).toContainEqual({ title: "Weed beds", priority: "low" });
    expect(garden.tasks).toContainEqual({ title: "Odd", priority: "medium" });
  });

  it("returns nothing for an empty workspace", () => {
    expect(listTaskForceLevels()).toEqual([]);
  });
});
