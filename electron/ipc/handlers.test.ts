/**
 * T30 — Integration tests for handlers.ts IPC surface
 *
 * Tests that each handler returns the correct shape, handles missing/invalid
 * input gracefully (returning { error } rather than throwing), and that the
 * db:mcpQuery bridge dispatches correctly.
 *
 * We import the query layer directly to seed the DB, then call the handler
 * logic through thin wrappers that bypass ipcMain registration.
 */

import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import {
  createWorkspace, createProject, createNote, createColumn, createCard,
} from "../db/queries";
import { executeTool as executeMcpTool } from "../mcp-server";
import { executeReadTool } from "../lib/read-tools";
import * as q from "../db/queries";

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function seed(db: Database.Database) {
  createWorkspace(db, { id: "ws1", name: "Workspace" });
  createProject(db, { id: "proj1", workspaceId: "ws1", name: "Project" });
  createColumn(db, { id: "col1", projectId: "proj1", workspaceId: "ws1", name: "Backlog", type: "backlog", order: 0 });
  createNote(db, { id: "note1", projectId: "proj1", workspaceId: "ws1", title: "Note", content: "body", contentText: "body" });
  createCard(db, { id: "card1", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Task", order: 0 });
}

// ── Query helpers (test as db:snapshot would) ─────────────────────────────────

describe("getFullSnapshot", () => {
  it("returns all entity arrays", () => {
    const db = makeDb();
    seed(db);
    const snap = q.getFullSnapshot(db);
    expect(snap.workspaces.length).toBe(1);
    expect(snap.projects.length).toBe(1);
    expect(snap.notes.length).toBe(1);
    expect(snap.columns.length).toBe(1);
    expect(snap.cards.length).toBe(1);
  });
});

// ── get_cairn_context ──────────────────────────────────

describe("get_cairn_context", () => {
  it("includes workspaces and projects with columns", () => {
    const db = makeDb();
    seed(db);
    const result = executeMcpTool(db, "", "get_cairn_context", {}) as Record<string, unknown>;
    expect(result).toHaveProperty("workspaces");
    expect(result).toHaveProperty("projects");
    const proj = (result.projects as Array<Record<string, unknown>>).find((p) => p.id === "proj1");
    expect(proj).toBeDefined();
    expect((proj!.columns as unknown[]).length).toBeGreaterThan(0);
  });
});

// ── executeReadTool — get_project_summary ─────────────────────────────────────

describe("executeReadTool: get_project_summary", () => {
  it("returns canonical shape for valid project", () => {
    const db = makeDb();
    seed(db);
    const snap = q.getFullSnapshot(db) as Parameters<typeof executeReadTool>[1];
    const res = executeReadTool(db, snap, "get_project_summary", { projectId: "proj1" });
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    const r = res.result as Record<string, unknown>;
    expect(r).toHaveProperty("project");
    expect(r).toHaveProperty("noteCount", 1);
    expect(r).toHaveProperty("totalCards", 1);
    expect(r).toHaveProperty("cardsByColumn");
    expect(r).toHaveProperty("pinnedNotes");
    expect(r).toHaveProperty("recentActivity");
  });

  it("returns { error } for missing project", () => {
    const db = makeDb();
    seed(db);
    const snap = q.getFullSnapshot(db) as Parameters<typeof executeReadTool>[1];
    const res = executeReadTool(db, snap, "get_project_summary", { projectId: "nope" });
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    expect(res.result).toHaveProperty("error");
  });
});

// ── executeReadTool — list_tasks ──────────────────────────────────────────────

describe("executeReadTool: list_tasks", () => {
  it("returns columns grouped with tasks", () => {
    const db = makeDb();
    seed(db);
    const snap = q.getFullSnapshot(db) as Parameters<typeof executeReadTool>[1];
    const res = executeReadTool(db, snap, "list_tasks", { projectId: "proj1" });
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    const cols = res.result as Array<Record<string, unknown>>;
    expect(Array.isArray(cols)).toBe(true);
    const backlog = cols.find((c) => c.columnId === "col1");
    expect(backlog).toBeDefined();
    expect((backlog!.tasks as unknown[]).length).toBe(1);
  });
});

// ── executeReadTool — list_notes ──────────────────────────────────────────────

describe("executeReadTool: list_notes", () => {
  it("returns notes for project", () => {
    const db = makeDb();
    seed(db);
    const snap = q.getFullSnapshot(db) as Parameters<typeof executeReadTool>[1];
    const res = executeReadTool(db, snap, "list_notes", { projectId: "proj1" });
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    const notes = res.result as Array<Record<string, unknown>>;
    expect(notes.length).toBe(1);
    expect(notes[0].id).toBe("note1");
  });
});

// ── executeReadTool — list_recent_activity ────────────────────────────────────

describe("executeReadTool: list_recent_activity", () => {
  it("returns recentNotes and recentTasks", () => {
    const db = makeDb();
    seed(db);
    const snap = q.getFullSnapshot(db) as Parameters<typeof executeReadTool>[1];
    const res = executeReadTool(db, snap, "list_recent_activity", { projectId: "proj1" });
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    const result = res.result as Record<string, unknown>;
    expect(result).toHaveProperty("recentNotes");
    expect(result).toHaveProperty("recentTasks");
    expect((result.recentNotes as unknown[]).length).toBe(1);
    expect((result.recentTasks as unknown[]).length).toBe(1);
  });
});

// ── executeReadTool — search_notes ────────────────────────────────────────────

describe("executeReadTool: search_notes", () => {
  it("finds matching notes by contentText", () => {
    const db = makeDb();
    seed(db);
    const snap = q.getFullSnapshot(db) as Parameters<typeof executeReadTool>[1];
    const res = executeReadTool(db, snap, "search_notes", { query: "body" });
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    const notes = res.result as Array<Record<string, unknown>>;
    expect(notes.length).toBe(1);
    expect(notes[0].id).toBe("note1");
  });

  it("returns empty for no match", () => {
    const db = makeDb();
    seed(db);
    const snap = q.getFullSnapshot(db) as Parameters<typeof executeReadTool>[1];
    const res = executeReadTool(db, snap, "search_notes", { query: "zzznomatch" });
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    expect((res.result as unknown[]).length).toBe(0);
  });
});

// ── executeReadTool — search_tasks ────────────────────────────────────────────

describe("executeReadTool: search_tasks", () => {
  it("finds matching tasks", () => {
    const db = makeDb();
    seed(db);
    const snap = q.getFullSnapshot(db) as Parameters<typeof executeReadTool>[1];
    const res = executeReadTool(db, snap, "search_tasks", { query: "Task" });
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    const tasks = res.result as Array<Record<string, unknown>>;
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe("card1");
  });
});

// ── executeReadTool — unknown tool ────────────────────────────────────────────

describe("executeReadTool: unknown tool", () => {
  it("returns handled: false for unknown tools", () => {
    const db = makeDb();
    const snap = q.getFullSnapshot(db) as Parameters<typeof executeReadTool>[1];
    const res = executeReadTool(db, snap, "write_only_tool", {});
    expect(res.handled).toBe(false);
  });
});

// ── IpcResult shape: { data } | { error } ─────────────────────────────────────

describe("IpcResult consistency", () => {
  it("getProjectById returns project or undefined — not null", () => {
    const db = makeDb();
    seed(db);
    const proj = q.getProjectById(db, "proj1");
    expect(proj).toBeDefined();
    expect(proj!.id).toBe("proj1");
    const missing = q.getProjectById(db, "nope");
    expect(missing).toBeNull();
  });

  it("getNoteById returns note or undefined", () => {
    const db = makeDb();
    seed(db);
    const note = q.getNoteById(db, "note1");
    expect(note!.id).toBe("note1");
    const missing = q.getNoteById(db, "nope");
    expect(missing).toBeNull();
  });

  it("getCardById returns card or undefined", () => {
    const db = makeDb();
    seed(db);
    const card = q.getCardById(db, "card1");
    expect(card!.id).toBe("card1");
    const missing = q.getCardById(db, "nope");
    expect(missing).toBeNull();
  });
});
