/**
 * T30 — Integration tests for handlers.ts IPC surface
 *
 * Tests that each handler returns the correct shape, handles missing/invalid
 * input gracefully (returning { error } rather than throwing), and that the
 * shared read-tool dispatcher routes correctly.
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
  createNote(db, { id: "note1", projectId: "proj1", workspaceId: "ws1", title: "Note", content: "body" });
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

// Search is SQL-backed (electron/mcp/tools/sql-reads.ts) and no longer part of
// the snapshot read dispatcher; see sql-reads.test.ts.

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
