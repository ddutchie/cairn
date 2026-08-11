/**
 * Community registry — shared manifest TYPES + Zod validation + parseManifest.
 *
 * The cairn-community manifest (the catalog of installable MCP servers + HTTP
 * services) is validated the SAME way on every platform, so this schema-and-type
 * core is shared. Platform-specific I/O (how the manifest is fetched + cached)
 * stays per-platform:
 *   - desktop: electron/lib/community-registry.ts (node fetch + ETag + fs cache)
 *   - mobile:  (Track 2) expo/fetch + a cached row in the meta DB
 *
 * Validation is fail-soft at the ENTRY level: `parseManifest` validates the
 * envelope strictly but drops individual malformed entries rather than rejecting
 * the whole catalog, so one bad community contribution can't blank the list.
 *
 * Dependency: `zod` only (present on both desktop + mobile at the same major).
 */

import * as z from "zod";

/**
 * Shared ceiling for a personality prompt (behavioural rules appended verbatim
 * to the chat system prompt). Enforced by the registry schema (zod .max), the
 * custom-personality forms (maxLength) and withPersonality (truncation) so an
 * oversized prompt can never bloat the system prompt.
 */
export const MAX_PERSONALITY_PROMPT_CHARS = 4000;

// ── Types (mirror src/types/index.ts; wired to the renderer by IPC strings) ──

export interface RegistryEntryMeta {
  id: string;
  author: string;
  version: string;
  category?: string;
  tags: string[];
  blurb: string;
  brandColor?: string;
  homepage?: string;
  /** Brand logo, compiled + allowlist-sanitized by cairn-community CI. */
  iconSvg?: string;
}

export interface RegistryMcpEntry extends RegistryEntryMeta {
  definition: {
    name: string;
    description?: string;
    transport: "sse" | "http";
    baseUrl: string;
    headers?: Record<string, string>;
    authMode?: "none" | "oauth";
    oauthScope?: string;
    /**
     * Optional pre-registered OAuth client id (confidential OAuth, skips DCR).
     * Client secrets are NEVER allowed in a manifest — the user enters theirs
     * after install.
     */
    oauthClientId?: string;
    /** Optional fixed redirect URI the provider requires pre-registered. */
    oauthRedirectUri?: string;
    /**
     * True when this provider forbids dynamic client registration, so the user
     * must supply a pre-registered client id (+ redirect URI) to connect. The
     * UI surfaces those fields and routes "Sign in" to them.
     */
    requiresClientId?: boolean;
    disabledTools?: string[];
    enabled: boolean;
  };
}

/** One operation of a multi-operation HTTP service. */
export interface RegistryServiceOperation {
  name: string;
  description?: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path?: string;
  toolDefinition: string;
  paramLocations?: Record<string, "path" | "query" | "body">;
  query?: Record<string, string>;
  responseKeys?: string[];
}

export interface RegistryServiceEntry extends RegistryEntryMeta {
  definition: {
    name: string;
    description?: string;
    /** Legacy single-op endpoint. Use baseUrl + operations for multi-op. */
    apiUrl?: string;
    method?: "GET" | "POST" | "PUT" | "DELETE";
    headers?: Record<string, string>;
    /** Legacy single-op tool. */
    toolDefinition?: string;
    /** Base URL shared by all operations (multi-op). */
    baseUrl?: string;
    /** Multi-operation definition — each becomes its own namespaced tool. */
    operations?: RegistryServiceOperation[];
    responseKeys?: string[];
    apiKeyUrl?: string;
    authMode?: "none" | "oauth";
    oauth?: { serverUrl?: string; scope?: string; clientId?: string; redirectUri?: string; authorizationUrl?: string; tokenUrl?: string };
    enabled: boolean;
  };
}

/**
 * A community slash command — a reusable prompt/text snippet surfaced in Cairn's
 * chat and/or agent input palettes. Installed workspace-globally; never executes
 * code, only inserts `insertText` into the input.
 */
