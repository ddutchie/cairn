/**
 * Cairn — MCP server (standalone Node.js script)
 *
 * Runs as a plain Node HTTP server on port 3123.
 * No Electron dependency — uses better-sqlite3 built for system Node.
 * Reads/writes the same SQLite DB that the Electron app uses.
 *
 * Started by: npm run mcp
 * External agents connect to: http://localhost:3123
 */

import http from "http";
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import { TOOL_SCHEMAS, CHAT_ONLY_TOOLS } from "./lib/tool-schemas";

import {
  MCP_NATIVE_BINDING,
  findDbPath,
  findWorkspacePath,
  ensureMcpActiveWritesTable,
  toWorkspace,
  toProject
} from "./mcp/db";
export { getSnapshot } from "./mcp/db";

export { executeTool } from "./mcp/tools";

export const MCP_PORT = 3123;

function buildMcpServer(db: Database.Database, workspacePath: string): McpServer {
  const server = new McpServer({ name: "cairn", version: "1.0.0" });

  // Register tools from TOOL_SCHEMAS, excluding chat-only tools
  const chatOnlySet = new Set<string>(CHAT_ONLY_TOOLS);
  for (const [name, { description, schema }] of Object.entries(TOOL_SCHEMAS)) {
    if (chatOnlySet.has(name)) continue;
    server.tool(name, description, schema.shape as Record<string, z.ZodTypeAny>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: Record<string, any>) => {
        const result = executeTool(db, workspacePath, name, args);
        const hasError = typeof result === "object" && result !== null && !Array.isArray(result) && "error" in result;
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }],
          ...(hasError ? { isError: true } : {}) };
      }
    );
  }

  server.resource("workspaces", "cairn://workspaces", { mimeType: "application/json" }, async () => ({
    contents: [{ uri: "cairn://workspaces", mimeType: "application/json",
      text: JSON.stringify(db.prepare("SELECT * FROM workspaces").all().map(toWorkspace)) }],
  }));
  server.resource("projects", "cairn://projects", { mimeType: "application/json" }, async () => ({
    contents: [{ uri: "cairn://projects", mimeType: "application/json",
      text: JSON.stringify(db.prepare("SELECT * FROM projects WHERE archived_at IS NULL").all().map(toProject)) }],
  }));

  return server;
}

// ── HTTP server ───────────────────────────────

export function startMcpServer(db: Database.Database, workspacePath: string): http.Server {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (req.url === "/health") {
      const snap = getSnapshot(db);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, source: "sqlite",
        counts: { workspaces: snap.workspaces.length, projects: snap.projects.length,
          notes: snap.notes.length, cards: snap.cards.length } }));
      return;
    }

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      const webReq = new Request(`http://localhost:${MCP_PORT}${req.url}`, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v ?? ""])
        ),
        body: body.length > 0 ? body : undefined,
      });

      const mcpServer = buildMcpServer(db, workspacePath);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      const webRes = await transport.handleRequest(webReq);

      res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
      res.end(Buffer.from(await webRes.arrayBuffer()));
    } catch (err) {
      console.error("[cairn:mcp]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal MCP server error" }));
    }
  });

  server.listen(MCP_PORT, "127.0.0.1", () => {
    process.stderr.write(`[cairn:mcp] Listening on http://localhost:${MCP_PORT}\n`);
  });

  return server;
}

// ── Standalone entry point ────────────────────
// Invoked by OpenCode via: node dist-mcp/mcp-server.js
// Uses stdio transport so OpenCode can communicate via stdin/stdout.

if (require.main === module) {
  const dbPath = findDbPath();
  if (!dbPath) {
    process.stderr.write("[cairn:mcp] No Cairn database found. Open the Cairn app first.\n");
    process.exit(1);
  }
  process.stderr.write(`[cairn:mcp] Using database: ${dbPath}\n`);
  const db = new Database(dbPath, ...(MCP_NATIVE_BINDING ? [{ nativeBinding: MCP_NATIVE_BINDING }] : []));
  // PRAGMA foreign_keys must be set per-connection; applySchema is not called in the MCP process.
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  ensureMcpActiveWritesTable(db);
  const workspacePath = findWorkspacePath(dbPath);
  process.stderr.write(`[cairn:mcp] Workspace folder: ${workspacePath}\n`);
  const server = buildMcpServer(db, workspacePath);
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    process.stderr.write(`[cairn:mcp] Fatal: ${err}\n`);
    process.exit(1);
  });
}
