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
import * as z from "zod";
import { TOOL_SCHEMAS, CHAT_ONLY_TOOLS } from "./lib/tool-schemas";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  MCP_NATIVE_BINDING,
  findDbPath,
  findWorkspacePath,
  ensureMcpActiveWritesTable,
  ensureEmbeddingsTable,
  toWorkspace,
  toProject,
  getSnapshot
} from "./mcp/db";
import { executeTool } from "./mcp/tools";

export { executeTool };
export { getSnapshot };

export const MCP_PORT = 3123;

/**
 * A workspace binding that re-resolves itself.
 *
 * The app can swap its workspace folder in place (`reinitialise()` in main.ts —
 * onboarding, or Settings → change folder) without relaunching anything. A
 * long-lived MCP process that resolved its db path once at startup would then
 * read and write the *abandoned* workspace forever — including writing .md files
 * into the old note tree — with a restart as the only cure.
 *
 * So we re-check the resolved path (throttled) on every tool call and reopen the
 * connection when it changes. The check is a couple of stats plus a small JSON
 * read, i.e. free next to any actual tool invocation.
 */
function createWorkspaceBinding(initialDbPath: string) {
  const RECHECK_MS = 1000;

  function open(p: string): Database.Database {
    const conn = new Database(p, ...(MCP_NATIVE_BINDING ? [{ nativeBinding: MCP_NATIVE_BINDING }] : []));
    // PRAGMAs are per-connection; applySchema is never called in the MCP process
    // (the app owns migrations), so these must be re-applied on every reopen.
    conn.pragma("foreign_keys = ON");
    conn.pragma("journal_mode = WAL");
    ensureMcpActiveWritesTable(conn);
    ensureEmbeddingsTable(conn);
    return conn;
  }

  /**
   * The MCP process deliberately never runs migrations — the app owns the schema.
   * That means an un-migrated or brand-new DB file yields cryptic "no such table"
   * errors from every tool. Say so once, clearly, on stderr instead.
   */
  function warnIfUnmigrated(conn: Database.Database, p: string): void {
    try {
      const row = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'")
        .get();
      if (!row) {
        process.stderr.write(
          `[cairn:mcp] WARNING: ${p} has no Cairn schema yet. The MCP server does not ` +
            `run migrations — open the Cairn app once against this workspace to create it.\n`,
        );
      }
    } catch { /* diagnostics only */ }
  }

  let dbPath = initialDbPath;
  let workspacePath = findWorkspacePath(dbPath);
  let db = open(dbPath);
  let lastCheck = Date.now();
  warnIfUnmigrated(db, dbPath);

  function refresh(): void {
    if (Date.now() - lastCheck < RECHECK_MS) return;
    lastCheck = Date.now();

    const nextDbPath = findDbPath();
    // Nothing resolvable right now (config mid-write, folder unmounted) — keep
    // the current connection rather than tearing down a working one.
    if (!nextDbPath) return;

    const nextWorkspacePath = findWorkspacePath(nextDbPath);
    if (nextDbPath === dbPath && nextWorkspacePath === workspacePath) return;

    try {
      const next = open(nextDbPath);
      const previous = db;
      db = next;
      dbPath = nextDbPath;
      workspacePath = nextWorkspacePath;
      try { previous.close(); } catch { /* already gone */ }
      process.stderr.write(`[cairn:mcp] Workspace changed — now using ${dbPath} (folder: ${workspacePath})\n`);
      warnIfUnmigrated(db, dbPath);
    } catch (err) {
      // Failed to open the new target; stay on the old one so tools keep working.
      process.stderr.write(`[cairn:mcp] Failed to switch to ${nextDbPath}: ${err}\n`);
    }
  }

  return {
    getDb(): Database.Database { refresh(); return db; },
    getWorkspacePath(): string { refresh(); return workspacePath; },
    /** Currently bound db file — surfaced for diagnostics. */
    currentDbPath(): string { return dbPath; },
  };
}

type WorkspaceBinding = ReturnType<typeof createWorkspaceBinding>;

function buildMcpServer(binding: WorkspaceBinding): McpServer {
  const server = new McpServer({ name: "cairn", version: "1.0.0" });

  // Register tools from TOOL_SCHEMAS, excluding chat-only tools
  const chatOnlySet = new Set<string>(CHAT_ONLY_TOOLS);
  for (const [name, { description, schema }] of Object.entries(TOOL_SCHEMAS)) {
    if (chatOnlySet.has(name)) continue;
    server.tool(name, description, schema.shape as Record<string, z.ZodTypeAny>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: Record<string, any>) => {
        const result = await executeTool(binding.getDb(), binding.getWorkspacePath(), name, args);
        const hasError = typeof result === "object" && result !== null && !Array.isArray(result) && "error" in result;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          ...(hasError ? { isError: true } : {})
        };
      }
    );
  }

  server.resource("workspaces", "cairn://workspaces", { mimeType: "application/json" }, async () => ({
    contents: [{
      uri: "cairn://workspaces", mimeType: "application/json",
      text: JSON.stringify(binding.getDb().prepare("SELECT * FROM workspaces").all().map(toWorkspace))
    }],
  }));
  server.resource("projects", "cairn://projects", { mimeType: "application/json" }, async () => ({
    contents: [{
      uri: "cairn://projects", mimeType: "application/json",
      text: JSON.stringify(binding.getDb().prepare("SELECT * FROM projects WHERE archived_at IS NULL").all().map(toProject))
    }],
  }));

  return server;
}

// ── HTTP server ───────────────────────────────

/**
 * HTTP/streamable transport variant. Currently unused — the shipped path is
 * stdio (see the standalone entry point below) — but kept as the alternative
 * transport. Takes the same live workspace binding as the stdio path so it can
 * never drift from the app's current workspace.
 */
export function startMcpServer(binding: WorkspaceBinding): http.Server {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (req.url === "/health") {
      const snap = getSnapshot(binding.getDb());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true, source: "sqlite", dbPath: binding.currentDbPath(),
        counts: {
          workspaces: snap.workspaces.length, projects: snap.projects.length,
          notes: snap.notes.length, cards: snap.cards.length
        }
      }));
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

      const mcpServer = buildMcpServer(binding);
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
    process.stderr.write(
      "[cairn:mcp] No Cairn database found. Open the Cairn app once to choose a " +
        "workspace folder, or set CAIRN_DB_PATH to a workspace folder / cairn.db.\n",
    );
    process.exit(1);
  }
  process.stderr.write(`[cairn:mcp] Using database: ${dbPath}\n`);
  const binding = createWorkspaceBinding(dbPath);
  process.stderr.write(`[cairn:mcp] Workspace folder: ${binding.getWorkspacePath()}\n`);
  const server = buildMcpServer(binding);
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    process.stderr.write(`[cairn:mcp] Fatal: ${err}\n`);
    process.exit(1);
  });

  // Clean up any spawned runtime process on shutdown
  const cleanup = () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { disposeSpawnedRuntime } = require("./runtime/port-discovery");
      disposeSpawnedRuntime();
    } catch { /* ignore */ }
  };
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
}
