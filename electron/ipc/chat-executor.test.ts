/**
 * T29 — Unit tests for chat-executor.ts tool cases
 *
 * Uses an in-memory SQLite DB. Covers happy path, missing entity,
 * and ensures tools return { error } rather than throwing.
 */

import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import {
  createWorkspace, createProject, createNote,
  createColumn, createCard, updateNote, getCardById,
} from "../db/queries";
import { executeTool } from "./chat-executor";
import type { LLMConfig } from "../lib/llm";
import type { ChatRequest } from "../lib/tools";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

const llmConfig: LLMConfig = { baseUrl: "http://localhost", model: "test", apiKey: "" };
const chatReq: ChatRequest = { workspaceId: "ws1", projectId: "proj1", threadId: "t1" };

function noEmit() {}

function seed(db: Database.Database) {
  createWorkspace(db, { id: "ws1", name: "Workspace" });
  createProject(db, { id: "proj1", workspaceId: "ws1", name: "Project" });
  createColumn(db, { id: "col1", projectId: "proj1", workspaceId: "ws1", name: "Backlog", type: "backlog", order: 0 });
  createColumn(db, { id: "col2", projectId: "proj1", workspaceId: "ws1", name: "Done", type: "done", order: 4 });
  createNote(db, { id: "note1", projectId: "proj1", workspaceId: "ws1", title: "My Note", content: "hello", contentText: "hello" });
  createCard(db, { id: "card1", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Task One", order: 0 });
}

async function exec(db: Database.Database, name: string, args: Record<string, unknown>) {
  return executeTool(db, chatReq, "/tmp/ws", llmConfig, name, args as never, noEmit);
}

// ── get_cairn_context ─────────────────────────────────────────────────────────

describe("get_cairn_context", () => {
  it("returns workspaces and projects", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_cairn_context", {}) as Record<string, unknown>;
    expect(result).toHaveProperty("workspaces");
    expect(result).toHaveProperty("projects");
  });
});

// ── get_active_context ────────────────────────────────────────────────────────

describe("get_active_context", () => {
  it("returns activeProject and columns", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_active_context", {}) as Record<string, unknown>;
    expect(result).toHaveProperty("activeProject");
    expect(result).toHaveProperty("columns");
  });
});

// ── get_project_summary ───────────────────────────────────────────────────────

describe("get_project_summary", () => {
  it("returns canonical shape", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_project_summary", { projectId: "proj1" }) as Record<string, unknown>;
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("noteCount");
    expect(result).toHaveProperty("totalCards");
    expect(result).toHaveProperty("cardsByColumn");
    expect(result).toHaveProperty("pinnedNotes");
    expect(result).toHaveProperty("recentActivity");
  });

  it("returns { error } for missing project", async () => {
    const db = makeDb();
    applySchema(db);
    const result = await exec(db, "get_project_summary", { projectId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── list_notes ────────────────────────────────────────────────────────────────

describe("list_notes", () => {
  it("returns all non-archived notes", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "list_notes", { projectId: "proj1" }) as Array<Record<string, unknown>>;
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("note1");
  });

  it("returns empty array when project has no notes", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "list_notes", { projectId: "nonexistent" }) as unknown[];
    expect(result).toEqual([]);
  });
});

// ── list_tasks ────────────────────────────────────────────────────────────────

describe("list_tasks", () => {
  it("returns columns with tasks", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "list_tasks", { projectId: "proj1" }) as Array<Record<string, unknown>>;
    expect(Array.isArray(result)).toBe(true);
    const backlog = result.find((c) => c.columnId === "col1");
    expect(backlog).toBeDefined();
    expect((backlog!.tasks as unknown[]).length).toBe(1);
  });
});

// ── search_notes ──────────────────────────────────────────────────────────────

describe("search_notes", () => {
  it("finds matching notes", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "search_notes", { query: "hello" }) as Array<Record<string, unknown>>;
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("note1");
  });

  it("returns empty for no match", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "search_notes", { query: "zzznomatch" }) as unknown[];
    expect(result).toEqual([]);
  });
});

// ── search_tasks ──────────────────────────────────────────────────────────────

describe("search_tasks", () => {
  it("finds matching tasks", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "search_tasks", { query: "Task One" }) as Array<Record<string, unknown>>;
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("card1");
  });
});

// ── get_note ──────────────────────────────────────────────────────────────────