export interface RegistryCommandEntry extends RegistryEntryMeta {
  definition: {
    name: string;
    description?: string;
    insertText: string;
    scope: "chat" | "agent" | "both";
  };
}

export interface CommunityManifest {
  version: number;
  updatedAt: string;
  mcpServers: RegistryMcpEntry[];
  services: RegistryServiceEntry[];
  /** Community slash commands (manifest v2+). Absent on older manifests. */
  commands: RegistryCommandEntry[];
}

/**
 * An external connector a recipe needs in scope to do its job — an MCP server
 * or a custom HTTP service. `name` matches the connector's catalog id (slug,
 * e.g. "linear") OR its display definition.name ("Linear"), case-insensitively.
 * Recipes that declare `requires` are connector-aware: their runs are offered
 * the project's attached external tools, and external tool calls are gated
 * behind the approval inbox by default (never auto-approved).
 */
export interface RegistryRequirement {
  kind: "mcp" | "service";
  name: string;
}

/**
 * A community automation recipe — a reusable scheduled background task.
 * Selecting one in the New Automation flow PRE-FILLS the form (name,
 * instructions, schedule, approval mode) so the user can tweak it and save.
 * Recipes only use the data-only knowledge-work toolset (notes/tasks/tags/
 * boards) — never shell/file edits.
 */
export interface RegistryAutomationEntry extends RegistryEntryMeta {
  definition: {
    /** Display name prefilled into the automation. */
    name: string;
    description?: string;
    /** Prompt replayed on every run. */
    instructions: string;
    schedule: {
      kind: "cron" | "every" | "once";
      /** cron (5-field) | "every N minutes/hours/days/weeks" | ISO datetime. */
      expr: string;
      timezone?: string;
    };
    /** auto (default) = writes run freely; ask = gate writes behind the approval inbox. */
    approvalMode?: "auto" | "ask";
    maxRuns?: number;
    /**
     * External connectors (MCP servers / HTTP services) the recipe needs in
     * scope. When present, the automation is connector-aware: the runner loads
     * the project's attached external tools, and external tool calls are
     * DEFAULT-gated to the approval inbox (never auto-approved side effects).
     */
    requires?: RegistryRequirement[];
  };
}

/** The parsed cairn-community AUTOMATIONS manifest (automations.json). */
export interface AutomationsManifest {
  version: number;
  updatedAt: string;
  automations: RegistryAutomationEntry[];
}

/**
 * A community AI provider — a one-click preset for an OpenAI-compatible endpoint
 * (base URL + default model). Installed into the shared `savedProviders` list;
 * the user just enters their API key (stored in the OS keychain). Kept in a
 * SEPARATE manifest (providers.json) from the tools/commands catalog so the two
 * can evolve independently.
 */
export interface RegistryProviderEntry extends RegistryEntryMeta {
  definition: {
    /** Label seeded into the saved provider's `name`. */
    name: string;
    /** OpenAI-compatible chat-completions endpoint root. */
    baseUrl: string;
    /** Default model id to seed the provider with. */
    defaultModel?: string;
    /** Whether this endpoint requires an API key (false = keyless / local). */
    needsApiKey: boolean;
    /** Where the user can obtain an API key (rendered as a "Get a key" link). */
    apiKeyUrl?: string;
    /** Optional curated model ids offered by the picker before a live /models fetch. */
    models?: string[];
    /**
     * Optional credit/balance lookup for this provider. When present, the app
     * queries this endpoint (instead of the default `{base}/v1/key` probe) to
     * show remaining credits, and parses the response per `shape`. Absent =
     * provider exposes no balance API (UI hides the display).
     */
    credits?: ProviderCreditsSpec;
  };
}

/**
 * How to locate + interpret a provider's credit/balance endpoint. `url` is an
 * absolute HTTPS endpoint (some providers expose balance off the chat
 * base, e.g. DeepSeek at the host root); `shape` selects the response parser.
 */
