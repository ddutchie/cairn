/**
 * Outbound MCP client — connects Cairn to *remote* MCP servers (SSE +
 * streamable-HTTP only; no stdio/process spawning) and exposes their tools to
 * the chat and agent loops.
 *
 * Responsibilities:
 *   - Lazily connect to a configured server on first use, caching one Client per
 *     server id for the lifetime of a run. Idle connections are disposed after
 *     {@link IDLE_TIMEOUT_MS}.
 *   - Resolve secret headers (secret://… refs) via the secure store at connect
 *     time so credentials never live in the renderer.
 *   - Convert MCP tool definitions into OpenAI function-calling defs, namespaced
 *     as `mcp__<serverId>__<toolName>` so they never collide with built-in tools
 *     or with each other across servers.
 *   - Surface connection/tool errors as values, never throwing into the agent
 *     loop (a flaky external server must not crash a run).
 *
 * The SDK's client transports are bundled by esbuild into the main process; this
 * module must only be imported from the Electron main process.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { resolveSecrets } from "./secure-store";
import { isOAuthServer, makeProvider } from "./mcp-oauth";
// Pure namespacing + shape conversion now live in shared so desktop + mobile
// namespace/convert/stringify identically. Re-exported below for existing
// callers (electron/mcp/tools, agent loop) that import them from this module.
import {
  namespaceToolName,
  parseToolName,
  isMcpToolName,
  mcpToolsToOpenAI,
  stringifyToolResult,
  type OpenAIToolDef,
  type McpToolDef,
} from "../../shared/chat/mcp-namespace";

export { namespaceToolName, parseToolName, isMcpToolName, mcpToolsToOpenAI };
export type { OpenAIToolDef };

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;

// ── Server config (subset of McpServerConfig from src/types) ─────────────────

export interface McpServerRuntimeConfig {
  id: string;
  baseUrl: string;
  /** "http" = streamable-HTTP, "sse" = legacy SSE. */
  transport: "http" | "sse";
  headers?: Record<string, string>;
  /** "oauth" routes the connection through the SDK OAuth provider. */
  authMode?: "none" | "oauth";
  /** Optional requested OAuth scope. */
  oauthScope?: string;
  /** Display name, used to label the OAuth client registration. */
  name?: string;
}

// ── Connection manager ───────────────────────────────────────────────────────

interface Conn {
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
  /** Signature of the config used to open this connection (baseUrl/transport/headers). */
  signature: string;
}

const conns = new Map<string, Conn>();

/**
 * Stable signature of the connection-relevant config fields. When any of these
 * change (server edited in Settings, secret rotated), the cached transport must
 * be torn down and rebuilt rather than silently reused.
 */
function configSignature(cfg: McpServerRuntimeConfig): string {
  return JSON.stringify({
    baseUrl: cfg.baseUrl,
    transport: cfg.transport,
    headers: cfg.headers ?? {},
    authMode: cfg.authMode ?? "none",
    oauthScope: cfg.oauthScope ?? "",
  });
}

function makeTransport(cfg: McpServerRuntimeConfig) {
  const url = new URL(cfg.baseUrl);
  // OAuth servers connect via the SDK provider, which injects (and refreshes)
  // the bearer token from the keychain. Static headers are not used here.
  if (isOAuthServer(cfg)) {
    const provider = makeProvider(
      { id: cfg.id, baseUrl: cfg.baseUrl, transport: cfg.transport, scope: cfg.oauthScope },
      cfg.name ?? cfg.id,
    );
    if (cfg.transport === "sse") {
      return new SSEClientTransport(url, { authProvider: provider });
    }
    return new StreamableHTTPClientTransport(url, { authProvider: provider });
  }
  // Resolve secret refs → real values only at connect time, in the main process.
  const headers = resolveSecrets(cfg.headers ?? {});
  const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
  if (cfg.transport === "sse") {
    return new SSEClientTransport(url, { requestInit });
  }
  return new StreamableHTTPClientTransport(url, { requestInit });
}

function touch(conn: Conn): void {
  conn.lastUsed = Date.now();
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  conn.idleTimer = setTimeout(() => {
    void dispose(findServerId(conn));
  }, IDLE_TIMEOUT_MS);
  // Don't keep the event loop alive solely for an idle MCP connection.
  conn.idleTimer.unref?.();
}

