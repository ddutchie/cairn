/** Project create and edit on the phone: default columns, sync capture, field edits. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import BetterSqlite3 from "../../../vitest-sqlite-shim.cjs";
import type Database from "better-sqlite3";
import { MOBILE_SCHEMA_SQL, MOBILE_TRIGGERS_SQL } from "./schema";
import { DEFAULT_COLUMNS } from "@cairn/shared/projects/defaults";

const h = vi.hoisted(() => ({ db: null as unknown as Database.Database, active: "ws1" as string | null }));
vi.mock("./index", () => ({
  getActiveSource: () => h.active,
  getDb: () => ({
    getAllSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).all(...p),
    getFirstSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).get(...p) ?? null,
    runSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).run(...p),
    withTransactionSync: (fn: () => void) => h.db.transaction(fn)(),
  }),
}));
vi.mock("@/sync/write-signal", () => ({ notifyLocalWrite: () => {} }));

const { createProject, updateProject, getProjectFields, listColumns, listProjects } = await import("./queries");
const NOW = "2026-11-22T10:00:00.000Z";

beforeEach(() => {
  h.db = new (BetterSqlite3 as unknown as new (f: string) => Database.Database)(":memory:");
  h.db.exec(MOBILE_SCHEMA_SQL);
  h.db.exec(MOBILE_TRIGGERS_SQL);
  h.active = "ws1";
});

describe("createProject", () => {
  it("creates the project in the open workspace with the default columns", () => {
    const id = createProject({ name: "  Garden  ", description: "Beds", icon: "TreePine", priority: "high" });
    expect(getProjectFields(id)).toEqual({ id, name: "Garden", description: "Beds", icon: "TreePine", status: "active", priority: "high" });
    expect(h.db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(id)).toEqual({ workspace_id: "ws1" });
    expect(listColumns(id).map((c) => [c.name, c.type, c.order])).toEqual(DEFAULT_COLUMNS.map((c) => [c.name, c.type, c.order]));
    expect(listProjects().map((p) => p.id)).toContain(id);
  });

  it("stages the project and its columns for sync", () => {
    const id = createProject({ name: "Garden" });
    const staged = h.db.prepare("SELECT entity, entity_id FROM sync_pending").all() as { entity: string; entity_id: string }[];
    expect(staged.filter((r) => r.entity === "projects").map((r) => r.entity_id)).toEqual([id]);
    expect(staged.filter((r) => r.entity === "board_columns")).toHaveLength(DEFAULT_COLUMNS.length);
  });

  it("falls back to the first workspace row when no source is active", () => {
    h.active = null;
    h.db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws9', 'Home', ?, ?)").run(NOW, NOW);
    const id = createProject({ name: "Garden" });
    expect(h.db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(id)).toEqual({ workspace_id: "ws9" });
  });

  it("refuses a blank name", () => {
    expect(() => createProject({ name: "   " })).toThrow(/name/);
  });
});

describe("updateProject", () => {
  it("changes only the given fields and clears a blank description", () => {
    const id = createProject({ name: "Garden", description: "Beds", priority: "low" });
    updateProject(id, { name: "Allotment", status: "on_hold", description: " " });
    expect(getProjectFields(id)).toMatchObject({ name: "Allotment", status: "on_hold", priority: "low", description: "" });
  });

  it("refuses a blank name and an unknown project", () => {
    const id = createProject({ name: "Garden" });
    expect(() => updateProject(id, { name: "" })).toThrow(/name/);
    expect(() => updateProject("missing", { name: "X" })).toThrow(/not found/);
  });
});
