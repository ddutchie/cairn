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
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveSecrets } from "./secure-store";
import { resolveStdioEnv } from "./mcp-stdio";
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
import { encode } from "gpt-tokenizer";
import { errMsg } from "../host-shared/errors";
import type { ListMcpToolsResult, McpTestResult, McpToolInfo } from "../../shared/types/tools";

export { namespaceToolName, parseToolName, isMcpToolName, mcpToolsToOpenAI };
export type { OpenAIToolDef };

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;

// ── Server config (subset of McpServerConfig from src/types) ─────────────────

export type McpServerRuntimeConfig =
  | {
      id: string;
      baseUrl: string;
      /** "http" = streamable-HTTP, "sse" = legacy SSE. */
      transport: "http" | "sse";
  headers?: Record<string, string>;
  /** "oauth" routes the connection through the SDK OAuth provider. */
  authMode?: "none" | "oauth";
  /** Optional requested OAuth scope. */
  oauthScope?: string;
  /** Pre-registered OAuth client id — skips DCR (public PKCE, e.g. Slack). */
  oauthClientId?: string;
  /** Fixed redirect URI (loopback URL pre-registered with the provider). */
  oauthRedirectUri?: string;
  /** Display name, used to label the OAuth client registration. */
  name?: string;
    }
  | {
      id: string;
      /** Local stdio server — served exclusively by dsh-mcp-client, never here. */
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      name?: string;
    };

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
  if (cfg.transport === "stdio") {
    return JSON.stringify({
      transport: "stdio",
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env ?? {},
      cwd: cfg.cwd ?? "",
    });
  }
  return JSON.stringify({
    baseUrl: cfg.baseUrl,
    transport: cfg.transport,
    headers: cfg.headers ?? {},
    authMode: cfg.authMode ?? "none",
    oauthScope: cfg.oauthScope ?? "",
    oauthClientId: cfg.oauthClientId ?? "",
    oauthRedirectUri: cfg.oauthRedirectUri ?? "",
  });
}

