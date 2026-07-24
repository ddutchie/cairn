/**
 * Custom HTTP Service — PURE request-shaping + tool-definition helpers.
 *
 * This is the framework-free core of the custom-services executor, shared by the
 * Electron desktop app and the Expo mobile app so both turn a user-/community-
 * defined HTTP API into a single function-calling tool the SAME way. The IMPURE
 * parts (network fetch, secret resolution, OAuth bearer injection) stay
 * platform-specific and live next to each platform's runtime:
 *   - desktop: electron/lib/custom-services.ts (node fetch + keychain secrets)
 *   - mobile:  (Track 2) expo/fetch + expo-secure-store
 *
 * Request shaping:
 *   - GET / DELETE → arguments become query-string params.
 *   - POST / PUT   → arguments become a JSON request body.
 *
 * Tool names are namespaced `svc__<serviceId>__<toolName>` so they never collide
 * with built-ins, MCP tools, or each other.
 *
 * No Node/Electron/RN imports → unit-testable in the root vitest suite.
 */

const NS_PREFIX = "svc__";
const NS_SEP = "__";

// ── Name namespacing (pure) ──────────────────────────────────────────────────

export function namespaceServiceTool(serviceId: string, toolName: string): string {
  return `${NS_PREFIX}${serviceId}${NS_SEP}${toolName}`;
}

export function parseServiceToolName(
  namespaced: string
): { serviceId: string; toolName: string } | null {
  if (!namespaced.startsWith(NS_PREFIX)) return null;
  const rest = namespaced.slice(NS_PREFIX.length);
  const sep = rest.indexOf(NS_SEP);
  if (sep <= 0 || sep >= rest.length - NS_SEP.length) return null;
  return { serviceId: rest.slice(0, sep), toolName: rest.slice(sep + NS_SEP.length) };
}

export function isServiceToolName(name: string): boolean {
  return name.startsWith(NS_PREFIX);
}

// ── Tool definition (pure) ────────────────────────────────────────────────────

export interface OpenAIToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface ParsedToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Parse a service's stored `toolDefinition` JSON into name/description/params.
 * Accepts either a bare `{ name, description, parameters }` object or the full
 * OpenAI `{ type:"function", function:{…} }` wrapper. Throws on invalid JSON.
 */
export function parseToolDefinition(toolDefinition: string): ParsedToolDefinition {
  const raw = JSON.parse(toolDefinition) as Record<string, unknown>;
  const fn = (raw.function ?? raw) as Record<string, unknown>;
  return {
    name: typeof fn.name === "string" ? fn.name : "call",
    description: typeof fn.description === "string" ? fn.description : "",
    parameters:
      fn.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as Record<string, unknown>)
        : { type: "object", properties: {} },
  };
}

// ── Service config (subset of CustomServiceConfig) ───────────────────────────

export interface CustomServiceRuntimeConfig {
  id: string;
  apiUrl: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  toolDefinition: string;
  responseKeys?: string[];
  /** "oauth" services inject a Bearer token resolved at call time (see resolveBearer). */
  authMode?: "none" | "oauth";
}

/**
 * Resolves a fresh OAuth bearer for an "oauth" service at call time. Injected by
 * the platform executor rather than imported directly so this module stays pure
 * and framework-free. Returns null when the service isn't connected or a refresh
 * fails, in which case no Authorization header is added.
 */
export type BearerResolver = (serviceId: string) => Promise<string | null>;

/** Convert a service config into a namespaced OpenAI function def. */
export function serviceToOpenAI(cfg: CustomServiceRuntimeConfig): OpenAIToolDef {
  const def = parseToolDefinition(cfg.toolDefinition);
  return {
    type: "function",
    function: {
      name: namespaceServiceTool(cfg.id, def.name),
      description: def.description,
      parameters: def.parameters,
    },
  };
}

// ── Request shaping (pure) ────────────────────────────────────────────────────

/**
 * Coerce model-supplied argument values to the JSON types declared in the
 * tool's parameter schema. Some models (especially smaller ones) emit numbers
 * and booleans as quoted strings (e.g. `"10"`, `"true"`) regardless of the
 * schema. Strict APIs like Exa reject those with a 400. We walk the schema's
 * top-level `properties` and convert each value to its declared type when it is
 * safely coercible; anything not described by the schema, or not cleanly
 * coercible, is passed through untouched.
 */
export function coerceArgs(
  args: Record<string, unknown>,
  parameters: Record<string, unknown> | undefined
): Record<string, unknown> {
  const props =
    parameters && typeof parameters === "object"
      ? (parameters.properties as Record<string, unknown> | undefined)
      : undefined;
  if (!props || typeof props !== "object") return { ...args };

  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args ?? {})) {
    const schema = props[key] as Record<string, unknown> | undefined;
    const declared = schema && typeof schema === "object" ? schema.type : undefined;
    out[key] = coerceValue(value, declared);
  }
  return out;
}

