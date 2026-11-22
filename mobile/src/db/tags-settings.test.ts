/** The Settings, Tags and Data queries: usage counts, rename/recolour, soft delete, row counts. */
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

const { listTagsWithUsage, updateTag, softDeleteTag, dataCounts, listAllTags } = await import("./queries");
const NOW = "2026-11-18T10:00:00.000Z";

const addTag = (id: string, name: string) =>
  h.db.prepare("INSERT INTO tags (id, workspace_id, name, color, created_at, updated_at) VALUES (?, 'ws1', ?, '#6366f1', ?, ?)").run(id, name, NOW, NOW);
const addNote = (id: string, tagIds: string[], deletedAt: string | null = null) =>
  h.db.prepare("INSERT INTO notes (id, project_id, workspace_id, title, content, tag_ids, created_at, updated_at, deleted_at) VALUES (?, 'p1', 'ws1', 't', 'x', ?, ?, ?, ?)").run(id, JSON.stringify(tagIds), NOW, NOW, deletedAt);

beforeEach(() => {
  h.db = new (BetterSqlite3 as unknown as new (f: string) => Database.Database)(":memory:");
  h.db.exec(MOBILE_SCHEMA_SQL);
  h.db.exec(MOBILE_TRIGGERS_SQL);
});

describe("tag settings queries", () => {
  it("counts live notes per tag and ignores deleted ones", () => {
    addTag("a", "alpha");
    addTag("b", "beta");
    addNote("n1", ["a", "b"]);
    addNote("n2", ["a"]);
    addNote("n3", ["a"], NOW);
    expect(listTagsWithUsage().map((t) => [t.name, t.uses])).toEqual([["alpha", 2], ["beta", 1]]);
  });

  it("renames and recolours, keeping the other field", () => {
    addTag("a", "alpha");
    updateTag("a", { name: "  Gamma " });
    updateTag("a", { color: "#ef4444" });
    expect(listAllTags()).toEqual([{ id: "a", name: "Gamma", color: "#ef4444" }]);
  });

  it("ignores a blank rename", () => {
    addTag("a", "alpha");
    updateTag("a", { name: "   " });
    expect(listAllTags()[0].name).toBe("alpha");
  });

  it("soft-deletes: gone from the list, row kept as a tombstone", () => {
    addTag("a", "alpha");
    softDeleteTag("a");
    expect(listAllTags()).toEqual([]);
    expect(h.db.prepare("SELECT deleted_at AS d FROM tags WHERE id='a'").get()).toEqual({ d: expect.any(String) });
  });
});

describe("dataCounts", () => {
  it("counts live rows only", () => {
    addTag("a", "alpha");
    addNote("n1", []);
    addNote("n2", [], NOW);
    expect(dataCounts()).toMatchObject({ notes: 1, tags: 1, projects: 0, tasks: 0, people: 0 });
  });
});
