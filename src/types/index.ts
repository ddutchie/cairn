// ─────────────────────────────────────────────
// Cairn — Core Domain Types
// ─────────────────────────────────────────────

export type ID = string;

// ── Tags ──────────────────────────────────────
export interface Tag {
  id: ID;
  name: string;
  color: string; // hex or tailwind color token
  workspaceId: ID;
}

// ── Slash commands ────────────────────────────
/** Which input pane(s) a slash command appears in. */
export type SlashCommandScope = "chat" | "agent" | "both";

/** Where a slash command came from. Built-ins are code constants, not rows. */
export type SlashCommandSource = "builtin" | "custom" | "community";

/**
 * A workspace-global, user-defined (or community-installed) slash command.
 * Persisted in the `slash_commands` table. Built-in commands are represented at
 * runtime with the same shape (source: "builtin") but are NOT stored in the DB.
 */
export interface CustomSlashCommand {
  id: ID;
  workspaceId: ID;
  name: string;
  description: string;
  /** Text inserted into the input when the command is chosen. */
  insertText: string;
  scope: SlashCommandScope;
  source: SlashCommandSource;
  /** Provenance link back to a cairn-community manifest entry, if installed. */
  communityId?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Workspace ─────────────────────────────────
export interface Workspace {
  id: ID;
  name: string;
  description?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

// ── Project ───────────────────────────────────
export type ProjectStatus = "active" | "on_hold" | "completed" | "archived";
export type Priority = "low" | "medium" | "high" | "urgent";

export interface ProjectSettings {
  prTemplate?: string;
  defaultBranch?: string;
  autoStageOnCommit?: boolean;
  useRepoPrTemplate?: boolean;
}

export interface Project {
  id: ID;
  workspaceId: ID;
  name: string;
  description?: string;
  icon?: string;
  status: ProjectStatus;
  priority: Priority;
  dueDate?: string;
  tagIds: ID[];
  codeDirectory: string | null;
  projectSettings?: ProjectSettings;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

// ── Note ─────────────────────────────────────
export type NoteType = "note" | "dashboard" | "template";

export interface Note {
  id: ID;
  projectId: ID;
  workspaceId: ID;
  title: string;
  /** Raw markdown (type=note) or HTML string (type=dashboard) */
  content: string;
  /** Plain-text representation for search (markdown stripped) */
  contentText: string;
  tagIds: ID[];
  /** Backlink references: note IDs this note mentions */
  linkedNoteIds: ID[];
  /** Task cards this note is linked to */
  linkedCardIds: ID[];
  isPinned: boolean;
  type: NoteType;
  /**
   * Slash-separated subfolder path within the project notes directory.
   * Empty string means the note is in the project root.
   * e.g. "Design/Typography" → notes/<project-slug>/design/typography/<note>.md
   */
  folder: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** Monotonically incrementing write counter. Used for optimistic-concurrency
   * checks by MCP tools that accept an optional expectedVersion argument. */
  version: number;
}

// ── Board Column ──────────────────────────────
export type ColumnType = "backlog" | "todo" | "in_progress" | "review" | "done" | "custom";

export interface BoardColumn {
  id: ID;
  projectId: ID;
  workspaceId: ID;
  name: string;
  type: ColumnType;
  order: number;
  cardLimit?: number;
  createdAt: string;
  updatedAt: string;
}

// ── Task Card ─────────────────────────────────
export interface TaskCard {
  id: ID;
  columnId: ID;
  projectId: ID;
  workspaceId: ID;
  title: string;
  description?: string;
  tagIds: ID[];
  priority: Priority;
  dueDate?: string;
  /** Note IDs this card is linked to */
  linkedNoteIds: ID[];
  /** Card IDs (same project) that block this card from being started */
  blockedByIds: ID[];
  order: number;
  assignee?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** Monotonically incrementing write counter for optimistic concurrency. */
  version: number;
}

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

// ── Chat ──────────────────────────────────────
export type ChatThreadScope = "workspace" | "project";

export interface TokenBreakdown {
  systemPrompt: number;
  skills: number;
  tools: number;
  conversation: number;
  toolOutputs: number;
  rules: number;
  mcp: number;
  subagentDefinitions: number;
}

export interface ChatThread {
  id: ID;
  scope: ChatThreadScope;
  workspaceId: ID;
  projectId?: ID;
  title?: string;
  createdAt: string;
  updatedAt: string;
  lastUsage?: {
    promptTokens: number;
    completionTokens: number;
    /** Subset of completion_tokens produced by the model's reasoning/thinking step. 0 if the model didn't split. */
    reasoningTokens?: number;
    /** Prompt tokens served from the provider's cache this turn (0 when the provider doesn't cache/report). */
    cacheReadTokens?: number;
    /** Prompt tokens written to the provider's cache this turn (0 when not split out). */
    cacheCreationTokens?: number;
    breakdown?: TokenBreakdown;
    /** Provider-reported USD cost of the turn (e.g. Neuralwatt usage.cost), when present. */
    costUsd?: number;
    /** Model capacity / context limit. */
    contextLimit?: number;
    contextWindow?: number;
  };
}

export type ChatRole = "user" | "assistant" | "system";

/**
 * Streaming token-usage shape mirrored from the OpenAI chat/completions spec.
 * `reasoningTokens` is the subset of `completionTokens` spent on chain-of-thought
 * reasoning; absent when the model doesn't split reasoning from content.
 */
export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  reasoningTokens?: number;
  /** Prompt tokens served from the provider's cache (billed at the cache_read rate). */
  cacheReadTokens?: number;
  /** Prompt tokens written to the provider's cache (billed at the cache_write rate). */
  cacheCreationTokens?: number;
  breakdown?: TokenBreakdown;
  /** Provider-reported USD cost of the call (e.g. Neuralwatt usage.cost), when present. */
  costUsd?: number;
}

export interface LinkedContextReference {
  type: "note" | "task" | "project" | "search_result";
  id: ID;
  title: string;
  snippet?: string;
}

export interface ChatToolCallRecord {
  tool: string;
  label: string;
  cairnRef?: { type: "note" | "task"; id: ID; title: string };
  /**
   * A linkable external artefact extracted from an MCP-server / custom-service
   * tool result (a Confluence page, web-search hit, GitHub PR, …). Rendered as a
   * browser-opening chip. Absent for native tools (which use `cairnRef`) and for
   * results with no usable http(s) URL.
   */
  externalRef?: { url: string; title?: string; snippet?: string };
  callId?: string;
  args?: string;      // JSON arguments string
  output?: string;    // JSON output string
  /**
   * Tool execution status. `ok: false` means the tool returned an error result
   * or threw — the chip renders a failure state and `error` carries the reason.
   * Absent (undefined) on older persisted records → treated as success.
   */
  ok?: boolean;
  error?: string;
  /**
   * Presentation metadata recomputed from the registered tool definition's
   * output.presentationMeta(args, value) (NOT persisted in the session log —
   * dsh recomputes it at render time like its web shell). Rich toolviews keyed
   * to this tool read it off the block; absent → generic text rendering.
   */
  meta?: Record<string, unknown>;
}

/**
 * A single subagent run inside a subagent-mode chat turn (dispatch → research/
 * write). Captures the subagent's role, the dispatcher's instruction, its own
 * streamed content + tool calls, and the brief it returned. Rendered as an
 * expandable inline block so the user can step into what each subagent did.
 */
export interface ChatSubagent {
  /** Unique child id: `${threadId}:sub:<n>` */
  childId: string;
  /** "research" | "write" */
  role: string;
  /** The dispatcher's instruction to this subagent */
  instruction: string;
  /** Content streamed by the subagent (its findings brief / confirmation) */
  content: string;
  /** Reasoning/thinking streamed by the subagent */
  reasoning?: string;
  /** Tool calls the subagent made */
  toolCalls?: ChatToolCallRecord[];
  /** Whether the subagent is still running */
  running: boolean;
  /** Final result returned to the dispatcher (usually == content) */
  result?: string;
  /** This subagent's OWN latest context-window usage — drives its dedicated ring. */
  lastUsage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: TokenBreakdown; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
}

export type SuggestedAction =
  | { type: "add_wikilink";   sourceNoteId: string; sourceTitle: string; targetTitle: string; reason: string }
  | { type: "link_note_note"; sourceNoteId: string; sourceTitle: string; targetNoteId: string; targetTitle: string; reason: string }
  | { type: "link_note_card"; noteId: string; noteTitle: string; cardId: string; cardTitle: string; reason: string }
  | { type: "add_tag";        nodeId: string; nodeTitle: string; nodeType: "note" | "card"; tagName: string; reason: string };

export interface ChatHistoryEntry {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
  reasoning?: string;
  reasoningField?: string;
  reasoningModel?: string;
  reasoningItems?: Array<Record<string, unknown>>;
}

export interface ChatMessage {
  id: ID;
  threadId: ID;
  role: ChatRole;
  content: string;
  /**
   * Reasoning / thinking text emitted by the model during generation (Claude's
   * thinking_delta, OpenAI-style delta.reasoning). Persisted so past messages
   * retain an expandable Thinking panel in the bubble; intentionally stripped
   * from compaction summaries. Empty for models that don't expose reasoning.
   */
  reasoning?: string;
  /**
   * Condensed reasoning summary (Responses `reasoning.summary`), when the
   * provider emits one. Shown in the collapsed Thinking panel in place of the
   * raw reasoning preview; absent for providers that don't support it.
   */
  reasoningSummary?: string;
  /**
   * Raw Responses reasoning items produced with this message, persisted so a
   * resumed thread can round-trip the chain-of-thought to the same model.
   */
  reasoningItems?: Array<Record<string, unknown>>;
  /** The provider field the reasoning text arrived in (round-trip target). */
  reasoningField?: string;
  /** Model key (`baseUrl::model`) that produced this message's reasoning. */
  reasoningModel?: string;
  /** Entities cited in or used to produce this message */
  contextRefs?: LinkedContextReference[];
  /** Tool calls made during this assistant turn — persisted so they remain visible after streaming ends */
  toolCalls?: ChatToolCallRecord[];
  /** Suggested connection actions for graph assistant */
  actions?: SuggestedAction[];
  /** Attachments on this message — inline base64 data URLs, ephemeral (not persisted to disk) */
  images?: Array<{ url: string; name: string; kind?: "image" | "pdf" }>;
  /** Subagent runs during this turn (subagent mode) — expandable inline traces. */
  subagents?: ChatSubagent[];
  createdAt: string;
}

// ── Idea Flow ────────────────────────────────
export type IdeaNodeType = "idea" | "note_ref" | "task_ref" | "url" | "ai_summary" | "group";

export interface IdeaNodeDataMap {
  idea:       { title: string; body?: string };
  note_ref:   { noteId: string };
  task_ref:   { cardId: string };
  url:        { url: string; title?: string; description?: string };
  ai_summary: { content: string };
  group:      { label?: string; color?: string };
}

/** Raw node as stored in / returned from the DB (data is opaque JSON). */
export interface IdeaFlowNode {
  id: ID;
  flowId: ID;
  type: IdeaNodeType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  parentId?: ID;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface IdeaFlowEdge {
  id: ID;
  flowId: ID;
  sourceNodeId: ID;
  targetNodeId: ID;
  label?: string;
  createdAt: string;
}

export interface IdeaFlow {
  id: ID;
  projectId: ID;
  createdAt: string;
  updatedAt: string;
}

/**
 * Resolved graph returned to the renderer and AI/MCP.
 * note_ref and task_ref nodes have their linked entity's data merged in.
 */
export interface ResolvedIdeaFlowNode extends IdeaFlowNode {
  // Absolute canvas position (group children store relative x/y in DB)
  absoluteX: number;
  absoluteY: number;
  // For note_ref: title + snippet from the linked note
  resolvedTitle?: string;
  resolvedSnippet?: string;
  // For task_ref: title + priority + column name from the linked card
  resolvedPriority?: string;
  resolvedColumnName?: string;
}

export interface ResolvedIdeaFlow {
  flowId: ID;
  projectId: ID;
  nodes: ResolvedIdeaFlowNode[];
  edges: IdeaFlowEdge[];
  spatial: {
    bounds: { x: number; y: number; width: number; height: number } | null;
    nextPosition: { x: number; y: number };
    groupSlots: Record<string, { x: number; y: number }>;
  };
}

// ── Knowledge Graph ───────────────────────────

export type GraphNodeType = "project" | "note" | "card" | "tag";

export type GraphEdgeType =
  | "note-note" | "note-card" | "tag-member" | "project-member"
  | "flow-ref" | "flow-edge" | "co-mention" | "keyword" | "assignee"
  | "wikilink" | "semantic";

export interface GraphNode {
  id: ID;
  type: GraphNodeType;
  title: string;
  projectId?: ID;
  workspaceId: string;
  meta?: {
    status?: string;
    priority?: string;
    assignee?: string;
    tagIds?: string[];
    isPinned?: boolean;
    snippet?: string;
    color?: string;
    isArchived?: boolean;
  };
}

export interface GraphEdge {
  id: ID;
  source: ID;
  target: ID;
  type: GraphEdgeType;
  label?: string;
  weight?: number;
  sourceSectionTitle?: string;
  targetSectionTitle?: string;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type GraphLayoutMode = "force" | "radial";

/** How the currently selected conversation is presented in the app shell. */
export type SessionPresentation = "center" | "drawer" | "workbench";

/** Session families shown by the unified conversation browser. */
export type SessionKind = "chat" | "coding" | "terminal";

export type SessionLoadState =
  | { status: "idle" }
  | { status: "loading"; sessionId: string }
  | { status: "ready"; sessionId: string }
  | { status: "error"; sessionId: string; message: string };

/** Transient object preview shown beside a centered conversation. */
export type ContextPanel =
  | { type: "note" | "task"; id: string }
  | { type: "file"; path: string }
  | { type: "diff"; path?: string };

export interface GraphFilters {
  projectIds: string[];
  nodeTypes: GraphNodeType[];
  edgeTypes: GraphEdgeType[];
  includeAuto: boolean;
}

// ── App UI State (not persisted) ──────────────
/** Deep-linkable Settings view sections. */
export type SettingsSection =
  | "general"
  | "ai"
  | "embeddings"
  | "agents"
  | "tools"
  | "commands"
  | "writing-style"
  | "plugins"
  | "mobile"
  | "sync"
  | "data"
  | "about"
  | "shortcuts"
  | "tags"
  | "extensions"
  | "system";

export interface AppUIState {
  activeWorkspaceId: ID | null;
  activeProjectId: ID | null;
  activeView: "overview" | "notes" | "board" | "flow" | "calendar" | "calendar-all" | "graph" | "insights" | "automations" | "usage" | "chat" | "search" | "settings" | "agent";
  sidebarCollapsed: boolean;
  chatOpen: boolean;
  searchOpen: boolean;
  activePreviewItem: { type: "note" | "task"; id: ID } | null;
  chatPanelResizing: boolean;
  lastContentView: "overview" | "notes" | "board" | "flow" | "calendar" | "calendar-all" | "graph" | "insights" | "automations" | "usage" | "settings" | "agent";
  seenFeatures: string[];
  tutorialActive: boolean;
  tutorialStepIndex: number;
}

// ── MCP / Chat Tool Shared Return Types ──────────

// ── Dashboard postMessage Bridge Types ───────────

/** Message sent from the dashboard iframe to the parent window. */
export type DashboardQueryMessage =
  | { type: "cairn:query"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "cairn:error"; message: string; source?: string; line?: number; col?: number; stack?: string }
  | { type: "cairn:ready" }
  | { type: "cairn:refresh" };

/** Message sent from the parent window to the dashboard iframe. */
export interface DashboardResponseMessage {
  type: "cairn:response";
  id: string;
  result?: unknown;
  error?: string;
}

/** Canonical shape returned by get_project_summary across all call sites. */
export interface ProjectSummaryColumn {
  columnName: string;
  columnType: string;
  count: number;
  cards: Array<{ id: string; title: string; priority: string; dueDate?: string | null }>;
}

export interface ProjectSummaryResult {
  project: { id: string; name: string; description?: string; status: string; priority: string; dueDate?: string | null };
  noteCount: number;
  totalCards: number;
  cardsByColumn: ProjectSummaryColumn[];
  pinnedNotes: Array<{ id: string; title: string }>;
  recentActivity: Array<{ type: "note" | "card"; id: string; title: string; updatedAt: string }>;
}

/** Wrapper for IPC handler return values — either a result or an error. */
export type IpcResult<T> = T | { error: string };

/** Type guard — returns true if the IPC result is an error object. */
export function isIpcError<T>(result: IpcResult<T>): result is { error: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    typeof (result as { error: unknown }).error === "string"
  );
}

// ── Agent message + session types ────────────────────────────────────────────
// Moved here from store/slices/terminal-sessions.ts (P5-1 of the cleanup plan)
// so all domain types live in one place. The slice re-exports them for backwards
// compatibility.

export interface AgentSubagentMessage {
  /** Unique child session ID */
  childSessionId: string;
  /** Messages streamed by the subagent */
  messages: AgentMessage[];
  /** Whether the subagent is still running */
  running: boolean;
  /** Final result returned to the parent */
  result?: string;
  /** Latest token usage from the subagent's LLM steps */
  lastUsage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: TokenBreakdown; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
}

/** One item in the agent session's todo list (todowrite tool). */
export interface SessionTodo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "error" | "system";
  content: string;
  /** Inline base64 attachment thumbnails (user messages), same shape as ChatMessage.images. */
  images?: Array<{ url: string; name: string; kind?: "image" | "pdf" }>;
  /** Same semantics as {@link ChatMessage.reasoning}. */
  reasoning?: string;
  /** Tool calls that occurred before or during this assistant message */
  toolCalls?: {
    callId: string;
    name: string;
    label: string;
    args?: Record<string, unknown>;
    running: boolean;
    ok: boolean;
    output?: string;
    cairnRef?: { type: "note" | "task"; id: string; title: string };
    confirmRequired?: boolean;
    /**
     * Per-ask nonce minted main-side and echoed back on the session runtime's
     * respond-tool event.
     * Prevents a compromised renderer from approving asks it never saw the
     * push for. Present when confirmRequired is true; cleared on settle.
     */
    approvalNonce?: string;
  }[];
  subagents?: AgentSubagentMessage[];
  isStreaming?: boolean;
  timestamp: string;
}

export interface TerminalSession {
  sessionId: string;
  taskId: string;
  taskTitle: string;
  agentId: string;
  agentName: string;
  projectId: string;
  cwd?: string;
  status: "running" | "exited";
  exitCode: number | null;
  spawnedAt: string;
  sessionType: "pty" | "coding";
  messages?: AgentMessage[];
  initialPrompt?: string;
  lastUsage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: TokenBreakdown; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  mode?: "plan" | "execute";
  /** Session persona — "automation-dev" restricts the toolset to file tools. */
  role?: "default" | "automation-dev";
  planNoteId?: string;
  /**
   * The last plan the agent committed via dsh-plan-mode's `exit_plan_mode`,
   * hydrated from the DB on session load. Preferred over planNoteId for the
   * plan-review card in plan mode and for the PlanTaskList in execute mode.
   */
  planContent?: string;
  /** Explicit plan approval choice for this session, if one was made. */
  autoApprove?: boolean;
}

export interface CodingSessionSummary {
  id: string;
  projectId: string;
  taskTitle: string;
  taskId: string | null;
  cwd: string;
  mode: "plan" | "execute";
  planNoteId: string | null;
  /**
   * The last plan the agent committed via dsh-plan-mode's `exit_plan_mode`
   * for this session (persisted by the coding-plugin's tool/call handler).
   * NULL when the session never called exit_plan_mode; sessions that used
   * the legacy PRD-note flow only will have planNoteId set instead.
   */
  planContent: string | null;
  status: "running" | "exited";
  spawnedAt: string;
  updatedAt: string;
}

// ── User writing style ──────────────────────
// Persona + full style guide + condensed cheat sheet, stored in the single-row
// `user_style` table and surfaced via the get_user_writing_style tool.

export type UserStyleSource = "none" | "guided" | "manual" | "analyzed";

export interface UserStylePersona {
  name?: string;
  role?: string;
  context?: string;
  audiences?: string;
}

export interface UserStyleRow {
  id: string;
  persona: UserStylePersona | null;
  /** The long, section-structured writing style guide (markdown). */
  fullGuide: string;
  /** The condensed one-page cheat sheet (markdown). */
  cheatsheet: string;
  /** How the guide was produced: guided wizard / manual / analyzed / none. */
  source: UserStyleSource;
  updatedAt: string;
}

export interface UserStyleSaveInput {
  persona?: UserStylePersona;
  fullGuide?: string;
  cheatsheet?: string;
  source: UserStyleSource;
}