function coerceValue(value: unknown, declared: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();

  if (declared === "number" || declared === "integer") {
    if (trimmed === "" || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)) return value;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return value;
    return declared === "integer" ? Math.trunc(n) : n;
  }
  if (declared === "boolean") {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return value;
  }
  if (declared === "array" || declared === "object") {
    // Models sometimes send JSON-encoded strings for structured params.
    if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      try {
        const parsed = JSON.parse(trimmed);
        // Only accept the parse if its shape matches the declared type.
        const shapeOk = declared === "array" ? Array.isArray(parsed) : isPlainObject(parsed);
        return shapeOk ? parsed : value;
      } catch {
        return value;
      }
    }
  }
  return value;
}

/** True for a non-null, non-array JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the final URL + fetch init for a call. GET/DELETE put args on the query
 * string; POST/PUT put them in a JSON body. Header secret refs are resolved by
 * the caller before this runs (kept pure here for testing) — pass already-
 * resolved headers. `parameters` is the tool's JSON-schema parameter object,
 * used to coerce stringified numbers/booleans the model may have emitted.
 */
export function buildRequest(
  cfg: CustomServiceRuntimeConfig,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>,
  parameters?: Record<string, unknown>
): { url: string; init: RequestInit } {
  const usesQuery = cfg.method === "GET" || cfg.method === "DELETE";
  const url = new URL(cfg.apiUrl);
  const headers: Record<string, string> = { ...resolvedHeaders };
  const coerced = coerceArgs(args ?? {}, parameters);
  let body: string | undefined;

  if (usesQuery) {
    for (const [k, v] of Object.entries(coerced)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  } else {
    body = JSON.stringify(coerced);
    if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
  }

  return { url: url.toString(), init: { method: cfg.method, headers, body } };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

// ── Response filtering (pure) ─────────────────────────────────────────────────

/**
 * Deep-filter a response value to only the keys in `keys`. Matching is by key
 * name at any depth: arrays are mapped, objects keep matching keys *and* recurse
 * into non-matching object/array values so a wanted key nested deeper still
 * surfaces. When `keys` is empty/undefined the value is returned unchanged.
 */
export function filterResponse(value: unknown, keys?: string[]): unknown {
  if (!keys || keys.length === 0) return value;
  const wanted = new Set(keys);
  return pick(value, wanted);
}

function pick(value: unknown, wanted: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => pick(item, wanted));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (wanted.has(k)) {
        out[k] = v; // keep the whole subtree of an explicitly wanted key
      } else if (v && typeof v === "object") {
        const nested = pick(v, wanted);
        if (!isEmptyContainer(nested)) out[k] = nested;
      }
    }
    return out;
  }
  return value;
}

function isEmptyContainer(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmptyContainer);
  if (v && typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

// ── Sample args (pure) — used by the Settings "Test connection" dry-run ───────

/**
 * Build a minimal-but-valid sample argument object from a JSON-schema parameter
 * definition. Populates every `required` property (and any property that
 * declares an `example`/`default`) with a representative value of the correct
 * type. Best-effort: unknown shapes fall back to a sensible primitive.
 */
export function sampleArgsFromSchema(parameters: Record<string, unknown> | undefined): Record<string, unknown> {
  const props =
    parameters && typeof parameters === "object"
      ? (parameters.properties as Record<string, unknown> | undefined)
      : undefined;
  if (!props || typeof props !== "object") return {};

  const required = Array.isArray((parameters as Record<string, unknown>).required)
    ? ((parameters as Record<string, unknown>).required as string[])
    : [];
  const requiredSet = new Set(required);

  const out: Record<string, unknown> = {};
  for (const [key, rawSchema] of Object.entries(props)) {
    const schema = (rawSchema && typeof rawSchema === "object" ? rawSchema : {}) as Record<string, unknown>;
    const hasHint = schema.example !== undefined || schema.default !== undefined;
    if (!requiredSet.has(key) && !hasHint) continue;
    out[key] = sampleValue(key, schema);
  }
  return out;
}

function sampleValue(key: string, schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;

  switch (schema.type) {
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array": {
      const items = (schema.items && typeof schema.items === "object" ? schema.items : {}) as Record<string, unknown>;
      return [sampleValue(key, items)];
    }
    case "object": {
      const nested = schema.properties && typeof schema.properties === "object"
        ? sampleArgsFromSchema(schema)
        : {};
      return nested;
    }
    case "string":
    default:
      return "test";
  }
}
