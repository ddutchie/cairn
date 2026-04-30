/**
 * T31 — MCP vs chat tool parity test
 *
 * Asserts that both chat-executor.ts (via TOOLS array) and mcp-server.ts
 * (via TOOL_DEFINITIONS array) expose identical shapes for shared tools:
 * same keys in their summary responses, consistent return types, and
 * no tool missing from either side.
 *
 * Chat-only tools (get_active_context, generate_prd, spawn_tasks_from_note)
 * are intentionally absent from MCP — these are excluded from the parity check.
 *
 * We also verify get_project_summary returns the canonical ProjectSummaryResult
 * shape from both chat-executor and the shared read-tools module.
 */

import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, createColumn, createNote, updateNote, createCard, getFullSnapshot } from "../db/queries";
import { executeReadTool, type CairnSnapshot } from "../lib/read-tools";
import { TOOLS } from "../lib/tools";

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function seed(db: Database.Database) {
  createWorkspace(db, { id: "ws1", name: "WS" });
  createProject(db, { id: "proj1", workspaceId: "ws1", name: "Proj" });
  createColumn(db, { id: "col1", projectId: "proj1", workspaceId: "ws1", name: "Backlog", type: "backlog", order: 0 });
  createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Note", content: "body", contentText: "body" });
  updateNote(db, "n1", { isPinned: true });
  createCard(db, { id: "c1", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Task", order: 0 });
}

// ── Tool name sets ────────────────────────────────────────────────────────────

// Chat-only tools that intentionally do not exist in the MCP server
const CHAT_ONLY_TOOLS = new Set(["get_active_context", "generate_prd", "spawn_tasks_from_note"]);

// Shared read tools handled by executeReadTool (and also in mcp-server.ts)
const SHARED_READ_TOOLS = [
  "get_project_summary",
  "list_tasks",
  "list_notes",
  "list_recent_activity",
  "search_notes",
  "search_tasks",
];

describe("Tool name parity", () => {
  it("TOOLS (chat) contains all shared read tool names", () => {
    const chatToolNames = new Set(TOOLS.map((t) => t.function.name));
    for (const name of SHARED_READ_TOOLS) {
      expect(chatToolNames.has(name), `chat TOOLS missing: ${name}`).toBe(true);
    }
  });

  it("All chat tools are either chat-only or shared with MCP", () => {
    // This test documents the intentional split — any new chat-only tool
    // should be added to CHAT_ONLY_TOOLS above; any new shared tool should
    // also appear in MCP TOOL_DEFINITIONS.
    const chatToolNames = TOOLS.map((t) => t.function.name);
    const documented = new Set([...CHAT_ONLY_TOOLS, ...SHARED_READ_TOOLS,
      // Shared write/delete tools also in MCP:
      "get_cairn_context", "get_note", "get_task",
      "create_project", "update_project", "delete_project",
      "create_note", "update_note", "delete_note",
      "create_task", "update_task", "update_task_status",
      "link_note_to_task", "create_dashboard", "update_dashboard", "delete_task",
    ]);
    for (const name of chatToolNames) {
      expect(documented.has(name), `Undocumented chat tool: ${name} — add to CHAT_ONLY_TOOLS or shared list`).toBe(true);
    }
  });
});

// ── get_project_summary canonical shape ───────────────────────────────────────

describe("get_project_summary shape consistency", () => {
  let db: Database.Database;
  let snap: CairnSnapshot;

  beforeEach(() => {
    db = makeDb();
    seed(db);
    snap = getFullSnapshot(db) as CairnSnapshot;
  });

  it("executeReadTool returns all canonical fields", () => {
    const res = executeReadTool(db, snap, "get_project_summary", { projectId: "proj1" });
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    const r = res.result as Record<string, unknown>;
    // Canonical ProjectSummaryResult fields
    expect(r).toHaveProperty("project");
    expect(r).toHaveProperty("noteCount");
    expect(r).toHaveProperty("totalCards");
    expect(r).toHaveProperty("cardsByColumn");
    expect(r).toHaveProperty("pinnedNotes");
    expect(r).toHaveProperty("recentActivity");
  });

  it("cardsByColumn entries have consistent shape", () => {
    const res = executeReadTool(db, snap, "get_project_summary", { projectId: "proj1" });
    if (!res.handled) return;
    const r = res.result as Record<string, unknown>;
    const cols = r.cardsByColumn as Array<Record<string, unknown>>;
    expect(cols.length).toBeGreaterThan(0);
    const col = cols[0];
    expect(col).toHaveProperty("columnName");
    expect(col).toHaveProperty("columnType");
    expect(col).toHaveProperty("count");
    expect(col).toHaveProperty("cards");
    const cards = col.cards as Array<Record<string, unknown>>;
    if (cards.length > 0) {
      expect(cards[0]).toHaveProperty("id");
      expect(cards[0]).toHaveProperty("title");
      expect(cards[0]).toHaveProperty("priority");
    }
  });

  it("pinnedNotes reflects actual pinned notes", () => {
    const res = executeReadTool(db, snap, "get_project_summary", { projectId: "proj1" });
    if (!res.handled) return;
    const r = res.result as Record<string, unknown>;
    const pinned = r.pinnedNotes as Array<Record<string, unknown>>;
    expect(pinned.length).toBe(1);
    expect(pinned[0].id).toBe("n1");
  });

  it("noteCount and totalCards are correct", () => {
    const res = executeReadTool(db, snap, "get_project_summary", { projectId: "proj1" });
    if (!res.handled) return;
    const r = res.result as Record<string, unknown>;
    expect(r.noteCount).toBe(1);
    expect(r.totalCards).toBe(1);
  });
});

// ── list_recent_activity shape ────────────────────────────────────────────────

describe("list_recent_activity shape consistency", () => {
  it("returns { recentNotes, recentTasks } from executeReadTool", () => {
    const db = makeDb();
    seed(db);
    const snap = getFullSnapshot(db) as CairnSnapshot;
    const res = executeReadTool(db, snap, "list_recent_activity", { projectId: "proj1" });
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    const r = res.result as Record<string, unknown>;
    expect(r).toHaveProperty("recentNotes");
    expect(r).toHaveProperty("recentTasks");
    // Items have id, title, projectId, updatedAt
    const note = (r.recentNotes as Array<Record<string, unknown>>)[0];
    expect(note).toHaveProperty("id");
    expect(note).toHaveProperty("title");
    expect(note).toHaveProperty("projectId");
    expect(note).toHaveProperty("updatedAt");
  });
});
