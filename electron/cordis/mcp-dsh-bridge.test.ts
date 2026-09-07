/**
 * mcp-dsh-bridge parity tests — the merge bar for the dsh-mcp-client spike.
 *
 * Strategy: TWO identical in-process Streamable HTTP fixture servers (one per
 * path, so client-capability observations can't cross-talk), each serving a
 * representative tool set over the real SDK wire:
 *   - echo_text / add_numbers (text + structuredContent results)
 *   - boom (isError result)
 *   - probe_sampling / probe_elicitation / probe_roots (the server attempts a
 *     server-initiated sampling / elicitation / roots request and reports the
 *     outcome as TEXT, so both paths' observable behavior is comparable)
 *   - probe_caps (reports the connected client's advertised capabilities)
 *
 * Against these fixtures the tests prove:
 *   (a) every tool the hand bridge exposes is exposed via the dsh path with
 *       the same name, description, and parameters;
 *   (b) risk class + approval gating are identical for a tool matrix
 *       (read vs exec vs external), and every dsh-registered name stays inside
 *       the `mcp__` prefix the EXTERNAL classifier matches;
 *   (c) sampling/elicitation/roots behave identically on both paths (neither
 *       side implements handlers — both clients advertise no such
 *       capabilities, and server-initiated requests fail with identical
 *       observable text instead of hanging or crashing).
 *
 * Plus: eligibility gating (SSE / OAuth / secret-headers / bad ids stay on the
 * hand bridge) and fail-closed behavior (parity mismatch disposes the dsh
 * mount and leaves the hand bridge serving).
 *
 * If ANY gated parity assertion fails, Item 1 STOPS (no forced merge) — the
 * failure output names the exact diverging case.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { Context } from "@deepseek-ai/cordis";
import toolsPlugin from "@deepseek-ai/dsh-tools";
import systemPromptPlugin from "@deepseek-ai/dsh-system-prompt";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, saveMcpServer, setToolAttachment } from "../db/queries";
import { callTool, dispose as disposeMcpConn } from "../lib/mcp-client";
import { riskForTool } from "../../shared/agent/tool-risk";
import { shouldAskForTool } from "../../shared/agent/approval-mode";
import { createHostStore } from "./host-store";
import {
  DSH_MCP_SPIKE_ENV,
  diffToolNameSets,
  maybeMountDshMcpSpike,
  toDshMcpConfig,
} from "./mcp-dsh-bridge";

// ── Fixture MCP server ────────────────────────────────────────────────────────

interface Fixture {
  id: string;
  url: string;
  close: () => Promise<void>;
  /** Capabilities the connected client advertised (recorded post-initialize). */
  clientCaps: () => unknown;
}

const textResult = (text: string): Record<string, unknown> => ({
  content: [{ type: "text", text }],
});

