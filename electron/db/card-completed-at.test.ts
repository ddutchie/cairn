import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./schema";
import { createWorkspace, createProject, createColumn, createCard, updateCard, getCards } from "./queries";

describe("task_cards.completed_at (schema v58 triggers)", () => {
  let db: Database.Database;
  const card = (id: string) => getCards(db, { projectId: "p1" }).find((c) => c.id === id)!;

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    applySchema(db);
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    createColumn(db, { id: "todo", projectId: "p1", workspaceId: "ws1", name: "Todo", type: "todo" });
    createColumn(db, { id: "done", projectId: "p1", workspaceId: "ws1", name: "Done", type: "done" });
    createColumn(db, { id: "done2", projectId: "p1", workspaceId: "ws1", name: "Shipped", type: "done" });
  });

  it("stamps on entering a done column and clears on leaving", () => {
    createCard(db, { id: "c", columnId: "todo", projectId: "p1", workspaceId: "ws1", title: "C" });
    expect(card("c").completedAt).toBeUndefined();
    updateCard(db, "c", { columnId: "done" });
    const stamped = card("c").completedAt;
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    updateCard(db, "c", { columnId: "done2" }); // done → done keeps the original time
    expect(card("c").completedAt).toBe(stamped);
    updateCard(db, "c", { title: "renamed" }); // unrelated edits don't touch it
    expect(card("c").completedAt).toBe(stamped);
    updateCard(db, "c", { columnId: "todo" });
    expect(card("c").completedAt).toBeUndefined();
  });

  it("stamps cards created directly in a done column", () => {
    createCard(db, { id: "d", columnId: "done", projectId: "p1", workspaceId: "ws1", title: "D" });
    expect(card("d").completedAt).toBeTruthy();
  });

  it("keeps a peer-supplied completed_at when a synced row moves into done", () => {
    createCard(db, { id: "s", columnId: "todo", projectId: "p1", workspaceId: "ws1", title: "S" });
    db.prepare("UPDATE task_cards SET column_id = 'done', completed_at = '2026-01-02T03:04:05.000Z' WHERE id = 's'").run();
    expect(card("s").completedAt).toBe("2026-01-02T03:04:05.000Z");
  });
});