export interface ProviderCreditsSpec {
  /** Absolute HTTPS endpoint returning the provider's credit/balance info. */
  url: string;
  /**
   * Response-shape parser:
   *  - "openrouter"    — { data: { limit, limit_remaining, usage, is_free_tier } } (USD)
   *  - "deepseek"      — { is_available, balance_infos: [{ currency, total_balance, ... }] }
   *  - "openai-grants" — { total_granted, total_used, total_available } (USD, legacy/undocumented)
   *  - "neuralwatt"    — { balance: { credits_remaining_usd, total_credits_usd, credits_used_usd } } (USD)
   */
  shape: "openrouter" | "deepseek" | "openai-grants" | "neuralwatt";
}

/** The parsed cairn-community PROVIDERS manifest (providers.json). */
export interface ProvidersManifest {
  version: number;
  updatedAt: string;
  providers: RegistryProviderEntry[];
}

/**
 * A community personality — a set of behavioral rules appended verbatim to
 * Cairn's chat system prompt to shape the assistant's tone and style. Installed
 * into `aiConfig.installedPersonalities` and picked next to the model selector
 * in chat. Kept in a SEPARATE manifest (personalities.json) from the tools
 * catalog so the two can evolve independently.
 */
export interface RegistryPersonalityEntry extends RegistryEntryMeta {
  definition: {
    /** Display name shown in the personality picker. */
    name: string;
    /** One line shown in the browse card and picker list. */
    description?: string;
    /**
     * Behavioral rules appended to the chat system prompt. A style LAYER on the
     * existing "You are the Cairn AI assistant" identity — must NOT open with a
     * "You are …" identity claim (CI rejects those upstream).
     */
    prompt: string;
  };
}

/** The parsed cairn-community PERSONALITIES manifest (personalities.json). */
export interface PersonalitiesManifest {
  version: number;
  updatedAt: string;
  personalities: RegistryPersonalityEntry[];
}

// ── validation (mirrors cairn-community/schema.json) ────────────────────────

const headers = z.record(z.string(), z.string()).optional();

const mcpDefinition = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  transport: z.enum(["sse", "http"]),
  baseUrl: z.string().url().startsWith("https://"),
  headers,
  authMode: z.enum(["none", "oauth"]).optional(),
  oauthScope: z.string().optional(),
  oauthClientId: z.string().optional(),
  oauthRedirectUri: z.string().optional(),
  requiresClientId: z.boolean().optional(),
  disabledTools: z.array(z.string()).optional(),
  enabled: z.boolean(),
});

const oauthConfig = z
  .object({
    serverUrl: z.string().url().startsWith("https://").optional(),
    scope: z.string().optional(),
    clientId: z.string().optional(),
    redirectUri: z.string().optional(),
    authorizationUrl: z.string().url().startsWith("https://").optional(),
    tokenUrl: z.string().url().startsWith("https://").optional(),
  })
  .optional();

const method = z.enum(["GET", "POST", "PUT", "DELETE"]);
const paramLocations = z.record(z.string(), z.enum(["path", "query", "body"])).optional();

/**
 * An operation `path` must be RELATIVE — it is appended to the service baseUrl,
 * so it must not carry its own scheme/host or the request could be redirected to
 * a different origin than the one shown + trusted at install time. Reject absolute
 * URLs ("https://…"), scheme-relative values ("//host") and any embedded scheme.
 */
const relativePath = z
  .string()
  .refine(
    (p) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(p) && !p.startsWith("//") && !p.includes("://"),
    { message: "operation path must be relative to baseUrl (no scheme or host)" }
  );

const serviceOperation = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  method,
  path: relativePath.optional(),
  toolDefinition: z.string().min(1),
  paramLocations,
  query: z.record(z.string(), z.string()).optional(),
  responseKeys: z.array(z.string()).optional(),
});

