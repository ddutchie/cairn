/**
 * External tool types (workspace MCP servers, custom HTTP services, per-project
 * attachments, OAuth sign-in results) shared by the renderer, the Electron main
 * process and the typed IPC contract (`shared/ipc/contract.ts`).
 */

import type { ID } from "./domain";

// ── External Tools (MCP servers + custom HTTP services) ──────────────
//
// Workspace-scoped definitions; per-project enable/attach lives in
// ToolAttachment rows. Header values that are secrets are stored as a
// ref token ("secret://<toolId>/<headerName>") — the real value lives in
// the OS keychain via the secure store, never in SQLite.

/** Where a tool definition came from. */
export type ToolSource = "manual" | "community" | "ai-builder";

/** MCP transport. `http` = streamable-HTTP, `sse` = legacy SSE, `stdio` = local child process. */
export type McpTransport = "sse" | "http" | "stdio";

/** Fields every MCP server carries regardless of transport. */
interface McpServerBase {
  id: ID;
  workspaceId: ID;
  name: string;
  description?: string;
  transport: McpTransport;
  /**
   * Authentication mode. "none" = static headers only (default). "oauth" =
   * SDK-driven OAuth 2.1 flow; client registration + tokens live in the OS
   * keychain, never in SQLite. Remote only — stdio servers run locally.
   */
  authMode?: "none" | "oauth";
  /**
   * of the hand bridge. Toggled from ToolsSettings on dev builds; the turn
   * bootstrap verifies parity per turn and falls back on mismatch.
   * Stdio servers always route via dsh and ignore this flag.
   */
  enabled: boolean;
  source: ToolSource;
  /** Set when installed from the community registry. */
  communityId?: string;
  version?: string;
  /**
   * Raw (un-namespaced) tool names the user has disabled for this server,
   * applied workspace-wide. Absent / empty = all tools enabled.
   */
  disabledTools?: string[];
  createdAt: string;
  updatedAt: string;
}

/** Remote MCP server the AI chat/agent can connect to as a client. */
export interface McpRemoteServerConfig extends McpServerBase {
  transport: "sse" | "http";
  /** Transport — derived from baseUrl when not explicit. */
  baseUrl: string;
  /** Header values may be literal or a "secret://" ref. */
  headers?: Record<string, string>;
  /** Optional requested OAuth scope string (space-delimited). Remote only. */
  oauthScope?: string;
  /**
   * Optional pre-registered OAuth client id. When set, Cairn SKIPS dynamic
   * client registration and authenticates as a public PKCE client against a
   * fixed app (e.g. Slack's MCP server, which forbids DCR). This is a PUBLIC
   * value (never a secret) — stored in SQLite.
   */
  oauthClientId?: string;
  /**
   * Optional fixed redirect URI for the OAuth flow, e.g. a loopback URL the
   * provider requires to be pre-registered (`http://127.0.0.1:48123/callback`).
   * When unset, Cairn uses its normal random-port loopback (public PKCE / DCR
   * providers like Canva, Figma).
   */
  oauthRedirectUri?: string;
  /**
   * True when this server's provider forbids dynamic client registration, so
   * sign-in is impossible until the user supplies a pre-registered `oauthClientId`
   * (and usually an `oauthRedirectUri`). Set by community connectors that need a
   * pre-registered app (e.g. Slack). The UI surfaces the Client ID / Redirect URI
   * fields and routes "Sign in" to them instead of failing on DCR.
   */
  oauthClientIdRequired?: boolean;
  command?: undefined;
  args?: undefined;
  env?: undefined;
  cwd?: undefined;
}

/** Local MCP server spawned as a child process over stdio (desktop only). */
export interface McpStdioServerConfig extends McpServerBase {
  transport: "stdio";
  /** Executable used to start the server (absolute path or PATH name, no shell). */
  command: string;
  /** Arguments passed directly, without shell interpolation. */
  args?: string[];
  /** Extra env vars (values may be literal or a "secret://" ref). */
  env?: Record<string, string>;
  /** Working directory for the child process (absolute; defaults to workspace). */
  cwd?: string;
  baseUrl?: undefined;
  headers?: undefined;
  authMode?: undefined;
  oauthScope?: undefined;
  oauthClientId?: undefined;
  oauthRedirectUri?: undefined;
  oauthClientIdRequired?: undefined;
}

/** Workspace MCP server: remote (http/sse) or local (stdio). */
export type McpServerConfig = McpRemoteServerConfig | McpStdioServerConfig;

/** True when the server is a local stdio server. */
export function isStdioMcpServer(s: Pick<McpServerConfig, "transport">): s is McpStdioServerConfig {
  return s.transport === "stdio";
}

