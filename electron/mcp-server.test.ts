/**
 * Tests for the MCP server's executeTool function.
 *
 * Uses an in-memory SQLite database seeded via queries.ts helpers.
 * executeTool is the single dispatch function used by the MCP server for
 * all tool calls — these tests verify its behaviour end-to-end.
 *
 * Write tools that touch the filesystem (create_note, update_note, etc.)
 * use a temp directory as workspacePath so they don't fail.
 *
 * Key invariants being tested:
 *   - search_notes / search_tasks — case-insensitive substring match, projectId filter, limit
 *   - resolve_project — exact → starts-with → contains priority, archived exclusion
 *   - get_cairn_context — includes tags (regression: snap.tags was undefined)
 *   - get_project_context_pack / get_project_summary — correct shapes
 *   - list_notes / list_tasks — project filter, archived exclusion
 *   - list_ready_tasks — excludes done columns, excludes tasks blocked by unresolved blockers
 *   - block_task / unblock_task — circular dep rejection, cross-project rejection
 *   - create_task / create_note / delete_note / delete_task — basic write round-trips
 *   - ensure_note — idempotent create-then-update
 *   - patch_note — string replacement
 *
 * Multi-match / realistic query scenarios (Part 2):
 *   - search_notes with many matches — ranking order (most-recently-updated first),
 *     disambiguation by projectId, title-vs-content match priority
 *   - search_tasks with same title across multiple projects and columns
 *   - resolve_project priority when multiple projects partially match the same query
 *   - ensure_note scoping: same title in different projects creates two separate notes
 *   - patch_note with multiple occurrences of the same string
 *   - list_recent_activity ordering and workspaceId scoping across two workspaces
 *   - list_ready_tasks with multi-level blocker chains
 *   - get_project_context_pack with multiple open columns
 *   - delete_task cleans up blocker refs across multiple blocked tasks
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "./db/schema";
import {
  createWorkspace,
  createProject,
  createNote,
  createColumn,
  createCard,
  updateNote,
  updateCard,
} from "./db/queries";
import { executeTool, getSnapshot } from "./mcp-server";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cairn-mcp-test-"));
}

function removeTmpDir(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Seeds a minimal workspace + project + column into the DB.
 * Returns the IDs for use in tests.
 */
function seedBase(db: Database.Database, opts?: {
  workspaceId?: string;
  projectId?: string;
  columnId?: string;
  projectName?: string;
}) {
  const workspaceId = opts?.workspaceId ?? "ws1";
  const projectId   = opts?.projectId   ?? "proj1";
  const columnId    = opts?.columnId    ?? "col1";
  const projectName = opts?.projectName ?? "Test Project";

  createWorkspace(db, { id: workspaceId, name: "Test Workspace" });
  createProject(db, { id: projectId, workspaceId, name: projectName });
  createColumn(db, { id: columnId, projectId, workspaceId, name: "Backlog", type: "backlog", order: 0 });

  return { workspaceId, projectId, columnId };
}

// ── getSnapshot ───────────────────────────────────────────────────────────────

describe("getSnapshot", () => {
  it("returns empty collections for a fresh DB", () => {
    const db = makeDb();
    const snap = getSnapshot(db);
    expect(snap.workspaces).toHaveLength(0);
    expect(snap.projects).toHaveLength(0);
    expect(snap.notes).toHaveLength(0);
    expect(snap.columns).toHaveLength(0);
    expect(snap.cards).toHaveLength(0);
    expect(snap.tags).toHaveLength(0);
  });

  it("includes tags in the snapshot", () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    db.prepare("INSERT INTO tags (id, workspace_id, name, color) VALUES (?, ?, ?, ?)").run("tag1", "ws1", "urgent", "#ff0000");
    const snap = getSnapshot(db);
    expect(snap.tags).toHaveLength(1);
    expect(snap.tags[0]).toMatchObject({ id: "tag1", name: "urgent", workspaceId: "ws1", color: "#ff0000" });
  });
});

// ── get_cairn_context ─────────────────────────────────────────────────────────

describe("get_cairn_context", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => { db = makeDb(); wp = makeTmpDir(); });
  afterEach(() => removeTmpDir(wp));

  it("returns workspaces and projects", () => {
    const { workspaceId, projectId } = seedBase(db);
    const result = executeTool(db, wp, "get_cairn_context", {}) as Record<string, unknown>;
    expect(Array.isArray(result.workspaces)).toBe(true);
    expect((result.workspaces as Array<{ id: string }>).find((w) => w.id === workspaceId)).toBeDefined();
    expect(Array.isArray(result.projects)).toBe(true);
    expect((result.projects as Array<{ id: string }>).find((p) => p.id === projectId)).toBeDefined();
  });

  it("includes tags array (regression: snap.tags was undefined)", () => {
    seedBase(db);
    const result = executeTool(db, wp, "get_cairn_context", {}) as Record<string, unknown>;
    expect(Array.isArray(result.tags)).toBe(true);
  });

  it("excludes archived projects", () => {
    const { workspaceId } = seedBase(db);
    createProject(db, { id: "archivedProj", workspaceId, name: "Old Project" });
    db.prepare("UPDATE projects SET archived_at = '2024-01-01T00:00:00.000Z' WHERE id = ?").run("archivedProj");
    const result = executeTool(db, wp, "get_cairn_context", {}) as Record<string, unknown>;
    const projects = result.projects as Array<{ id: string }>;
    expect(projects.find((p) => p.id === "archivedProj")).toBeUndefined();
  });

  it("projects include their columns", () => {
    const { projectId, columnId } = seedBase(db);
    const result = executeTool(db, wp, "get_cairn_context", {}) as Record<string, unknown>;
    const proj = (result.projects as Array<{ id: string; columns: unknown[] }>).find((p) => p.id === projectId);
    expect(proj).toBeDefined();
    expect(proj!.columns.length).toBeGreaterThan(0);
    expect((proj!.columns as Array<{ id: string }>).find((c) => c.id === columnId)).toBeDefined();
  });
});

// ── resolve_project ───────────────────────────────────────────────────────────

