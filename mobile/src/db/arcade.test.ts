/** Shared arcade DB loader: live projects, due dates, note links, and demo fallback. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import BetterSqlite3 from "../../../vitest-sqlite-shim.cjs";
import type Database from "better-sqlite3";
import { MOBILE_SCHEMA_SQL } from "./schema";

const h = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("./index", () => ({
  getDb: () => ({ getAllSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).all(...p) }),
}));

const { listArcadeProjects, loadArcadeProjects } = await import("./arcade");
const NOW = new Date(2026, 10, 24, 12, 0, 0);
const STAMP = "2026-11-24T10:00:00.000Z";

function project(id: string, name: string, updated = STAMP) {
  h.db.prepare(`INSERT INTO projects (id, workspace_id, name, created_at, updated_at) VALUES (?, 'ws', ?, ?, ?)`)
    .run(id, name, STAMP, updated);
  for (const type of ["todo", "done"])
    h.db.prepare(`INSERT INTO board_columns (id, project_id, workspace_id, name, type, "order", created_at, updated_at) VALUES (?, ?, 'ws', ?, ?, 0, ?, ?)`)
      .run(`${id}-${type}`, id, type, type, STAMP, STAMP);
}
function task(id: string, projectId: string, title: string, priority: string, dueDate: string | null = null, col: "todo" | "done" = "todo") {
  h.db.prepare(`INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, priority, due_date, created_at, updated_at) VALUES (?, ?, ?, 'ws', ?, ?, ?, ?, ?)`)
    .run(id, `${projectId}-${col}`, projectId, title, priority, dueDate, STAMP, STAMP);
}
function note(id: string, projectId: string, title: string, links: string[] = [], content = "Some note content") {
  h.db.prepare(`INSERT INTO notes (id, project_id, workspace_id, title, content, linked_note_ids, created_at, updated_at) VALUES (?, ?, 'ws', ?, ?, ?, ?, ?)`)
    .run(id, projectId, title, content, JSON.stringify(links), STAMP, STAMP);
}

beforeEach(() => {
  h.db = new (BetterSqlite3 as unknown as new (f: string) => Database.Database)(":memory:");
  h.db.exec(MOBILE_SCHEMA_SQL);
});

describe("listArcadeProjects", () => {
  it("loads open tasks with overdue flags and cross-note links", () => {
    project("p1", "Cairn Mobile", "2026-11-24T12:00:00.000Z");
    task("t1", "p1", "Fix sync", "urgent", "2026-11-23"); // yesterday -> overdue
    task("t2", "p1", "Polish UI", "low", "2026-11-24"); // today 17:00
    task("t3", "p1", "Shipped", "high", null, "done");
    note("n1", "p1", "Sync Spec", ["n2", "missing", "n1"]);
    project("p2", "Garden", "2026-11-24T11:00:00.000Z");
    note("n2", "p2", "Seeds", []);

    const projs = listArcadeProjects(NOW);
    expect(projs.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(projs[0].tasks).toHaveLength(2);
    expect(projs[0].tasks[0]).toMatchObject({ title: "FIX SYNC", priority: "urgent", overdue: true });
    expect(projs[0].tasks[1]).toMatchObject({ title: "POLISH UI", priority: "low", overdue: false });
    // Filters out self-links and non-existent ids while preserving valid cross-project links.
    expect(projs[0].notes[0].links).toEqual(["n2"]);
  });

  it("falls back to demo projects when workspace is thin", () => {
    const res = loadArcadeProjects(NOW);
    expect(res.demo).toBe(true);
    expect(res.projects.length).toBeGreaterThanOrEqual(4);
  });
});