function toolDefs(extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  return [
    {
      name: "echo_text",
      description: "Echo back the input text.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    {
      name: "add_numbers",
      description: "Add two numbers.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
    {
      name: "boom",
      description: "Always fails with an error result.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "probe_sampling",
      description: "Attempts a server-initiated sampling request; reports the outcome.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "probe_elicitation",
      description: "Attempts a server-initiated elicitation request; reports the outcome.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "probe_roots",
      description: "Attempts a server-initiated roots request; reports the outcome.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "probe_caps",
      description: "Reports the connected client's advertised capabilities as JSON.",
      inputSchema: { type: "object", properties: {} },
    },
    ...extra,
  ];
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: Server;
  capsBox: { caps: unknown };
  /** Session id assigned by the transport on initialize (captured via our generator). */
  sidBox: { sid?: string };
}

/** One low-level Server + transport pair (a Server handles a single client lifecycle). */
function createSessionPair(tools: Array<Record<string, unknown>>, capsBox: { caps: unknown }, sidBox: { sid?: string }): SessionEntry {
  const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools as never }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name as string;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    switch (name) {
      case "echo_text":
        return textResult(`echo:${String(args.text ?? "")}`);
      case "add_numbers": {
        const sum = Number(args.a ?? 0) + Number(args.b ?? 0);
        return { content: [{ type: "text", text: `sum:${sum}` }], structuredContent: { sum } };
      }
      case "boom":
        return { content: [{ type: "text", text: "kaboom" }], isError: true };
      case "probe_sampling":
        try {
          await (server as unknown as {
            createMessage: (p: unknown) => Promise<unknown>;
          }).createMessage({
            messages: [{ role: "user", content: { type: "text", text: "ping" } }],
            maxTokens: 5,
          });
          return textResult("sampling:supported");
        } catch (e) {
          return textResult(`sampling:unsupported:${errText(e)}`);
        }
      case "probe_elicitation":
        try {
          await (server as unknown as {
            elicitInput: (p: unknown) => Promise<unknown>;
          }).elicitInput({ message: "pick?", requestedSchema: { type: "object", properties: {} } });
          return textResult("elicitation:supported");
        } catch (e) {
          return textResult(`elicitation:unsupported:${errText(e)}`);
        }
      case "probe_roots":
        try {
          const roots = await (server as unknown as { listRoots: () => Promise<unknown> }).listRoots();
          return textResult(`roots:supported:${JSON.stringify(roots)}`);
        } catch (e) {
          return textResult(`roots:unsupported:${errText(e)}`);
        }
      case "probe_caps":
        return textResult(`caps:${JSON.stringify(capsBox.caps)}`);
      default: {
        const exotic = tools.find((t) => t.name === name);
        if (exotic) return textResult(`exotic-ok:${String(name)}`);
        return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
      }
    }
  });
  // Stateful sessions: stateless Streamable HTTP rejects the SDK client's
  // `notifications/initialized` POST, while real servers (and both of our
  // clients) are stateful-capable. The generator records the assigned id into
  // sidBox (the transport does NOT go through res.setHeader for it).
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      const sid = randomUUID();
      sidBox.sid = sid;
      return sid;
    },
  });
  return { transport, server, capsBox, sidBox };
}