describe("resolve_project", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => { db = makeDb(); wp = makeTmpDir(); });
  afterEach(() => removeTmpDir(wp));

  it("exact match (case-insensitive)", () => {
    const { workspaceId } = seedBase(db, { projectName: "Cairn Dev" });
    const result = executeTool(db, wp, "resolve_project", { workspaceId, name: "cairn dev" }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    expect(result.id).toBe("proj1");
    expect(result.name).toBe("Cairn Dev");
  });

  it("starts-with match when no exact match", () => {
    seedBase(db, { projectName: "Cairn Development" });
    const result = executeTool(db, wp, "resolve_project", { name: "Cairn Dev" }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    expect(result.id).toBe("proj1");
  });

  it("contains match as fallback", () => {
    seedBase(db, { projectName: "My Cairn Project" });
    const result = executeTool(db, wp, "resolve_project", { name: "Cairn" }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    expect(result.id).toBe("proj1");
  });

  it("returns error with candidates list when no match", () => {
    seedBase(db, { projectName: "Design" });
    const result = executeTool(db, wp, "resolve_project", { name: "zzznomatch" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect(Array.isArray(result.candidates)).toBe(true);
  });

  it("excludes archived projects from resolution", () => {
    const { workspaceId } = seedBase(db, { projectName: "Old Project" });
    db.prepare("UPDATE projects SET archived_at = '2024-01-01T00:00:00.000Z' WHERE id = ?").run("proj1");
    const result = executeTool(db, wp, "resolve_project", { workspaceId, name: "Old Project" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });

  it("returns columns for the matched project", () => {
    const { columnId } = seedBase(db, { projectName: "Design" });
    const result = executeTool(db, wp, "resolve_project", { name: "Design" }) as Record<string, unknown>;
    expect(Array.isArray(result.columns)).toBe(true);
    expect((result.columns as Array<{ id: string }>).find((c) => c.id === columnId)).toBeDefined();
  });

  it("filters by workspaceId when provided", () => {
    // Two workspaces, each with a "Design" project
    createWorkspace(db, { id: "ws1", name: "WS1" });
    createWorkspace(db, { id: "ws2", name: "WS2" });
    createProject(db, { id: "proj-ws1", workspaceId: "ws1", name: "Design" });
    createProject(db, { id: "proj-ws2", workspaceId: "ws2", name: "Design" });

    const result = executeTool(db, wp, "resolve_project", { workspaceId: "ws2", name: "Design" }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    expect(result.id).toBe("proj-ws2");
  });
});

// ── search_notes ──────────────────────────────────────────────────────────────

describe("search_notes", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId } = seedBase(db);

    // Second project for cross-project filter tests
    createProject(db, { id: "proj2", workspaceId, name: "Other Project" });

    createNote(db, { id: "n1", projectId, workspaceId, title: "Alpha Release Notes", content: "First release" });
    createNote(db, { id: "n2", projectId, workspaceId, title: "Beta Notes", content: "second iteration" });
    createNote(db, { id: "n3", projectId: "proj2", workspaceId, title: "Alpha in Other Project", content: "other project content" });
  });
  afterEach(() => removeTmpDir(wp));

  it("finds by title substring (case-insensitive)", () => {
    const results = executeTool(db, wp, "search_notes", { query: "alpha" }) as Array<{ id: string }>;
    const ids = results.map((r) => r.id);
    expect(ids).toContain("n1");
    expect(ids).toContain("n3");
    expect(ids).not.toContain("n2");
  });

  it("finds by content substring", () => {
    const results = executeTool(db, wp, "search_notes", { query: "second iteration" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).toContain("n2");
  });

  it("respects projectId filter", () => {
    const results = executeTool(db, wp, "search_notes", { query: "alpha", projectId: "proj1" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).toEqual(["n1"]);
  });

  it("returns empty array for no match", () => {
    const results = executeTool(db, wp, "search_notes", { query: "zzznomatch" }) as unknown[];
    expect(results).toHaveLength(0);
  });

  it("respects limit parameter", () => {
    // Add more notes
    createNote(db, { id: "n4", projectId: "proj1", workspaceId: "ws1", title: "Alpha 4", content: "" });
    createNote(db, { id: "n5", projectId: "proj1", workspaceId: "ws1", title: "Alpha 5", content: "" });
    const results = executeTool(db, wp, "search_notes", { query: "alpha", limit: 2 }) as unknown[];
    expect(results).toHaveLength(2);
  });

  it("excludes archived notes", () => {
    updateNote(db, "n1", { archivedAt: "2024-01-01T00:00:00.000Z" });
    const results = executeTool(db, wp, "search_notes", { query: "alpha" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).not.toContain("n1");
  });

  it("result includes snippet, projectId, updatedAt", () => {
    const results = executeTool(db, wp, "search_notes", { query: "beta" }) as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty("snippet");
    expect(results[0]).toHaveProperty("projectId", "proj1");
    expect(results[0]).toHaveProperty("updatedAt");
  });
});

// ── search_tasks ──────────────────────────────────────────────────────────────

describe("search_tasks", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);

    // Second project
    createProject(db, { id: "proj2", workspaceId, name: "Other Project" });
    createColumn(db, { id: "col2", projectId: "proj2", workspaceId, name: "Backlog", type: "backlog", order: 0 });

    createCard(db, { id: "c1", columnId, projectId, workspaceId, title: "Fix login bug", description: "Users cannot log in" });
    createCard(db, { id: "c2", columnId, projectId, workspaceId, title: "Update readme" });
    createCard(db, { id: "c3", columnId, projectId, workspaceId, title: "Fix signup bug" });
    createCard(db, { id: "c4", columnId: "col2", projectId: "proj2", workspaceId, title: "Fix other issue" });
  });
  afterEach(() => removeTmpDir(wp));

  it("finds tasks by title substring (case-insensitive)", () => {
    const results = executeTool(db, wp, "search_tasks", { query: "fix" }) as Array<{ id: string }>;
    const ids = results.map((r) => r.id);
    expect(ids).toContain("c1");
    expect(ids).toContain("c3");
    expect(ids).toContain("c4");
    expect(ids).not.toContain("c2");
  });

  it("finds tasks by description substring", () => {
    const results = executeTool(db, wp, "search_tasks", { query: "cannot log in" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).toContain("c1");
  });

  it("respects projectId filter", () => {
    const results = executeTool(db, wp, "search_tasks", { query: "fix", projectId: "proj1" }) as Array<{ id: string }>;
    const ids = results.map((r) => r.id);
    expect(ids).toContain("c1");
    expect(ids).toContain("c3");
    expect(ids).not.toContain("c4");
  });

  it("respects columnType filter", () => {
    // Move c1 to an in-progress column
    createColumn(db, { id: "col-inprog", projectId: "proj1", workspaceId: "ws1", name: "In Progress", type: "in_progress", order: 1 });
    updateCard(db, "c1", { columnId: "col-inprog" });
    const results = executeTool(db, wp, "search_tasks", { query: "fix", columnType: "in_progress" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).toContain("c1");
    expect(results.map((r) => r.id)).not.toContain("c3");
  });

  it("returns empty array for no match", () => {
    const results = executeTool(db, wp, "search_tasks", { query: "zzznomatch" }) as unknown[];
    expect(results).toHaveLength(0);
  });

  it("respects limit parameter", () => {
    const results = executeTool(db, wp, "search_tasks", { query: "fix", limit: 1 }) as unknown[];
    expect(results).toHaveLength(1);
  });

  it("excludes archived tasks", () => {
    updateCard(db, "c1", { archivedAt: "2024-01-01T00:00:00.000Z" });
    const results = executeTool(db, wp, "search_tasks", { query: "fix" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).not.toContain("c1");
  });

  it("result includes columnName, columnType, priority, projectId", () => {
    const results = executeTool(db, wp, "search_tasks", { query: "readme" }) as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty("columnName");
    expect(results[0]).toHaveProperty("columnType");
    expect(results[0]).toHaveProperty("priority");
    expect(results[0]).toHaveProperty("projectId", "proj1");
  });
});

// ── list_notes ────────────────────────────────────────────────────────────────

describe("list_notes", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId } = seedBase(db);
    createProject(db, { id: "proj2", workspaceId, name: "Proj2" });
    createNote(db, { id: "n1", projectId, workspaceId, title: "Note 1" });
    createNote(db, { id: "n2", projectId, workspaceId, title: "Note 2" });
    createNote(db, { id: "n3", projectId: "proj2", workspaceId, title: "Note in proj2" });
  });
  afterEach(() => removeTmpDir(wp));

  it("returns all non-archived notes when no projectId given", () => {
    const results = executeTool(db, wp, "list_notes", {}) as Array<{ id: string }>;
    const ids = results.map((r) => r.id);
    expect(ids).toContain("n1");
    expect(ids).toContain("n2");
    expect(ids).toContain("n3");
  });

  it("filters by projectId", () => {
    const results = executeTool(db, wp, "list_notes", { projectId: "proj1" }) as Array<{ id: string }>;
    const ids = results.map((r) => r.id);
    expect(ids).toContain("n1");
    expect(ids).toContain("n2");
    expect(ids).not.toContain("n3");
  });

  it("excludes archived notes", () => {
    updateNote(db, "n1", { archivedAt: "2024-01-01T00:00:00.000Z" });
    const results = executeTool(db, wp, "list_notes", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).not.toContain("n1");
  });

  it("result shape includes id, title, projectId, isPinned, updatedAt", () => {
    const results = executeTool(db, wp, "list_notes", { projectId: "proj1" }) as Array<Record<string, unknown>>;
    expect(results[0]).toHaveProperty("id");
    expect(results[0]).toHaveProperty("title");
    expect(results[0]).toHaveProperty("projectId");
    expect(results[0]).toHaveProperty("isPinned");
    expect(results[0]).toHaveProperty("updatedAt");
  });
});

// ── list_tasks ────────────────────────────────────────────────────────────────

describe("list_tasks", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    createCard(db, { id: "c1", columnId, projectId, workspaceId, title: "Task A" });
    createCard(db, { id: "c2", columnId, projectId, workspaceId, title: "Task B" });
  });
  afterEach(() => removeTmpDir(wp));

  it("returns tasks grouped by column", () => {
    const cols = executeTool(db, wp, "list_tasks", { projectId: "proj1" }) as Array<Record<string, unknown>>;
    expect(Array.isArray(cols)).toBe(true);
    const backlog = cols.find((c) => c.columnId === "col1");
    expect(backlog).toBeDefined();
    const tasks = backlog!.tasks as Array<{ id: string }>;
    expect(tasks.map((t) => t.id)).toContain("c1");
    expect(tasks.map((t) => t.id)).toContain("c2");
  });

  it("excludes archived cards", () => {
    updateCard(db, "c1", { archivedAt: "2024-01-01T00:00:00.000Z" });
    const cols = executeTool(db, wp, "list_tasks", { projectId: "proj1" }) as Array<Record<string, unknown>>;
    const backlog = cols.find((c) => c.columnId === "col1")!;
    const tasks = backlog.tasks as Array<{ id: string }>;
    expect(tasks.map((t) => t.id)).not.toContain("c1");
  });
});

// ── list_ready_tasks ──────────────────────────────────────────────────────────