/** True when the server is a remote HTTP/SSE server. */
export function isRemoteMcpServer(s: Pick<McpServerConfig, "transport">): s is McpRemoteServerConfig {
  return s.transport === "http" || s.transport === "sse";
}


/** Custom HTTP API exposed to the AI as a single function-calling tool. */
/** One operation of a multi-operation HTTP service (mirrors the registry shape). */
export interface ServiceOperationConfig {
  name: string;
  description?: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path?: string;
  toolDefinition: string;
  paramLocations?: Record<string, "path" | "query" | "body">;
  query?: Record<string, string>;
  responseKeys?: string[];
}

export interface CustomServiceConfig {
  id: ID;
  workspaceId: ID;
  name: string;
  description?: string;
  /** Legacy single-op endpoint. For multi-op services use baseUrl + operations. */
  apiUrl?: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Header values may be literal or a "secret://" ref. Shared across operations. */
  headers?: Record<string, string>;
  /** Legacy single-op stringified OpenAI tool JSON (name/description/parameters). */
  toolDefinition?: string;
  /** Base URL shared by all operations (multi-op); each operation's path appends. */
  baseUrl?: string;
  /** Multi-operation definition — each becomes its own namespaced tool. */
  operations?: ServiceOperationConfig[];
  /** Keys to keep from the API response (token optimisation). */
  responseKeys?: string[];
  /** Where the user can obtain an API key. */
  apiKeyUrl?: string;
  /**
   * Authentication mode. "none" (default) uses static/keychain header secrets;
   * "oauth" runs the OAuth 2.1 flow (browser sign-in, tokens auto-refreshed and
   * injected as `Authorization: Bearer`). OAuth tokens/registration live in the
   * OS keychain, never in SQLite.
   */
  authMode?: "none" | "oauth";
  /**
   * OAuth parameters for `authMode: "oauth"`. `serverUrl` is the base the SDK
   * runs authorization-server discovery against (defaults to the apiUrl origin
   * when absent). `scope` is the requested scope string. Reserved
   * `clientId`/`authorizationUrl`/`tokenUrl` support vendors that require a
   * preregistered client (Phase C) — absent means discovery + DCR.
   */
  oauth?: {
    serverUrl?: string;
    scope?: string;
    clientId?: string;
    /** Fixed redirect URI (loopback URL) a pre-registered client requires. */
    redirectUri?: string;
    authorizationUrl?: string;
    tokenUrl?: string;
  };
  enabled: boolean;
  source: ToolSource;
  communityId?: string;
  version?: string;
  createdAt: string;
  updatedAt: string;
}

export type ToolType = "mcp" | "service";

/**
 * Per-project enable/attach of a workspace tool. A row with
 * projectId === GLOBAL_TOOL_SCOPE marks the tool as always-on everywhere.
 */
export interface ToolAttachment {
  projectId: ID;
  toolType: ToolType;
  toolId: ID;
  enabled: boolean;
}

/** Sentinel projectId for workspace-global ("always-on") attachments. */
export const GLOBAL_TOOL_SCOPE = "__global__";

// ── Settings test / listing results ───────────────────────────────────────

/** A server's individual tool, with its raw (un-namespaced) name + description. */
export interface McpToolInfo {
  name: string;
  description?: string;
  /** Tokens of the full function def sent to the model (name + description + inputSchema). */
  tokens?: number;
}

/** `tools:listMcpTools`: never rejects for a connection failure — `ok: false` + `error`. */
export interface ListMcpToolsResult {
  ok: boolean;
  tools: McpToolInfo[];
  error?: string;
}

/** `tools:testMcp`: connect + list tools, then disconnect. */
export interface McpTestResult {
  ok: boolean;
  toolCount?: number;
  toolNames?: string[];
  error?: string;
}

/** `tools:testService`: dry-run with sample args. */
export interface ServiceTestResult {
  ok: boolean;
  status?: number;
  preview?: string;
  error?: string;
}

// ── OAuth sign-in ─────────────────────────────────────────────────────────

/** Result of starting a sign-in; completion arrives later on `tools:oauthCallback`. */
export type AuthStartResult =
  | { status: "redirected" }
  | { status: "already_authorized" }
  | { status: "error"; error: string };

/** How a sign-in finished — the `tools:oauthCallback` event payload. */
export type AuthCompleteResult =
  | { status: "authorized"; serverId: string }
  | { status: "unknown_state"; serverId?: undefined }
  | { status: "error"; serverId?: string; error: string };

/** An OAuth MCP server needs sign-in — the `tools:authRequired` event payload. */
export interface McpAuthRequiredEvent {
  serverId: string;
  serverName: string;
}

/** Keychain namespaces the renderer may address through `secrets:*`. */
export type SecretToolType = "mcp" | "service" | "llm";
