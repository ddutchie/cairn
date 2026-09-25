/**
 * MCP server instructions + resources on Cairn's hand bridge
 * (registerExternalCairnTools → dsh-mcp-resources + a system prompt section),
 * against a live Streamable HTTP MCP server on localhost.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { Context } from "@deepseek-ai/cordis";
import toolsPlugin from "@deepseek-ai/dsh-tools";
import systemPromptPlugin from "@deepseek-ai/dsh-system-prompt";
import McpResourceRuntime from "@deepseek-ai/dsh-mcp-resources";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, saveMcpServer, setToolAttachment } from "../db/queries";
import { disposeAll } from "../lib/mcp-client";
import { riskForTool, needsApproval } from "../../shared/agent/tool-risk";
import { registerExternalCairnTools } from "./cairn-tools";

const INSTRUCTIONS = "Always cite the doc id. {{notAVariable}}";

interface Fixture { url: string; close: () => Promise<void> }

/** One stateful server session per client handshake (see mcp-dsh-bridge.test.ts). */
async function startFixture(opts: { resources: boolean; instructions?: string }): Promise<Fixture> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  const fresh = () => {
    const server = new Server(
      { name: "fixture", version: "1.0.0" },
      { capabilities: { tools: {}, ...(opts.resources ? { resources: {} } : {}) }, ...(opts.instructions ? { instructions: opts.instructions } : {}) },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] }));
    if (opts.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [{ uri: "doc://one", name: "One" }] }));
      server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [{ uriTemplate: "doc://{id}", name: "Doc" }] }));
      server.setRequestHandler(ReadResourceRequestSchema, (req) => ({ contents: [{ uri: req.params.uri, mimeType: "text/plain", text: `body of ${req.params.uri}` }] }));
    }
    const box: { sid?: string } = {};
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => (box.sid = randomUUID()) });
    return { server, transport, box };
  };
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      void (async () => {
        const sid = req.headers["mcp-session-id"];
        let entry = typeof sid === "string" ? sessions.get(sid) : undefined;
        let created: ReturnType<typeof fresh> | undefined;
        if (!entry) {
          created = fresh();
          await created.server.connect(created.transport);
          entry = created;
        }
        await entry.transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
        if (created?.box.sid) sessions.set(created.box.sid, created);
      })().catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      for (const e of sessions.values()) { await e.transport.close().catch(() => {}); await e.server.close().catch(() => {}); }
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

let withResources: Fixture;
let toolsOnly: Fixture;
beforeAll(async () => {
  withResources = await startFixture({ resources: true, instructions: INSTRUCTIONS });
  toolsOnly = await startFixture({ resources: false });
});
afterAll(async () => {
  await disposeAll();
  await withResources.close();
  await toolsOnly.close();
});
afterEach(async () => { await disposeAll(); });

function seed(servers: Array<{ id: string; url: string }>): Database.Database {
  const db: Database.Database = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws-1", name: "WS" });
  createProject(db, { id: "proj-1", workspaceId: "ws-1", name: "Proj" });
  for (const s of servers) {
    saveMcpServer(db, { id: s.id, workspaceId: "ws-1", name: `Docs ${s.id}`, transport: "http", baseUrl: s.url, enabled: true, source: "test" });
    setToolAttachment(db, { projectId: "proj-1", toolType: "mcp", toolId: s.id, enabled: true });
  }
  return db;
}

async function makeCtx(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(systemPromptPlugin, { personaPrefix: "", includeHarnessIdentity: false });
  await ctx.plugin(toolsPlugin, { mode: "native" });
  await ctx.plugin(McpResourceRuntime);
  return ctx;
}

type ToolLike = { execute(args: unknown, exec: unknown): Promise<unknown>; output: { render(args: unknown, value: unknown): Array<{ text?: string }> } };
const tools = (ctx: Context) => ctx.tools as unknown as { get(name: string): ToolLike | undefined };
const exec = () => ({ callId: "c", rootCallId: "c", token: Symbol("t"), name: "t", arguments: {}, signal: AbortSignal.timeout(15_000) }) as never;

async function sectionNames(ctx: Context): Promise<string[]> {
  const assembly = await (ctx.systemPrompt as unknown as { assemble(c: object): Promise<{ sections?: Array<{ name: string; text?: string }> }> }).assemble({});
  return (assembly.sections ?? []).map((s) => s.name);
}

describe("MCP resources + instructions on the hand bridge", () => {
  it("exposes resource tools and server instructions while the turn is live, then removes them", async () => {
    const ctx = await makeCtx();
    const db = seed([{ id: "docs", url: withResources.url }, { id: "plain", url: toolsOnly.url }]);
    const disposers = await registerExternalCairnTools(ctx, { db, workspaceId: "ws-1", projectId: "proj-1" });

    const read = tools(ctx).get("read_mcp_resource");
    expect(read).toBeDefined();
    expect(tools(ctx).get("list_mcp_resources")).toBeDefined();
    const listed = await tools(ctx).get("list_mcp_resources")!.execute({ server: "docs" }, exec());
    expect(JSON.stringify(listed)).toContain("doc://one");
    const value = await read!.execute({ server: "docs", uri: "doc://two" }, exec());
    expect(read!.output.render({ server: "docs" }, value).map((b) => b.text).join("")).toContain("body of doc://two");
    // A server without the resources capability is not registered.
    await expect(read!.execute({ server: "plain", uri: "doc://x" }, exec())).rejects.toThrow(/unavailable/);

    expect(await sectionNames(ctx)).toContain("mcp-server:docs");
    expect(await sectionNames(ctx)).not.toContain("mcp-server:plain");
    const assembly = await (ctx.systemPrompt as unknown as { assemble(c: object): Promise<{ sections: Array<{ name: string; text: string }> }> }).assemble({});
    const docs = assembly.sections.find((s) => s.name === "mcp-server:docs")!;
    // Server text is literal: the {{…}} placeholder is not interpolated.
    expect(docs.text).toContain(INSTRUCTIONS);

    disposers.forEach((d) => d());
    await new Promise((r) => setTimeout(r, 0));
    expect(tools(ctx).get("read_mcp_resource")).toBeUndefined();
    expect(await sectionNames(ctx)).not.toContain("mcp-server:docs");
  });

  it("skips servers served by the dsh-mcp-client spike", async () => {
    const ctx = await makeCtx();
    const db = seed([{ id: "docs", url: withResources.url }]);
    const disposers = await registerExternalCairnTools(ctx, { db, workspaceId: "ws-1", projectId: "proj-1" }, { excludeServerIds: new Set(["docs"]) });
    expect(tools(ctx).get("read_mcp_resource")).toBeUndefined();
    expect(await sectionNames(ctx)).not.toContain("mcp-server:docs");
    disposers.forEach((d) => d());
  });

  it("classifies the resource tools as external (always gated)", () => {
    for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
      expect(riskForTool(name)).toBe("EXTERNAL");
      expect(needsApproval(name)).toBe(true);
    }
  });
});
