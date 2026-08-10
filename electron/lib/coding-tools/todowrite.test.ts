/**
 * Unit tests for the todowrite coding tool.
 */

import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../../db/schema";
import { createWorkspace, createProject, createPiSession, getSessionTodos } from "../../db/queries";
import { todowriteTool, todowriteToolDefinition } from "./todowrite";

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

describe("todowriteTool", () => {
  let db: Database.Database;
  let ctx: { db: Database.Database; sessionId: string };

  beforeEach(() => {
    db = makeDb();
    createWorkspace(db, { id: "ws1", name: "Work" });
    createProject(db, { id: "proj1", workspaceId: "ws1", name: "Project" });
    createPiSession(db, {
      id: "pi1", projectId: "proj1", taskTitle: "Sweep", cwd: "/tmp", mode: "execute", spawnedAt: "2026-08-10T00:00:00.000Z",
    });
    ctx = { db, sessionId: "pi1" };
  });

  it("persists the given list and returns it", async () => {
    const out = await todowriteTool(
      { todos: [{ content: "Ship", status: "in_progress", priority: "high" }] },
      ctx,
    );
    expect(JSON.parse(out)).toEqual({ todos: [{ content: "Ship", status: "in_progress", priority: "high" }] });
    expect(getSessionTodos(db, "pi1")).toEqual([{ content: "Ship", status: "in_progress", priority: "high" }]);
  });

  it("normalises invalid status/priority and empty content", async () => {
    await todowriteTool(
      { todos: [
        { content: 123 as unknown as string, status: "bogus" as never, priority: "urgent" as never },
        { content: "", status: "pending" as never, priority: "medium" as never },
      ] },
      ctx,
    );
    expect(getSessionTodos(db, "pi1")).toEqual([
      { content: "123", status: "pending", priority: "medium" },
      { content: "", status: "pending", priority: "medium" },
    ]);
  });

  it("persists an empty list (clears prior todos)", async () => {
    await todowriteTool({ todos: [{ content: "Old", status: "completed", priority: "low" }] }, ctx);
    await todowriteTool({ todos: [] }, ctx);
    expect(getSessionTodos(db, "pi1")).toEqual([]);
  });

  it("rejects more than one in_progress todo without persisting", async () => {
    const out = await todowriteTool(
      {
        todos: [
          { content: "A", status: "in_progress", priority: "high" },
          { content: "B", status: "in_progress", priority: "medium" },
        ],
      },
      ctx,
    );
    expect(JSON.parse(out).error).toContain("exactly one may be active");
    expect(getSessionTodos(db, "pi1")).toEqual([]);
  });

  it("accepts a single in_progress todo", async () => {
    const out = await todowriteTool(
      { todos: [{ content: "A", status: "in_progress", priority: "high" }] },
      ctx,
    );
    expect(JSON.parse(out).error).toBeUndefined();
    expect(getSessionTodos(db, "pi1")).toHaveLength(1);
  });

  it("defines a schema with the required todos array", () => {
    expect(todowriteToolDefinition.function.name).toBe("todowrite");
    expect(todowriteToolDefinition.function.parameters.required).toContain("todos");
  });
});