const serviceDefinition = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    // Legacy single-op fields (optional now that operations[] exists).
    apiUrl: z.string().url().startsWith("https://").optional(),
    method: method.optional(),
    headers,
    toolDefinition: z.string().min(1).optional(),
    // Multi-op fields.
    baseUrl: z.string().url().startsWith("https://").optional(),
    operations: z.array(serviceOperation).optional(),
    responseKeys: z.array(z.string()).optional(),
    apiKeyUrl: z.string().url().startsWith("https://").optional(),
    authMode: z.enum(["none", "oauth"]).optional(),
    oauth: oauthConfig,
    enabled: z.boolean(),
  })
  // A service is valid if it's either legacy single-op (apiUrl+method+
  // toolDefinition) OR multi-op (baseUrl+operations). Reject a def that is
  // neither, so a malformed connector is caught at parse time.
  .refine(
    (d) =>
      (d.operations && d.operations.length > 0 && d.baseUrl) ||
      (d.apiUrl && d.method && d.toolDefinition),
    { message: "service must define either baseUrl+operations or apiUrl+method+toolDefinition" }
  );

const entryMeta = {
  id: z.string(),
  author: z.string(),
  version: z.string(),
  category: z.string().optional(),
  tags: z.array(z.string()),
  blurb: z.string(),
  brandColor: z.string().optional(),
  // Validated as an https URL — it is rendered as an anchor href in the Browse
  // modal, so an unvalidated string could smuggle a javascript:/data: URI.
  homepage: z.string().url().startsWith("https://").optional(),
  // Brand logo, compiled + allowlist-sanitized by cairn-community CI (never raw
  // user SVG). Rendered inline by ConnectorLogo. Absent → app fallback glyph.
  iconSvg: z.string().optional(),
};

const mcpEntry = z.object({ ...entryMeta, definition: mcpDefinition }).passthrough();
const serviceEntry = z.object({ ...entryMeta, definition: serviceDefinition }).passthrough();

const commandDefinition = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().optional(),
  insertText: z.string().min(1),
  scope: z.enum(["chat", "agent", "both"]),
});

const commandEntry = z.object({ ...entryMeta, definition: commandDefinition }).passthrough();

const automationSchedule = z.object({
  kind: z.enum(["cron", "every", "once"]),
  expr: z.string().min(1),
  timezone: z.string().optional(),
});

const automationRequirement = z.object({
  kind: z.enum(["mcp", "service"]),
  name: z.string().min(1),
});

const automationDefinition = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string().min(10),
  schedule: automationSchedule,
  approvalMode: z.enum(["auto", "ask"]).optional(),
  maxRuns: z.number().int().min(1).optional(),
  // Fail-soft at the ENTRY level like every other field: a recipe with a
  // malformed requirement drops the whole recipe (safeParse on the entry),
  // it never blanks the catalog.
  requires: z.array(automationRequirement).optional(),
});

const automationEntry = z.object({ ...entryMeta, definition: automationDefinition }).passthrough();

// Manifest-level shape only validates the envelope; entries are validated
// individually in parseManifest so ONE bad community entry can't blank the
// whole catalog (the reject-all behaviour of z.array(z.object(...)) would).
// `commands` is optional so a pre-v2 manifest (no commands key) still parses.
const manifestSchema = z.object({
  version: z.number(),
  updatedAt: z.string(),
  mcpServers: z.array(z.unknown()),
  services: z.array(z.unknown()),
  commands: z.array(z.unknown()).optional(),
});

/** Parse + validate an unknown payload into a CommunityManifest, or throw. */
export function parseManifest(raw: unknown): CommunityManifest {
  const m = manifestSchema.parse(raw);  return {
    version: m.version,
    updatedAt: m.updatedAt,
    // Drop malformed entries individually rather than failing the whole parse.
    mcpServers: m.mcpServers.flatMap((e) => {
      const r = mcpEntry.safeParse(e);
      return r.success ? [r.data] : [];
    }),
    services: m.services.flatMap((e) => {
      const r = serviceEntry.safeParse(e);
      return r.success ? [r.data] : [];
    }),
    commands: (m.commands ?? []).flatMap((e) => {
      const r = commandEntry.safeParse(e);
      return r.success ? [r.data] : [];
    }),
  } as CommunityManifest;
}

// ── automations manifest (automations.json) ─────────────────────────────────

