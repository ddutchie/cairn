
/**
 * Throwaway benchmark — seeds a representative Cairn DB and prints
 * `JSON.stringify(executeTool(...)).length` for every MCP tool that returns
 * a data payload to the agent. Run via:
 *
 *   npx vitest run electron/mcp/payload-baseline.test.ts
 *
 * The output is captured into docs/plans/mcp-payload-optimization.md.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "../db/schema";
import {
  createWorkspace, createProject, createNote, createColumn, createCard,
  updateNote, updateCard, createTag,
} from "../db/queries";
import { executeTool as executeMcpTool } from "../mcp-server";
import { executeTool as executeChatTool } from "../cordis/chat-executor";
import type { ChatRequest } from "../lib/tools";
import type { LLMConfig } from "../lib/llm";

function makeDb() {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function seed(db: Database.Database) {
  createWorkspace(db, { id: "ws-main", name: "Main Workspace" });
  createWorkspace(db, { id: "ws-other", name: "Side Workspace" });

  // 3 projects, one archived
  createProject(db, { id: "proj-app", workspaceId: "ws-main", name: "Cairn App", description: "The desktop app", priority: "high", icon: "🪨" });
  createProject(db, { id: "proj-docs", workspaceId: "ws-main", name: "Docs", description: "User docs" });
  createProject(db, { id: "proj-old", workspaceId: "ws-main", name: "Old Project" });
  db.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run("2025-01-01T00:00:00.000Z", "proj-old");

  // Columns for each
  for (const [pid, cols] of [
    ["proj-app", [["backlog", "Backlog", "backlog", 0], ["ip", "In Progress", "in_progress", 1], ["done", "Done", "done", 2]]],
    ["proj-docs", [["db", "Backlog", "backlog", 0], ["dip", "In Progress", "in_progress", 1]]],
  ] as const) {
    for (const [cid, name, type, order] of cols) {
      createColumn(db, { id: cid, projectId: pid, workspaceId: "ws-main", name, type, order });
    }
  }

  // Tags
  createTag(db, { id: "t-bug", workspaceId: "ws-main", name: "bug", color: "#ef4444" });
  createTag(db, { id: "t-doc", workspaceId: "ws-main", name: "docs", color: "#3b82f6" });
  createTag(db, { id: "t-arch", workspaceId: "ws-main", name: "architecture", color: "#10b981" });

  // Notes — pinned 2000-char body for proj-app, several normal notes
  const longBody = "# Design\n\n" + "This is a paragraph of design content. ".repeat(60);
  createNote(db, { id: "n-design", projectId: "proj-app", workspaceId: "ws-main", title: "Design Doc", content: longBody, isPinned: true, tagIds: ["t-arch"] });
  createNote(db, { id: "n-roadmap", projectId: "proj-app", workspaceId: "ws-main", title: "Roadmap", content: "Q1, Q2, Q3 roadmap milestones", tagIds: ["t-arch"] });
  createNote(db, { id: "n-meeting", projectId: "proj-app", workspaceId: "ws-main", title: "Meeting notes", content: "Standup notes from this week. Discussed authentication." });
  createNote(db, { id: "n-readme", projectId: "proj-app", workspaceId: "ws-main", title: "README", content: "## Install\n\nnpm install cairn" });
  createNote(db, { id: "n-changelog", projectId: "proj-app", workspaceId: "ws-main", title: "Changelog", content: "v1.0 initial release" });

  // Cross-link note↔note
  updateNote(db, "n-roadmap", { linkedNoteIds: ["n-design"] });

  // Docs project notes
  createNote(db, { id: "nd-userguide", projectId: "proj-docs", workspaceId: "ws-main", title: "User Guide", content: "How to use Cairn. [[Design Doc]]", tagIds: ["t-doc"] });
  createNote(db, { id: "nd-faq", projectId: "proj-docs", workspaceId: "ws-main", title: "FAQ", content: "Frequently asked questions about authentication." });
  createNote(db, { id: "nd-troubleshoot", projectId: "proj-docs", workspaceId: "ws-main", title: "Troubleshooting", content: "Common bugs and fixes. Mention roadmap.", tagIds: ["t-bug"] });

  // Cards (tasks)
  createCard(db, { id: "c-fix-login", columnId: "backlog", projectId: "proj-app", workspaceId: "ws-main", title: "Fix login bug", description: "Users cannot log in when their password has special characters. We need to URL-encode the password before sending it to the auth service.", priority: "high", tagIds: ["t-bug"] });
  createCard(db, { id: "c-add-search", columnId: "backlog", projectId: "proj-app", workspaceId: "ws-main", title: "Add full-text search", description: "Implement a new search bar that does substring matching across notes and tasks.", priority: "medium", tagIds: ["t-arch"] });
  createCard(db, { id: "c-wip", columnId: "ip", projectId: "proj-app", workspaceId: "ws-main", title: "WIP refactor", description: "Refactoring the store slices.", priority: "medium" });
  createCard(db, { id: "c-shipped", columnId: "done", projectId: "proj-app", workspaceId: "ws-main", title: "Initial release", description: "Shipped v1.0.", priority: "low" });
  createCard(db, { id: "c-blocked", columnId: "backlog", projectId: "proj-app", workspaceId: "ws-main", title: "Blocked task", description: "Waiting on the login fix.", priority: "high" });
  createCard(db, { id: "c-blocker", columnId: "backlog", projectId: "proj-app", workspaceId: "ws-main", title: "Blocker", description: "Need to land the auth change first.", priority: "urgent" });

  // Note ↔ card link
  updateCard(db, "c-fix-login", { linkedNoteIds: ["n-meeting"] });
  updateNote(db, "n-meeting", { linkedCardIds: ["c-fix-login"] });

  // Block c-blocked by c-blocker
  db.prepare("UPDATE task_cards SET blocked_by_ids = ? WHERE id = ?").run('["c-blocker"]', "c-blocked");

  // Archived card
  createCard(db, { id: "c-arch", columnId: "backlog", projectId: "proj-app", workspaceId: "ws-main", title: "Old task", description: "Will be archived." });
  updateCard(db, "c-arch", { archivedAt: "2025-01-01" });

  // relationship_cache: co-mention + wikilink + semantic
  db.prepare(`
    INSERT INTO relationship_cache (source_id, target_id, type, weight, computed_at, source_section_title, target_section_title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("n-roadmap", "n-design", "co-mention", 0.65, Math.floor(Date.now()/1000), null, null);
  db.prepare(`
    INSERT INTO relationship_cache (source_id, target_id, type, weight, computed_at, source_section_title, target_section_title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("nd-userguide", "n-design", "wikilink", 1.0, Math.floor(Date.now()/1000), null, null);
  db.prepare(`
    INSERT INTO relationship_cache (source_id, target_id, type, weight, computed_at, source_section_title, target_section_title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("n-meeting", "nd-faq", "semantic", 0.78, Math.floor(Date.now()/1000), "Discussion", "Authentication");

  // Idea flow: 4 nodes + 2 edges
  db.prepare(`
    INSERT INTO idea_flows (id, project_id, created_at, updated_at)
    VALUES ('flow-1', 'proj-app', ?, ?)
  `).run(Math.floor(Date.now()/1000), Math.floor(Date.now()/1000));
  const nowStr = new Date().toISOString();
  db.prepare(`INSERT INTO idea_flow_nodes (id, flow_id, type, x, y, width, height, parent_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "fn-idea", "flow-1", "idea", 40, 40, 260, 100, null, JSON.stringify({ title: "Reduce payload size", body: "Audit MCP tools" }), nowStr, nowStr
  );
  db.prepare(`INSERT INTO idea_flow_nodes (id, flow_id, type, x, y, width, height, parent_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "fn-noteref", "flow-1", "note_ref", 320, 40, 220, 80, null, JSON.stringify({ noteId: "n-design" }), nowStr, nowStr
  );
  db.prepare(`INSERT INTO idea_flow_nodes (id, flow_id, type, x, y, width, height, parent_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "fn-taskref", "flow-1", "task_ref", 580, 40, 220, 80, null, JSON.stringify({ cardId: "c-fix-login" }), nowStr, nowStr
  );
  db.prepare(`INSERT INTO idea_flow_nodes (id, flow_id, type, x, y, width, height, parent_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "fn-group", "flow-1", "group", 20, 200, 600, 180, null, JSON.stringify({ label: "Brainstorm", color: "#6366f1" }), nowStr, nowStr
  );
  db.prepare(`INSERT INTO idea_flow_edges (id, flow_id, source_node_id, target_node_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "fe-1", "flow-1", "fn-idea", "fn-noteref", "leads to", nowStr
  );
  db.prepare(`INSERT INTO idea_flow_edges (id, flow_id, source_node_id, target_node_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "fe-2", "flow-1", "fn-noteref", "fn-taskref", null, nowStr
  );
}

describe("payload baseline", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-payload-"));
    seed(db);
  });
  afterEach(() => {
    try { db.close(); } catch { /* ignore — already closed */ }
    try { fs.rmSync(wp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("measures every tool", () => {
    const size = (r: unknown) => JSON.stringify(r).length;
    const calls: Array<[string, () => unknown]> = [
      ["get_cairn_context",        () => executeMcpTool(db, wp, "get_cairn_context", {})],
      ["get_project_context_pack", () => executeMcpTool(db, wp, "get_project_context_pack", { projectId: "proj-app" })],
      ["search_notes",             () => executeMcpTool(db, wp, "search_notes", { query: "design" })],
      ["search_tasks",             () => executeMcpTool(db, wp, "search_tasks", { query: "fix" })],
      ["get_note",                 () => executeMcpTool(db, wp, "get_note", { noteId: "n-design" })],
      ["get_task",                 () => executeMcpTool(db, wp, "get_task", { cardId: "c-fix-login" })],
      ["list_ready_tasks",         () => executeMcpTool(db, wp, "list_ready_tasks", { projectId: "proj-app" })],
      ["get_knowledge_graph",      () => executeMcpTool(db, wp, "get_knowledge_graph", { workspaceId: "ws-main" })],
      ["get_neighbors",            () => executeMcpTool(db, wp, "get_neighbors", { workspaceId: "ws-main", nodeId: "n-meeting", depth: 1 })],
      ["get_semantic_neighbors",   () => executeMcpTool(db, wp, "get_semantic_neighbors", { noteId: "n-meeting" })],
      ["get_idea_flow",            () => executeMcpTool(db, wp, "get_idea_flow", { projectId: "proj-app" })],
    ];

    const rows: string[] = ["tool,size_bytes,approx_tokens"];
    for (const [name, run] of calls) {
      const r = run();
      const s = size(r);
      rows.push(`${name},${s},${Math.round(s / 4)}`);
      console.log(`${name.padEnd(28)} ${String(s).padStart(6)} b  ${Math.round(s / 4).toString().padStart(5)} t`);
    }
    // Also write CSV for documentation
    fs.writeFileSync(
      path.join(wp, "payload-sizes.csv"),
      rows.join("\n"),
    );
    console.log("CSV:\n" + rows.join("\n"));
  });
});

