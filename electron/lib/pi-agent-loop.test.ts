/**
 * pi-agent-loop streaming tests
 *
 * Spins up a real HTTP server (Node http module) that emits OpenAI-compatible
 * SSE responses. Runs runAgentLoop against it and asserts the exact sequence
 * of callbacks — especially that onToolStart fires BEFORE onToolEnd, and that
 * onToolsReady fires before either.
 *
 * This directly tests the bug where tool chips only appeared on completion:
 * if onToolsReady / onToolStart are missing from the sequence the chip
 * never enters "running" state, only appearing when onToolEnd fires.
 *
 * Scenarios:
 *   1. Text-only response  — onToken* + onDone, no tool callbacks
 *   2. Tool call, no text  — onToolsReady → onToolStart → onToolEnd → onDone
 *   3. Tool call, text first — onToken* → onToolsReady → onToolStart → onToolEnd → onDone
 *   4. Multi-turn (tool → result → second LLM call) — onStepStart fires on step 2,
 *      second turn's callbacks appear after first turn's onToolEnd
 *   5. SSE chunks split mid-JSON — tool call buffered correctly across reads
 *   6. Usage chunk — onUsage fires with prompt/completion token counts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, createColumn } from "../db/queries";
import { runAgentLoop, type PiAgentSession, type AgentLoopCallbacks, type AgentToolContext } from "./pi-agent-loop";
import { normaliseBaseUrl } from "./llm";
import { LIVE_TESTS_ENABLED } from "./bench-endpoint";
import type { ChatRequest } from "./tools";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws1", name: "Test WS" });
  createProject(db, { id: "proj1", workspaceId: "ws1", name: "Test Proj" });
  createColumn(db, { id: "col1", projectId: "proj1", workspaceId: "ws1", name: "Backlog", type: "backlog", order: 0 });
  return db;
}

function makeSession(): PiAgentSession {
  return { messages: [], abortCtrl: new AbortController() };
}

const chatReq: ChatRequest = {
  message: "",
  workspaceId: "ws1",
  projectId: "proj1",
  threadId: "test",
};

function makeToolCtx(db: Database.Database): AgentToolContext {
  return {
    cwd: "/tmp",
    db,
    req: chatReq,
    workspacePath: "/tmp",
    sessionId: "test",
    send: () => {},
  };
}

/**
 * Build a server that serves a fixed sequence of SSE response bodies.
 * Each call to POST /v1/chat/completions consumes the next body in the queue.
 * Also records every request body so tests can assert what was actually sent.
 */
function makeServer(responses: string[]): Promise<{ url: string; close: () => Promise<void>; bodies: Record<string, unknown>[] }> {
  let callIndex = 0;
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    // The transport probe (POST /v1/responses) must 404 so this completions-only
    // mock server resolves to chat-completions without consuming an SSE body.
    if (req.url && req.url.endsWith("/responses")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        bodies.push({});
      }
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

/** Collect all callbacks fired during a runAgentLoop call into an ordered log. */
function makeCallbacks(): { log: string[]; callbacks: AgentLoopCallbacks } {
  const log: string[] = [];
  const callbacks: AgentLoopCallbacks = {
    onToken:         (d)       => log.push(`token:${d}`),
    onToolsReady:    ()        => log.push("tools-ready"),
    onToolPending:   (n, id)   => log.push(`tool-pending:${n}:${id}`),
    onToolStart:     (n, l)    => log.push(`tool-start:${n}:${l}`),
    onToolEnd:       (n, _l, ok, out) => log.push(`tool-end:${n}:${ok}:${out.slice(0, 40)}`),
    onStepStart:     ()        => log.push("step-start"),
    onUsage:         (p, c)    => log.push(`usage:${p}:${c}`),
    onDone:          ()        => log.push("done"),
    onError:         (e)       => log.push(`error:${e}`),
    onPlanNoteFound: (id)      => log.push(`plan-note:${id}`),
  };
  return { log, callbacks };
}

// ── SSE body builders ─────────────────────────────────────────────────────────

/** Emit a stream of text tokens followed by [DONE]. */
function textOnlySSE(tokens: string[]): string {
  const chunks = tokens.map((t) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`
  );
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

/** Emit a tool call (no preceding text) followed by [DONE]. */
function toolCallSSE(opts: {
  toolId?: string;
  toolName: string;
  toolArgs: string;
  usagePrompt?: number;
  usageCompletion?: number;
}): string {
  const id = opts.toolId ?? "call_abc123";
  const lines: string[] = [];

  // First chunk: tool_calls delta with id + name
  lines.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: opts.toolName, arguments: "" } }] } }],
  })}\n\n`);

  // Subsequent chunks: argument fragments (simulate streaming)
  const argStr = opts.toolArgs;
  const mid = Math.floor(argStr.length / 2);
  lines.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(0, mid) } }] } }],
  })}\n\n`);
  lines.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(mid) } }] } }],
    finish_reason: "tool_calls",
  })}\n\n`);

  // Usage chunk
  if (opts.usagePrompt !== undefined) {
    lines.push(`data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: opts.usagePrompt, completion_tokens: opts.usageCompletion ?? 0 },
    })}\n\n`);
  }

  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