async function startFixture(id: string, extraTools: Array<Record<string, unknown>> = []): Promise<Fixture> {
  const tools = toolDefs(extraTools);
  // Session routing: a second `initialize` on one low-level Server fails with
  // "Server already initialized", so every handshake without a known
  // `mcp-session-id` gets a FRESH pair with identical tool definitions. Both
  // parity paths (and repeated tests) each get their own session.
  const sessions = new Map<string, SessionEntry>();
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      void (async () => {
        try {
          const sid = req.headers["mcp-session-id"];
          let entry = typeof sid === "string" ? sessions.get(sid) : undefined;
          if (!entry) {
            const capsBox: { caps: unknown } = { caps: null };
            const sidBox: { sid?: string } = {};
            const fresh = createSessionPair(tools, capsBox, sidBox);
            await fresh.server.connect(fresh.transport);
            entry = fresh;
          }
          const parsed = body ? (JSON.parse(body) as unknown) : undefined;
          await entry.transport.handleRequest(req, res, parsed);
          // The id generator runs while the initialize is handled — after it
          // settles, the fresh pair's id is known and routable.
          if (entry.sidBox.sid) sessions.set(entry.sidBox.sid, entry);
          try {
            entry.capsBox.caps = (entry.server as unknown as { getClientCapabilities: () => unknown }).getClientCapabilities() ?? null;
          } catch { /* pre-initialize — keep null */ }
        } catch {
          if (!res.headersSent) {
            res.writeHead(500).end("fixture error");
          }
        }
      })();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    id,
    url: `http://127.0.0.1:${port}/mcp`,
    clientCaps: () => null, // per-session caps are observed via the probe_caps tool
    close: async () => {
      for (const entry of sessions.values()) {
        try { await entry.transport.close(); } catch { /* noop */ }
        try { await entry.server.close(); } catch { /* noop */ }
      }
      sessions.clear();
      // Long-lived SSE GET streams would otherwise hold http.close() open.
      try { httpServer.closeAllConnections(); } catch { /* noop */ }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

// ── DB seeding ────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db: Database.Database = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function seedServer(db: Database.Database, id: string, url: string, transport: "sse" | "http" = "http"): void {
  // Idempotent workspace/project rows: tests seeding two servers share them.
  try {
    createWorkspace(db, { id: "ws-1", name: "WS" });
  } catch { /* already seeded */ }
  try {
    createProject(db, { id: "proj-1", workspaceId: "ws-1", name: "Proj" });
  } catch { /* already seeded */ }
  saveMcpServer(db, {
    id, workspaceId: "ws-1", name: `Fixture ${id}`, transport, baseUrl: url,
    enabled: true, source: "test",
  });
  setToolAttachment(db, { projectId: "proj-1", toolType: "mcp", toolId: id, enabled: true });
}

async function makeCtx(): Promise<Context> {
  const ctx = new Context();
  // tools injects systemPrompt (mount order mirrors cordis-context ENTRY_LIST).
  await ctx.plugin(systemPromptPlugin, { persona: "", includeHarnessIdentity: false });
  await ctx.plugin(toolsPlugin, { mode: "native" });
  return ctx;
}

function dshSchemas(ctx: Context, prefix: string): Array<{ name: string; description: string; parameters: unknown }> {
  const tools = ctx.tools as unknown as {
    schemas?: () => Array<{ name?: string; description?: string; parameters?: unknown }>;
  };
  return (tools.schemas?.() ?? [])
    .filter((s) => typeof s.name === "string" && s.name.startsWith(prefix))
    .map((s) => ({ name: s.name as string, description: s.description ?? "", parameters: s.parameters }));
}

function fakeExec(name: string, args: unknown): never {
  return {
    callId: `test-${name}`,
    rootCallId: `test-${name}`,
    token: Symbol("test"),
    name,
    arguments: args,
    signal: AbortSignal.timeout(15000),
    deferContext: () => {},
    concludeTurn: () => {},
  } as never;
}

function renderText(def: { output: { render: (a: unknown, v: unknown) => Array<{ type?: string; text?: string }> } }, args: unknown, value: unknown): string {
  return def.output.render(args, value).map((b) => (b.type === "text" ? (b.text ?? "") : JSON.stringify(b))).join("\n");
}

interface DshToolHandle {
  execute: (a: unknown, e: never) => Promise<unknown>;
  output: { render: (a: unknown, v: unknown) => Array<{ type?: string; text?: string }> };
}

function mustGet(
  tools: { get?: (name: string) => DshToolHandle | undefined },
  name: string,
): DshToolHandle {
  const def = tools.get?.(name);
  expect(def, `dsh path missing tool ${name}`).toBeTruthy();
  return def!;
}

// Two fixture instances (one per path) + per-test DB/ctx.
let fixA: Fixture;
let fixB: Fixture;

beforeAll(async () => {
  const longName = `tool_${"x".repeat(65)}`; // valid chars, qualified name > 64 chars → dsh truncates+hashes
  fixA = await startFixture("pathA");
  fixB = await startFixture("pathB", [
    { name: longName, description: "Over-long name.", inputSchema: { type: "object", properties: {} } },
    { name: "tool.name", description: "Dotted name.", inputSchema: { type: "object", properties: {} } },
  ]);
}, 30000);

afterAll(async () => {
  await fixA.close();
  await fixB.close();
  await disposeMcpConn("spikeA");
  await disposeMcpConn("spikeB");
  await disposeMcpConn("spikeExotic");
});

// ── Eligibility gating (pure) ─────────────────────────────────────────────────

describe("toDshMcpConfig eligibility", () => {
  it("accepts a plain streamable-HTTP server", () => {
    const r = toDshMcpConfig({ id: "spikeA", baseUrl: fixA.url, transport: "http", headers: {}, authMode: "none" });
    expect(r.eligible).toBe(true);
  });
  it("declines SSE (hand bridge owns the SSE transport)", () => {
    const r = toDshMcpConfig({ id: "spikeSse", baseUrl: fixA.url, transport: "sse" });
    expect(r.eligible).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/sse/i);
  });
  it("declines OAuth (hand bridge owns the provider + keychain refresh)", () => {
    const r = toDshMcpConfig({ id: "spikeO", baseUrl: fixA.url, transport: "http", authMode: "oauth" });
    expect(r.eligible).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/oauth/i);
  });
  it("declines secret:// headers (they resolve only in the hand bridge)", () => {
    const r = toDshMcpConfig({
      id: "spikeH", baseUrl: fixA.url, transport: "http", headers: { Authorization: "Bearer secret://tok" },
    });
    expect(r.eligible).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/secret/i);
  });
  it("declines ids outside dsh's serverName grammar (renaming would break name parity)", () => {
    const r = toDshMcpConfig({ id: "way-too-long-server-id-00000000000000000000", baseUrl: fixA.url, transport: "http" });
    expect(r.eligible).toBe(false);
  });
  it("declines invalid base URLs", () => {
    const r = toDshMcpConfig({ id: "spikeU", baseUrl: "not-a-url", transport: "http" });
    expect(r.eligible).toBe(false);
  });
});

