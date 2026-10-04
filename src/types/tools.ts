/** External tools (MCP servers, custom HTTP services) and the community registry. */

import type { ID } from "../../shared/types/domain";
import type { SlashCommandScope } from "./workspace";

// ── External Tools (MCP servers + custom HTTP services) ──────────────
//
// Workspace-scoped definitions; per-project enable/attach lives in
// ToolAttachment rows. Header values that are secrets are stored as a
// ref token ("secret://<toolId>/<headerName>") — the real value lives in
// the OS keychain via the secure store, never in SQLite.

/** Where a tool definition came from. */
export type ToolSource = "manual" | "community" | "ai-builder";

/** Remote MCP server the AI chat/agent can connect to as a client. */
export interface McpServerConfig {
  id: ID;
  workspaceId: ID;
  name: string;
  description?: string;
  /** Transport — derived from baseUrl when not explicit. */
  transport: "sse" | "http";
  baseUrl: string;
  /** Header values may be literal or a "secret://" ref. */
  headers?: Record<string, string>;
  /**
   * Authentication mode. "none" = static headers only (default). "oauth" =
   * SDK-driven OAuth 2.1 flow; client registration + tokens live in the OS
   * keychain, never in SQLite.
   */
  authMode?: "none" | "oauth";
  /** Optional requested OAuth scope string (space-delimited). */
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
  /**
   * Dev-only: route this server through dsh-mcp-client (parity spike) instead
   * of the hand bridge. Toggled from ToolsSettings on dev builds; the turn
   * bootstrap verifies parity per turn and falls back on mismatch.
   */
  dshPath?: boolean;
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

// ── Community registry (cairn-community) ───────────────────────────────────
// Mirrors the manifest published at
// https://github.com/ddutchie/cairn-community (manifest.json). Fetched at
// runtime; each entry's `definition` is the install-relevant subset of a
// McpServerConfig / CustomServiceConfig — id/workspaceId/timestamps are assigned
// locally on install.

/** The install-relevant subset of McpServerConfig carried by a registry entry. */
export interface RegistryMcpDefinition {
  name: string;
  description?: string;
  transport: "sse" | "http";
  baseUrl: string;
  headers?: Record<string, string>;
  authMode?: "none" | "oauth";
  oauthScope?: string;
  /** Optional pre-registered public client id (confidential-style, skips DCR). */
  oauthClientId?: string;
  /** Optional fixed redirect URI the provider requires pre-registered. */
  oauthRedirectUri?: string;
  /**
   * True when this connector's provider forbids dynamic client registration, so
   * the user must supply a pre-registered client id (+ redirect URI) to connect.
   */
  requiresClientId?: boolean;
  disabledTools?: string[];
  enabled: boolean;
}

/** The install-relevant subset of CustomServiceConfig carried by a registry entry. */
export interface RegistryServiceDefinition {
  name: string;
  description?: string;
  /** Legacy single-op endpoint. Multi-op services use baseUrl + operations. */
  apiUrl?: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  /** Legacy single-op tool. */
  toolDefinition?: string;
  /** Base URL shared by all operations (multi-op). */
  baseUrl?: string;
  /** Multi-operation definition — each becomes its own namespaced tool. */
  operations?: ServiceOperationConfig[];
  responseKeys?: string[];
  apiKeyUrl?: string;
  /** Mirror of CustomServiceConfig auth fields so the registry can ship an OAuth preset. */
  authMode?: "none" | "oauth";
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
}

/** Registry metadata common to every catalog entry (shown on the browse card). */
export interface RegistryEntryMeta {
  /** Stable connector id (the cairn-community folder name). */
  id: string;
  author: string;
  /** SemVer of THIS entry — bump drives the "update available" badge. */
  version: string;
  /** Fixed category vocabulary — shown as the Browse Community filter chip. */
  category?: string;
  tags: string[];
  blurb: string;
  brandColor?: string;
  homepage?: string;
  /**
   * Brand logo as inline SVG markup, compiled and allowlist-sanitized by the
   * cairn-community CI (never raw contributor SVG). Rendered inline by
   * ConnectorLogo. Absent → the app's fallback glyph.
   */
  iconSvg?: string;
}

export interface RegistryMcpEntry extends RegistryEntryMeta {
  definition: RegistryMcpDefinition;
}

export interface RegistryServiceEntry extends RegistryEntryMeta {
  definition: RegistryServiceDefinition;
}

/** The install-relevant subset of a community slash command. */
export interface RegistryCommandDefinition {
  name: string;
  description?: string;
  insertText: string;
  scope: SlashCommandScope;
}

export interface RegistryCommandEntry extends RegistryEntryMeta {
  definition: RegistryCommandDefinition;
}

/** The parsed cairn-community manifest. */
export interface CommunityManifest {
  version: number;
  updatedAt: string;
  mcpServers: RegistryMcpEntry[];
  services: RegistryServiceEntry[];
  /** Community slash commands (manifest v2+). Empty on older manifests. */
  commands: RegistryCommandEntry[];
}

/** Result of a registry fetch — the manifest plus cache provenance. */
export interface RegistryFetchResult {
  manifest: CommunityManifest;
  /** true when served from the local cache (offline / 304 Not Modified). */
  fromCache: boolean;
  /** ISO time the cache was last populated from the network. */
  cachedAt?: string;
  /** Set when the network fetch failed and no cache was available. */
  error?: string;
}

/** The install-relevant subset of a community AI provider preset. */
export interface RegistryProviderDefinition {
  /** Label seeded into the saved provider's name. */
  name: string;
  /** OpenAI-compatible chat-completions endpoint root. */
  baseUrl: string;
  /** Default model id to seed the provider with. */
  defaultModel?: string;
  /** Whether this endpoint requires an API key (false = keyless / local). */
  needsApiKey: boolean;
  /** Where the user can obtain an API key (rendered as a "Get a key" link). */
  apiKeyUrl?: string;
  /** Optional curated model ids offered before a live /models fetch. */
  models?: string[];
}

export interface RegistryProviderEntry extends RegistryEntryMeta {
  definition: RegistryProviderDefinition;
}

/** The parsed cairn-community PROVIDERS manifest (providers.json). */
export interface ProvidersManifest {
  version: number;
  updatedAt: string;
  providers: RegistryProviderEntry[];
}

/** Result of a providers-manifest fetch — the manifest plus cache provenance. */
export interface ProvidersFetchResult {
  manifest: ProvidersManifest;
  fromCache: boolean;
  cachedAt?: string;
  error?: string;
}

/** An external connector (MCP server / HTTP service) a recipe needs in scope. */
export interface RegistryRequirement {
  kind: "mcp" | "service";
  /** Matches the connector's catalog id (slug) or display name, case-insensitive. */
  name: string;
}

/** A community automation recipe that pre-fills the New Automation form. */
export interface RegistryAutomationDefinition {
  /** Display name prefilled into the automation. */
  name: string;
  description?: string;
  /** Prompt replayed on every run (data-only toolset, no shell). */
  instructions: string;
  schedule: {
    kind: "cron" | "every" | "once";
    /** cron (5-field) | "every N minutes/hours/days/weeks" | ISO datetime. */
    expr: string;
    timezone?: string;
  };
  approvalMode?: "auto" | "ask";
  maxRuns?: number;
  /**
   * External connectors the recipe needs in scope. When present the automation
   * is connector-aware: runs get the project's attached external tools and
   * external tool calls default to the approval inbox (never auto-approved).
   */
  requires?: RegistryRequirement[];
}

export interface RegistryAutomationEntry extends RegistryEntryMeta {
  definition: RegistryAutomationDefinition;
}

/** The parsed cairn-community AUTOMATIONS manifest (automations.json). */
export interface AutomationsManifest {
  version: number;
  updatedAt: string;
  automations: RegistryAutomationEntry[];
}

/** Result of an automations-manifest fetch — manifest plus cache provenance. */
export interface AutomationsFetchResult {
  manifest: AutomationsManifest;
  fromCache: boolean;
  cachedAt?: string;
  error?: string;
}

/** A community personality — behavioral rules appended to the chat system prompt. */
export interface RegistryPersonalityDefinition {
  /** Display name shown in the personality picker. */
  name: string;
  /** One line shown in the browse card and picker list. */
  description?: string;
  /** Behavioral rules appended to the chat system prompt (style layer, never a
   *  "You are …" identity claim). */
  prompt: string;
}

export interface RegistryPersonalityEntry extends RegistryEntryMeta {
  definition: RegistryPersonalityDefinition;
}

/** The parsed cairn-community PERSONALITIES manifest (personalities.json). */
export interface PersonalitiesManifest {
  version: number;
  updatedAt: string;
  personalities: RegistryPersonalityEntry[];
}

/** Result of a personalities-manifest fetch — manifest plus cache provenance. */
export interface PersonalitiesFetchResult {
  manifest: PersonalitiesManifest;
  fromCache: boolean;
  cachedAt?: string;
  error?: string;
}