// Envelope-only validation; entries validated individually in
// parseAutomationsManifest so one bad recipe can't blank the catalog.
const automationsManifestSchema = z.object({
  version: z.number(),
  updatedAt: z.string(),
  automations: z.array(z.unknown()),
});

/** Parse + validate an unknown payload into an AutomationsManifest, or throw. */
export function parseAutomationsManifest(raw: unknown): AutomationsManifest {
  const m = automationsManifestSchema.parse(raw);
  return {
    version: m.version,
    updatedAt: m.updatedAt,
    automations: m.automations.flatMap((e) => {
      const r = automationEntry.safeParse(e);
      return r.success ? [r.data] : [];
    }),
  } as AutomationsManifest;
}

// ── providers manifest (providers.json) ─────────────────────────────────────

const providerDefinition = z.object({
  name: z.string().min(1),
  // OpenAI-compatible endpoint root. Must be https so a community entry can't
  // point the app at a plaintext origin.
  baseUrl: z.string().url().startsWith("https://"),
  defaultModel: z.string().optional(),
  needsApiKey: z.boolean(),
  // Rendered as a "Get a key" anchor href — validate as https for the same
  // reason homepage is (no javascript:/data: smuggling).
  apiKeyUrl: z.string().url().startsWith("https://").optional(),
  models: z.array(z.string()).optional(),
  // Credit/balance lookup descriptor. `url` must be https (same rationale as
  // baseUrl/apiKeyUrl — a community entry can't point the app at plaintext).
  credits: z
    .object({
      url: z.string().url().startsWith("https://"),
      shape: z.enum(["openrouter", "deepseek", "openai-grants", "neuralwatt"]),
    })
    .optional(),
});

const providerEntry = z.object({ ...entryMeta, definition: providerDefinition }).passthrough();

// Envelope-only validation; entries validated individually in
// parseProvidersManifest so one bad entry can't blank the catalog.
const providersManifestSchema = z.object({
  version: z.number(),
  updatedAt: z.string(),
  providers: z.array(z.unknown()),
});

/** Parse + validate an unknown payload into a ProvidersManifest, or throw. */
export function parseProvidersManifest(raw: unknown): ProvidersManifest {
  const m = providersManifestSchema.parse(raw);
  return {
    version: m.version,
    updatedAt: m.updatedAt,
    providers: m.providers.flatMap((e) => {
      const r = providerEntry.safeParse(e);
      return r.success ? [r.data] : [];
    }),
  } as ProvidersManifest;
}

// ── personalities manifest (personalities.json) ──────────────────────────────

const personalityDefinition = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  // A personality is a STYLE LAYER on the existing Cairn assistant identity. An
  // opening "You are …" claim would contradict the base system prompt, so it is
  // rejected here (mirrors the cairn-community validator). Min 20 chars keeps
  // thin one-liners that add nothing to the prompt out of the catalog; the max
  // (shared MAX_PERSONALITY_PROMPT_CHARS) keeps the appended layer compact.
  prompt: z
    .string()
    .min(20)
    .max(MAX_PERSONALITY_PROMPT_CHARS)
    .refine((p) => !/^you\s+are/i.test(p.trim()), {
      message: "prompt must not start with a 'You are …' identity claim",
    }),
});

const personalityEntry = z.object({ ...entryMeta, definition: personalityDefinition }).passthrough();

// Envelope-only validation; entries validated individually in
// parsePersonalitiesManifest so one bad entry can't blank the catalog.
const personalitiesManifestSchema = z.object({
  version: z.number(),
  updatedAt: z.string(),
  personalities: z.array(z.unknown()),
});

/** Parse + validate an unknown payload into a PersonalitiesManifest, or throw. */
export function parsePersonalitiesManifest(raw: unknown): PersonalitiesManifest {
  const m = personalitiesManifestSchema.parse(raw);
  return {
    version: m.version,
    updatedAt: m.updatedAt,
    personalities: m.personalities.flatMap((e) => {
      const r = personalityEntry.safeParse(e);
      return r.success ? [r.data] : [];
    }),
  } as PersonalitiesManifest;
}
