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
    oauth?: { serverUrl?: string; scope?: string; clientId?: string; authorizationUrl?: string; tokenUrl?: string };
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
  disabledTools: z.array(z.string()).optional(),
  enabled: z.boolean(),
});

const oauthConfig = z
  .object({
    serverUrl: z.string().url().startsWith("https://").optional(),
    scope: z.string().optional(),
    clientId: z.string().optional(),
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
