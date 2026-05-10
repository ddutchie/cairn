/**
 * T29 — Unit tests for chat-executor.ts tool cases
 *
 * Uses an in-memory SQLite DB. Covers happy path, missing entity,
 * and ensures tools return { error } rather than throwing.
 *
 * Part 2 additions:
 *   - get_active_context — tags included, workspaceId/projectId scoping
 *   - get_task — blockedByIds parity with MCP server
 *   - ensure_note — create and update paths, idempotency, case-sensitive title
 *   - append_to_note — appends with separator, custom separator, error cases
 *   - patch_note — single replace, replaceAll, multi-occurrence error
 *   - block_task / unblock_task — happy path, self-block, circular dep, cross-project
 *   - list_ready_tasks — unblocked tasks only, blocker resolution on move-to-done
 *   - bulk_update_task_status to done — clears blockedByIds for all moved tasks
 *   - get_project_context_pack — shape, openTasks excludes done, pinnedNotes content
 */

import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import {
  createWorkspace, createProject, createNote, updateNote,
  createColumn, createCard, getCardById,
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
const chatReq: ChatRequest = { message: "", workspaceId: "ws1", projectId: "proj1", threadId: "t1" };

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

// ── get_note ──────────────────────────────────────────────────────────────────

describe("get_note linked fields", () => {
  it("returns linkedNoteIds and linkedCardIds", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_note", { noteId: "note1" }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    expect(result).toHaveProperty("linkedNoteIds");
    expect(result).toHaveProperty("linkedCardIds");
    expect(result).toHaveProperty("isPinned");
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

// ── upsert_project ────────────────────────────────────────────────────────────

describe("upsert_project (create)", () => {
  it("creates project with default columns when projectId is omitted", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "upsert_project", { workspaceId: "ws1", name: "New Project" }) as Record<string, unknown>;
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("columns");
    expect((result.columns as unknown[]).length).toBe(5);
  });

  it("returns { error } for missing workspaceId", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "upsert_project", { name: "X" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

describe("upsert_project (update)", () => {
  it("updates project name when projectId is provided", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "upsert_project", { projectId: "proj1", name: "Renamed" }) as Record<string, unknown>;
    expect(result).toHaveProperty("name");
  });

  it("returns { error } for missing project", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "upsert_project", { projectId: "nope", name: "X" }) as Record<string, unknown>;
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

// ── unknown tool ──────────────────────────────────────────────────────────────

describe("unknown tool", () => {
  it("returns { error } for unknown tool names", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "totally_unknown_tool", {}) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART 2 — Comprehensive coverage for previously untested tools
// ═════════════════════════════════════════════════════════════════════════════

// ── get_active_context ────────────────────────────────────────────────────────

describe("get_active_context — full coverage", () => {
  it("includes tags array", async () => {
    const db = makeDb();
    seed(db);
    db.prepare("INSERT INTO tags (id, workspace_id, name, color) VALUES (?, ?, ?, ?)").run("tag1", "ws1", "urgent", "#ff0000");
    const result = await exec(db, "get_active_context", {}) as Record<string, unknown>;
    expect(Array.isArray(result.tags)).toBe(true);
    const tags = result.tags as Array<{ id: string; name: string }>;
    expect(tags.find((t) => t.id === "tag1")).toBeDefined();
  });

  it("recentNotes includes notes from active project", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_active_context", {}) as Record<string, unknown>;
    const notes = result.recentNotes as Array<{ noteId: string }>;
    expect(notes.some((n) => n.noteId === "note1")).toBe(true);
  });

  it("columns include task counts", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_active_context", {}) as Record<string, unknown>;
    const columns = result.columns as Array<{ columnId: string; taskCount: number }>;
    const backlog = columns.find((c) => c.columnId === "col1");
    expect(backlog?.taskCount).toBe(1);
  });

  it("allProjects lists all non-archived projects", async () => {
    const db = makeDb();
    seed(db);
    createProject(db, { id: "proj2", workspaceId: "ws1", name: "Second Project" });
    const result = await exec(db, "get_active_context", {}) as Record<string, unknown>;
    const projects = result.allProjects as Array<{ projectId: string }>;
    expect(projects.map((p) => p.projectId)).toContain("proj1");
    expect(projects.map((p) => p.projectId)).toContain("proj2");
  });
});

// ── get_task — blockedByIds parity ────────────────────────────────────────────

describe("get_task — blockedByIds field", () => {
  it("includes blockedByIds in the result", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_task", { cardId: "card1" }) as Record<string, unknown>;
    expect(result).toHaveProperty("blockedByIds");
    expect(Array.isArray(result.blockedByIds)).toBe(true);
  });

  it("blockedByIds is empty when task has no blockers", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_task", { cardId: "card1" }) as Record<string, unknown>;
    expect((result.blockedByIds as string[])).toHaveLength(0);
  });

  it("blockedByIds contains the blocker after update_task { blockedBy }", async () => {
    const db = makeDb();
    seed(db);
    createCard(db, { id: "blocker", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocker", order: 1 });
    await exec(db, "update_task", { cardId: "card1", blockedBy: "blocker" });
    const result = await exec(db, "get_task", { cardId: "card1" }) as Record<string, unknown>;
    expect((result.blockedByIds as string[])).toContain("blocker");
  });
});

// ── ensure_note ───────────────────────────────────────────────────────────────

describe("ensure_note", () => {
  it("creates note and returns action: created", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "ensure_note", { projectId: "proj1", title: "README", content: "hello" }) as Record<string, unknown>;
    expect(result.action).toBe("created");
    expect(result).toHaveProperty("id");
  });

  it("updates existing note and returns action: updated", async () => {
    const db = makeDb();
    seed(db);
    await exec(db, "ensure_note", { projectId: "proj1", title: "README", content: "v1" });
    const result = await exec(db, "ensure_note", { projectId: "proj1", title: "README", content: "v2" }) as Record<string, unknown>;
    expect(result.action).toBe("updated");
  });

  it("only one note exists after two ensure calls with same title", async () => {
    const db = makeDb();
    seed(db);
    await exec(db, "ensure_note", { projectId: "proj1", title: "README", content: "v1" });
    await exec(db, "ensure_note", { projectId: "proj1", title: "README", content: "v2" });
    const notes = await exec(db, "list_notes", { projectId: "proj1" }) as Array<{ title: string }>;
    expect(notes.filter((n) => n.title === "README")).toHaveLength(1);
  });

  it("title match is case-sensitive — different case creates a new note", async () => {
    const db = makeDb();
    seed(db);
    await exec(db, "ensure_note", { projectId: "proj1", title: "readme", content: "lower" });
    const result = await exec(db, "ensure_note", { projectId: "proj1", title: "README", content: "upper" }) as Record<string, unknown>;
    expect(result.action).toBe("created");
  });

  it("archived note with same title triggers a new create", async () => {
    const db = makeDb();
    seed(db);
    const r1 = await exec(db, "ensure_note", { projectId: "proj1", title: "Spec", content: "old" }) as Record<string, unknown>;
    db.prepare("UPDATE notes SET archived_at = '2024-01-01T00:00:00.000Z' WHERE id = ?").run(r1.id as string);
    const r2 = await exec(db, "ensure_note", { projectId: "proj1", title: "Spec", content: "new" }) as Record<string, unknown>;
    expect(r2.action).toBe("created");
    expect(r2.id).not.toBe(r1.id);
  });

  it("returns error for unknown project", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "ensure_note", { projectId: "nope", title: "X" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── append_to_note ────────────────────────────────────────────────────────────

describe("append_to_note", () => {
  it("appends content with default double-newline separator", async () => {
    const db = makeDb();
    seed(db);
    await exec(db, "append_to_note", { noteId: "note1", content: "appended text" });
    const note = await exec(db, "get_note", { noteId: "note1" }) as Record<string, unknown>;
    expect(note.content as string).toBe("hello\n\nappended text");
  });

  it("uses a custom separator when provided", async () => {
    const db = makeDb();
    seed(db);
    await exec(db, "append_to_note", { noteId: "note1", content: "new section", separator: "\n---\n" });
    const note = await exec(db, "get_note", { noteId: "note1" }) as Record<string, unknown>;
    expect(note.content as string).toBe("hello\n---\nnew section");
  });

  it("returns newLength reflecting the combined content", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "append_to_note", { noteId: "note1", content: "more" }) as Record<string, unknown>;
    expect(result.newLength).toBe("hello\n\nmore".length);
  });

  it("multiple appends accumulate correctly", async () => {
    const db = makeDb();
    seed(db);
    await exec(db, "append_to_note", { noteId: "note1", content: "part 2" });
    await exec(db, "append_to_note", { noteId: "note1", content: "part 3" });
    const note = await exec(db, "get_note", { noteId: "note1" }) as Record<string, unknown>;
    expect(note.content as string).toContain("part 2");
    expect(note.content as string).toContain("part 3");
  });

  it("returns { error } for unknown note", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "append_to_note", { noteId: "nope", content: "x" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── patch_note ────────────────────────────────────────────────────────────────

describe("patch_note", () => {
  it("replaces a unique string", async () => {
    const db = makeDb();
    seed(db);
    await exec(db, "patch_note", { noteId: "note1", oldString: "hello", newString: "goodbye" });
    const note = await exec(db, "get_note", { noteId: "note1" }) as Record<string, unknown>;
    expect(note.content).toBe("goodbye");
  });

  it("returns error when oldString not found", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "patch_note", { noteId: "note1", oldString: "nothere", newString: "x" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });

  it("returns error when oldString matches multiple times and replaceAll not set", async () => {
    const db = makeDb();
    seed(db);
    updateNote(db, "note1", { content: "TODO fix\nTODO fix" });
    const result = await exec(db, "patch_note", { noteId: "note1", oldString: "TODO fix", newString: "done" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect(String(result.error)).toMatch(/2/);
  });

  it("replaceAll: true replaces all occurrences", async () => {
    const db = makeDb();
    seed(db);
    updateNote(db, "note1", { content: "TODO fix\nTODO fix" });
    await exec(db, "patch_note", { noteId: "note1", oldString: "TODO fix", newString: "done", replaceAll: true });
    const note = await exec(db, "get_note", { noteId: "note1" }) as Record<string, unknown>;
    expect(note.content as string).not.toContain("TODO fix");
    expect((note.content as string).match(/done/g)?.length).toBe(2);
  });

  it("sequential patches build on each other", async () => {
    const db = makeDb();
    seed(db);
    await exec(db, "patch_note", { noteId: "note1", oldString: "hello", newString: "Status: draft" });
    await exec(db, "patch_note", { noteId: "note1", oldString: "Status: draft", newString: "Status: done" });
    const note = await exec(db, "get_note", { noteId: "note1" }) as Record<string, unknown>;
    expect(note.content).toBe("Status: done");
  });

  it("returns { error } for unknown note", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "patch_note", { noteId: "nope", oldString: "x", newString: "y" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── update_task block / unblock ───────────────────────────────────────────────

describe("update_task block and unblock", () => {
  function seedTwo(db: Database.Database) {
    seed(db);
    createCard(db, { id: "card2", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Task Two", order: 1 });
  }

  it("blockedBy adds the blocker to blockedByIds", async () => {
    const db = makeDb();
    seedTwo(db);
    const result = await exec(db, "update_task", { cardId: "card2", blockedBy: "card1" }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    const ids = result.blockedByIds as string[];
    expect(ids).toContain("card1");
  });

  it("blocked task appears in get_task blockedByIds", async () => {
    const db = makeDb();
    seedTwo(db);
    await exec(db, "update_task", { cardId: "card2", blockedBy: "card1" });
    const task = await exec(db, "get_task", { cardId: "card2" }) as Record<string, unknown>;
    expect((task.blockedByIds as string[])).toContain("card1");
  });

  it("blocked task does not appear in list_ready_tasks", async () => {
    const db = makeDb();
    seedTwo(db);
    await exec(db, "update_task", { cardId: "card2", blockedBy: "card1" });
    const ready = await exec(db, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(ready.map((r) => r.id)).not.toContain("card2");
  });

  it("unblockFrom clears the blocker from blockedByIds", async () => {
    const db = makeDb();
    seedTwo(db);
    await exec(db, "update_task", { cardId: "card2", blockedBy: "card1" });
    await exec(db, "update_task", { cardId: "card2", unblockFrom: "card1" });
    const task = await exec(db, "get_task", { cardId: "card2" }) as Record<string, unknown>;
    expect((task.blockedByIds as string[])).not.toContain("card1");
  });

  it("returns { error } when blocking itself", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "update_task", { cardId: "card1", blockedBy: "card1" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect(String(result.error)).toMatch(/cannot block itself/i);
  });

  it("returns { error } for circular dependency", async () => {
    const db = makeDb();
    seedTwo(db);
    await exec(db, "update_task", { cardId: "card1", blockedBy: "card2" });
    const result = await exec(db, "update_task", { cardId: "card2", blockedBy: "card1" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect(String(result.error)).toMatch(/circular/i);
  });

  it("returns { error } for cross-project blocking", async () => {
    const db = makeDb();
    seed(db);
    createProject(db, { id: "proj2", workspaceId: "ws1", name: "Other" });
    createColumn(db, { id: "col-other", projectId: "proj2", workspaceId: "ws1", name: "Backlog", type: "backlog", order: 0 });
    createCard(db, { id: "card-other", columnId: "col-other", projectId: "proj2", workspaceId: "ws1", title: "Other task", order: 0 });
    const result = await exec(db, "update_task", { cardId: "card1", blockedBy: "card-other" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect(String(result.error)).toMatch(/same project/i);
  });

  it("returns { error } for missing task", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "update_task", { cardId: "nope", blockedBy: "card1" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });

  it("returns { error } for missing blocker", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "update_task", { cardId: "card1", blockedBy: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── list_ready_tasks ──────────────────────────────────────────────────────────

describe("list_ready_tasks", () => {
  it("returns unblocked tasks", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(result.map((r) => r.id)).toContain("card1");
  });

  it("excludes tasks in done columns", async () => {
    const db = makeDb();
    seed(db);
    createCard(db, { id: "done-card", columnId: "col2", projectId: "proj1", workspaceId: "ws1", title: "Done task", order: 0 });
    const result = await exec(db, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(result.map((r) => r.id)).not.toContain("done-card");
  });

  it("excludes tasks with unresolved blockers", async () => {
    const db = makeDb();
    seed(db);
    createCard(db, { id: "blocker", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocker", order: 1 });
    createCard(db, { id: "blocked", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocked", order: 2 });
    await exec(db, "update_task", { cardId: "blocked", blockedBy: "blocker" });
    const result = await exec(db, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(result.map((r) => r.id)).not.toContain("blocked");
    expect(result.map((r) => r.id)).toContain("blocker");
  });

  it("task becomes ready after blocker moves to done", async () => {
    const db = makeDb();
    seed(db);
    createCard(db, { id: "blocker", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocker", order: 1 });
    createCard(db, { id: "blocked", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocked", order: 2 });
    await exec(db, "update_task", { cardId: "blocked", blockedBy: "blocker" });
    await exec(db, "update_task", { cardId: "blocker", columnId: "col2" });
    const result = await exec(db, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(result.map((r) => r.id)).toContain("blocked");
  });
});

// ── update_task (columnId=done) — blocker cleanup ────────────────────────────

describe("update_task to done — blocker cleanup", () => {
  it("clears done task from blocked task's blockedByIds", async () => {
    const db = makeDb();
    seed(db);
    createCard(db, { id: "blocker", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocker", order: 1 });
    createCard(db, { id: "blocked", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocked", order: 2 });
    await exec(db, "update_task", { cardId: "blocked", blockedBy: "blocker" });

    await exec(db, "update_task", { cardId: "blocker", columnId: "col2" });

    const task = await exec(db, "get_task", { cardId: "blocked" }) as Record<string, unknown>;
    expect((task.blockedByIds as string[])).not.toContain("blocker");
    expect((task.blockedByIds as string[])).toHaveLength(0);
  });

  it("moving to non-done does NOT clear blockedByIds", async () => {
    const db = makeDb();
    seed(db);
    createColumn(db, { id: "col-ip", projectId: "proj1", workspaceId: "ws1", name: "In Progress", type: "in_progress", order: 1 });
    createCard(db, { id: "blocker", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocker", order: 1 });
    createCard(db, { id: "blocked", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocked", order: 2 });
    await exec(db, "update_task", { cardId: "blocked", blockedBy: "blocker" });

    await exec(db, "update_task", { cardId: "blocker", columnId: "col-ip" });

    const task = await exec(db, "get_task", { cardId: "blocked" }) as Record<string, unknown>;
    expect((task.blockedByIds as string[])).toContain("blocker");
  });
});

// ── bulk_update_task_status to done — blocker cleanup ────────────────────────

describe("bulk_update_task_status to done — blocker cleanup", () => {
  it("clears all bulk-moved tasks from blocked tasks' blockedByIds", async () => {
    const db = makeDb();
    seed(db);
    createCard(db, { id: "b1", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocker 1", order: 1 });
    createCard(db, { id: "b2", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocker 2", order: 2 });
    createCard(db, { id: "dep", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Dependent", order: 3 });
    await exec(db, "update_task", { cardId: "dep", blockedBy: "b1" });
    await exec(db, "update_task", { cardId: "dep", blockedBy: "b2" });

    await exec(db, "bulk_update_task_status", { cardIds: ["b1", "b2"], targetColumnId: "col2" });

    const task = await exec(db, "get_task", { cardId: "dep" }) as Record<string, unknown>;
    expect((task.blockedByIds as string[])).toHaveLength(0);
  });
});

// ── get_project_context_pack ──────────────────────────────────────────────────

describe("get_project_context_pack", () => {
  it("returns correct shape", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_project_context_pack", { projectId: "proj1" }) as Record<string, unknown>;
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("noteCount");
    expect(result).toHaveProperty("pinnedNotes");
    expect(result).toHaveProperty("openTasks");
    expect(result).toHaveProperty("recentActivity");
  });

  it("openTasks excludes done-column tasks", async () => {
    const db = makeDb();
    seed(db);
    createCard(db, { id: "done-card", columnId: "col2", projectId: "proj1", workspaceId: "ws1", title: "Done task", order: 1 });
    const result = await exec(db, "get_project_context_pack", { projectId: "proj1" }) as Record<string, unknown>;
    const openTasks = result.openTasks as Array<{ tasks: Array<{ id: string }> }>;
    const allIds = openTasks.flatMap((c) => c.tasks.map((t) => t.id));
    expect(allIds).toContain("card1");
    expect(allIds).not.toContain("done-card");
  });

  it("pinnedNotes includes full content", async () => {
    const db = makeDb();
    seed(db);
    createNote(db, { id: "pinned", projectId: "proj1", workspaceId: "ws1", title: "Pinned", content: "# Overview\nDetails here", isPinned: true });
    const result = await exec(db, "get_project_context_pack", { projectId: "proj1" }) as Record<string, unknown>;
    const pinned = result.pinnedNotes as Array<{ id: string; content: string }>;
    expect(pinned.find((n) => n.id === "pinned")?.content).toContain("Overview");
  });

  it("returns { error } for unknown project", async () => {
    const db = makeDb();
    seed(db);
    const result = await exec(db, "get_project_context_pack", { projectId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});