describe("diffToolNameSets", () => {
  it("reports missing + extra sorted", () => {
    expect(diffToolNameSets(["a", "b"], ["b", "c"])).toEqual({ missing: ["a"], extra: ["c"] });
    expect(diffToolNameSets(["a"], ["a"])).toEqual({ missing: [], extra: [] });
  });
});

// ── (a) tool name + schema parity over the live wire ──────────────────────────

describe("parity (a): names + schemas over the live wire", () => {
  it("exposes the same names/descriptions/parameters via both paths", async () => {
    const db = openDb();
    try {
      seedServer(db, "spikeA", fixA.url);
      const host = createHostStore(db);
      const cairnDefs = await host.getExternalToolDefs("ws-1", "proj-1") as Array<{
        function: { name: string; description: string; parameters: Record<string, unknown> };
      }>;
      expect(cairnDefs.length).toBeGreaterThan(0);

      const ctx = await makeCtx();
      const mount = await maybeMountDshMcpSpike(ctx, host, "ws-1", "proj-1", { serverId: "spikeA" });
      try {
        expect(mount.excludedServerIds).toEqual(new Set(["spikeA"]));
        const prefix = "mcp__spikeA__";
        const got = dshSchemas(ctx, prefix);
        const wantNames = cairnDefs.filter((d) => d.function.name.startsWith(prefix)).map((d) => d.function.name).sort();
        expect(got.map((s) => s.name).sort()).toEqual(wantNames);
        for (const def of cairnDefs.filter((d) => d.function.name.startsWith(prefix))) {
          const match = got.find((s) => s.name === def.function.name);
          expect(match, `dsh path missing ${def.function.name}`).toBeTruthy();
          expect(match!.description).toBe(def.function.description ?? "");
          expect(match!.parameters).toEqual(def.function.parameters ?? {});
        }
      } finally {
        for (const dispose of mount.disposers) await dispose();
      }
      // Disposal unregisters the dsh tools again (turn-scoped mount hygiene).
      expect(dshSchemas(ctx, "mcp__spikeA__")).toEqual([]);
    } finally {
      db.close();
    }
  }, 30000);

  it("model-visible execution text matches for text / structured / error results", async () => {
    const db = openDb();
    try {
      seedServer(db, "spikeA", fixA.url);
      const host = createHostStore(db);
      const ctx = await makeCtx();
      const mount = await maybeMountDshMcpSpike(ctx, host, "ws-1", "proj-1", { serverId: "spikeA" });
      try {
        expect(mount.excludedServerIds.has("spikeA")).toBe(true);
        const tools = ctx.tools as unknown as {
          get?: (name: string) => DshToolHandle | undefined;
        };
        const cfg = { id: "spikeA", baseUrl: fixA.url, transport: "http" as const};

        // Text result.
        const cairnEcho = await callTool(cfg, "mcp__spikeA__echo_text", { text: "hello" });
        const dshEchoDef = mustGet(tools, "mcp__spikeA__echo_text");
        const dshEchoValue = await dshEchoDef.execute({ text: "hello" }, fakeExec("echo", { text: "hello" }));
        expect(renderText(dshEchoDef, { text: "hello" }, dshEchoValue)).toBe(cairnEcho);
        expect(cairnEcho).toBe("echo:hello");

        // Structured result renders to the same model text.
        const cairnAdd = await callTool(cfg, "mcp__spikeA__add_numbers", { a: 2, b: 3 });
        const dshAddDef = mustGet(tools, "mcp__spikeA__add_numbers");
        const dshAddValue = await dshAddDef.execute({ a: 2, b: 3 }, fakeExec("add", { a: 2, b: 3 }));
        expect(renderText(dshAddDef, { a: 2, b: 3 }, dshAddValue)).toBe(cairnAdd);
        expect(cairnAdd).toBe("sum:5");

        // Error contract (DOCUMENTED envelope divergence, same text): the hand
        // bridge returns "Error: …" strings; the dsh executor throws so the
        // ToolRuntime can mark the result isError. The model-visible TEXT must
        // still match modulo the prefix.
        const cairnBoom = await callTool(cfg, "mcp__spikeA__boom", {});
        const dshBoomDef = mustGet(tools, "mcp__spikeA__boom");
        const thrown = await dshBoomDef.execute({}, fakeExec("boom", {})).then(
          () => { throw new Error("dsh boom should have thrown"); },
          (e: unknown) => e as Error,
        );
        expect(cairnBoom).toBe(`Error: ${thrown.message}`);
      } finally {
        for (const dispose of mount.disposers) await dispose();
      }
    } finally {
      db.close();
    }
  }, 30000);
});