function findServerId(conn: Conn): string {
  for (const [id, c] of conns) if (c === conn) return id;
  return "";
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Connect (or reuse a cached connection) to a server. Throws on failure. */
async function connect(cfg: McpServerRuntimeConfig): Promise<Conn> {
  const signature = configSignature(cfg);
  const existing = conns.get(cfg.id);
  if (existing && existing.signature === signature) {
    touch(existing);
    return existing;
  }
  // Config changed (or no connection yet) — drop any stale transport first.
  if (existing) await dispose(cfg.id);

  const client = new Client(
    { name: "cairn", version: "1.0.0" },
    { capabilities: {} }
  );
  const transport = makeTransport(cfg);
  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP connect to ${cfg.id}`);
  const conn: Conn = { client, transport, lastUsed: Date.now(), idleTimer: null, signature };
  conns.set(cfg.id, conn);
  touch(conn);
  return conn;
}

/** Disconnect and forget a server connection. Safe to call when not connected. */
export async function dispose(serverId: string): Promise<void> {
  const conn = conns.get(serverId);
  if (!conn) return;
  conns.delete(serverId);
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  try {
    await conn.client.close();
  } catch {
    // Already gone — nothing to do.
  }
}

/** Disconnect every server (called on workspace switch / app teardown). */
export async function disposeAll(): Promise<void> {
  await Promise.all([...conns.keys()].map((id) => dispose(id)));
}

/**
 * List a server's tools as namespaced OpenAI function defs. Returns [] on any
 * connection/list failure (logged) so a flaky server can't break the loop.
 */
export async function listTools(cfg: McpServerRuntimeConfig): Promise<OpenAIToolDef[]> {
  try {
    const conn = await connect(cfg);
    const res = await withTimeout(conn.client.listTools(), CALL_TIMEOUT_MS, `MCP listTools ${cfg.id}`);
    return mcpToolsToOpenAI(cfg.id, (res.tools ?? []) as McpToolDef[]);
  } catch (e) {
    console.error(`[mcp-client] listTools failed for ${cfg.id}:`, e instanceof Error ? e.message : e);
    return [];
  }
}

/** A server's individual tool, with its raw (un-namespaced) name + description. */
export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface ListMcpToolsResult {
  ok: boolean;
  tools: McpToolInfo[];
  error?: string;
}

/**
 * List a server's tools with raw names + descriptions, for the Settings
 * per-tool enable/disable checklist. Unlike {@link testConnection} this keeps
 * the (cached) connection alive — the user is actively configuring the server —
 * and surfaces descriptions. Never throws.
 */
export async function listToolsDetailed(cfg: McpServerRuntimeConfig): Promise<ListMcpToolsResult> {
  try {
    const conn = await connect(cfg);
    const res = await withTimeout(conn.client.listTools(), CALL_TIMEOUT_MS, `MCP listToolsDetailed ${cfg.id}`);
    const tools = (res.tools ?? []) as McpToolDef[];
    return { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description })) };
  } catch (e) {
    return { ok: false, tools: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Call a namespaced MCP tool. Returns the textual result, or an error string
 * (never throws). `namespaced` is the `mcp__<serverId>__<tool>` name; `cfg` must
 * be the matching server config.
 */
export async function callTool(
  cfg: McpServerRuntimeConfig,
  namespaced: string,
  args: Record<string, unknown>
): Promise<string> {
  const parsed = parseToolName(namespaced);
  if (!parsed || parsed.serverId !== cfg.id) {
    return `Error: "${namespaced}" is not a tool of MCP server ${cfg.id}`;
  }
  try {
    const conn = await connect(cfg);
    const res = await withTimeout(
      conn.client.callTool({ name: parsed.toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      `MCP callTool ${namespaced}`
    );
    return stringifyToolResult(res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[mcp-client] callTool ${namespaced} failed:`, msg);
    return `Error calling ${namespaced}: ${msg}`;
  }
}

/**
 * Test a connection for the Settings "test connection" button: connect + list
 * tools, returning a small status payload. Always disposes afterward so the test
 * doesn't leave a lingering connection.
 */
export async function testConnection(
  cfg: McpServerRuntimeConfig
): Promise<{ ok: boolean; toolCount?: number; toolNames?: string[]; error?: string }> {
  try {
    const conn = await connect(cfg);
    const res = await withTimeout(conn.client.listTools(), CONNECT_TIMEOUT_MS, `MCP test ${cfg.id}`);
    const tools = (res.tools ?? []) as McpToolDef[];
    return { ok: true, toolCount: tools.length, toolNames: tools.map((t) => t.name) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await dispose(cfg.id);
  }
}