function makeTransport(cfg: Extract<McpServerRuntimeConfig, { transport: "http" | "sse" }>) {
  const url = new URL(cfg.baseUrl);
  // OAuth servers connect via the SDK provider, which injects (and refreshes)
  // the bearer token from the keychain. Static headers are not used here.
  if (isOAuthServer(cfg)) {
    const provider = makeProvider(
      {
        id: cfg.id,
        baseUrl: cfg.baseUrl,
        transport: cfg.transport,
        scope: cfg.oauthScope,
        clientId: cfg.oauthClientId,
        redirectUri: cfg.oauthRedirectUri,
      },
      cfg.name ?? cfg.id,
      undefined,
      undefined,
      // Background connect: never open the browser (no loopback listener here).
      { interactive: false },
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

// ── Sign-in required ─────────────────────────────────────────────────────────

/** An OAuth server rejected a background connect: the user must sign in. */
export interface McpAuthRequired {
  serverId: string;
  serverName: string;
}

const authRequiredListeners = new Set<(e: McpAuthRequired) => void>();

/** Subscribe to "server needs sign-in" signals; returns the unsubscribe function. */
export function onAuthRequired(cb: (e: McpAuthRequired) => void): () => void {
  authRequiredListeners.add(cb);
  return () => authRequiredListeners.delete(cb);
}

/** Notify listeners when `e` is an OAuth rejection; returns whether it was. */
function reportIfAuthError(cfg: McpServerRuntimeConfig, e: unknown): boolean {
  if (!(e instanceof UnauthorizedError)) return false;
  const evt = { serverId: cfg.id, serverName: cfg.name ?? cfg.id };
  for (const cb of authRequiredListeners) cb(evt);
  return true;
}

/** Connect (or reuse a cached connection) to a server. Throws on failure. */
async function connect(cfg: McpServerRuntimeConfig): Promise<Conn> {
  if (cfg.transport === "stdio") throw new Error(`MCP server ${cfg.id} is stdio (dsh path) — hand bridge is remote-only`);
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
  if (cfg.transport === "stdio") return [];
  try {
    const conn = await connect(cfg);
    const res = await withTimeout(conn.client.listTools(), CALL_TIMEOUT_MS, `MCP listTools ${cfg.id}`);
    return mcpToolsToOpenAI(cfg.id, (res.tools ?? []) as McpToolDef[]);
  } catch (e) {
    if (reportIfAuthError(cfg, e)) {
      console.warn(`[mcp-client] ${cfg.id} needs sign-in; skipping its tools`);
      return [];
    }
    console.error(`[mcp-client] listTools failed for ${cfg.id}:`, e instanceof Error ? e.message : e);
    return [];
  }
}

export type { McpToolInfo, ListMcpToolsResult };

/**
 * List a server's tools with raw names + descriptions, for the Settings
 * per-tool enable/disable checklist. Unlike {@link testConnection} this keeps
 * the (cached) connection alive — the user is actively configuring the server —
 * and surfaces descriptions. Never throws.
 */
/**
 * One-shot stdio list (Settings/test only — never the turn path): spawn,
 * listTools, close. The turn path serves stdio exclusively via dsh-mcp-client.
 */
async function listStdioToolsOnce(cfg: Extract<McpServerRuntimeConfig, { transport: "stdio" }>): Promise<McpToolDef[]> {
  const client = new Client({ name: "cairn", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: resolveStdioEnv(cfg.env),
    cwd: cfg.cwd?.trim() || undefined,
    stderr: "pipe",
  });
  // Keep the tail of the child's stderr: when it dies at startup the SDK only
  // reports "Connection closed", and stderr is the one place the real cause
  // (auth failure, missing runtime, bad flag) shows up.
  const stderrTail = captureStderrTail(transport.stderr);
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP stdio connect ${cfg.id}`);
    const res = await withTimeout(client.listTools(), CALL_TIMEOUT_MS, `MCP stdio listTools ${cfg.id}`);
    return (res.tools ?? []) as McpToolDef[];
  } catch (e) {
    throw withStderr(e, stderrTail());
  } finally {
    try {
      await client.close();
    } catch {
      /* already gone */
    }
  }
}

const STDERR_TAIL_BYTES = 2000;

/** Collect the last {@link STDERR_TAIL_BYTES} of a child's stderr; the returned getter is safe to call any time. */
export function captureStderrTail(stream: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null | undefined): () => string {
  // Accumulate raw bytes and decode once in the getter: a multi-byte UTF-8
  // character split across two chunks would otherwise decode as U+FFFD.
  let chunks: Buffer[] = [];
  let len = 0;
  stream?.on("data", (chunk: Buffer | string) => {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(b);
    len += b.length;
    while (chunks.length > 1 && len - chunks[0].length >= STDERR_TAIL_BYTES) {
      len -= chunks.shift()!.length;
    }
    if (len > STDERR_TAIL_BYTES) {
      chunks = [chunks[chunks.length - 1].subarray(-STDERR_TAIL_BYTES)];
      len = chunks[0].length;
    }
  });
  return () => Buffer.concat(chunks).slice(-STDERR_TAIL_BYTES).toString("utf8").trim();
}

/** `e` with the child's stderr tail appended to its message (when there is any). */
export function withStderr(e: unknown, stderr: string): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  if (!stderr) return err;
  const wrapped = new Error(`${err.message}\n--- server stderr ---\n${stderr}`);
  return wrapped;
}

export async function listToolsDetailed(cfg: McpServerRuntimeConfig): Promise<ListMcpToolsResult> {
  if (cfg.transport === "stdio") {
    try {
      const tools = await listStdioToolsOnce(cfg);
      const defs = mcpToolsToOpenAI(cfg.id, tools);
      return {
        ok: true,
        tools: tools.map((tool, i) => ({
          name: tool.name,
          description: tool.description,
          tokens: encode(JSON.stringify(defs[i])).length,
        })),
      };
    } catch (e) {
      return { ok: false, tools: [], error: errMsg(e) };
    }
  }
  try {
    const conn = await connect(cfg);
    const res = await withTimeout(conn.client.listTools(), CALL_TIMEOUT_MS, `MCP listToolsDetailed ${cfg.id}`);
    const tools = (res.tools ?? []) as McpToolDef[];
    // Measure the def as the model receives it — the input schema is usually
    // the bulk of the cost, so name + description alone badly undercounts.
    const defs = mcpToolsToOpenAI(cfg.id, tools);
    return {
      ok: true,
      tools: tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        tokens: encode(JSON.stringify(defs[i])).length,
      })),
    };
  } catch (e) {
    reportIfAuthError(cfg, e);
    return { ok: false, tools: [], error: errMsg(e) };
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
  if (cfg.transport === "stdio") {
    return `Error: "${namespaced}" is a stdio tool and must run through the dsh path, not the hand bridge.`;
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
    if (reportIfAuthError(cfg, e)) {
      return `Error calling ${namespaced}: MCP server "${cfg.name ?? cfg.id}" is not signed in. A Sign in button is shown in the chat; ask the user to sign in, then retry.`;
    }
    const msg = errMsg(e);
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
): Promise<McpTestResult> {
  if (cfg.transport === "stdio") {
    try {
      const tools = await listStdioToolsOnce(cfg);
      return { ok: true, toolCount: tools.length, toolNames: tools.map((tool) => tool.name) };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }
  try {
    const conn = await connect(cfg);
    const res = await withTimeout(conn.client.listTools(), CONNECT_TIMEOUT_MS, `MCP test ${cfg.id}`);
    const tools = (res.tools ?? []) as McpToolDef[];
    return { ok: true, toolCount: tools.length, toolNames: tools.map((t) => t.name) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  } finally {
    await dispose(cfg.id);
  }
}

/** What a connected server advertises beyond tools: its instructions and whether it serves resources. */
export interface McpServerMeta {
  instructions?: string;
  resources: boolean;
}

/**
 * Read a server's `initialize` result (instructions + resources capability)
 * from its live cached connection. Never connects: callers run this right
 * after {@link listTools}, so an unreachable server (no connection) costs no
 * second connect timeout. Returns null when there is no live connection.
 */
export function getServerMeta(cfg: McpServerRuntimeConfig): McpServerMeta | null {
  if (cfg.transport === "stdio") return null;
  const conn = conns.get(cfg.id);
  if (!conn || conn.signature !== configSignature(cfg)) return null;
  try {
    touch(conn);
    const instructions = conn.client.getInstructions()?.trim();
    return {
      ...(instructions ? { instructions } : {}),
      resources: conn.client.getServerCapabilities()?.resources !== undefined,
    };
  } catch (e) {
    console.error(`[mcp-client] getServerMeta failed for ${cfg.id}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** One MCP resource operation (list / list templates / read), with server-owned cursors and URIs. */
export type McpResourceRequest =
  | { method: "resources/list" | "resources/templates/list"; cursor?: string }
  | { method: "resources/read"; uri: string };

/**
 * Run one resource operation against a server. Unlike {@link callTool} this
 * throws: the dsh resource tools turn a thrown error into an `isError` result.
 */
export async function requestResource(
  cfg: McpServerRuntimeConfig,
  request: McpResourceRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  if (cfg.transport === "stdio") throw new Error(`MCP server ${cfg.id} is stdio (dsh path) — hand-bridge resources are remote-only`);
  const conn = await connect(cfg);
  const options = { signal, timeout: CALL_TIMEOUT_MS };
  const label = `MCP ${request.method} ${cfg.id}`;
  switch (request.method) {
    case "resources/list":
      return withTimeout(conn.client.listResources(request.cursor ? { cursor: request.cursor } : undefined, options), CALL_TIMEOUT_MS, label);
    case "resources/templates/list":
      return withTimeout(conn.client.listResourceTemplates(request.cursor ? { cursor: request.cursor } : undefined, options), CALL_TIMEOUT_MS, label);
    case "resources/read":
      return withTimeout(conn.client.readResource({ uri: request.uri }, options), CALL_TIMEOUT_MS, label);
  }
}
