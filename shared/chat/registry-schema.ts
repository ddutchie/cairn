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

export interface CommunityManifest {
  version: number;
  updatedAt: string;
  mcpServers: RegistryMcpEntry[];
  services: RegistryServiceEntry[];
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

const serviceOperation = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  method,
  path: z.string().optional(),
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

// Manifest-level shape only validates the envelope; entries are validated
// individually in parseManifest so ONE bad community entry can't blank the
// whole catalog (the reject-all behaviour of z.array(z.object(...)) would).
const manifestSchema = z.object({
  version: z.number(),
  updatedAt: z.string(),
  mcpServers: z.array(z.unknown()),
  services: z.array(z.unknown()),
});

/** Parse + validate an unknown payload into a CommunityManifest, or throw. */
export function parseManifest(raw: unknown): CommunityManifest {
  const m = manifestSchema.parse(raw);
  return {
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
  } as CommunityManifest;
}
