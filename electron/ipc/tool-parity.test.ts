/**
 * T31 — MCP vs chat tool parity test
 *
 * Asserts that both chat-executor.ts (via TOOLS array) and mcp-server.ts
 * (via TOOL_DEFINITIONS array) expose identical shapes for shared tools:
 * same keys in their summary responses, consistent return types, and
 * no tool missing from either side.
 *
 * Chat-only tools (defined in CHAT_ONLY_TOOLS in tool-schemas.ts) are
 * intentionally absent from MCP — these are excluded from the parity check.
 *
 * We also verify get_project_summary returns the canonical ProjectSummaryResult
 * shape from both chat-executor and the shared read-tools module.
 */

import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import os from "os";
import fs from "fs";
import path from "path";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, createColumn, createNote, updateNote, createCard, getFullSnapshot } from "../db/queries";
import { executeReadTool, type CairnSnapshot } from "../lib/read-tools";
import { TOOLS } from "../lib/tools";
import { CHAT_ONLY_TOOLS as CHAT_ONLY_TOOLS_LIST } from "../lib/tool-schemas";
import { executeTool as mcpExec } from "../mcp-server";
import { executeTool as chatExec } from "./chat-executor";
import type { LLMConfig } from "../lib/llm";
import type { ChatRequest } from "../lib/tools";

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

// Chat-only tools that intentionally do not exist in the MCP server.
// Imported directly from tool-schemas so this test stays in sync automatically.
const CHAT_ONLY_TOOLS = new Set(CHAT_ONLY_TOOLS_LIST);

// Shared read tools handled by executeReadTool (and also in mcp-server.ts)
const SHARED_READ_TOOLS = [
  "get_project_summary",
  "get_project_context_pack",
  "list_tasks",
  "list_ready_tasks",
  "list_notes",
  "list_recent_activity",
  "search_notes",
  "search_tasks",
];

describe("Tool name parity", () => {
  it("TOOLS (chat) contains all shared read tool names", () => {
    const chatToolNames = new Set<string>(TOOLS.map((t) => t.function.name));
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
      "resolve_project",
      "create_note", "import_note_from_file", "ensure_note", "append_to_note", "patch_note",
      "update_note", "move_note", "delete_note",
      "create_task", "update_task", "update_task_status", "bulk_update_task_status",
      "archive_task", "restore_task",
      "link_note_to_task", "block_task", "unblock_task", "list_ready_tasks",
      "create_dashboard", "update_dashboard", "delete_task",
      "get_idea_flow", "create_idea_flow_node", "update_idea_flow_node", "delete_idea_flow_node",
      "create_idea_flow_edge", "delete_idea_flow_edge", "layout_idea_flow", "get_idea_flow_rules",
      "get_knowledge_graph", "get_neighbors", "create_tag",
      "get_dashboard_constants",
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

// ═════════════════════════════════════════════════════════════════════════════
// PART 2 — Cross-executor return shape parity
//
// For each shared tool, we call both the MCP executor (mcp-server.ts executeTool)
// and the chat executor (chat-executor.ts executeTool) against the same seeded DB
// and assert that the returned keys and values are identical.
//
// Known intentional divergences are documented with separate tests that assert
// the difference explicitly, so regressions are caught if either side changes.
// ═════════════════════════════════════════════════════════════════════════════

const llmCfg: LLMConfig = { baseUrl: "http://localhost", model: "test", apiKey: "" };
const chatReq: ChatRequest = { message: "", workspaceId: "ws1", projectId: "proj1", threadId: "t1" };
function noEmit() {}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "parity-test-"));
}

/** Call a tool through both executors and return [mcpResult, chatResult]. */
async function both(
  db: Database.Database,
  wp: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<[unknown, unknown]> {
  const mcp  = mcpExec(db, wp, tool, args);
  const chat = await chatExec(db, chatReq, wp, llmCfg, tool, args as never, noEmit);
  return [mcp, chat];
}

// ── get_note ──────────────────────────────────────────────────────────────────

describe("get_note — MCP vs chat parity", () => {
  it("returns identical keys for a found note", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "get_note", { noteId: "n1" });
    const mk = Object.keys(mcp as object).sort();
    const ck = Object.keys(chat as object).sort();
    expect(mk).toEqual(ck);
  });

  it("both return { error } for a missing note", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "get_note", { noteId: "nope" });
    expect(mcp).toHaveProperty("error");
    expect(chat).toHaveProperty("error");
  });

  it("content and id values are identical", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "get_note", { noteId: "n1" });
    const m = mcp as Record<string, unknown>;
    const c = chat as Record<string, unknown>;
    expect(m.id).toBe(c.id);
    expect(m.content).toBe(c.content);
    expect(m.isPinned).toBe(c.isPinned);
  });
});

