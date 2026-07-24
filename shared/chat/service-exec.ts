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

/** Where a tool argument is placed in the HTTP request. */
export type ParamLocation = "path" | "query" | "body";

/**
 * One operation of a (possibly multi-operation) HTTP service. A service groups
 * several operations that share a base URL + headers/auth; each operation is
 * exposed to the model as its own namespaced tool.
 */
export interface ServiceOperation {
  /** Un-namespaced tool name, unique within the service. */
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /**
   * Path appended to the service baseUrl, with `{placeholder}` segments filled
   * from arguments (e.g. "/repos/{owner}/{repo}/issues/{number}"). May be "" when
   * the baseUrl is already the full endpoint (legacy single-op services).
   */
  path?: string;
  /** Stringified OpenAI tool JSON (name/description/parameters) for THIS op. */
  toolDefinition: string;
  /**
   * Where each argument goes: "path" | "query" | "body". Args named by a
   * `{placeholder}` in `path` are treated as "path" automatically. Any arg not
   * listed defaults by method (query for GET/DELETE, body for POST/PUT) — so the
   * legacy behaviour is the zero-config case.
   */
  paramLocations?: Record<string, ParamLocation>;
  /**
   * Static query params ALWAYS sent for this operation (e.g. { format: "json",
   * units: "metric" }, or Open-Meteo's `current` field list). These are supplied
   * by the connector, not the model — so results don't depend on the model
   * remembering to pass an optional arg (function-calling `default`s are NOT
   * auto-applied). A model-supplied arg of the same name overrides the static one.
   */
  query?: Record<string, string>;
  /** Response key allow-list for THIS op (falls back to the service default). */
  responseKeys?: string[];
}

export interface CustomServiceRuntimeConfig {
  id: string;
  /**
   * Legacy single-op endpoint. For multi-op services use `baseUrl` + `operations`
   * instead. When `operations` is present these are ignored (normalizeOperations
   * prefers operations).
   */
  apiUrl?: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  toolDefinition?: string;
  responseKeys?: string[];
  /** Base URL shared by all operations (multi-op). Operations' `path` is appended. */
  baseUrl?: string;
  /** Multi-operation definition. When present, each becomes its own tool. */
  operations?: ServiceOperation[];
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
  const def = parseToolDefinition(cfg.toolDefinition ?? "{}");
  return {
    type: "function",
    function: {
      name: namespaceServiceTool(cfg.id, def.name),
      description: def.description,
      parameters: def.parameters,
    },
  };
}

// ── Multi-operation support (pure) ────────────────────────────────────────────

/**
 * A normalized operation resolved against its owning service — the internal
 * shape every code path uses so single-op and multi-op services share one flow.
 */
export interface ResolvedOperation {
  toolName: string; // un-namespaced
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string; // full URL (baseUrl + path), placeholders still present
  toolDefinition: string;
  paramLocations: Record<string, ParamLocation>;
  /** Static query params always sent (model args of the same name override). */
  query?: Record<string, string>;
  responseKeys?: string[];
}

