/**
 * The consolidated (model-facing) tools, end to end through the MCP executor on
 * a real schema: each one must reach the right per-operation handlers with the
 * right arguments, and report partial failures instead of hiding them.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../../db/schema";
import { createWorkspace, createProject, createColumn, createNote, createCard, createTag, getNoteById, getCardById } from "../../db/queries";
import { executeTool } from "./index";
import { TOOL_SCHEMAS } from "../../lib/tool-schemas";
import { CONSOLIDATED_TOOLS } from "./consolidated";

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let db: Database.Database;
let wp: string;
const run = async (name: string, args: Record<string, unknown>) => (await executeTool(db, wp, name, args)) as R;

beforeEach(() => {
  wp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-consolidated-"));
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws", name: "WS" });
  createProject(db, { id: "p", workspaceId: "ws", name: "Proj" });
  for (const [id, type, order] of [["c-back", "backlog", 0], ["c-todo", "todo", 1], ["c-prog", "in_progress", 2], ["c-done", "done", 3]] as const) {
    createColumn(db, { id, projectId: "p", workspaceId: "ws", name: id, type, order });
  }
  createTag(db, { id: "t-bug", workspaceId: "ws", name: "bug", color: "#ef4444" });
  createNote(db, { id: "n1", projectId: "p", workspaceId: "ws", title: "Auth design", content: "# Auth\n\nTokens rotate hourly." });
  createNote(db, { id: "n2", projectId: "p", workspaceId: "ws", title: "Roadmap", content: "Q3 plans", folder: "Plans" });
  createCard(db, { id: "k1", columnId: "c-todo", projectId: "p", workspaceId: "ws", title: "Login bug" });
  createCard(db, { id: "k2", columnId: "c-todo", projectId: "p", workspaceId: "ws", title: "Refresh tokens" });
});

afterEach(() => {
  db.close();
  fs.rmSync(wp, { recursive: true, force: true });
});

describe("consolidated toolset", () => {
  it("every advertised tool is either consolidated here or a direct handler", () => {
    const direct = new Set(["upsert_project", "get_idea_flow", "get_user_writing_style", "update_user_writing_style", "codebase_reindex", "ask_questions", "suggest_connections", "spawn_tasks_from_note"]);
    for (const name of Object.keys(TOOL_SCHEMAS)) {
      expect(CONSOLIDATED_TOOLS.has(name) || direct.has(name), name).toBe(true);
    }
  });

  it("get_context: workspace overview without projectId, project pack with folders + templates with it", async () => {
    expect((await run("get_context", {})).projects).toBeDefined();
    const pack = await run("get_context", { projectId: "p" });
    expect(pack.error).toBeUndefined();
    expect(pack.folders).toContain("Plans");
    expect(Array.isArray(pack.templates)).toBe(true);
  });

  it("get_item detects notes vs tasks and errors on unknown ids", async () => {
    expect(await run("get_item", { id: "n1" })).toMatchObject({ type: "note", id: "n1", title: "Auth design" });
    expect(await run("get_item", { id: "k1" })).toMatchObject({ type: "task", id: "k1", title: "Login bug" });
    expect((await run("get_item", { id: "nope" })).error).toMatch(/No note or task/);
  });

  it("search_notes keyword honours folder; search_tasks honours tag and filters", async () => {
    const inPlans = await run("search_notes", { query: "", folder: "plans" }) as unknown as R[];
    expect(inPlans.map((n) => n.id)).toEqual(["n2"]);
    await run("update_tasks", { cardIds: ["k1"], tagNames: ["bug"] });
    const bugs = await run("search_tasks", { query: "", tag: "bug" }) as unknown as R[];
    expect(bugs.map((c) => c.id)).toEqual(["k1"]);
    const ready = await run("search_tasks", { query: "login", filter: "ready" }) as unknown as R[];
    expect(ready.map((c) => c.id)).toEqual(["k1"]);
  });

  it("edit_note replaces with oldString and appends without it", async () => {
    await run("edit_note", { noteId: "n1", oldString: "hourly", newString: "daily" });
    await run("edit_note", { noteId: "n1", newString: "Reviewed." });
    const content = getNoteById(db, "n1")!.content;
    expect(content).toContain("Tokens rotate daily.");
    expect(content.trimEnd().endsWith("Reviewed.")).toBe(true);
  });

  it("update_notes renames one note, moves and tags several, and links cards", async () => {
    expect(await run("update_notes", { noteIds: ["n1"], title: "Auth v2" })).toMatchObject({ id: "n1", title: "Auth v2" });
    expect((await run("update_notes", { noteIds: ["n1", "n2"], title: "x" })).error).toMatch(/single note/);
    const moved = await run("update_notes", { noteIds: ["n1", "n2"], folder: "Research", tagNames: ["bug"], linkCardIds: ["k1"] });
    expect(moved.error).toBeUndefined();
    expect(getNoteById(db, "n1")!.folder).toBe("Research");
    expect(getNoteById(db, "n2")!.tagIds).toContain("t-bug");
    expect(getCardById(db, "k1")!.linkedNoteIds).toEqual(expect.arrayContaining(["n1", "n2"]));
  });

  it("create_task places the card by columnType (default backlog) and links notes", async () => {
    const card = await run("create_task", { projectId: "p", title: "Ship", columnType: "todo", linkNoteIds: ["n1"] });
    expect(getCardById(db, card.id)!.columnId).toBe("c-todo");
    expect(getCardById(db, card.id)!.linkedNoteIds).toEqual(["n1"]);
    const fallback = await run("create_task", { projectId: "p", title: "Later" });
    expect(getCardById(db, fallback.id)!.columnId).toBe("c-back");
  });

  it("update_tasks moves several cards by columnType, blocks, and reports per-card failures", async () => {
    await run("update_tasks", { cardIds: ["k1", "k2"], columnType: "in_progress", priority: "high" });
    expect(getCardById(db, "k1")!.columnId).toBe("c-prog");
    expect(getCardById(db, "k2")!.priority).toBe("high");
    await run("update_tasks", { cardIds: ["k2"], blockedBy: ["k1"] });
    expect(getCardById(db, "k2")!.blockedByIds).toEqual(["k1"]);
    const partial = await run("update_tasks", { cardIds: ["k1", "missing"], assignee: "Alex" });
    expect(partial.error).toMatch(/missing: Task not found/);
    expect(getCardById(db, "k1")!.assignee).toBe("Alex");
  });

  it("task_progress claims then logs", async () => {
    const claimed = await run("task_progress", { cardId: "k1", action: "claim", agent: "Claude Code" });
    expect(claimed.error).toBeUndefined();
    expect(getCardById(db, "k1")!.assignee).toBe("Claude Code");
    expect((await run("task_progress", { cardId: "k1", action: "log" })).error).toMatch(/message is required/);
    await run("task_progress", { cardId: "k1", action: "log", message: "Fixed it", moveTo: "done" });
    expect(getCardById(db, "k1")!.columnId).toBe("c-done");
  });

  it("delete routes by type", async () => {
    expect((await run("delete", { type: "task", id: "k2" })).error).toBeUndefined();
    expect(getCardById(db, "k2")).toBeFalsy();
    expect((await run("delete", { type: "note", id: "n2" })).error).toBeUndefined();
    expect(getNoteById(db, "n2")).toBeFalsy();
  });

  it("edit_idea_flow applies ops in order and resolves refs", async () => {
    const res = await run("edit_idea_flow", {
      projectId: "p",
      ops: [
        { op: "add_node", type: "idea", ref: "a", data: { title: "Cache" } },
        { op: "add_node", type: "idea", ref: "b", data: { title: "LRU" } },
        { op: "add_edge", source: "a", target: "b", label: "uses" },
      ],
    });
    expect(res.error).toBeUndefined();
    expect(Object.keys(res.refs)).toEqual(["a", "b"]);
    const flow = await run("get_idea_flow", { projectId: "p" });
    expect(flow.edges).toHaveLength(1);
  });

  it("edit_idea_flow accepts a node type nested inside data, and defaults to idea", async () => {
    const res = await run("edit_idea_flow", { projectId: "p", ops: [
      { op: "add_node", data: { type: "idea", title: "Nested" } },
      { op: "add_node", data: { title: "Untyped", body: "x" } },
    ] });
    expect(res.error).toBeUndefined();
    const flow = await run("get_idea_flow", { projectId: "p" });
    const types = (flow.nodes as R[]).map((n) => n.type);
    expect(types).toEqual(["idea", "idea"]);
  });

  it("get_graph resolves the workspace itself", async () => {
    expect((await run("get_graph", {})).error).toBeUndefined();
    expect((await run("get_graph", { nodeId: "n1" })).error).toBeUndefined();
  });
});