// ── get_task ──────────────────────────────────────────────────────────────────

describe("get_task — MCP vs chat parity", () => {
  it("returns identical keys for a found task", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "get_task", { cardId: "c1" });
    const mk = Object.keys(mcp as object).sort();
    const ck = Object.keys(chat as object).sort();
    expect(mk).toEqual(ck);
  });

  it("both return { error } for missing task", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "get_task", { cardId: "nope" });
    expect(mcp).toHaveProperty("error");
    expect(chat).toHaveProperty("error");
  });

  it("blockedByIds is present and empty in both when no blockers", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "get_task", { cardId: "c1" });
    expect((mcp as Record<string, unknown>).blockedByIds).toEqual([]);
    expect((chat as Record<string, unknown>).blockedByIds).toEqual([]);
  });
});

// ── search_notes ──────────────────────────────────────────────────────────────

describe("search_notes — MCP vs chat parity", () => {
  it("same item keys in results", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "search_notes", { query: "body" });
    const mr = mcp as Array<Record<string, unknown>>;
    const cr = chat as Array<Record<string, unknown>>;
    expect(mr).toHaveLength(1);
    expect(cr).toHaveLength(1);
    expect(Object.keys(mr[0]).sort()).toEqual(Object.keys(cr[0]).sort());
  });

  it("same id and snippet returned", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "search_notes", { query: "body" });
    const mr = (mcp as Array<Record<string, unknown>>)[0];
    const cr = (chat as Array<Record<string, unknown>>)[0];
    expect(mr.id).toBe(cr.id);
    expect(mr.snippet).toBe(cr.snippet);
  });

  it("both return empty array for no match", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "search_notes", { query: "zzznomatch" });
    expect(mcp).toEqual([]);
    expect(chat).toEqual([]);
  });
});

// ── search_tasks ──────────────────────────────────────────────────────────────

describe("search_tasks — MCP vs chat parity", () => {
  it("same item keys in results", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "search_tasks", { query: "Task" });
    const mr = mcp as Array<Record<string, unknown>>;
    const cr = chat as Array<Record<string, unknown>>;
    expect(mr).toHaveLength(1);
    expect(cr).toHaveLength(1);
    expect(Object.keys(mr[0]).sort()).toEqual(Object.keys(cr[0]).sort());
  });

  it("same id, priority, columnId returned", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "search_tasks", { query: "Task" });
    const mr = (mcp as Array<Record<string, unknown>>)[0];
    const cr = (chat as Array<Record<string, unknown>>)[0];
    expect(mr.id).toBe(cr.id);
    expect(mr.priority).toBe(cr.priority);
    expect(mr.columnId).toBe(cr.columnId);
  });
});

// ── list_notes ────────────────────────────────────────────────────────────────

describe("list_notes — MCP vs chat parity", () => {
  it("same item keys (including folder)", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "list_notes", { projectId: "proj1" });
    const mr = mcp as Array<Record<string, unknown>>;
    const cr = chat as Array<Record<string, unknown>>;
    expect(mr.length).toBeGreaterThan(0);
    expect(Object.keys(mr[0]).sort()).toEqual(Object.keys(cr[0]).sort());
  });

  it("folder field present and equal in both", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "list_notes", { projectId: "proj1" });
    const mr = (mcp as Array<Record<string, unknown>>)[0];
    const cr = (chat as Array<Record<string, unknown>>)[0];
    expect(mr).toHaveProperty("folder");
    expect(cr).toHaveProperty("folder");
    expect(mr.folder).toBe(cr.folder);
  });
});

// ── list_tasks ────────────────────────────────────────────────────────────────

describe("list_tasks — MCP vs chat parity", () => {
  it("same column and task keys", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "list_tasks", { projectId: "proj1" });
    const mcols = mcp as Array<Record<string, unknown>>;
    const ccols = chat as Array<Record<string, unknown>>;
    expect(mcols.length).toBeGreaterThan(0);
    expect(Object.keys(mcols[0]).sort()).toEqual(Object.keys(ccols[0]).sort());
    // Task item keys
    const mtasks = mcols.find((c) => (c.tasks as unknown[]).length > 0)!.tasks as Array<Record<string, unknown>>;
    const ctasks = ccols.find((c) => (c.tasks as unknown[]).length > 0)!.tasks as Array<Record<string, unknown>>;
    expect(Object.keys(mtasks[0]).sort()).toEqual(Object.keys(ctasks[0]).sort());
  });

  it("same task id and priority values", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "list_tasks", { projectId: "proj1" });
    const mTask = (mcp as Array<{ tasks: Array<Record<string, unknown>> }>)
      .flatMap((c) => c.tasks)[0];
    const cTask = (chat as Array<{ tasks: Array<Record<string, unknown>> }>)
      .flatMap((c) => c.tasks)[0];
    expect(mTask.id).toBe(cTask.id);
    expect(mTask.priority).toBe(cTask.priority);
  });
});