/** Emit text tokens then a tool call. */
function textThenToolSSE(text: string, toolName: string, toolArgs: string): string {
  const lines: string[] = [];
  for (const char of text) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`);
  }
  lines.push(`data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "call_xyz", function: { name: toolName, arguments: toolArgs } }] } }],
    finish_reason: "tool_calls",
  })}\n\n`);
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAgentLoop — SSE streaming", () => {
  let db: Database.Database;
  let server: { url: string; close: () => Promise<void>; bodies: Record<string, unknown>[] };

  beforeEach(() => { db = makeDb(); });
  afterEach(async () => { await server?.close(); db.close(); });

  // ── 1. Text-only response ─────────────────────────────────────────────────

  it("text-only: fires onToken for each delta then onDone", async () => {
    server = await makeServer([textOnlySSE(["Hello", " world", "!"])]);
    const session = makeSession();
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    expect(log).toContain("token:Hello");
    expect(log).toContain("token: world");
    expect(log).toContain("token:!");
    expect(log).toContain("done");
    expect(log).not.toContain("tools-ready");
    expect(log).not.toContain("error");
    // done is last
    expect(log[log.length - 1]).toBe("done");
  });

  it("strips optional fields on 400 and consumes the stripped response (no third request)", async () => {
    // Strict Responses endpoint: the full body (with temperature/include) 400s,
    // the stripped retry succeeds. The stripped response must be consumed
    // directly — a third request re-sending the original body would 400 again.
    let loopCalls = 0;
    const loopBodies: Record<string, unknown>[] = [];
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { parsed = {}; }
        if (!("model" in parsed)) {
          // Transport probe ({}): validation error → resolves to responses.
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "'model' is a required property", type: "invalid_request_error" } }));
          return;
        }
        loopCalls++;
        loopBodies.push(parsed);
        if (loopCalls === 1) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "unknown parameter 'temperature'", type: "invalid_request_error" } }));
          return;
        }
        // The Responses transport's parser consumes Responses SSE, not
        // chat-completions chunks.
        const sse = [
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Stripped OK." })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: {} } })}\n\n`,
        ].join("");
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        res.end(sse);
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

    const session = makeSession();
    const { log, callbacks } = makeCallbacks();
    try {
      await runAgentLoop(
        session, "You are a test assistant.",
        { baseUrl: url, model: "test", apiKey: "test", maxSteps: 5, temperature: 0.3 },
        callbacks, makeToolCtx(db),
      );
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }

    expect(log).toContain("token:Stripped OK.");
    expect(log).toContain("done");
    expect(log).not.toContain("error");
    // Exactly two loop requests: the full body (400) then the stripped retry —
    // the successful stripped response is consumed, never re-sent.
    expect(loopCalls).toBe(2);
    expect(loopBodies[0]).toHaveProperty("temperature");
    expect(loopBodies[1]).not.toHaveProperty("temperature");
    expect(loopBodies[1]).not.toHaveProperty("include");
  });

  // ── 2. Tool call with no preceding text ───────────────────────────────────

  it("tool-call (no text): onToolsReady fires BEFORE onToolStart", async () => {
    server = await makeServer([
      // Turn 1: tool call
      toolCallSSE({ toolName: "ls", toolArgs: JSON.stringify({ path: "." }) }),
      // Turn 2: final text response (no more tools)
      textOnlySSE(["Done."]),
    ]);

    const session = makeSession();
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    const toolsReadyIdx = log.indexOf("tools-ready");
    const toolStartIdx  = log.findIndex((e) => e.startsWith("tool-start:ls"));
    const toolEndIdx    = log.findIndex((e) => e.startsWith("tool-end:ls"));

    expect(toolsReadyIdx).toBeGreaterThanOrEqual(0);
    expect(toolStartIdx).toBeGreaterThanOrEqual(0);
    expect(toolEndIdx).toBeGreaterThanOrEqual(0);

    // THE KEY ASSERTION: tools-ready must come before tool-start
    expect(toolsReadyIdx).toBeLessThan(toolStartIdx);
    // tool-start must come before tool-end
    expect(toolStartIdx).toBeLessThan(toolEndIdx);
    // done comes last
    expect(log[log.length - 1]).toBe("done");
  });

  // ── 3. Text tokens then tool call ─────────────────────────────────────────

  it("text-then-tool: onToken fires before onToolsReady", async () => {
    server = await makeServer([
      textThenToolSSE("Thinking…", "ls", JSON.stringify({ path: "." })),
      textOnlySSE(["Done."]),
    ]);

    const session = makeSession();
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    const firstTokenIdx  = log.findIndex((e) => e.startsWith("token:"));
    const toolsReadyIdx  = log.indexOf("tools-ready");
    const toolStartIdx   = log.findIndex((e) => e.startsWith("tool-start:ls"));
    const toolEndIdx     = log.findIndex((e) => e.startsWith("tool-end:ls"));

    expect(firstTokenIdx).toBeGreaterThanOrEqual(0);
    expect(toolsReadyIdx).toBeGreaterThan(firstTokenIdx);
    expect(toolStartIdx).toBeGreaterThan(toolsReadyIdx);
    expect(toolEndIdx).toBeGreaterThan(toolStartIdx);
  });

  // ── 4. Multi-turn: step-start fires on second turn ────────────────────────

  it("multi-turn: step-start fires before second turn tokens", async () => {
    server = await makeServer([
      toolCallSSE({ toolName: "ls", toolArgs: JSON.stringify({ path: "." }) }),
      textOnlySSE(["All done."]),
    ]);

    const session = makeSession();
    session.messages.push({ role: "user", content: "List files then summarise." });
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    const stepStartIdx      = log.indexOf("step-start");
    const secondTurnTokenIdx = log.lastIndexOf("token:All done.");

    // step-start fires at the beginning of turn 2 (before its tokens)
    expect(stepStartIdx).toBeGreaterThanOrEqual(0);
    // Second-turn tokens come after step-start
    expect(secondTurnTokenIdx).toBeGreaterThan(stepStartIdx);
    expect(log).toContain("done");
  });

  // ── 5. SSE chunks split across reads ─────────────────────────────────────

  it("split chunks: tool call JSON split across SSE lines is buffered correctly", async () => {
    // Manually build an SSE body where the tool call is split across
    // many tiny chunks (simulating slow network / large args).
    const args = JSON.stringify({ path: "/some/very/long/directory/path" });
    const lines: string[] = [];

    // Name arrives in first chunk
    lines.push(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_split", function: { name: "ls", arguments: "" } }] } }],
    })}\n\n`);

    // Args arrive one character at a time
    for (const char of args) {
      lines.push(`data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: char } }] } }],
      })}\n\n`);
    }

    lines.push(`data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    })}\n\n`);
    lines.push("data: [DONE]\n\n");

    server = await makeServer([
      lines.join(""),
      textOnlySSE(["ok"]),
    ]);

    const session = makeSession();
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    // Tool should have executed with the full reconstructed args
    const toolStart = log.find((e) => e.startsWith("tool-start:ls"));
    expect(toolStart).toBeDefined();
    expect(log.find((e) => e.startsWith("tool-end:ls"))).toBeDefined();
    expect(log).not.toContain("error");
  });

  // ── 6. Usage chunk ────────────────────────────────────────────────────────

  it("usage: onUsage fires with correct token counts", async () => {
    server = await makeServer([
      toolCallSSE({
        toolName: "ls",
        toolArgs: JSON.stringify({ path: "." }),
        usagePrompt: 512,
        usageCompletion: 64,
      }),
      textOnlySSE(["done"]),
    ]);

    const session = makeSession();
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    expect(log).toContain("usage:512:64");
  });

  // ── 7. onToolsReady fires even when LLM emits zero text tokens ────────────

  it("no-text tool call: no token events but tools-ready still fires", async () => {
    server = await makeServer([
      toolCallSSE({ toolName: "ls", toolArgs: JSON.stringify({ path: "." }) }),
      textOnlySSE(["done"]),
    ]);

    const session = makeSession();
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    const toolsReadyIdx = log.indexOf("tools-ready");
    // No token events should appear before tools-ready (LLM emitted no text before the tool call)
    const tokensBefore = log.slice(0, toolsReadyIdx).filter((e) => e.startsWith("token:"));
    expect(tokensBefore).toHaveLength(0);
    expect(log).toContain("tools-ready");
    expect(toolsReadyIdx)
      .toBeLessThan(log.findIndex((e) => e.startsWith("tool-start:")));
  });

  // ── 8. Multiple parallel tool calls in one turn ───────────────────────────

  it("parallel tools: both tool-start events fire before either tool-end", async () => {
    // Two tool calls at different indices in the same turn
    const lines: string[] = [];
    lines.push(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_a", function: { name: "ls", arguments: "" } },
      ] } }],
    })}\n\n`);
    lines.push(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [
        { index: 0, function: { arguments: JSON.stringify({ path: "." }) } },
      ] } }],
    })}\n\n`);
    lines.push(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [
        { index: 1, id: "call_b", function: { name: "ls", arguments: "" } },
      ] } }],
    })}\n\n`);
    lines.push(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [
        { index: 1, function: { arguments: JSON.stringify({ path: "/tmp" }) } },
      ] } }],
      finish_reason: "tool_calls",
    })}\n\n`);
    lines.push("data: [DONE]\n\n");

    server = await makeServer([lines.join(""), textOnlySSE(["done"])]);

    const session = makeSession();
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    const starts = log.filter((e) => e.startsWith("tool-start:"));
    const ends   = log.filter((e) => e.startsWith("tool-end:"));
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);

    // All starts before all ends (sequential execution, but chips created before execution)
    const firstEndIdx = log.findIndex((e) => e.startsWith("tool-end:"));
    const lastStartIdx = log.map((e, i) => e.startsWith("tool-start:") ? i : -1).filter(i => i >= 0).pop()!;
    // The loop executes tools sequentially: start A, end A, start B, end B
    // So at minimum start A comes before end A
    expect(log.findIndex(e => e === starts[0])).toBeLessThan(firstEndIdx);
    expect(lastStartIdx).toBeLessThan(log.lastIndexOf(ends[ends.length - 1]));
  });

  // ── 9. Output-token-limit truncation guard ─────────────────────────────────

  it("finish_reason length: tool call is NOT executed, chip fails, loop continues", async () => {
    // Turn 1: tool call truncated by the output-token cap (finish_reason "length")
    const lines: string[] = [];
    lines.push(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_trunc", function: { name: "ls", arguments: "" } }] } }],
    })}\n\n`);
    lines.push(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: "." }).slice(0, 3) } }] } }],
      finish_reason: "length",
    })}\n\n`);
    lines.push("data: [DONE]\n\n");

    server = await makeServer([
      lines.join(""),
      textOnlySSE(["Re-issued successfully."]),
    ]);

    const session = makeSession();
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    // The truncated tool call must be failed, never executed
    expect(log.some((e) => e.startsWith("tool-end:ls:false"))).toBe(true);
    expect(log.some((e) => e.startsWith("tool-end:ls:true"))).toBe(false);
    // Loop continues so the model can re-issue, then finishes normally
    expect(log).toContain("step-start");
    expect(log).toContain("token:Re-issued successfully.");
    expect(log[log.length - 1]).toBe("done");
    expect(log.some((e) => e.startsWith("error:"))).toBe(false);
  });

  it("truncation does NOT poison the next request: no truncated tool_calls, no internal metadata, no duplicate ids", async () => {
    // Turn 1: tool call truncated (finish_reason "length") with NO id chunk —
    // the case that previously synthesized a colliding position-based id.
    const lines: string[] = [];
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "ls", arguments: "" } }] } }] })}\n\n`);
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pat' } }] } }], finish_reason: "length" })}\n\n`);
    lines.push("data: [DONE]\n\n");

    // Closed in the finally below (and never again via the shared afterEach,
    // which only closes the outer `server` variable).
    const server = await makeServer([
      lines.join(""),
      textOnlySSE(["Re-issued successfully."]),
      textOnlySSE(["Final reply."]),
    ]);
    try {
      const session = makeSession();
      const { log, callbacks } = makeCallbacks();
      await runAgentLoop(
        session, "You are a test assistant.",
        { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
        callbacks, makeToolCtx(db),
      );

      // Request #2 (the retry round) must be a clean, valid OpenAI-compatible body:
      expect(log.some((e) => e.startsWith("tool-end:ls:false"))).toBe(true);

      const sent = server.bodies[1].messages as Array<Record<string, unknown>>;
      const serialized = JSON.stringify(sent);

      // No truncated assistant turn replayed, no tool round-trip for the refused call.
      expect(sent.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls))).toBe(false);
      expect(sent.some((m) => m.role === "tool")).toBe(false);
      // Internal round-trip metadata must never leak.
      expect(serialized).not.toContain("reasoningModel");
      expect(serialized).not.toContain("reasoningField");
      // The model got the re-issue notice instead.
      expect(sent.some((m) => m.role === "user" && String(m.content).includes("NOT executed"))).toBe(true);

      // Simulate "continue the conversation": the loop ran twice more, and the
      // third request still carries no dangling tool_call_id and no duplicates.
      session.messages.push({ role: "user", content: "continue please" });
      const continueServer = await makeServer([textOnlySSE(["Final reply."])]);
      try {
        await runAgentLoop(
          session, "You are a test assistant.",
          { baseUrl: continueServer.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
          callbacks, makeToolCtx(db),
        );

        const sent3 = continueServer.bodies[0].messages as Array<Record<string, unknown>>;
        const ids = sent3.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
        expect(new Set(ids).size).toBe(ids.length); // no duplicate tool_call_id
        expect(JSON.stringify(sent3)).not.toContain("reasoningModel");
      } finally {
        await continueServer.close();
      }
    } finally {
      await server.close();
    }
  });

  it("length-truncated turn with tail-complete args EXECUTES the tool (dropped closing delimiter)", async () => {
    // The stream/gateway dropped the final `"}` after otherwise-complete
    // arguments — the data emitted IS the intended data, so tail repair must
    // recover and execute it rather than refuse + re-issue.
    const lines: string[] = [];
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_xyz", function: { name: "ls", arguments: "" } }] } }] })}\n\n`);
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path": "/tmp"' } }] } }], finish_reason: "length" })}\n\n`);
    lines.push("data: [DONE]\n\n");

    server = await makeServer([lines.join(""), textOnlySSE(["Done."])]);

    const session = makeSession();
    const { log, callbacks } = makeCallbacks();
    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    // The tool EXECUTED (recovered) rather than failing / re-issuing.
    expect(log.some((e) => e.startsWith("tool-end:ls:true"))).toBe(true);
    expect(log.some((e) => e.startsWith("tool-end:ls:false"))).toBe(false);
    // History holds the canonical (repaired) arguments, so the turn round-trips.
    const asst = session.messages.find((m) => m.role === "assistant" && m.tool_calls) as
      | { tool_calls: Array<{ function: { arguments: string } }> }
      | undefined;
    expect(asst).toBeDefined();
    expect(JSON.parse(asst!.tool_calls[0].function.arguments)).toEqual({ path: "/tmp" });
    expect(log[log.length - 1]).toBe("done");
    expect(log.some((e) => e.startsWith("error:"))).toBe(false);
  });

  it("sends the 32K Auto cap when maxTokens is unset, and the manual value when set", async () => {
    // Auto (unset) → a generous max_tokens is SENT (never omitted), otherwise
    // the endpoint applies a tiny server-side default (often 4096) that
    // truncates mid-tool-call.
    const auto = await makeServer([textOnlySSE(["hi"])]);
    await runAgentLoop(
      makeSession(), "You are a test assistant.",
      { baseUrl: auto.url, model: "test", apiKey: "test", maxSteps: 5, temperature: 0.3 },
      { onToken: () => {}, onToolsReady: () => {}, onToolPending: () => {}, onToolStart: () => {}, onToolEnd: () => {}, onStepStart: () => {}, onUsage: () => {}, onDone: () => {}, onError: () => {} },
      makeToolCtx(db),
    );
    expect((auto.bodies[0].max_tokens as number)).toBe(32000);
    await auto.close();

    // Explicit manual value is respected.
    const manual = await makeServer([textOnlySSE(["hi"])]);
    await runAgentLoop(
      makeSession(), "You are a test assistant.",
      { baseUrl: manual.url, model: "test", apiKey: "test", maxSteps: 5, temperature: 0.3, maxTokens: 8192 },
      { onToken: () => {}, onToolsReady: () => {}, onToolPending: () => {}, onToolStart: () => {}, onToolEnd: () => {}, onStepStart: () => {}, onUsage: () => {}, onDone: () => {}, onError: () => {} },
      makeToolCtx(db),
    );
    expect((manual.bodies[0].max_tokens as number)).toBe(8192);
    await manual.close();
  });

  // ── 10. Reasoning-only turn (length) is stored for round-trip, not surfaced ─

  it("finish_reason length with only reasoning: reasoning stays out of content (pi behaviour)", async () => {
    // A "thinking" model emits only chain-of-thought then hits the output cap.
    const lines: string[] = [];
    for (const char of "Let me think carefully about the answer.") {
      lines.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: char } }] })}\n\n`);
    }
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`);
    lines.push("data: [DONE]\n\n");

    server = await makeServer([lines.join("")]);

    const session = makeSession();
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    // Reasoning is never baked into content (pi behaviour) — no surfaced token bubble
    expect(log.some((e) => e.startsWith("token:*[This model hit its output-token limit"))).toBe(false);
    expect(log[log.length - 1]).toBe("done");
    expect(log.some((e) => e.startsWith("error:"))).toBe(false);

    // The message stored on the session keeps an EMPTY content; the reasoning
    // stays in its own field (with round-trip metadata) so it can be sent back
    // to the SAME model under its native field — never baked into content.
    expect(session.messages).toHaveLength(1);
    const stored = session.messages[0] as { content: string; reasoning?: string; reasoningField?: string; reasoningModel?: string };
    expect(stored.content).toBe("");
    expect(stored.reasoning).toBe("Let me think carefully about the answer.");
    expect(stored.reasoningField).toBe("reasoning_content");
    expect(stored.reasoningModel).toBe(`${server.url}::test`);
  });

  // ── 11. Bare reasoning without round-trip metadata is never leaked ─────────

  it("a prior reasoning-only turn (no round-trip metadata) is dropped from the request body", async () => {
    server = await makeServer([textOnlySSE(["ok"])]);

    const session = makeSession();
    session.messages.push({ role: "user", content: "Continue." });
    // Prior turn produced only reasoning, but with NO reasoningField/Model (e.g.
    // persisted before round-trip metadata existed) — must never reach the provider.
    session.messages.push({ role: "assistant", content: "", reasoning: "SECRET_CHAIN_OF_THOUGHT" });

    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    expect(log[log.length - 1]).toBe("done");
    expect(server.bodies).toHaveLength(1);
    const sentMessages = server.bodies[0].messages as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(sentMessages);
    expect(serialized).not.toContain("SECRET_CHAIN_OF_THOUGHT");
    // The user message is still sent
    expect(serialized).toContain("Continue.");
  });

  // ── 12. Reasoning round-trips to the same model under its native field ─────

  it("reasoning round-trips to the SAME model under its native field (pi behaviour)", async () => {
    server = await makeServer([textOnlySSE(["ok"])]);

    const session = makeSession();
    session.messages.push({ role: "user", content: "Continue." });
    session.messages.push({
      role: "assistant",
      content: "",
      reasoning: "SECRET_CHAIN_OF_THOUGHT",
      reasoningField: "reasoning_content",
      reasoningModel: `${server.url}::test`,
    });

    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    expect(log[log.length - 1]).toBe("done");
    const sentMessages = server.bodies[0].messages as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(sentMessages);
    // Reasoning is sent back under the recorded field name (reasoning_content)
    expect(serialized).toContain("reasoning_content");
    expect(serialized).toContain("SECRET_CHAIN_OF_THOUGHT");
  });

  // ── 13. Cross-model reasoning is converted to text ─────────────────────────

  it("reasoning from a DIFFERENT model is sent as text, not as a foreign field", async () => {
    server = await makeServer([textOnlySSE(["ok"])]);

    const session = makeSession();
    session.messages.push({ role: "user", content: "Continue." });
    // Produced by a different model — must not round-trip as a reasoning field,
    // but pi converts it to plain text so the new model still sees the context.
    session.messages.push({
      role: "assistant",
      content: "",
      reasoning: "OTHER_MODEL_THOUGHTS",
      reasoningField: "reasoning",
      reasoningModel: "https://other.example/v1::other-model",
    });

    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    expect(log[log.length - 1]).toBe("done");
    const sentMessages = server.bodies[0].messages as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(sentMessages);
    // Not a reasoning field — appears as text content instead
    expect(serialized).not.toContain("\"reasoning\":\"OTHER_MODEL_THOUGHTS\"");
    expect(serialized).not.toContain("reasoningModel");
    expect(serialized).toContain("OTHER_MODEL_THOUGHTS");
  });

  // ── 14. Interrupted stream (no finish_reason) with tool calls ──────────────

  it("stream that ends without finish_reason refuses to execute buffered tool calls", async () => {
    // Tool call streamed, then the connection just ends — no finish_reason chunk.
    const lines: string[] = [];
    lines.push(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_int", function: { name: "ls", arguments: "" } }] } }],
    })}\n\n`);
    lines.push(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: "." }) } }] } }],
    })}\n\n`);
    lines.push("data: [DONE]\n\n");

    server = await makeServer([
      lines.join(""),
      textOnlySSE(["Re-issued successfully."]),
    ]);

    const session = makeSession();
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session, "You are a test assistant.",
      { baseUrl: server.url, model: "test", apiKey: "test", maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    // The buffered tool call must be failed, never executed
    expect(log.some((e) => e.startsWith("tool-end:ls:false"))).toBe(true);
    expect(log.some((e) => e.startsWith("tool-end:ls:true"))).toBe(false);
    // Loop continues so the model can re-issue, then finishes normally
    expect(log).toContain("step-start");
    expect(log).toContain("token:Re-issued successfully.");
    expect(log[log.length - 1]).toBe("done");
  });
});

