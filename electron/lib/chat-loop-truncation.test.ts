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

function makeServer(responses: string[]): Promise<{ url: string; close: () => Promise<void>; bodies: Record<string, unknown>[] }> {
  let callIndex = 0;
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>); } catch { bodies.push({}); }
      const body = responses[callIndex] ?? "";
      callIndex++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        bodies,
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

    // 4. The retry request (round 2) is a clean, valid body: the truncated
    //    assistant turn and its refused tool round-trip are NOT replayed, so a
    //    later "continue" can never 400 on duplicate/dangling tool_call_ids.
    const sent = (server.bodies[1].messages ?? []) as Array<Record<string, unknown>>;
    expect(sent.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls))).toBe(false);
    expect(sent.some((m) => m.role === "tool")).toBe(false);
    expect(sent.some((m) => m.role === "user" && String(m.content).includes("NOT executed"))).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("reasoningModel");

    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it("recovers a length-truncated tool call whose args are complete except the closing delimiter", async () => {
    const db = makeDb();
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-chatloop-"));
    // Args are INVALID JSON only because the final `"}` never arrived — the
    // content body is fully emitted, so tail repair must recover and execute.
    const recoveredArgs = '{"projectId":"proj1","title":"Recovered Note","content":"Full body with trailing text here"';
    const server = await makeServer([
      truncatedToolCallSSE(recoveredArgs),
      textOnlySSE(["Done."]),
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

    // The tool EXECUTED (recovered), with the complete content.
    expect(doneEvents[0]?.ok).toBe(true);
    const note = (db.prepare("SELECT title, content FROM notes WHERE title = 'Recovered Note'").get() as
      | { title: string; content: string }
      | undefined);
    expect(note).toBeTruthy();
    expect(note?.content).toBe("Full body with trailing text here");
    expect(result.content).toBe("Done.");

    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it("round-trips streamed reasoning back to the SAME model under its native field", async () => {
    const db = makeDb();
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-chatloop-"));
    // Turn 1: reasoning_content + a tool call (normal tool_calls finish).
    const turn1 = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Let me think carefully." } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "ensure_note", arguments: "" } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ projectId: "proj1", title: "Round Trip", content: "body" }) } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const server = await makeServer([turn1, textOnlySSE(["Done."])]);
    servers.push(server);

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
      undefined,
      undefined,
    );

    expect(result.content).toBe("Done.");

    // Request #2 must carry the reasoning under its native field for the SAME
    // model, and must NOT leak internal metadata.
    const sent = (server.bodies[1].messages ?? []) as Array<Record<string, unknown>>;
    const asst = sent.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls)) as Record<string, unknown> | undefined;
    expect(asst).toBeTruthy();
    expect(asst?.reasoning_content).toBe("Let me think carefully.");
    expect(asst?.reasoningModel).toBeUndefined();
    expect(asst?.reasoning).toBeUndefined();
    expect(asst?.reasoningField).toBeUndefined();

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

  it("refuses a tail-repaired tool call on a NATURAL tool_calls finish (recovery is length-only)", async () => {
    // Args missing only their closing delimiter arrive on a natural finish — the
    // normal execution path must refuse (only the explicit length/interrupted
    // gate may recover tail-repaired args) and let the model re-issue.
    const db = makeDb();
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-chatloop-"));
    const server = await makeServer([
      [
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "ensure_note", arguments: "" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"projectId":"proj1","title":"Tail Note","content":"body"' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      textOnlySSE(["Retry done."]),
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

    // NOT executed: the call was refused with the tail-repaired parse error, and
    // no note was persisted.
    expect(doneEvents[0]?.ok).toBe(false);
    expect(doneEvents[0]?.error).toMatch(/closing delimiter/i);
    const count = (db.prepare("SELECT COUNT(*) c FROM notes").get() as { c: number }).c;
    expect(count).toBe(0);
    expect(result.content).toBe("Retry done.");

    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it("executes multiple tool calls in one turn in parallel and persists all results", async () => {
    const db = makeDb();
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-chatloop-"));
    const server = await makeServer([
      [
        // Two parallel ensure_note calls in a single turn (index 0 and 1).
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "ensure_note", arguments: "" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ projectId: "proj1", title: "Note A" }) } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "ensure_note", arguments: "" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: JSON.stringify({ projectId: "proj1", title: "Note B" }) } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      textOnlySSE(["Both notes created."]),
    ]);
    servers.push(server);

    const emitToolCallEvents: string[] = [];
    const doneEvents: { ok?: boolean; error?: string }[] = [];

    const messages = [
      { role: "system" as const, content: "test" },
      { role: "user" as const, content: "create two notes" },
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
      (e) => doneEvents.push({ ok: e.ok, error: e.error }),
    );

    // Both chips fired (in source order) and both completed successfully.
    expect(emitToolCallEvents).toEqual(["ensure_note", "ensure_note"]);
    expect(doneEvents).toHaveLength(2);
    expect(doneEvents.every((d) => d.ok)).toBe(true);

    // Both parallel calls persisted their notes.
    const titles = (db.prepare("SELECT title FROM notes ORDER BY title").all() as { title: string }[]).map((r) => r.title);
    expect(titles).toEqual(["Note A", "Note B"]);

    expect(result.content).toBe("Both notes created.");

    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
});