describe("chat-only tool payload baseline", () => {
  let db: Database.Database;
  let wp: string;

  beforeEach(() => {
    db = makeDb();
    wp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-payload-"));
    seed(db);
  });
  afterEach(() => {
    try { db.close(); } catch { /* ignore — already closed */ }
    try { fs.rmSync(wp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("measures chat-only tools", async () => {
    // Mock ChatRequest + LLMConfig. get_active_context doesn't use llmConfig,
    // but TypeScript still requires the parameter positional shape.
    const req: ChatRequest = {
      message: "",
      threadId: "thread-1",
      workspaceId: "ws-main",
      projectId: "proj-app",
    };
    const llmConfig: LLMConfig = { baseUrl: "", model: "", apiKey: "" };
    const size = (r: unknown) => JSON.stringify(r).length;
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["get_active_context", () => executeChatTool(db, req, wp, llmConfig, "get_active_context", {})],
      ["ask_questions",     () => executeChatTool(db, req, wp, llmConfig, "ask_questions", { questions: [{q:"x",options:["a","b"]}] })],
      ["suggest_connections",() => executeChatTool(db, req, wp, llmConfig, "suggest_connections", { actions: [{type:"link_notes",source:"n1",target:"n2"}] })],
    ];

    const rows: string[] = ["tool,size_bytes,approx_tokens"];
    for (const [name, run] of calls) {
      const r = await run();
      const s = size(r);
      rows.push(`${name},${s},${Math.round(s / 4)}`);
      console.log(`${name.padEnd(28)} ${String(s).padStart(6)} b  ${Math.round(s / 4).toString().padStart(5)} t`);
    }
    fs.writeFileSync(
      path.join(wp, "chat-payload-sizes.csv"),
      rows.join("\n"),
    );
    console.log("CSV:\n" + rows.join("\n"));

    // Dump the full get_active_context payload so we can audit the shape
    const arc = await executeChatTool(db, req, wp, llmConfig, "get_active_context", {});
    console.log("--- get_active_context shape ---");
    console.log(JSON.stringify(arc, null, 2));
  });
});