describe("list_ready_tasks", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    // Add done column
    createColumn(db, { id: "col-done", projectId, workspaceId, name: "Done", type: "done", order: 1 });
    createCard(db, { id: "c1", columnId, projectId, workspaceId, title: "Ready task" });
    createCard(db, { id: "c2", columnId: "col-done", projectId, workspaceId, title: "Done task" });
    createCard(db, { id: "c3", columnId, projectId, workspaceId, title: "Blocked task" });
    createCard(db, { id: "blocker", columnId, projectId, workspaceId, title: "Blocker" });
  });
  afterEach(() => removeTmpDir(wp));

  it("excludes tasks in done columns", () => {
    const results = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).not.toContain("c2");
  });

  it("includes tasks with no blockers", () => {
    const results = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).toContain("c1");
  });

  it("excludes tasks blocked by unresolved blockers", () => {
    // Block c3 by "blocker" (which is in backlog — not resolved)
    executeTool(db, wp, "block_task", { cardId: "c3", blockerCardId: "blocker" });
    const results = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).not.toContain("c3");
  });

  it("includes task once its blocker moves to done", () => {
    executeTool(db, wp, "block_task", { cardId: "c3", blockerCardId: "blocker" });
    // Move blocker to done
    executeTool(db, wp, "update_task_status", { cardId: "blocker", targetColumnId: "col-done" });
    const results = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).toContain("c3");
  });

  it("returns all projects' ready tasks when no projectId given", () => {
    const results = executeTool(db, wp, "list_ready_tasks", {}) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).toContain("c1");
  });
});

// ── block_task / unblock_task ─────────────────────────────────────────────────

