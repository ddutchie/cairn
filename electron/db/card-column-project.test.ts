/**
 * A card's column must belong to the card's own project. A card filed under
 * one project but sitting in another's column shows on neither board (#202
 * follow-up: MCP update_task/create_task accepted any column id).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema, applySchemaThrough } from "./schema";
import { changeFeedHead, createCard, createColumn, createProject, createWorkspace, getCardById, getCards, updateCard } from "./queries";
import { executeTool } from "../mcp-server";

function seed(db: Database.Database) {
  createWorkspace(db, { id: "ws", name: "W" });
  for (const p of ["a", "b"]) {
    createProject(db, { id: p, workspaceId: "ws", name: p.toUpperCase() });
    for (const [type, order] of [["todo", 0], ["in_progress", 1], ["done", 2]] as const) {
      createColumn(db, { id: `${p}-${type}`, projectId: p, workspaceId: "ws", name: type, type, order });
    }
  }
}

describe("card column guard", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    applySchema(db);
    seed(db);
    createCard(db, { id: "k", columnId: "a-todo", projectId: "a", workspaceId: "ws", title: "Card" });
  });

  it("rejects creating a card in another project's column", () => {
    expect(() => createCard(db, { id: "x", columnId: "b-todo", projectId: "a", workspaceId: "ws", title: "Stray" }))
      .toThrow(/belongs to a different project/);
    expect(() => createCard(db, { id: "y", columnId: "nope", projectId: "a", workspaceId: "ws", title: "Lost" }))
      .toThrow(/Column not found/);
  });

  it("rejects moving a card into another project's column, but allows its own", () => {
    expect(() => updateCard(db, "k", { columnId: "b-in_progress" })).toThrow(/belongs to a different project/);
    expect(getCardById(db, "k")?.columnId).toBe("a-todo");
    expect(updateCard(db, "k", { columnId: "a-done" }).columnId).toBe("a-done");
  });

  describe("MCP tools", () => {
    let wp: string;
    const run = (name: string, args: Record<string, unknown>) => executeTool(db, wp, name, args) as Record<string, unknown>;
    beforeEach(() => { wp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-colproj-")); });
    afterEach(() => fs.rmSync(wp, { recursive: true, force: true }));

    it("update_task refuses a column from another project", () => {
      expect(run("update_task", { cardId: "k", columnId: "b-done" }).error).toMatch(/different project/);
      expect(getCardById(db, "k")?.columnId).toBe("a-todo");
    });

    it("create_task refuses a projectId that disagrees with the column, and takes the column's project otherwise", () => {
      expect(run("create_task", { columnId: "b-todo", projectId: "a", title: "Stray" }).error).toMatch(/belongs to project b/);
      const made = run("create_task", { columnId: "b-todo", title: "Fine" }) as { id: string };
      expect(getCardById(db, made.id)?.projectId).toBe("b");
    });
  });
});

describe("v61 repair", () => {
  let db: Database.Database;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db = new BetterSqlite3(":memory:");
    applySchemaThrough(db, 60);
    seed(db);
    createCard(db, { id: "home", columnId: "a-in_progress", projectId: "a", workspaceId: "ws", title: "Already home" });
    // What update_task used to allow: project a, column from project b.
    db.prepare(`INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, tag_ids, priority, linked_note_ids, blocked_by_ids, "order", created_at, updated_at)
      VALUES ('stray', 'b-in_progress', 'a', 'ws', 'Stray', '[]', 'medium', '[]', '[]', 0, 'now', 'now')`).run();
    db.prepare(`INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, tag_ids, priority, linked_note_ids, blocked_by_ids, "order", created_at, updated_at, deleted_at)
      VALUES ('gone', 'b-todo', 'a', 'ws', 'Tombstone', '[]', 'medium', '[]', '[]', 0, 'now', 'now', 'now')`).run();
  });
  afterEach(() => { warn.mockRestore(); });

  it("moves a stray card into its own project's column of the same type, at the end", () => {
    const head = changeFeedHead(db);
    const before = getCardById(db, "stray")!;
    applySchema(db);
    const after = getCardById(db, "stray")!;
    expect(after.columnId).toBe("a-in_progress");
    expect(after.order).toBe(1); // after "home"
    expect(after.version).toBe((before.version as number) + 1);
    expect(getCards(db, { projectId: "a" }).map((c) => c.id).sort()).toEqual(["home", "stray"]);
    expect(changeFeedHead(db)).toBeGreaterThan(head); // other windows hear about it
    expect((db.prepare("SELECT COUNT(*) AS n FROM sync_pending WHERE entity_id = 'stray'").get() as { n: number }).n).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("moved 1 card(s)"));
  });

  it("leaves tombstones and well-placed cards alone", () => {
    applySchema(db);
    expect((db.prepare("SELECT column_id FROM task_cards WHERE id = 'gone'").get() as { column_id: string }).column_id).toBe("b-todo");
    expect(getCardById(db, "home")?.order).toBe(0);
  });

  it("falls back to the first column when the project has no column of that type", () => {
    db.prepare("UPDATE board_columns SET type = 'custom' WHERE id = 'a-in_progress'").run();
    applySchema(db);
    expect(getCardById(db, "stray")?.columnId).toBe("a-todo");
  });
});