/** Join a base URL and a path fragment without doubling or dropping slashes. */
function joinUrl(base: string, path?: string): string {
  if (!path) return base;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Arg names referenced as {placeholders} in a path template. */
function pathParams(path?: string): string[] {
  if (!path) return [];
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/**
 * Normalize a service config into a uniform list of operations. A multi-op
 * service yields its `operations`; a legacy single-op service (apiUrl + method +
 * toolDefinition) yields exactly one operation whose URL is the apiUrl. Path
 * placeholders are folded into paramLocations as "path" automatically.
 */
export function normalizeOperations(cfg: CustomServiceRuntimeConfig): ResolvedOperation[] {
  const ops: ServiceOperation[] =
    cfg.operations && cfg.operations.length > 0
      ? cfg.operations
      : [
          {
            name: parseToolDefinition(cfg.toolDefinition ?? "{}").name,
            method: cfg.method ?? "GET",
            path: "",
            toolDefinition: cfg.toolDefinition ?? "{}",
            responseKeys: cfg.responseKeys,
          },
        ];
  const base = cfg.baseUrl ?? cfg.apiUrl ?? "";
  return ops.map((op) => {
    const locations: Record<string, ParamLocation> = { ...(op.paramLocations ?? {}) };
    for (const p of pathParams(op.path)) locations[p] = "path";
    return {
      toolName: op.name,
      method: op.method,
      url: joinUrl(base, op.path),
      toolDefinition: op.toolDefinition,
      paramLocations: locations,
      query: op.query,
      responseKeys: op.responseKeys ?? cfg.responseKeys,
    };
  });
}

/** Every operation of a service as namespaced OpenAI function defs (one per op). */
export function serviceOperationsToOpenAI(cfg: CustomServiceRuntimeConfig): OpenAIToolDef[] {
  return normalizeOperations(cfg).map((op) => {
    const def = parseToolDefinition(op.toolDefinition);
    return {
      type: "function" as const,
      function: {
        name: namespaceServiceTool(cfg.id, def.name),
        description: def.description,
        parameters: def.parameters,
      },
    };
  });
}

/**
 * Resolve a namespaced tool name (svc__<id>__<op>) back to its operation within
 * a service config. Returns null if the name isn't one of this service's ops.
 */
export function resolveOperation(
  cfg: CustomServiceRuntimeConfig,
  namespaced: string
): ResolvedOperation | null {
  const parsed = parseServiceToolName(namespaced);
  if (!parsed || parsed.serviceId !== cfg.id) return null;
  for (const op of normalizeOperations(cfg)) {
    if (parseToolDefinition(op.toolDefinition).name === parsed.toolName) return op;
  }
  return null;
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
 * Build the final URL + fetch init for a legacy single-op service. GET/DELETE
 * put args on the query string; POST/PUT put them in a JSON body. Kept for
 * backward-compatible callers; internally delegates to buildOperationRequest via
 * a normalized single operation. Header secret refs must already be resolved.
 */
export function buildRequest(
  cfg: CustomServiceRuntimeConfig,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>,
  parameters?: Record<string, unknown>
): { url: string; init: RequestInit } {
  const [op] = normalizeOperations(cfg);
  return buildOperationRequest(op, args, resolvedHeaders, parameters);
}

/**
 * Build the URL + fetch init for a resolved operation. Arguments are placed by
 * `op.paramLocations`:
 *   - "path"  → fills a {placeholder} in the URL (URL-encoded).
 *   - "query" → query-string param.
 *   - "body"  → JSON body field.
 * Unlisted args default by method: query for GET/DELETE, body for POST/PUT (the
 * legacy zero-config behaviour). `parameters` is the op's JSON-schema parameters,
 * used to coerce stringified numbers/booleans the model may have emitted.
 */
export function buildOperationRequest(
  op: ResolvedOperation,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>,
  parameters?: Record<string, unknown>
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = { ...resolvedHeaders };
  const coerced = coerceArgs(args ?? {}, parameters);
  const defaultLoc: ParamLocation = op.method === "GET" || op.method === "DELETE" ? "query" : "body";

  // 1) Fill path placeholders, then build the URL.
  let filledPath = op.url;
  const body: Record<string, unknown> = {};
  const queryEntries: [string, unknown][] = [];

  for (const [k, v] of Object.entries(coerced)) {
    if (v === undefined || v === null) continue;
    const loc = op.paramLocations[k] ?? defaultLoc;
    if (loc === "path") {
      // Replace {k} in the URL; encode the value. If the placeholder isn't
      // present (mis-declared), fall through to query so the value isn't lost.
      const token = `{${k}}`;
      if (filledPath.includes(token)) {
        // Global replace without String.replaceAll (shared targets ES2020).
        filledPath = filledPath.split(token).join(encodeURIComponent(String(v)));
      } else {
        queryEntries.push([k, v]);
      }
    } else if (loc === "query") {
      queryEntries.push([k, v]);
    } else {
      body[k] = v;
    }
  }

  const url = new URL(filledPath);
  // Static query params first (connector-supplied), then model args — so a
  // model-provided value of the same name overrides the static default.
  for (const [k, v] of Object.entries(op.query ?? {})) {
    url.searchParams.set(k, v);
  }
  for (const [k, v] of queryEntries) {
    url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }

  let bodyStr: string | undefined;
  if (op.method === "POST" || op.method === "PUT") {
    // Always send a body for write methods (even if empty) to match prior
    // behaviour where POST/PUT stringified all args.
    bodyStr = JSON.stringify(body);
    if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
  } else if (Object.keys(body).length > 0) {
    // A GET/DELETE op that explicitly routed args to "body" (unusual but allowed).
    bodyStr = JSON.stringify(body);
    if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
  }

  return { url: url.toString(), init: { method: op.method, headers, body: bodyStr } };
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