describe("block_task / unblock_task", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    createCard(db, { id: "c1", columnId, projectId, workspaceId, title: "Task 1" });
    createCard(db, { id: "c2", columnId, projectId, workspaceId, title: "Task 2" });
    createCard(db, { id: "c3", columnId, projectId, workspaceId, title: "Task 3" });
  });
  afterEach(() => removeTmpDir(wp));

  it("blocks a task and marks it as blocked", () => {
    const result = executeTool(db, wp, "block_task", { cardId: "c1", blockerCardId: "c2" }) as Record<string, unknown>;
    expect(result.blocked).toBe(true);
  });

  it("rejects blocking itself", () => {
    const result = executeTool(db, wp, "block_task", { cardId: "c1", blockerCardId: "c1" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect(result.error).toMatch(/cannot block itself/i);
  });

  it("rejects circular dependencies", () => {
    executeTool(db, wp, "block_task", { cardId: "c2", blockerCardId: "c1" });
    const result = executeTool(db, wp, "block_task", { cardId: "c1", blockerCardId: "c2" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect(result.error).toMatch(/circular/i);
  });

  it("rejects cross-project blocking", () => {
    createWorkspace(db, { id: "ws2", name: "WS2" });
    createProject(db, { id: "proj2", workspaceId: "ws2", name: "Project 2" });
    createColumn(db, { id: "col2", projectId: "proj2", workspaceId: "ws2", name: "Backlog", type: "backlog", order: 0 });
    createCard(db, { id: "c-other", columnId: "col2", projectId: "proj2", workspaceId: "ws2", title: "Other task" });

    const result = executeTool(db, wp, "block_task", { cardId: "c1", blockerCardId: "c-other" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect(result.error).toMatch(/same project/i);
  });

  it("unblocks a task", () => {
    executeTool(db, wp, "block_task", { cardId: "c1", blockerCardId: "c2" });
    const result = executeTool(db, wp, "unblock_task", { cardId: "c1", blockerCardId: "c2" }) as Record<string, unknown>;
    expect(result.unblocked).toBe(true);
    // After unblocking, c1 should appear in ready tasks
    const ready = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(ready.map((r) => r.id)).toContain("c1");
  });

  it("rejects missing task", () => {
    const result = executeTool(db, wp, "block_task", { cardId: "nope", blockerCardId: "c1" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });

  it("rejects missing blocker", () => {
    const result = executeTool(db, wp, "block_task", { cardId: "c1", blockerCardId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── get_project_summary ───────────────────────────────────────────────────────

describe("get_project_summary", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    createNote(db, { id: "n1", projectId, workspaceId, title: "Design Doc", isPinned: true });
    createNote(db, { id: "n2", projectId, workspaceId, title: "Brainstorm" });
    createCard(db, { id: "c1", columnId, projectId, workspaceId, title: "Task 1" });
  });
  afterEach(() => removeTmpDir(wp));

  it("returns correct shape", () => {
    const result = executeTool(db, wp, "get_project_summary", { projectId: "proj1" }) as Record<string, unknown>;
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("noteCount", 2);
    expect(result).toHaveProperty("totalCards", 1);
    expect(result).toHaveProperty("cardsByColumn");
    expect(result).toHaveProperty("pinnedNotes");
    expect(result).toHaveProperty("recentActivity");
  });

  it("pinnedNotes only includes pinned notes", () => {
    const result = executeTool(db, wp, "get_project_summary", { projectId: "proj1" }) as Record<string, unknown>;
    const pinned = result.pinnedNotes as Array<{ id: string }>;
    expect(pinned.map((p) => p.id)).toContain("n1");
    expect(pinned.map((p) => p.id)).not.toContain("n2");
  });

  it("returns error for unknown project", () => {
    const result = executeTool(db, wp, "get_project_summary", { projectId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── get_project_context_pack ──────────────────────────────────────────────────

describe("get_project_context_pack", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    createColumn(db, { id: "col-done", projectId, workspaceId, name: "Done", type: "done", order: 1 });
    createNote(db, { id: "n1", projectId, workspaceId, title: "Pinned Doc", isPinned: true, content: "# Design\n\nContent here" });
    createCard(db, { id: "c1", columnId, projectId, workspaceId, title: "Open task" });
    createCard(db, { id: "c2", columnId: "col-done", projectId, workspaceId, title: "Done task" });
  });
  afterEach(() => removeTmpDir(wp));

  it("returns project, noteCount, pinnedNotes, openTasks, recentActivity", () => {
    const result = executeTool(db, wp, "get_project_context_pack", { projectId: "proj1" }) as Record<string, unknown>;
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("noteCount", 1);
    expect(result).toHaveProperty("pinnedNotes");
    expect(result).toHaveProperty("openTasks");
    expect(result).toHaveProperty("recentActivity");
  });

  it("openTasks does not include done-column tasks", () => {
    const result = executeTool(db, wp, "get_project_context_pack", { projectId: "proj1" }) as Record<string, unknown>;
    const openTasks = result.openTasks as Array<Record<string, unknown>>;
    const allTaskIds = openTasks.flatMap((col) => (col.tasks as Array<{ id: string }>).map((t) => t.id));
    expect(allTaskIds).toContain("c1");
    expect(allTaskIds).not.toContain("c2");
  });

  it("pinnedNotes includes full content", () => {
    const result = executeTool(db, wp, "get_project_context_pack", { projectId: "proj1" }) as Record<string, unknown>;
    const pinned = result.pinnedNotes as Array<{ id: string; content: string }>;
    expect(pinned[0].content).toContain("Design");
  });

  it("returns error for unknown project", () => {
    const result = executeTool(db, wp, "get_project_context_pack", { projectId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── create_task ───────────────────────────────────────────────────────────────

describe("create_task", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => { db = makeDb(); wp = makeTmpDir(); seedBase(db); });
  afterEach(() => removeTmpDir(wp));

  it("creates a task and returns id, title, columnId, createdAt", () => {
    const result = executeTool(db, wp, "create_task", { columnId: "col1", projectId: "proj1", title: "New task" }) as Record<string, unknown>;
    expect(result).toHaveProperty("id");
    expect(result.title).toBe("New task");
    expect(result.columnId).toBe("col1");
    expect(result).toHaveProperty("createdAt");
  });

  it("persists the task — appears in list_tasks", () => {
    executeTool(db, wp, "create_task", { columnId: "col1", projectId: "proj1", title: "Persisted task" });
    const cols = executeTool(db, wp, "list_tasks", { projectId: "proj1" }) as Array<{ tasks: Array<{ title: string }> }>;
    const allTitles = cols.flatMap((c) => c.tasks.map((t) => t.title));
    expect(allTitles).toContain("Persisted task");
  });

  it("returns error for unknown column", () => {
    const result = executeTool(db, wp, "create_task", { columnId: "nope", projectId: "proj1", title: "T" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── delete_task ───────────────────────────────────────────────────────────────

describe("delete_task", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    createCard(db, { id: "c1", columnId, projectId, workspaceId, title: "To delete" });
  });
  afterEach(() => removeTmpDir(wp));

  it("deletes the task", () => {
    const result = executeTool(db, wp, "delete_task", { cardId: "c1" }) as Record<string, unknown>;
    expect(result.deleted).toBe(true);
    const tasks = executeTool(db, wp, "list_tasks", { projectId: "proj1" }) as Array<{ tasks: Array<{ id: string }> }>;
    const allIds = tasks.flatMap((c) => c.tasks.map((t) => t.id));
    expect(allIds).not.toContain("c1");
  });

  it("cleans up blocker references in other tasks", () => {
    const { workspaceId, projectId, columnId } = { workspaceId: "ws1", projectId: "proj1", columnId: "col1" };
    createCard(db, { id: "c2", columnId, projectId, workspaceId, title: "Blocked" });
    executeTool(db, wp, "block_task", { cardId: "c2", blockerCardId: "c1" });
    executeTool(db, wp, "delete_task", { cardId: "c1" });
    // After deleting c1, c2 should now be ready (no blockers)
    const ready = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(ready.map((r) => r.id)).toContain("c2");
  });

  it("returns error for unknown task", () => {
    const result = executeTool(db, wp, "delete_task", { cardId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── create_note / delete_note ─────────────────────────────────────────────────

describe("create_note and delete_note", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => { db = makeDb(); wp = makeTmpDir(); seedBase(db); });
  afterEach(() => removeTmpDir(wp));

  it("create_note returns id and title", () => {
    const result = executeTool(db, wp, "create_note", { projectId: "proj1", title: "My Note", content: "# Hello" }) as Record<string, unknown>;
    expect(result).toHaveProperty("id");
    expect(result.title).toBe("My Note");
    expect(result).toHaveProperty("createdAt");
  });

  it("created note appears in list_notes", () => {
    executeTool(db, wp, "create_note", { projectId: "proj1", title: "Visible Note", content: "" });
    const notes = executeTool(db, wp, "list_notes", { projectId: "proj1" }) as Array<{ title: string }>;
    expect(notes.map((n) => n.title)).toContain("Visible Note");
  });

  it("delete_note removes note from list", () => {
    const { id } = executeTool(db, wp, "create_note", { projectId: "proj1", title: "To Delete", content: "" }) as { id: string };
    executeTool(db, wp, "delete_note", { noteId: id });
    const notes = executeTool(db, wp, "list_notes", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(notes.map((n) => n.id)).not.toContain(id);
  });

  it("create_note returns error for unknown project", () => {
    const result = executeTool(db, wp, "create_note", { projectId: "nope", title: "X" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── ensure_note ───────────────────────────────────────────────────────────────

describe("ensure_note", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => { db = makeDb(); wp = makeTmpDir(); seedBase(db); });
  afterEach(() => removeTmpDir(wp));

  it("creates when note does not exist — action: created", () => {
    const result = executeTool(db, wp, "ensure_note", { projectId: "proj1", title: "README", content: "Hello" }) as Record<string, unknown>;
    expect(result.action).toBe("created");
    expect(result).toHaveProperty("id");
  });

  it("updates when note already exists — action: updated", () => {
    executeTool(db, wp, "ensure_note", { projectId: "proj1", title: "README", content: "v1" });
    const result = executeTool(db, wp, "ensure_note", { projectId: "proj1", title: "README", content: "v2" }) as Record<string, unknown>;
    expect(result.action).toBe("updated");
  });

  it("idempotent: only one note with that title exists", () => {
    executeTool(db, wp, "ensure_note", { projectId: "proj1", title: "README", content: "v1" });
    executeTool(db, wp, "ensure_note", { projectId: "proj1", title: "README", content: "v2" });
    const notes = executeTool(db, wp, "list_notes", { projectId: "proj1" }) as Array<{ title: string }>;
    const readmes = notes.filter((n) => n.title === "README");
    expect(readmes).toHaveLength(1);
  });
});

// ── patch_note ────────────────────────────────────────────────────────────────

describe("patch_note", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    seedBase(db);
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Patch Test", content: "Hello world" });
  });
  afterEach(() => removeTmpDir(wp));

  it("replaces old string with new string", () => {
    executeTool(db, wp, "patch_note", { noteId: "n1", oldString: "Hello world", newString: "Goodbye world" });
    const note = executeTool(db, wp, "get_note", { noteId: "n1" }) as Record<string, unknown>;
    expect(note.content).toContain("Goodbye world");
    expect(note.content).not.toContain("Hello world");
  });

  it("returns error if oldString not found", () => {
    const result = executeTool(db, wp, "patch_note", { noteId: "n1", oldString: "not in note", newString: "x" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });

  it("returns error for unknown note", () => {
    const result = executeTool(db, wp, "patch_note", { noteId: "nope", oldString: "x", newString: "y" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── update_task_status / bulk_update_task_status ──────────────────────────────

describe("update_task_status", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    createColumn(db, { id: "col-done", projectId, workspaceId, name: "Done", type: "done", order: 1 });
    createCard(db, { id: "c1", columnId, projectId, workspaceId, title: "Task" });
  });
  afterEach(() => removeTmpDir(wp));

  it("moves task to new column", () => {
    const result = executeTool(db, wp, "update_task_status", { cardId: "c1", targetColumnId: "col-done" }) as Record<string, unknown>;
    expect(result).toHaveProperty("newColumn", "col-done");
    expect(result).not.toHaveProperty("error");
  });

  it("returns error for unknown task", () => {
    const result = executeTool(db, wp, "update_task_status", { cardId: "nope", targetColumnId: "col-done" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });

  it("returns error for unknown column", () => {
    const result = executeTool(db, wp, "update_task_status", { cardId: "c1", targetColumnId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

describe("bulk_update_task_status", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    createColumn(db, { id: "col-done", projectId, workspaceId, name: "Done", type: "done", order: 1 });
    createCard(db, { id: "c1", columnId, projectId, workspaceId, title: "T1" });
    createCard(db, { id: "c2", columnId, projectId, workspaceId, title: "T2" });
  });
  afterEach(() => removeTmpDir(wp));

  it("moves multiple tasks and reports counts", () => {
    const result = executeTool(db, wp, "bulk_update_task_status", { cardIds: ["c1", "c2"], targetColumnId: "col-done" }) as Record<string, unknown>;
    expect(result.moved).toBe(2);
    expect((result.failed as unknown[]).length).toBe(0);
  });

  it("reports failed tasks for unknown IDs", () => {
    const result = executeTool(db, wp, "bulk_update_task_status", { cardIds: ["c1", "nope"], targetColumnId: "col-done" }) as Record<string, unknown>;
    expect(result.moved).toBe(1);
    expect((result.failed as unknown[]).length).toBe(1);
  });

  it("returns error for unknown column", () => {
    const result = executeTool(db, wp, "bulk_update_task_status", { cardIds: ["c1"], targetColumnId: "nope" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ── link_note_to_task ─────────────────────────────────────────────────────────

describe("link_note_to_task", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    createNote(db, { id: "n1", projectId, workspaceId, title: "Note" });
    createCard(db, { id: "c1", columnId, projectId, workspaceId, title: "Task" });
  });
  afterEach(() => removeTmpDir(wp));

  it("links note and task bidirectionally", () => {
    const result = executeTool(db, wp, "link_note_to_task", { noteId: "n1", cardId: "c1" }) as Record<string, unknown>;
    expect(result.linked).toBe(true);
    // Verify the link is reflected in get_note
    const note = executeTool(db, wp, "get_note", { noteId: "n1" }) as Record<string, unknown>;
    expect((note.linkedCardIds as string[])).toContain("c1");
    // Verify the link is reflected in get_task
    const task = executeTool(db, wp, "get_task", { cardId: "c1" }) as Record<string, unknown>;
    expect((task.linkedNoteIds as string[])).toContain("n1");
  });

  it("linking the same pair twice is idempotent", () => {
    executeTool(db, wp, "link_note_to_task", { noteId: "n1", cardId: "c1" });
    executeTool(db, wp, "link_note_to_task", { noteId: "n1", cardId: "c1" });
    const note = executeTool(db, wp, "get_note", { noteId: "n1" }) as Record<string, unknown>;
    const linkedCards = note.linkedCardIds as string[];
    expect(linkedCards.filter((id) => id === "c1")).toHaveLength(1);
  });
});

// ── create_project ────────────────────────────────────────────────────────────

describe("create_project", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => { db = makeDb(); wp = makeTmpDir(); });
  afterEach(() => removeTmpDir(wp));

  it("creates project with default columns", () => {
    createWorkspace(db, { id: "ws1", name: "WS" });
    const result = executeTool(db, wp, "create_project", { workspaceId: "ws1", name: "New Project" }) as Record<string, unknown>;
    expect(result).toHaveProperty("projectId");
    expect(result.name).toBe("New Project");
    const columns = result.columns as unknown[];
    expect(columns.length).toBeGreaterThan(0);
  });

  it("returns error for unknown workspace", () => {
    const result = executeTool(db, wp, "create_project", { workspaceId: "nope", name: "X" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART 2 — Multi-match and realistic query scenarios
// ═════════════════════════════════════════════════════════════════════════════

// ── search_notes: multiple matches, ordering, disambiguation ─────────────────

describe("search_notes — multi-match ordering and disambiguation", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId } = seedBase(db, { projectName: "App" });
    createProject(db, { id: "proj2", workspaceId, name: "Docs" });
    createProject(db, { id: "proj3", workspaceId, name: "Marketing" });
  });
  afterEach(() => removeTmpDir(wp));

  it("returns all matching notes across projects when no projectId filter", () => {
    // Three notes all containing "authentication" — spread across projects
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Authentication flow", content: "" });
    createNote(db, { id: "n2", projectId: "proj2", workspaceId: "ws1", title: "OAuth authentication guide", content: "" });
    createNote(db, { id: "n3", projectId: "proj3", workspaceId: "ws1", title: "Marketing brief", content: "covers authentication requirements" });

    const results = executeTool(db, wp, "search_notes", { query: "authentication" }) as Array<{ id: string }>;
    const ids = results.map((r) => r.id);
    expect(ids).toContain("n1");
    expect(ids).toContain("n2");
    expect(ids).toContain("n3");
  });

  it("results are ordered most-recently-updated first", async () => {
    createNote(db, { id: "n-old", projectId: "proj1", workspaceId: "ws1", title: "Design spec v1", content: "" });
    await new Promise((r) => setTimeout(r, 10));
    createNote(db, { id: "n-new", projectId: "proj1", workspaceId: "ws1", title: "Design spec v2", content: "" });

    const results = executeTool(db, wp, "search_notes", { query: "design spec" }) as Array<{ id: string }>;
    expect(results[0].id).toBe("n-new");
    expect(results[1].id).toBe("n-old");
  });

  it("updating a note promotes it to the top of results", async () => {
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Feature spec A", content: "" });
    await new Promise((r) => setTimeout(r, 10));
    createNote(db, { id: "n2", projectId: "proj1", workspaceId: "ws1", title: "Feature spec B", content: "" });
    await new Promise((r) => setTimeout(r, 10));
    // Update n1 — should now appear first
    updateNote(db, "n1", { content: "Updated content" });

    const results = executeTool(db, wp, "search_notes", { query: "feature spec" }) as Array<{ id: string }>;
    expect(results[0].id).toBe("n1");
  });

  it("projectId filter narrows multi-project matches to one project only", () => {
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Deployment notes", content: "" });
    createNote(db, { id: "n2", projectId: "proj2", workspaceId: "ws1", title: "Deployment notes", content: "" });
    createNote(db, { id: "n3", projectId: "proj3", workspaceId: "ws1", title: "Deployment notes", content: "" });

    const results = executeTool(db, wp, "search_notes", { query: "deployment notes", projectId: "proj2" }) as Array<{ id: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("n2");
  });

  it("title match and content match both returned when both exist", () => {
    // n1 matches via title, n2 matches via content only
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "GDPR compliance", content: "some other content" });
    createNote(db, { id: "n2", projectId: "proj1", workspaceId: "ws1", title: "Legal notes", content: "covers GDPR compliance requirements" });

    const results = executeTool(db, wp, "search_notes", { query: "gdpr compliance" }) as Array<{ id: string }>;
    const ids = results.map((r) => r.id);
    expect(ids).toContain("n1");
    expect(ids).toContain("n2");
  });

  it("snippet is truncated to 200 chars for long content", () => {
    const longContent = "This note is about performance. ".repeat(20); // 640 chars
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Performance note", content: longContent });

    const results = executeTool(db, wp, "search_notes", { query: "performance" }) as Array<{ snippet: string }>;
    expect(results[0].snippet.length).toBeLessThanOrEqual(200);
  });

  it("default limit of 10 caps results when more than 10 notes match", () => {
    for (let i = 0; i < 15; i++) {
      createNote(db, { id: `n${i}`, projectId: "proj1", workspaceId: "ws1", title: `Bug report ${i}`, content: "" });
    }
    const results = executeTool(db, wp, "search_notes", { query: "bug report" }) as unknown[];
    expect(results).toHaveLength(10);
  });

  it("explicit limit higher than default is respected", () => {
    for (let i = 0; i < 15; i++) {
      createNote(db, { id: `n${i}`, projectId: "proj1", workspaceId: "ws1", title: `Sprint note ${i}`, content: "" });
    }
    const results = executeTool(db, wp, "search_notes", { query: "sprint note", limit: 15 }) as unknown[];
    expect(results).toHaveLength(15);
  });

  it("same-title notes in different projects are both returned without filter", () => {
    createNote(db, { id: "na", projectId: "proj1", workspaceId: "ws1", title: "README", content: "app readme" });
    createNote(db, { id: "nb", projectId: "proj2", workspaceId: "ws1", title: "README", content: "docs readme" });

    const results = executeTool(db, wp, "search_notes", { query: "readme" }) as Array<{ id: string }>;
    const ids = results.map((r) => r.id);
    expect(ids).toContain("na");
    expect(ids).toContain("nb");
  });

  it("archived note with same title as active note is not returned", () => {
    createNote(db, { id: "n-live", projectId: "proj1", workspaceId: "ws1", title: "Architecture overview", content: "" });
    createNote(db, { id: "n-arch", projectId: "proj1", workspaceId: "ws1", title: "Architecture overview", content: "" });
    updateNote(db, "n-arch", { archivedAt: "2024-01-01T00:00:00.000Z" });

    const results = executeTool(db, wp, "search_notes", { query: "architecture overview" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).toContain("n-live");
    expect(results.map((r) => r.id)).not.toContain("n-arch");
  });
});

// ── search_tasks: multiple matches across projects and columns ────────────────

describe("search_tasks — multi-match across projects and columns", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId } = seedBase(db, { projectName: "Backend" });
    createProject(db, { id: "proj2", workspaceId, name: "Frontend" });
    createColumn(db, { id: "col2", projectId: "proj2", workspaceId, name: "Backlog", type: "backlog", order: 0 });
    createColumn(db, { id: "col-ip", projectId: "proj1", workspaceId, name: "In Progress", type: "in_progress", order: 1 });
    createColumn(db, { id: "col-done", projectId: "proj1", workspaceId, name: "Done", type: "done", order: 2 });
  });
  afterEach(() => removeTmpDir(wp));

  it("same task title in two projects — both returned without projectId filter", () => {
    createCard(db, { id: "c-be", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Implement auth" });
    createCard(db, { id: "c-fe", columnId: "col2", projectId: "proj2", workspaceId: "ws1", title: "Implement auth" });

    const results = executeTool(db, wp, "search_tasks", { query: "implement auth" }) as Array<{ id: string }>;
    const ids = results.map((r) => r.id);
    expect(ids).toContain("c-be");
    expect(ids).toContain("c-fe");
  });

  it("same task title in two projects — projectId filter isolates one", () => {
    createCard(db, { id: "c-be", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Write tests" });
    createCard(db, { id: "c-fe", columnId: "col2", projectId: "proj2", workspaceId: "ws1", title: "Write tests" });

    const results = executeTool(db, wp, "search_tasks", { query: "write tests", projectId: "proj2" }) as Array<{ id: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("c-fe");
  });

  it("columnType filter returns only tasks in that column type across all projects", () => {
    createCard(db, { id: "c1", columnId: "col1",    projectId: "proj1", workspaceId: "ws1", title: "Fix bug" });
    createCard(db, { id: "c2", columnId: "col-ip",  projectId: "proj1", workspaceId: "ws1", title: "Fix bug" });
    createCard(db, { id: "c3", columnId: "col-done", projectId: "proj1", workspaceId: "ws1", title: "Fix bug" });

    const results = executeTool(db, wp, "search_tasks", { query: "fix bug", columnType: "in_progress" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).toEqual(["c2"]);
  });

  it("combined projectId + columnType filter is additive", () => {
    // proj1 backlog + proj2 backlog — filter to proj1+backlog only
    createCard(db, { id: "c1", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Refactor service" });
    createCard(db, { id: "c2", columnId: "col2", projectId: "proj2", workspaceId: "ws1", title: "Refactor service" });

    const results = executeTool(db, wp, "search_tasks", { query: "refactor service", projectId: "proj1", columnType: "backlog" }) as Array<{ id: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("c1");
  });

  it("description-only match is returned when title does not match", () => {
    createCard(db, { id: "c1", columnId: "col1", projectId: "proj1", workspaceId: "ws1",
      title: "Performance work", description: "investigate N+1 query in dashboard loader" });
    createCard(db, { id: "c2", columnId: "col1", projectId: "proj1", workspaceId: "ws1",
      title: "Something else", description: "unrelated" });

    const results = executeTool(db, wp, "search_tasks", { query: "n+1 query" }) as Array<{ id: string }>;
    expect(results.map((r) => r.id)).toContain("c1");
    expect(results.map((r) => r.id)).not.toContain("c2");
  });

  it("default limit of 10 caps results when many tasks match", () => {
    for (let i = 0; i < 14; i++) {
      createCard(db, { id: `c${i}`, columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: `Todo item ${i}` });
    }
    const results = executeTool(db, wp, "search_tasks", { query: "todo item" }) as unknown[];
    expect(results).toHaveLength(10);
  });

  it("each result includes columnName and columnType", () => {
    createCard(db, { id: "c1", columnId: "col-ip", projectId: "proj1", workspaceId: "ws1", title: "Active work" });

    const results = executeTool(db, wp, "search_tasks", { query: "active work" }) as Array<Record<string, unknown>>;
    expect(results[0].columnName).toBe("In Progress");
    expect(results[0].columnType).toBe("in_progress");
  });

  it("task whose column was deleted shows Unknown column gracefully", () => {
    // FK constraints prevent a card referencing a non-existent column_id.
    // We simulate the same code path (col === undefined) by temporarily
    // disabling FK enforcement to create the dangling reference.
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, description,
      tag_ids, priority, linked_note_ids, "order", created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '[]', 'medium', '[]', 0, datetime('now'), datetime('now'))`)
      .run("c-orphan", "col-gone", "proj1", "ws1", "Orphaned task", null);
    db.pragma("foreign_keys = ON");

    const results = executeTool(db, wp, "search_tasks", { query: "orphaned task" }) as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0].columnName).toBe("Unknown");
    expect(results[0].columnType).toBe("custom");
  });
});

// ── resolve_project: priority when multiple projects partially match ───────────

describe("resolve_project — ambiguous multi-match priority", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    createWorkspace(db, { id: "ws1", name: "Workspace" });
  });
  afterEach(() => removeTmpDir(wp));

  it("exact match wins over starts-with when both exist", () => {
    createProject(db, { id: "p-exact",      workspaceId: "ws1", name: "Design" });
    createProject(db, { id: "p-startswith", workspaceId: "ws1", name: "Design System" });

    const result = executeTool(db, wp, "resolve_project", { name: "Design" }) as Record<string, unknown>;
    expect(result.id).toBe("p-exact");
  });

  it("starts-with match wins over contains when both exist", () => {
    createProject(db, { id: "p-startswith", workspaceId: "ws1", name: "Backend API" });
    createProject(db, { id: "p-contains",   workspaceId: "ws1", name: "Old Backend API Docs" });

    const result = executeTool(db, wp, "resolve_project", { name: "Backend" }) as Record<string, unknown>;
    expect(result.id).toBe("p-startswith");
  });

  it("when two projects both starts-with the query, first inserted is returned", () => {
    createProject(db, { id: "p1", workspaceId: "ws1", name: "Mobile iOS" });
    createProject(db, { id: "p2", workspaceId: "ws1", name: "Mobile Android" });

    const result = executeTool(db, wp, "resolve_project", { name: "Mobile" }) as Record<string, unknown>;
    // resolve_project uses Array.find — returns first match in insertion order
    expect(result.id).toBe("p1");
  });

  it("when two projects both contain the query, first inserted is returned", () => {
    createProject(db, { id: "p1", workspaceId: "ws1", name: "v1 Auth Service" });
    createProject(db, { id: "p2", workspaceId: "ws1", name: "v2 Auth Service" });

    const result = executeTool(db, wp, "resolve_project", { name: "Auth Service" }) as Record<string, unknown>;
    expect(result.id).toBe("p1");
  });

  it("archived project that would be exact match is ignored — falls through to next", () => {
    createProject(db, { id: "p-archived", workspaceId: "ws1", name: "Payments" });
    createProject(db, { id: "p-active",   workspaceId: "ws1", name: "Payments v2" });
    db.prepare("UPDATE projects SET archived_at = '2024-01-01T00:00:00.000Z' WHERE id = ?").run("p-archived");

    // "Payments" exact-matches p-archived but it is archived, so falls through to
    // starts-with match on "Payments v2"
    const result = executeTool(db, wp, "resolve_project", { name: "Payments" }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    expect(result.id).toBe("p-active");
  });

  it("no match returns all active projects as candidates", () => {
    createProject(db, { id: "p1", workspaceId: "ws1", name: "Alpha" });
    createProject(db, { id: "p2", workspaceId: "ws1", name: "Beta" });

    const result = executeTool(db, wp, "resolve_project", { name: "Gamma" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    const candidates = result.candidates as Array<{ id: string }>;
    expect(candidates.map((c) => c.id)).toContain("p1");
    expect(candidates.map((c) => c.id)).toContain("p2");
  });

  it("candidates list does not include archived projects", () => {
    createProject(db, { id: "p-live",     workspaceId: "ws1", name: "Live Project" });
    createProject(db, { id: "p-archived", workspaceId: "ws1", name: "Old Project" });
    db.prepare("UPDATE projects SET archived_at = '2024-01-01T00:00:00.000Z' WHERE id = ?").run("p-archived");

    const result = executeTool(db, wp, "resolve_project", { name: "zzznomatch" }) as Record<string, unknown>;
    const candidates = result.candidates as Array<{ id: string }>;
    expect(candidates.map((c) => c.id)).not.toContain("p-archived");
  });
});

// ── ensure_note: scoping by projectId with same title ────────────────────────

describe("ensure_note — same title across different projects", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId } = seedBase(db, { projectName: "Project A" });
    createProject(db, { id: "proj2", workspaceId, name: "Project B" });
  });
  afterEach(() => removeTmpDir(wp));

  it("same title in two different projects creates two separate notes", () => {
    const r1 = executeTool(db, wp, "ensure_note", { projectId: "proj1", title: "README", content: "Project A readme" }) as Record<string, unknown>;
    const r2 = executeTool(db, wp, "ensure_note", { projectId: "proj2", title: "README", content: "Project B readme" }) as Record<string, unknown>;

    expect(r1.action).toBe("created");
    expect(r2.action).toBe("created");
    expect(r1.id).not.toBe(r2.id);
  });

  it("updating note in proj1 does not affect note with same title in proj2", () => {
    executeTool(db, wp, "ensure_note", { projectId: "proj1", title: "Spec", content: "v1 content" });
    executeTool(db, wp, "ensure_note", { projectId: "proj2", title: "Spec", content: "other content" });

    // Update proj1's "Spec"
    executeTool(db, wp, "ensure_note", { projectId: "proj1", title: "Spec", content: "v2 content" });

    // proj2's note should still have its original content
    const proj2Notes = executeTool(db, wp, "search_notes", { query: "other content", projectId: "proj2" }) as Array<{ id: string }>;
    expect(proj2Notes).toHaveLength(1);
  });

  it("archived note with same title is not matched — new note is created instead", () => {
    const r1 = executeTool(db, wp, "ensure_note", { projectId: "proj1", title: "Design doc", content: "old" }) as Record<string, unknown>;
    // Archive that note directly
    db.prepare("UPDATE notes SET archived_at = '2024-01-01T00:00:00.000Z' WHERE id = ?").run(r1.id as string);

    const r2 = executeTool(db, wp, "ensure_note", { projectId: "proj1", title: "Design doc", content: "new" }) as Record<string, unknown>;
    expect(r2.action).toBe("created");
    expect(r2.id).not.toBe(r1.id);
  });

  it("ensure_note title match is case-sensitive (exact)", () => {
    executeTool(db, wp, "ensure_note", { projectId: "proj1", title: "roadmap", content: "lower" });
    const r = executeTool(db, wp, "ensure_note", { projectId: "proj1", title: "Roadmap", content: "upper" }) as Record<string, unknown>;
    // Different case → treated as a different title → new note created
    expect(r.action).toBe("created");

    const notes = executeTool(db, wp, "list_notes", { projectId: "proj1" }) as Array<{ title: string }>;
    const titles = notes.map((n) => n.title);
    expect(titles).toContain("roadmap");
    expect(titles).toContain("Roadmap");
  });
});

// ── patch_note: multiple occurrences of the same string ──────────────────────

describe("patch_note — multiple occurrences", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    seedBase(db);
  });
  afterEach(() => removeTmpDir(wp));

  it("returns error when oldString appears more than once and replaceAll is not set", () => {
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Note",
      content: "TODO: fix this\nSome work\nTODO: fix this\nMore work" });

    const result = executeTool(db, wp, "patch_note", { noteId: "n1", oldString: "TODO: fix this", newString: "DONE: fixed" }) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect(String(result.error)).toMatch(/2/); // reports the count
  });

  it("replaceAll: true replaces every occurrence", () => {
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Note",
      content: "TODO: fix this\nSome work\nTODO: fix this\nMore work" });

    executeTool(db, wp, "patch_note", { noteId: "n1", oldString: "TODO: fix this", newString: "DONE: fixed", replaceAll: true });
    const note = executeTool(db, wp, "get_note", { noteId: "n1" }) as Record<string, unknown>;
    expect(note.content).not.toContain("TODO: fix this");
    expect((note.content as string).match(/DONE: fixed/g)?.length).toBe(2);
  });

  it("replaceAll: true with a single occurrence still succeeds", () => {
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Note",
      content: "Only one instance of PLACEHOLDER here" });

    const result = executeTool(db, wp, "patch_note", { noteId: "n1", oldString: "PLACEHOLDER", newString: "VALUE", replaceAll: true }) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    const note = executeTool(db, wp, "get_note", { noteId: "n1" }) as Record<string, unknown>;
    expect(note.content).toContain("VALUE");
  });

  it("sequential patches build on each other correctly", () => {
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Note",
      content: "Status: draft" });

    executeTool(db, wp, "patch_note", { noteId: "n1", oldString: "Status: draft", newString: "Status: review" });
    executeTool(db, wp, "patch_note", { noteId: "n1", oldString: "Status: review", newString: "Status: approved" });

    const note = executeTool(db, wp, "get_note", { noteId: "n1" }) as Record<string, unknown>;
    expect(note.content).toBe("Status: approved");
  });
});

// ── list_recent_activity: ordering and workspace scoping ─────────────────────

describe("list_recent_activity — ordering and workspace scoping", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
  });
  afterEach(() => removeTmpDir(wp));

  it("items are returned newest first across both notes and tasks", async () => {
    const { workspaceId, projectId, columnId } = seedBase(db);
    createNote(db, { id: "n-old", projectId, workspaceId, title: "Old note" });
    await new Promise((r) => setTimeout(r, 10));
    createCard(db, { id: "c-new", columnId, projectId, workspaceId, title: "New task" });

    const result = executeTool(db, wp, "list_recent_activity", { workspaceId }) as Array<{ id: string }>;
    const ids = result.map((r) => r.id);
    expect(ids.indexOf("c-new")).toBeLessThan(ids.indexOf("n-old"));
  });

  it("workspaceId filter excludes items from other workspaces", () => {
    // Workspace 1
    seedBase(db, { workspaceId: "ws1", projectId: "p1", columnId: "col1" });
    createNote(db, { id: "n-ws1", projectId: "p1", workspaceId: "ws1", title: "WS1 note" });

    // Workspace 2
    createWorkspace(db, { id: "ws2", name: "Workspace 2" });
    createProject(db, { id: "p2", workspaceId: "ws2", name: "WS2 Project" });
    createColumn(db, { id: "col2", projectId: "p2", workspaceId: "ws2", name: "Backlog", type: "backlog", order: 0 });
    createNote(db, { id: "n-ws2", projectId: "p2", workspaceId: "ws2", title: "WS2 note" });

    const result = executeTool(db, wp, "list_recent_activity", { workspaceId: "ws1" }) as Array<{ id: string }>;
    const ids = result.map((r) => r.id);
    expect(ids).toContain("n-ws1");
    expect(ids).not.toContain("n-ws2");
  });

  it("projectId filter narrows activity to a single project within workspace", () => {
    const { workspaceId, columnId } = seedBase(db, { projectId: "p1", columnId: "col1" });
    createProject(db, { id: "p2", workspaceId, name: "Other" });
    createColumn(db, { id: "col2", projectId: "p2", workspaceId, name: "Backlog", type: "backlog", order: 0 });

    createNote(db, { id: "n1", projectId: "p1", workspaceId, title: "P1 note" });
    createNote(db, { id: "n2", projectId: "p2", workspaceId, title: "P2 note" });
    createCard(db, { id: "c1", columnId,  projectId: "p1", workspaceId, title: "P1 task" });
    createCard(db, { id: "c2", columnId: "col2", projectId: "p2", workspaceId, title: "P2 task" });

    const result = executeTool(db, wp, "list_recent_activity", { workspaceId, projectId: "p1" }) as Array<{ id: string }>;
    const ids = result.map((r) => r.id);
    expect(ids).toContain("n1");
    expect(ids).toContain("c1");
    expect(ids).not.toContain("n2");
    expect(ids).not.toContain("c2");
  });

  it("limit parameter caps result count", () => {
    const { workspaceId } = seedBase(db);
    for (let i = 0; i < 25; i++) {
      createNote(db, { id: `n${i}`, projectId: "proj1", workspaceId, title: `Note ${i}` });
    }
    const result = executeTool(db, wp, "list_recent_activity", { workspaceId, limit: 5 }) as unknown[];
    expect(result).toHaveLength(5);
  });

  it("action field is 'created' for new items, 'updated' after an update", async () => {
    const { workspaceId } = seedBase(db);
    createNote(db, { id: "n1", projectId: "proj1", workspaceId, title: "Fresh note" });
    await new Promise((r) => setTimeout(r, 10));
    updateNote(db, "n1", { content: "edited" });

    const result = executeTool(db, wp, "list_recent_activity", { workspaceId }) as Array<{ id: string; action: string }>;
    const entry = result.find((r) => r.id === "n1");
    expect(entry?.action).toBe("updated");
  });

  it("archived notes and tasks are excluded", () => {
    const { workspaceId, columnId } = seedBase(db);
    createNote(db, { id: "n-arch", projectId: "proj1", workspaceId, title: "Archived note" });
    createCard(db, { id: "c-arch", columnId, projectId: "proj1", workspaceId, title: "Archived task" });
    updateNote(db, "n-arch", { archivedAt: "2024-01-01T00:00:00.000Z" });
    updateCard(db, "c-arch", { archivedAt: "2024-01-01T00:00:00.000Z" });

    const result = executeTool(db, wp, "list_recent_activity", { workspaceId }) as Array<{ id: string }>;
    const ids = result.map((r) => r.id);
    expect(ids).not.toContain("n-arch");
    expect(ids).not.toContain("c-arch");
  });
});

// ── list_ready_tasks: multi-level blocker chains ──────────────────────────────

describe("list_ready_tasks — multi-level blocker chains", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    createColumn(db, { id: "col-done", projectId, workspaceId, name: "Done", type: "done", order: 1 });
    // Chain: c3 blocked by c2, c2 blocked by c1
    createCard(db, { id: "c1", columnId, projectId, workspaceId, title: "Root task" });
    createCard(db, { id: "c2", columnId, projectId, workspaceId, title: "Mid task" });
    createCard(db, { id: "c3", columnId, projectId, workspaceId, title: "Leaf task" });
  });
  afterEach(() => removeTmpDir(wp));

  it("c3 is blocked when c2 blocks it and c2 itself is blocked by c1", () => {
    executeTool(db, wp, "block_task", { cardId: "c2", blockerCardId: "c1" });
    executeTool(db, wp, "block_task", { cardId: "c3", blockerCardId: "c2" });

    const ready = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    const ids = ready.map((r) => r.id);
    expect(ids).toContain("c1");      // root is ready
    expect(ids).not.toContain("c2");  // blocked by c1
    expect(ids).not.toContain("c3");  // blocked by c2
  });

  it("resolving root blocker (move to done) makes mid task ready but not leaf", () => {
    executeTool(db, wp, "block_task", { cardId: "c2", blockerCardId: "c1" });
    executeTool(db, wp, "block_task", { cardId: "c3", blockerCardId: "c2" });

    executeTool(db, wp, "update_task_status", { cardId: "c1", targetColumnId: "col-done" });

    const ready = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    const ids = ready.map((r) => r.id);
    expect(ids).toContain("c2");      // c1 resolved → c2 now ready
    expect(ids).not.toContain("c3");  // c2 still in backlog → c3 still blocked
  });

  it("resolving all blockers in chain makes leaf task ready", () => {
    executeTool(db, wp, "block_task", { cardId: "c2", blockerCardId: "c1" });
    executeTool(db, wp, "block_task", { cardId: "c3", blockerCardId: "c2" });

    executeTool(db, wp, "update_task_status", { cardId: "c1", targetColumnId: "col-done" });
    executeTool(db, wp, "update_task_status", { cardId: "c2", targetColumnId: "col-done" });

    const ready = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(ready.map((r) => r.id)).toContain("c3");
  });

  it("task with multiple blockers — only ready when ALL are resolved", () => {
    const { workspaceId, projectId, columnId } = { workspaceId: "ws1", projectId: "proj1", columnId: "col1" };
    createCard(db, { id: "dep-a", columnId, projectId, workspaceId, title: "Dep A" });
    createCard(db, { id: "dep-b", columnId, projectId, workspaceId, title: "Dep B" });
    createCard(db, { id: "work",  columnId, projectId, workspaceId, title: "Main work" });

    executeTool(db, wp, "block_task", { cardId: "work", blockerCardId: "dep-a" });
    executeTool(db, wp, "block_task", { cardId: "work", blockerCardId: "dep-b" });

    // Resolve only dep-a
    executeTool(db, wp, "update_task_status", { cardId: "dep-a", targetColumnId: "col-done" });
    let ready = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(ready.map((r) => r.id)).not.toContain("work"); // dep-b still pending

    // Resolve dep-b too
    executeTool(db, wp, "update_task_status", { cardId: "dep-b", targetColumnId: "col-done" });
    ready = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(ready.map((r) => r.id)).toContain("work");
  });
});

// ── delete_task: cleans up references across multiple blocked tasks ───────────

describe("delete_task — blocker reference cleanup across multiple tasks", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    createCard(db, { id: "blocker", columnId, projectId, workspaceId, title: "Blocker" });
    createCard(db, { id: "blocked-a", columnId, projectId, workspaceId, title: "Blocked A" });
    createCard(db, { id: "blocked-b", columnId, projectId, workspaceId, title: "Blocked B" });
    createCard(db, { id: "blocked-c", columnId, projectId, workspaceId, title: "Blocked C" });
    executeTool(db, wp, "block_task", { cardId: "blocked-a", blockerCardId: "blocker" });
    executeTool(db, wp, "block_task", { cardId: "blocked-b", blockerCardId: "blocker" });
    executeTool(db, wp, "block_task", { cardId: "blocked-c", blockerCardId: "blocker" });
  });
  afterEach(() => removeTmpDir(wp));

  it("deleting a blocker task frees all tasks that were blocked by it", () => {
    executeTool(db, wp, "delete_task", { cardId: "blocker" });

    const ready = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    const ids = ready.map((r) => r.id);
    expect(ids).toContain("blocked-a");
    expect(ids).toContain("blocked-b");
    expect(ids).toContain("blocked-c");
  });

  it("task that was blocking others is also gone from list_tasks after delete", () => {
    executeTool(db, wp, "delete_task", { cardId: "blocker" });

    const cols = executeTool(db, wp, "list_tasks", { projectId: "proj1" }) as Array<{ tasks: Array<{ id: string }> }>;
    const allIds = cols.flatMap((c) => c.tasks.map((t) => t.id));
    expect(allIds).not.toContain("blocker");
  });
});

// ── blocker cleanup when task moves to done ───────────────────────────────────

describe("blocker cleanup on move-to-done", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    createColumn(db, { id: "col-done", projectId, workspaceId, name: "Done", type: "done", order: 1 });
    createCard(db, { id: "blocker", columnId, projectId, workspaceId, title: "Blocker task" });
    createCard(db, { id: "blocked", columnId, projectId, workspaceId, title: "Blocked task" });
    executeTool(db, wp, "block_task", { cardId: "blocked", blockerCardId: "blocker" });
  });
  afterEach(() => removeTmpDir(wp));

  it("get_task reports the blocker as pending before it moves to done", () => {
    const task = executeTool(db, wp, "get_task", { cardId: "blocked" }) as Record<string, unknown>;
    expect((task.blockedByIds as string[])).toContain("blocker");
  });

  it("update_task_status to done clears blockedByIds on the blocked task", () => {
    executeTool(db, wp, "update_task_status", { cardId: "blocker", targetColumnId: "col-done" });
    const task = executeTool(db, wp, "get_task", { cardId: "blocked" }) as Record<string, unknown>;
    expect((task.blockedByIds as string[])).not.toContain("blocker");
    expect((task.blockedByIds as string[])).toHaveLength(0);
  });

  it("moving to a non-done column does NOT clear blockedByIds", () => {
    createColumn(db, { id: "col-ip", projectId: "proj1", workspaceId: "ws1", name: "In Progress", type: "in_progress", order: 2 });
    executeTool(db, wp, "update_task_status", { cardId: "blocker", targetColumnId: "col-ip" });
    const task = executeTool(db, wp, "get_task", { cardId: "blocked" }) as Record<string, unknown>;
    // Blocker is still active — blocked task should still list it
    expect((task.blockedByIds as string[])).toContain("blocker");
  });

  it("bulk_update_task_status to done clears blockedByIds for all moved tasks", () => {
    // Two blockers, both bulk-moved to done at once
    createCard(db, { id: "blocker2", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocker 2" });
    createCard(db, { id: "blocked2", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocked 2" });
    executeTool(db, wp, "block_task", { cardId: "blocked2", blockerCardId: "blocker2" });

    executeTool(db, wp, "bulk_update_task_status", { cardIds: ["blocker", "blocker2"], targetColumnId: "col-done" });

    const t1 = executeTool(db, wp, "get_task", { cardId: "blocked" }) as Record<string, unknown>;
    const t2 = executeTool(db, wp, "get_task", { cardId: "blocked2" }) as Record<string, unknown>;
    expect((t1.blockedByIds as string[])).toHaveLength(0);
    expect((t2.blockedByIds as string[])).toHaveLength(0);
  });

  it("a task with multiple blockers only has the done-moved ones cleared", () => {
    createCard(db, { id: "blocker2", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Blocker 2" });
    executeTool(db, wp, "block_task", { cardId: "blocked", blockerCardId: "blocker2" });

    // Only move the first blocker to done
    executeTool(db, wp, "update_task_status", { cardId: "blocker", targetColumnId: "col-done" });

    const task = executeTool(db, wp, "get_task", { cardId: "blocked" }) as Record<string, unknown>;
    const ids = task.blockedByIds as string[];
    expect(ids).not.toContain("blocker");  // cleared
    expect(ids).toContain("blocker2");     // still pending
  });

  it("after clearing, the task appears in list_ready_tasks AND get_task shows empty blockedByIds", () => {
    executeTool(db, wp, "update_task_status", { cardId: "blocker", targetColumnId: "col-done" });

    const ready = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(ready.map((r) => r.id)).toContain("blocked");

    const task = executeTool(db, wp, "get_task", { cardId: "blocked" }) as Record<string, unknown>;
    expect((task.blockedByIds as string[])).toHaveLength(0);
  });

  it("moving back out of done re-blocks the dependent task (blockedByIds was already cleared — needs explicit re-block)", () => {
    // Move to done → clears blockedByIds
    executeTool(db, wp, "update_task_status", { cardId: "blocker", targetColumnId: "col-done" });
    // Move back to backlog
    executeTool(db, wp, "update_task_status", { cardId: "blocker", targetColumnId: "col1" });

    // blocked task's blockedByIds was already cleared — agent must call block_task again
    const task = executeTool(db, wp, "get_task", { cardId: "blocked" }) as Record<string, unknown>;
    expect((task.blockedByIds as string[])).toHaveLength(0);

    // And it appears ready (no longer tracked as blocked)
    const ready = executeTool(db, wp, "list_ready_tasks", { projectId: "proj1" }) as Array<{ id: string }>;
    expect(ready.map((r) => r.id)).toContain("blocked");
  });
});

// ── get_project_context_pack: multiple open columns ──────────────────────────

describe("get_project_context_pack — multiple open columns with tasks", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = makeTmpDir();
    const { workspaceId, projectId, columnId } = seedBase(db);
    createColumn(db, { id: "col-ip",   projectId, workspaceId, name: "In Progress", type: "in_progress", order: 1 });
    createColumn(db, { id: "col-rev",  projectId, workspaceId, name: "Review",      type: "review",      order: 2 });
    createColumn(db, { id: "col-done", projectId, workspaceId, name: "Done",        type: "done",        order: 3 });

    createCard(db, { id: "c-backlog", columnId,      projectId, workspaceId, title: "Backlog task" });
    createCard(db, { id: "c-ip",      columnId: "col-ip",   projectId, workspaceId, title: "In progress task" });
    createCard(db, { id: "c-review",  columnId: "col-rev",  projectId, workspaceId, title: "Review task" });
    createCard(db, { id: "c-done",    columnId: "col-done", projectId, workspaceId, title: "Done task" });
  });
  afterEach(() => removeTmpDir(wp));

  it("openTasks includes backlog, in_progress and review columns but not done", () => {
    const result = executeTool(db, wp, "get_project_context_pack", { projectId: "proj1" }) as Record<string, unknown>;
    const openTasks = result.openTasks as Array<{ columnType: string; tasks: Array<{ id: string }> }>;

    const types = openTasks.map((c) => c.columnType);
    expect(types).toContain("backlog");
    expect(types).toContain("in_progress");
    expect(types).toContain("review");
    expect(types).not.toContain("done");

    const allIds = openTasks.flatMap((c) => c.tasks.map((t) => t.id));
    expect(allIds).toContain("c-backlog");
    expect(allIds).toContain("c-ip");
    expect(allIds).toContain("c-review");
    expect(allIds).not.toContain("c-done");
  });

  it("empty columns are excluded from openTasks", () => {
    // col-rev has the only review task; remove it
    executeTool(db, wp, "delete_task", { cardId: "c-review" });

    const result = executeTool(db, wp, "get_project_context_pack", { projectId: "proj1" }) as Record<string, unknown>;
    const openTasks = result.openTasks as Array<{ columnType: string }>;
    expect(openTasks.map((c) => c.columnType)).not.toContain("review");
  });

  it("recentActivity includes both notes and tasks sorted newest first", async () => {
    createNote(db, { id: "n-old", projectId: "proj1", workspaceId: "ws1", title: "Old note" });
    await new Promise((r) => setTimeout(r, 10));
    createCard(db, { id: "c-latest", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Latest task" });

    const result = executeTool(db, wp, "get_project_context_pack", { projectId: "proj1" }) as Record<string, unknown>;
    const activity = result.recentActivity as Array<{ id: string }>;
    const ids = activity.map((a) => a.id);
    expect(ids.indexOf("c-latest")).toBeLessThan(ids.indexOf("n-old"));
  });
});