// ── (b) risk + approval parity matrix ─────────────────────────────────────────

describe("parity (b): risk class + approval gating matrix", () => {
  const externalNames = [
    "mcp__spikeA__echo_text",
    "mcp__spikeA__add_numbers",
    "mcp__spikeA__boom",
    "svc__weather__get_forecast",
  ];
  it("every dsh-path name stays EXTERNAL (always-ask, even in auto mode)", () => {
    for (const name of externalNames) {
      expect(name).toMatch(/^(?:mcp|svc)__/); // the classifier's prefix contract
      expect(riskForTool(name)).toBe("EXTERNAL");
      expect(shouldAskForTool(name, "auto")).toBe(true);
      expect(shouldAskForTool(name, "interactive")).toBe(true);
    }
  });
  it("read vs exec controls behave identically regardless of bridge (same names → same gates)", () => {
    const cases: Array<{ name: string; args?: Record<string, unknown>; risk: string; auto: boolean; interactive: boolean }> = [
      { name: "get_note", risk: "READ", auto: false, interactive: false },
      { name: "search_notes", risk: "READ", auto: false, interactive: false },
      { name: "codebase_search_symbols", risk: "READ", auto: false, interactive: false },
      { name: "write", risk: "WRITE_LOCAL", auto: false, interactive: true },
      { name: "ensure_note", risk: "WRITE_LOCAL", auto: false, interactive: true },
      { name: "bash", risk: "EXEC", auto: false, interactive: true },
      { name: "subagent", risk: "EXEC", auto: false, interactive: true },
      // Multiplexed tool: read-only invocation never asks.
      { name: "str_replace_editor", args: { command: "view" }, risk: "WRITE_LOCAL", auto: false, interactive: false },
      { name: "str_replace_editor", args: { command: "str_replace" }, risk: "WRITE_LOCAL", auto: false, interactive: true },
    ];
    for (const c of cases) {
      expect(riskForTool(c.name), `risk ${c.name}`).toBe(c.risk);
      expect(shouldAskForTool(c.name, "auto", c.args ?? {}), `auto ${c.name}`).toBe(c.auto);
      expect(shouldAskForTool(c.name, "interactive", c.args ?? {}), `interactive ${c.name}`).toBe(c.interactive);
    }
  });
  it("live dsh-registered names satisfy the bridge invariant (all EXTERNAL, all always-ask)", async () => {
    const db = openDb();
    try {
      seedServer(db, "spikeA", fixA.url);
      const host = createHostStore(db);
      const ctx = await makeCtx();
      const mount = await maybeMountDshMcpSpike(ctx, host, "ws-1", "proj-1", { serverId: "spikeA" });
      try {
        for (const s of dshSchemas(ctx, "mcp__spikeA__")) {
          expect(riskForTool(s.name)).toBe("EXTERNAL");
          expect(shouldAskForTool(s.name, "auto")).toBe(true);
        }
      } finally {
        for (const dispose of mount.disposers) await dispose();
      }
    } finally {
      db.close();
    }
  }, 30000);
});