describe("get_note", () => {
  it("returns note by ID", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_note", { noteId: "note1" }) as Record<string, unknown>;
    expect(result.id).toBe("note1");
    expect(result.content).toBe("hello");
  });

  it("returns { error } for missing note", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_note", { noteId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── get_task ──────────────────────────────────────────────────────────────────

describe("get_task", () => {
  it("returns task by ID", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_task", { cardId: "card1" }) as Record<string, unknown>;
    expect(result.id).toBe("card1");
    expect(result.columnId).toBe("col1");
  });

  it("returns { error } for missing task", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_task", { cardId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── create_note ───────────────────────────────────────────────────────────────

describe("create_note", () => {
  it("creates and returns a note", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "create_note", { projectId: "proj1", title: "New Note", content: "body" }) as Record<string, unknown>;
    expect(result.title).toBe("New Note");
    expect(result.projectId).toBe("proj1");
  });

  it("returns { error } for missing project", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "create_note", { projectId: "nope", title: "X" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── update_note ───────────────────────────────────────────────────────────────

describe("update_note", () => {
  it("updates note title and content", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "update_note", { noteId: "note1", title: "Updated", content: "new body" }) as Record<string, unknown>;
    expect(result.title).toBe("Updated");
  });

  it("returns { error } for missing note", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "update_note", { noteId: "nope", title: "X" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── create_task ───────────────────────────────────────────────────────────────

describe("create_task", () => {
  it("creates a card in a column", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "create_task", { columnId: "col1", projectId: "proj1", title: "New Task" }) as Record<string, unknown>;
    expect(result.title).toBe("New Task");
    expect(result.columnId).toBe("col1");
  });

  it("returns { error } for missing column", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "create_task", { columnId: "nope", projectId: "proj1", title: "X" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── update_task ───────────────────────────────────────────────────────────────

describe("update_task", () => {
  it("updates task title", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "update_task", { cardId: "card1", title: "Updated Task" }) as Record<string, unknown>;
    expect(result.title).toBe("Updated Task");
  });

  it("returns { error } for missing task", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "update_task", { cardId: "nope", title: "X" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── update_task_status ────────────────────────────────────────────────────────

describe("update_task_status", () => {
  it("moves task to target column", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "update_task_status", { cardId: "card1", targetColumnId: "col2" }) as Record<string, unknown>;
    expect(result.columnId).toBe("col2");
  });

  it("returns { error } for missing card", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "update_task_status", { cardId: "nope", targetColumnId: "col2" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });

  it("returns { error } for missing target column", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "update_task_status", { cardId: "card1", targetColumnId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── bulk_update_task_status ───────────────────────────────────────────────────

describe("bulk_update_task_status", () => {
  it("moves multiple tasks to target column", async () => {
    const db = makeDb();
    seed(db);
    // Add a second card to move
    createCard(db, { id: "card2", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Task 2", order: 1 });
    const result = await exec(db, "bulk_update_task_status", { cardIds: ["card1", "card2"], targetColumnId: "col2" }) as Record<string, unknown>;
    expect(result.moved).toBe(2);
    expect((result.failed as unknown[]).length).toBe(0);
    expect(result.targetColumnId).toBe("col2");
    // Verify DB state
    const card1 = getCardById(db, "card1");
    expect(card1?.columnId).toBe("col2");
  });

  it("reports missing cards without aborting the rest", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "bulk_update_task_status", { cardIds: ["card1", "does-not-exist"], targetColumnId: "col2" }) as Record<string, unknown>;
    expect(result.moved).toBe(1);
    const failed = result.failed as Array<Record<string, unknown>>;
    expect(failed.length).toBe(1);
    expect(failed[0].id).toBe("does-not-exist");
    expect(failed[0]).toHaveProperty("error");
  });

  it("returns { error } for missing target column", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "bulk_update_task_status", { cardIds: ["card1"], targetColumnId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });

  it("returns { error } for empty cardIds array", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "bulk_update_task_status", { cardIds: [], targetColumnId: "col2" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── create_project ────────────────────────────────────────────────────────────

describe("create_project", () => {
  it("creates project with default columns", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "create_project", { workspaceId: "ws1", name: "New Project" }) as Record<string, unknown>;
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("columns");
    expect((result.columns as unknown[]).length).toBe(5);
  });
});

// ── update_project ────────────────────────────────────────────────────────────

describe("update_project", () => {
  it("updates project name", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "update_project", { projectId: "proj1", name: "Renamed" }) as Record<string, unknown>;
    expect(result.name).toBe("Renamed");
  });

  it("returns { error } for missing project", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "update_project", { projectId: "nope", name: "X" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── delete_note ───────────────────────────────────────────────────────────────

describe("delete_note", () => {
  it("deletes note and returns confirmation", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "delete_note", { noteId: "note1" }) as Record<string, unknown>;
    expect(result.deleted).toBe(true);
    expect(result.id).toBe("note1");
  });

  it("returns { error } for missing note", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "delete_note", { noteId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── delete_task ───────────────────────────────────────────────────────────────

describe("delete_task", () => {
  it("deletes task and returns confirmation", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "delete_task", { cardId: "card1" }) as Record<string, unknown>;
    expect(result.deleted).toBe(true);
    expect(result.id).toBe("card1");
  });

  it("returns { error } for missing task", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "delete_task", { cardId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── link_note_to_task ─────────────────────────────────────────────────────────

describe("link_note_to_task", () => {
  it("links note and card bidirectionally", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "link_note_to_task", { noteId: "note1", cardId: "card1" }) as Record<string, unknown>;
    expect(result.linked).toBe(true);
  });

  it("returns { error } for missing note", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "link_note_to_task", { noteId: "nope", cardId: "card1" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── list_recent_activity ──────────────────────────────────────────────────────

describe("list_recent_activity", () => {
  it("returns recentNotes and recentTasks", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "list_recent_activity", { projectId: "proj1" }) as Record<string, unknown>;
    expect(result).toHaveProperty("recentNotes");
    expect(result).toHaveProperty("recentTasks");
  });
});

// ── unknown tool ──────────────────────────────────────────────────────────────

describe("unknown tool", () => {
  it("returns { error } for unknown tool names", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "totally_unknown_tool", {}) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});
