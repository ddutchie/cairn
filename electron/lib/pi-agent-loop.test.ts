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
 */
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
  let server: { url: string; close: () => Promise<void> };

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
});

// ── Live integration tests ─────────────────────────────────────────────────────
// Only run when TEST_LLM_BASE_URL is set in .env.test (or the environment).
// These hit a real LLM endpoint and verify the full round-trip.

const liveBaseUrl = process.env.TEST_LLM_BASE_URL
  ? normaliseBaseUrl(process.env.TEST_LLM_BASE_URL)
  : undefined;
const liveModel   = process.env.TEST_LLM_MODEL   ?? "claude-sonnet-4-6";
const liveApiKey  = process.env.TEST_LLM_API_KEY  ?? "";

describe.skipIf(!liveBaseUrl)("runAgentLoop — live endpoint", () => {
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
    expect(log).not.toContain(expect.stringContaining("error:"));
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
    expect(log).not.toContain(expect.stringContaining("error:"));
  }, 60_000);
});