// ── (c) sampling / elicitation / roots parity ─────────────────────────────────

describe("parity (c): sampling / elicitation / roots", () => {
  it("both paths surface identical observable behavior (no handlers either side — no hang, no crash)", async () => {
    const db = openDb();
    try {
      seedServer(db, "spikeA", fixA.url);
      seedServer(db, "spikeB", fixB.url);
      const host = createHostStore(db);
      const ctx = await makeCtx();
      // pathB goes through the HAND bridge here (fixB serves the same probes);
      // pathA goes through the DSH bridge. Both connections are live at once.
      const mount = await maybeMountDshMcpSpike(ctx, host, "ws-1", "proj-1", { serverId: "spikeA" });
      try {
        expect(mount.excludedServerIds.has("spikeA")).toBe(true);
        const tools = ctx.tools as unknown as {
          get?: (name: string) => DshToolHandle | undefined;
        };
        const cfgB = { id: "spikeB", baseUrl: fixB.url, transport: "http" as const };
        for (const probe of ["probe_sampling", "probe_elicitation", "probe_roots"] as const) {
          const cairnText = await callTool(cfgB, `mcp__spikeB__${probe}`, {});
          const dshDef = mustGet(tools, `mcp__spikeA__${probe}`);
          const value = await dshDef.execute({}, fakeExec(probe, {}));
          const dshText = renderText(dshDef, {}, value);
          // Same verdict on both paths (unsupported), same failure shape —
          // the exact SDK wording is asserted EQUAL, not pinned, so an SDK
          // bump that rewords errors can't silently fake a pass.
          expect(cairnText).toMatch(/unsupported/);
          expect(dshText).toBe(cairnText);
        }
        // Neither client advertises sampling / elicitation / roots.
        const cairnCapsText = await callTool(cfgB, "mcp__spikeB__probe_caps", {});
        const dshCapsDef = mustGet(tools, "mcp__spikeA__probe_caps");
        const dshCapsValue = await dshCapsDef.execute({}, fakeExec("caps", {}));
        const dshCapsText = renderText(dshCapsDef, {}, dshCapsValue);
        expect(dshCapsText).toBe(cairnCapsText);
        for (const capsText of [cairnCapsText, dshCapsText]) {
          const caps = JSON.parse(capsText.replace(/^caps:/, "")) as Record<string, unknown> | null;
          expect(caps ?? {}).not.toHaveProperty("sampling");
          expect(caps ?? {}).not.toHaveProperty("elicitation");
          expect(caps ?? {}).not.toHaveProperty("roots");
        }
      } finally {
        for (const dispose of mount.disposers) await dispose();
      }
    } finally {
      db.close();
    }
  }, 60000);
});

