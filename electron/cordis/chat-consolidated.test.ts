/**
 * The consolidated tools through the in-app chat executor: chat resolves
 * get_context to the ACTIVE workspace/project (not the MCP workspace overview),
 * keeps its per-note write path, and emits chips that open the touched item.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, createColumn, createNote, createCard, getNoteById, getCardById } from "../db/queries";
import { executeTool } from "../agent/tools/cairn-executor";
import type { ChatRequest } from "../lib/tools";
import type { LLMConfig } from "../lib/llm";

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let db: Database.Database;
let wp: string;
const req: ChatRequest = { message: "", threadId: "t", projectId: "p", workspaceId: "ws" };
const llm: LLMConfig = { baseUrl: "", model: "", apiKey: "" };

beforeEach(() => {
  wp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-chat-consolidated-"));
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws", name: "WS" });
  createProject(db, { id: "p", workspaceId: "ws", name: "Proj" });
  createColumn(db, { id: "c-todo", projectId: "p", workspaceId: "ws", name: "Todo", type: "todo", order: 0 });
  createColumn(db, { id: "c-prog", projectId: "p", workspaceId: "ws", name: "Doing", type: "in_progress", order: 1 });
  createNote(db, { id: "n1", projectId: "p", workspaceId: "ws", title: "Spec", content: "Draft" });
  createCard(db, { id: "k1", columnId: "c-todo", projectId: "p", workspaceId: "ws", title: "Build it" });
});

afterEach(() => {
  db.close();
  fs.rmSync(wp, { recursive: true, force: true });
});

describe("chat executor — consolidated tools", () => {
  it("get_context without projectId is the active context", async () => {
    const ctx = await executeTool(db, req, wp, llm, "get_context", {}) as R;
    expect(ctx.error).toBeUndefined();
    expect(JSON.stringify(ctx)).toContain("c-todo");
  });

  it("writes go through and the chip points at the touched item", async () => {
    const done: R[] = [];
    const emitDone = (e: R) => done.push(e);
    await executeTool(db, req, wp, llm, "edit_note", { noteId: "n1", newString: "More." }, undefined, undefined, emitDone);
    expect(getNoteById(db, "n1")!.content).toContain("More.");
    await executeTool(db, req, wp, llm, "update_tasks", { cardIds: ["k1"], columnType: "in_progress" }, undefined, undefined, emitDone);
    expect(getCardById(db, "k1")!.columnId).toBe("c-prog");
    await executeTool(db, req, wp, llm, "get_item", { id: "k1" }, undefined, undefined, emitDone);
    expect(done.map((e) => e.cairnRef?.type)).toEqual(["note", "task", "task"]);
    // Inner handler calls must not emit chips of their own.
    expect(done.map((e) => e.tool)).toEqual(["edit_note", "update_tasks", "get_item"]);
  });
});