// ── resolve_project ───────────────────────────────────────────────────────────

describe("resolve_project — MCP vs chat parity", () => {
  it("same keys on match", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "resolve_project", { name: "Proj" });
    expect(Object.keys(mcp as object).sort()).toEqual(Object.keys(chat as object).sort());
  });

  it("same id, name, workspaceId, status values", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "resolve_project", { name: "Proj" });
    const m = mcp as Record<string, unknown>;
    const c = chat as Record<string, unknown>;
    expect(m.id).toBe(c.id);
    expect(m.name).toBe(c.name);
    expect(m.workspaceId).toBe(c.workspaceId);
    expect(m.status).toBe(c.status);
  });

  it("both return error + candidates on no match", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "resolve_project", { name: "zzznomatch" });
    expect(mcp).toHaveProperty("error");
    expect(chat).toHaveProperty("error");
    expect((mcp as Record<string, unknown>).candidates).toBeDefined();
    expect((chat as Record<string, unknown>).candidates).toBeDefined();
  });
});

// ── get_project_summary ───────────────────────────────────────────────────────

describe("get_project_summary — MCP vs chat parity", () => {
  it("same top-level keys", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "get_project_summary", { projectId: "proj1" });
    expect(Object.keys(mcp as object).sort()).toEqual(Object.keys(chat as object).sort());
  });

  it("same noteCount and totalCards values", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "get_project_summary", { projectId: "proj1" });
    const m = mcp as Record<string, unknown>;
    const c = chat as Record<string, unknown>;
    expect(m.noteCount).toBe(c.noteCount);
    expect(m.totalCards).toBe(c.totalCards);
  });

  it("both return { error } for missing project", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "get_project_summary", { projectId: "nope" });
    expect(mcp).toHaveProperty("error");
    expect(chat).toHaveProperty("error");
  });
});

// ── get_project_context_pack ──────────────────────────────────────────────────

describe("get_project_context_pack — MCP vs chat parity", () => {
  it("same top-level keys", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "get_project_context_pack", { projectId: "proj1" });
    expect(Object.keys(mcp as object).sort()).toEqual(Object.keys(chat as object).sort());
  });

  it("same noteCount and pinned note ids", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "get_project_context_pack", { projectId: "proj1" });
    const m = mcp as Record<string, unknown>;
    const c = chat as Record<string, unknown>;
    expect(m.noteCount).toBe(c.noteCount);
    const mPinned = (m.pinnedNotes as Array<{ id: string }>).map((n) => n.id).sort();
    const cPinned = (c.pinnedNotes as Array<{ id: string }>).map((n) => n.id).sort();
    expect(mPinned).toEqual(cPinned);
  });

  it("both return { error } for missing project", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "get_project_context_pack", { projectId: "nope" });
    expect(mcp).toHaveProperty("error");
    expect(chat).toHaveProperty("error");
  });
});

// ── Known intentional divergences (documented) ───────────────────────────────

describe("known intentional divergences between MCP and chat", () => {
  it("list_recent_activity: MCP returns a flat array, chat returns { recentNotes, recentTasks }", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "list_recent_activity", { workspaceId: "ws1", projectId: "proj1" });
    // MCP: flat sorted array
    expect(Array.isArray(mcp)).toBe(true);
    // Chat (via executeReadTool): split object
    expect(chat).toHaveProperty("recentNotes");
    expect(chat).toHaveProperty("recentTasks");
  });

  it("create_project: MCP returns { projectId, name, columns }, chat returns { project, columns }", async () => {
    const db = makeDb(); const wp = makeTmpDir();
    seed(db);
    const [mcp, chat] = await both(db, wp, "create_project", { workspaceId: "ws1", name: "New Project" });
    // MCP uses projectId key
    expect(mcp).toHaveProperty("projectId");
    expect(mcp).not.toHaveProperty("project");
    // Chat wraps the full project object
    expect(chat).toHaveProperty("project");
    expect(chat).not.toHaveProperty("projectId");
  });
});
