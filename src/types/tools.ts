/** External tools (MCP servers, custom HTTP services) and the community registry. */

import type { ServiceOperationConfig } from "../../shared/types/tools";
import type { SlashCommandScope } from "./workspace";

// External tool definitions (MCP servers, services, attachments) live in shared/ so the
// IPC contract and the main process use the same shapes.
export * from "../../shared/types/tools";

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