// ── Fail-closed behavior ──────────────────────────────────────────────────────

describe("fail-closed: spike never regresses the hand bridge", () => {
  it("env unset → empty mount, hand bridge untouched", async () => {
    const db = openDb();
    try {
      seedServer(db, "spikeA", fixA.url);
      const host = createHostStore(db);
      const ctx = await makeCtx();
      delete process.env[DSH_MCP_SPIKE_ENV];
      const mount = await maybeMountDshMcpSpike(ctx, host, "ws-1", "proj-1");
      expect(mount.disposers).toEqual([]);
      expect(mount.excludedServerIds.size).toBe(0);
      expect(dshSchemas(ctx, "mcp__")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("dshPath-flagged server mounts with no env var (dev toggle gate)", async () => {
    const db = openDb();
    try {
      seedServer(db, "spikeA", fixA.url);
      saveMcpServer(db, {
        id: "spikeA", workspaceId: "ws-1", name: "Fixture spikeA", transport: "http",
        baseUrl: fixA.url, enabled: true, source: "test", dshPath: true,
      });
      const host = createHostStore(db);
      const ctx = await makeCtx();
      delete process.env[DSH_MCP_SPIKE_ENV];
      const mount = await maybeMountDshMcpSpike(ctx, host, "ws-1", "proj-1");
      try {
        expect(mount.excludedServerIds).toEqual(new Set(["spikeA"]));
        expect(dshSchemas(ctx, "mcp__spikeA__").length).toBeGreaterThan(0);
      } finally {
        for (const dispose of mount.disposers) await dispose();
      }
    } finally {
      db.close();
    }
  }, 30000);

  it("unknown server → empty mount", async () => {
    const db = openDb();
    try {
      seedServer(db, "spikeA", fixA.url);
      const host = createHostStore(db);
      const ctx = await makeCtx();
      const logs: string[] = [];
      const mount = await maybeMountDshMcpSpike(ctx, host, "ws-1", "proj-1", { serverId: "nope", log: (m) => logs.push(m) });
      expect(mount.excludedServerIds.size).toBe(0);
      expect(logs.join("\n")).toMatch(/not found/);
    } finally {
      db.close();
    }
  });

  it("exotic tool names (dsh normalizes+hashes, hand bridge verbatim) → parity mismatch → dispose + hand bridge keeps serving", async () => {
    const db = openDb();
    try {
      seedServer(db, "spikeExotic", fixB.url);
      const host = createHostStore(db);
      // The hand bridge serves the exotic tools verbatim (pre-existing behavior).
      const cairnDefs = await host.getExternalToolDefs("ws-1", "proj-1") as Array<{ function: { name: string } }>;
      const exoticNames = cairnDefs.map((d) => d.function.name).filter((n) => n.startsWith("mcp__spikeExotic__"));
      expect(exoticNames.length).toBeGreaterThan(7); // 7 clean + 2 exotic

      const ctx = await makeCtx();
      const logs: string[] = [];
      const mount = await maybeMountDshMcpSpike(ctx, host, "ws-1", "proj-1", { serverId: "spikeExotic", log: (m) => logs.push(m) });
      expect(mount.excludedServerIds.size).toBe(0);
      expect(mount.disposers).toEqual([]);
      expect(logs.join("\n")).toMatch(/parity FAILED/);
      // Nothing from this server lingers on ctx.tools.
      expect(dshSchemas(ctx, "mcp__spikeExotic__")).toEqual([]);
      // And the hand bridge still offers every exotic tool (no regression).
      const after = await host.getExternalToolDefs("ws-1", "proj-1") as Array<{ function: { name: string } }>;
      expect(after.map((d) => d.function.name).filter((n) => n.startsWith("mcp__spikeExotic__")).sort()).toEqual(exoticNames.sort());
    } finally {
      db.close();
    }
  }, 30000);
});
