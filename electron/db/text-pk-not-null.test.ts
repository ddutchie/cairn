/**
 * v60: every text primary key is NOT NULL. SQLite otherwise lets NULL into a
 * non-INTEGER primary key, so a create that forgot its id saved a row nobody
 * could address (Idea Flow promote-to-task, #194).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { SCHEMA_SQL, applySchema, applySchemaThrough, nullablePrimaryKeys, rebuildWithNotNullPrimaryKey } from "./schema";
import {
  changeFeedHead, createCard, createColumn, createNote, createProject, createWorkspace, getCards, searchNotes, updateNote,
} from "./queries";

const V59 = 59;
const dependents = (db: Database.Database) =>
  (db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY name").all() as Array<{ name: string }>)
    .map((r) => r.name);

describe("text primary keys", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it("are all NOT NULL on a fresh database", () => {
    const db = new BetterSqlite3(":memory:");
    applySchema(db);
    expect(nullablePrimaryKeys(db)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stay NOT NULL on the next startup, when the base schema recreates dropped tables", () => {
    // v49 drops chat_messages, and the base schema's CREATE TABLE IF NOT EXISTS
    // brings it back on every later startup, after v60 has already run.
    const db = new BetterSqlite3(":memory:");
    applySchema(db);
    applySchema(db);
    expect(nullablePrimaryKeys(db)).toEqual([]);
  });

  describe("upgrading a v59 database", () => {
    let db: Database.Database;
    let tablesBefore: string[];
    let dependentsBefore: string[];

    beforeEach(() => {
      db = new BetterSqlite3(":memory:");
      // Base tables as shipped before v60 (no NOT NULL on their ids).
      db.exec(SCHEMA_SQL.replace(/TEXT NOT NULL PRIMARY KEY/g, "TEXT PRIMARY KEY"));
      applySchemaThrough(db, V59);
      tablesBefore = nullablePrimaryKeys(db).map((t) => t.table);
      createWorkspace(db, { id: "ws1", name: "WS" });
      createProject(db, { id: "p1", workspaceId: "ws1", name: "Proj" });
      createColumn(db, { id: "c1", projectId: "p1", workspaceId: "ws1", name: "Todo", type: "todo" });
      createCard(db, { id: "k1", columnId: "c1", projectId: "p1", workspaceId: "ws1", title: "Card" });
      createNote(db, { id: "n1", projectId: "p1", workspaceId: "ws1", title: "Zebra crossing", content: "striped body" });
      createNote(db, { id: "n2", projectId: "p1", workspaceId: "ws1", title: "Second", content: "plain" });
      // A NULL-key row, as a buggy create could leave (app_kv has no change-feed trigger to stop it).
      db.exec("INSERT INTO app_kv (key, value, updated_at) VALUES (NULL, 'orphan', 'now'), ('kept', 'v', 'now')");
      dependentsBefore = dependents(db);
      applySchema(db);
    });

    it("starts with nullable text keys on the synced and local tables", () => {
      expect(tablesBefore).toEqual(expect.arrayContaining(["workspaces", "projects", "notes", "board_columns", "task_cards", "app_kv"]));
    });

    it("leaves no nullable text key and rejects a NULL id afterwards", () => {
      expect(nullablePrimaryKeys(db)).toEqual([]);
      expect(() => db.exec("INSERT INTO app_kv (key, value, updated_at) VALUES (NULL, 'x', 'now')"))
        .toThrow(/NOT NULL constraint failed: app_kv\.key/);
      expect(() => createCard(db, { id: null as never, columnId: "c1", projectId: "p1", workspaceId: "ws1", title: "No id" }))
        .toThrow(/NOT NULL constraint failed: task_cards\.id/);
    });

    it("gives a NULL-key row a new id instead of dropping it", () => {
      const rows = db.prepare("SELECT key, value FROM app_kv ORDER BY value").all() as Array<{ key: string; value: string }>;
      expect(rows.map((r) => r.value)).toEqual(["orphan", "v"]);
      expect(rows[0].key).toMatch(/^[0-9a-f]{32}$/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("gave 1 app_kv row(s) with a NULL primary key a new id"));
      expect(getCards(db, { projectId: "p1" }).map((c) => c.id)).toEqual(["k1"]);
      expect((db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n).toBe(2);
    });

    it("keeps every index and trigger", () => {
      expect(dependents(db)).toEqual(expect.arrayContaining(dependentsBefore));
    });

    it("keeps note full-text search aligned (rowids preserved)", () => {
      expect(searchNotes(db, { query: "zebra" }).map((n: { id: string }) => n.id)).toEqual(["n1"]);
      updateNote(db, "n2", { title: "Giraffe" });
      expect(searchNotes(db, { query: "giraffe" }).map((n: { id: string }) => n.id)).toEqual(["n2"]);
    });

    it("keeps the change-feed triggers firing", () => {
      const head = changeFeedHead(db);
      updateNote(db, "n1", { title: "Renamed" });
      expect(changeFeedHead(db)).toBeGreaterThan(head);
    });

    it("re-enables foreign keys and leaves no violations", () => {
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("user_version", { simple: true })).toBeGreaterThan(V59);
    });
  });

  it("rebuilds a parent table without cascading into its children", () => {
    const db = new BetterSqlite3(":memory:");
    db.exec(`
      CREATE TABLE parent (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE child (id TEXT PRIMARY KEY NOT NULL, parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE);
      CREATE INDEX idx_parent_name ON parent(name);
      INSERT INTO parent VALUES ('a', 'A'), (NULL, 'ghost');
      INSERT INTO child VALUES ('x', 'a');
    `);
    db.pragma("foreign_keys = OFF");
    const result = db.transaction(() => rebuildWithNotNullPrimaryKey(db, "parent", ["id"]))();
    db.pragma("foreign_keys = ON");
    expect(result).toEqual({ repaired: 1, dropped: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM parent WHERE name = 'ghost' AND id IS NOT NULL").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT * FROM child").all()).toEqual([{ id: "x", parent_id: "a" }]);
    expect(nullablePrimaryKeys(db)).toEqual([]);
    expect(dependents(db)).toContain("idx_parent_name");
    db.exec("DELETE FROM parent WHERE id = 'a'");
    expect(db.prepare("SELECT COUNT(*) AS n FROM child").get()).toEqual({ n: 0 }); // cascade still wired
  });

  it("drops a row whose composite key has a NULL, since there's no id to invent", () => {
    const db = new BetterSqlite3(":memory:");
    db.exec(`
      CREATE TABLE pair (a TEXT, b TEXT, v TEXT, PRIMARY KEY (a, b));
      INSERT INTO pair VALUES ('x', 'y', 'kept'), ('x', NULL, 'gone');
    `);
    db.pragma("foreign_keys = OFF");
    const result = db.transaction(() => rebuildWithNotNullPrimaryKey(db, "pair", ["a", "b"]))();
    expect(result).toEqual({ repaired: 0, dropped: 1 });
    expect(db.prepare("SELECT v FROM pair").all()).toEqual([{ v: "kept" }]);
    expect(nullablePrimaryKeys(db)).toEqual([]);
  });

  it("refuses to rebuild with foreign keys on, which would cascade-delete children", () => {
    const db = new BetterSqlite3(":memory:");
    db.exec("CREATE TABLE parent (id TEXT PRIMARY KEY); INSERT INTO parent VALUES ('a');");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1); // better-sqlite3's default
    expect(() => rebuildWithNotNullPrimaryKey(db, "parent", ["id"])).toThrow(/foreign keys on/);
  });

  it("refuses to run v60 inside a transaction, where foreign keys can't be turned off", () => {
    const db = new BetterSqlite3(":memory:");
    db.exec(SCHEMA_SQL.replace(/TEXT NOT NULL PRIMARY KEY/g, "TEXT PRIMARY KEY"));
    applySchemaThrough(db, V59);
    createWorkspace(db, { id: "ws1", name: "WS" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "Proj" });
    expect(() => db.transaction(() => applySchema(db))()).toThrow(/needs foreign keys off/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });
    expect(db.pragma("user_version", { simple: true })).toBe(V59);
  });
});
