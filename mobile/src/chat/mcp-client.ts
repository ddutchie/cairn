/**
 * Mobile outbound MCP client — connects Cairn to remote streamable-HTTP MCP
 * servers and exposes their tools to the chat/agent loop. The mobile counterpart
 * to electron/lib/mcp-client.ts.
 *
 * Confirmed on-device (Track 3 spike): the stock @modelcontextprotocol/sdk
 * `Client` + `StreamableHTTPClientTransport` run on Hermes when `expo/fetch` is
 * injected as the transport's `fetch` (its Response.body is a real ReadableStream
 * the SDK's TextDecoderStream pipeline consumes). Pure namespacing + tool-def
 * conversion + result stringify are shared with desktop via @cairn/shared.
 *
 * Only streamable-HTTP is supported on mobile for now (the registry is HTTP-first
 * anyway). OAuth servers connect via the SecureStoreOAuthProvider, which injects
 * (and refreshes) the bearer from the keychain. Errors are returned as values,
 * never thrown into the agent loop — a flaky server must not crash a run.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fetch as expoFetch } from "expo/fetch";
import {
  mcpToolsToOpenAI,
  parseToolName,
  stringifyToolResult,
  type OpenAIToolDef,
  type McpToolDef,
} from "@cairn/shared/chat/mcp-namespace";
import { SecureStoreOAuthProvider } from "./mcp-oauth";

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Runtime config for a mobile MCP server (subset of the stored config). */
export interface McpServerRuntimeConfig {
  id: string;
  baseUrl: string;
  /** Only "http" (streamable-HTTP) on mobile. */
  transport: "http" | "sse";
  headers?: Record<string, string>;
  authMode?: "none" | "oauth";
  oauthScope?: string;
  name?: string;
}

interface Conn {
  client: Client;
  transport: StreamableHTTPClientTransport;
  idleTimer: ReturnType<typeof setTimeout> | null;
  signature: string;
}

const conns = new Map<string, Conn>();

/** Stable signature of the connection-relevant fields; a change forces a rebuild. */
function configSignature(cfg: McpServerRuntimeConfig): string {
  return JSON.stringify({
    baseUrl: cfg.baseUrl,
    transport: cfg.transport,
    headers: cfg.headers ?? {},
    authMode: cfg.authMode ?? "none",
    oauthScope: cfg.oauthScope ?? "",
  });
}

function makeTransport(cfg: McpServerRuntimeConfig): StreamableHTTPClientTransport {
  const url = new URL(cfg.baseUrl);
  const fetchFn = expoFetch as unknown as typeof fetch;
  if (cfg.authMode === "oauth") {
    // The provider injects + refreshes the bearer from the keychain; static
    // headers aren't used for OAuth servers.
    const provider = new SecureStoreOAuthProvider(cfg.id, cfg.name ?? cfg.id, cfg.oauthScope);
    return new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: fetchFn });
  }
  const headers = cfg.headers ?? {};
  const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
  return new StreamableHTTPClientTransport(url, { requestInit, fetch: fetchFn });
}

function touch(conn: Conn, serverId: string): void {
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  conn.idleTimer = setTimeout(() => void dispose(serverId), IDLE_TIMEOUT_MS);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
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
    touch(existing, cfg.id);
    return existing;
  }
  if (existing) await dispose(cfg.id);

  const client = new Client({ name: "cairn-mobile", version: "1.0.0" }, { capabilities: {} });
  const transport = makeTransport(cfg);
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP connect to ${cfg.id}`);
  } catch (e) {
    // Connect (or its timeout) failed — close the half-open client/transport so
    // the socket + refresh timers don't leak, then rethrow the original error.
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw e;
  }
  const conn: Conn = { client, transport, idleTimer: null, signature };
  conns.set(cfg.id, conn);
  touch(conn, cfg.id);
  return conn;
}

/** Disconnect and forget a server connection. Safe when not connected. */
export async function dispose(serverId: string): Promise<void> {
  const conn = conns.get(serverId);
  if (!conn) return;
  conns.delete(serverId);
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  try {
    await conn.client.close();
  } catch {
    // Already gone.
  }
}

/** Disconnect every server (workspace switch / teardown). */
export async function disposeAll(): Promise<void> {
  await Promise.all([...conns.keys()].map((id) => dispose(id)));
}

/**
 * List a server's tools as namespaced OpenAI function defs. Returns [] on any
 * failure (logged) so a flaky server can't break the loop.
 */
export async function listTools(cfg: McpServerRuntimeConfig): Promise<OpenAIToolDef[]> {
  try {
    const conn = await connect(cfg);
    const res = await withTimeout(conn.client.listTools(), CALL_TIMEOUT_MS, `MCP listTools ${cfg.id}`);
    return mcpToolsToOpenAI(cfg.id, (res.tools ?? []) as McpToolDef[]);
  } catch (e) {
    console.warn(`[mcp-client] listTools failed for ${cfg.id}:`, e instanceof Error ? e.message : e);
    return [];
  }
}

/** Server tool with raw name + description, for the Settings tool list. */
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
 * Connect + list a server's tools with raw names + descriptions (Settings). Keeps
 * the connection cached (the user is configuring it). Never throws.
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
 * Call a namespaced MCP tool (`mcp__<serverId>__<tool>`). Returns the textual
 * result, or an error string (never throws). `cfg` must be the matching server.
 */
export async function callTool(
  cfg: McpServerRuntimeConfig,
  namespaced: string,
  args: Record<string, unknown>,
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
      `MCP callTool ${namespaced}`,
    );
    return stringifyToolResult(res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[mcp-client] callTool ${namespaced} failed:`, msg);
    return `Error calling ${namespaced}: ${msg}`;
  }
}

/**
 * Test a connection for the Settings "test" action: connect + list tools, return
 * a small status payload, always dispose afterward. Never throws.
 */
export async function testConnection(
  cfg: McpServerRuntimeConfig,
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