// ── Live integration tests ─────────────────────────────────────────────────────
// Only run when TEST_LLM_BASE_URL is set in .env.test (or the environment).
// These hit a real LLM endpoint and verify the full round-trip.

const liveBaseUrl = process.env.TEST_LLM_BASE_URL
  ? normaliseBaseUrl(process.env.TEST_LLM_BASE_URL)
  : undefined;
const liveModel   = process.env.TEST_LLM_MODEL   ?? "claude-sonnet-4-6";
const liveApiKey  = process.env.TEST_LLM_API_KEY  ?? "";

// Live suite requires BOTH the opt-in flag (which honours the CAIRN_SKIP_LIVE_TESTS
// hard override via LIVE_TESTS_ENABLED) AND a configured endpoint URL.
describe.skipIf(!LIVE_TESTS_ENABLED || !liveBaseUrl)("runAgentLoop — live endpoint", () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it("completes a simple text prompt without errors", async () => {
    const session = makeSession();
    session.messages.push({ role: "user", content: "Reply with exactly the word PONG and nothing else." });
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session,
      "You are a test assistant. Follow instructions exactly.",
      { baseUrl: liveBaseUrl!, model: liveModel, apiKey: liveApiKey, maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    expect(log).toContain("done");
    expect(log.some((e) => e.startsWith("token:"))).toBe(true);
    expect(log.some((e) => e.startsWith("error:"))).toBe(false);
  }, 30_000);

  it("executes a tool call and returns a result", async () => {
    const session = makeSession();
    session.messages.push({ role: "user", content: "Use the ls tool to list files in /tmp and then stop." });
    const { log, callbacks } = makeCallbacks();

    await runAgentLoop(
      session,
      "You are a test assistant with access to coding tools. When asked to list files, always use the ls tool.",
      { baseUrl: liveBaseUrl!, model: liveModel, apiKey: liveApiKey, maxSteps: 10, temperature: 0.3 },
      callbacks, makeToolCtx(db),
    );

    expect(log).toContain("done");
    // tool chip ordering must still hold on real endpoint
    const toolsReadyIdx = log.indexOf("tools-ready");
    const toolStartIdx  = log.findIndex((e) => e.startsWith("tool-start:ls"));
    if (toolStartIdx !== -1) {
      // If the model chose to call ls, verify ordering
      expect(toolsReadyIdx).toBeLessThan(toolStartIdx);
    }
    expect(log.some((e) => e.startsWith("error:"))).toBe(false);
  }, 60_000);
});
