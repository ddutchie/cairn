/**
 * chat-loop truncation-guard tests
 *
 * A "length" finish_reason means the model hit its output-token limit mid-turn.
 * Streamed tool-call arguments in that message may be truncated — and a cut that
 * lands on a well-formed JSON boundary yields arguments that PARSE cleanly yet
 * are silently missing fields. No parser can detect that, so the loop must refuse
 * to execute any tool call from a truncated turn (mirroring pi's
 * `failToolCallsFromTruncatedMessage`).
 *
 * This spins up a real HTTP server (Node http) emitting OpenAI-compatible SSE and
 * drives `runToolLoop` against it, asserting the tool is NEVER executed and the
 * loop continues to the next round.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject } from "../db/queries";
import { runToolLoop } from "./chat-loop";
import type { ChatRequest } from "./tools";

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws1", name: "Test WS" });
  createProject(db, { id: "proj1", workspaceId: "ws1", name: "Test Proj" });
  return db;
}

const chatReq: ChatRequest = {
  message: "",
  workspaceId: "ws1",
  projectId: "proj1",
  threadId: "test",
};

function makeServer(responses: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  let callIndex = 0;
  const server = http.createServer((_req, res) => {
    const body = responses[callIndex] ?? "";
    callIndex++;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** A tool call whose args are VALID JSON but cut off before the intended fields. */
function truncatedToolCallSSE(args: string): string {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_t", function: { name: "ensure_note", arguments: "" } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return lines.join("");
}

function textOnlySSE(tokens: string[]): string {
  const chunks = tokens.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

describe("runToolLoop — finish_reason length truncation guard", () => {
  const servers: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  it("refuses to execute ANY tool call from a length-truncated turn, then continues to the next round", async () => {
    const db = makeDb();
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-chatloop-"));
    // Args parse as valid JSON — the OLD behaviour would have created this note.
    const truncatedArgs = JSON.stringify({ title: "Truncated" });
    const server = await makeServer([
      truncatedToolCallSSE(truncatedArgs),
      textOnlySSE(["Done."]),
    ]);
    servers.push(server);

    const emitToolCallEvents: string[] = [];
    const emitToolCallDoneEvents: { ok?: boolean; error?: string }[] = [];

    const messages = [
      { role: "system" as const, content: "test" },
      { role: "user" as const, content: "do the thing" },
    ];

    const result = await runToolLoop(
      db,
      chatReq,
      workspacePath,
      server.url,
      "test-model",
      "test-key",
      messages,
      (e) => emitToolCallEvents.push(e.tool),
      undefined,
      undefined,
      "openai",
      undefined,
      (e) => emitToolCallDoneEvents.push({ ok: e.ok, error: e.error }),
    );

    // 1. The chip fired but the tool was marked failed — never executed.
    expect(emitToolCallEvents).toEqual(["ensure_note"]);
    expect(emitToolCallDoneEvents).toHaveLength(1);
    expect(emitToolCallDoneEvents[0].ok).toBe(false);
    expect(emitToolCallDoneEvents[0].error).toMatch(/output-token limit|truncated/i);

    // 2. The valid-but-truncated args were NOT executed: no note was persisted.
    const count = (db.prepare("SELECT COUNT(*) c FROM notes").get() as { c: number }).c;
    expect(count).toBe(0);

    // 3. The loop continued (round 2) and returned the final text reply.
    expect(result.exhausted).toBe(false);
    expect(result.content).toBe("Done.");

    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it("does NOT guard a normal tool_calls finish — the tool executes", async () => {
    const db = makeDb();
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-chatloop-"));
    const server = await makeServer([
      [
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "ensure_note", arguments: "" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ projectId: "proj1", title: "Real Note", content: "body" }) } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      textOnlySSE(["Great."]),
    ]);
    servers.push(server);

    const doneEvents: { ok?: boolean; error?: string }[] = [];
    const messages = [
      { role: "system" as const, content: "test" },
      { role: "user" as const, content: "create a note" },
    ];

    const result = await runToolLoop(
      db,
      chatReq,
      workspacePath,
      server.url,
      "test-model",
      "test-key",
      messages,
      () => {},
      undefined,
      undefined,
      "openai",
      undefined,
      (e) => doneEvents.push({ ok: e.ok, error: e.error }),
    );

    // Tool executed successfully (finish_reason tool_calls, not length).
    expect(doneEvents[0]?.ok).toBe(true);
    const count = (db.prepare("SELECT COUNT(*) c FROM notes").get() as { c: number }).c;
    expect(count).toBe(1);
    expect(result.content).toBe("Great.");

    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
});
