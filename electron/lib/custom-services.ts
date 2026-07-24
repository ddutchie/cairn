/**
 * Custom HTTP Services executor — turns a user-/community-defined HTTP API into
 * a single function-calling tool the chat and agent loops can invoke.
 *
 * A service config carries a stringified OpenAI tool definition
 * (name/description/parameters), an HTTP method + URL, optional secret headers,
 * and an optional `responseKeys` allow-list used to trim the response down to
 * the fields the model actually needs (token optimisation — ported from the
 * Pinch community `optimize_service.js` semantics).
 *
 * Request shaping:
 *   - GET / DELETE → arguments become query-string params.
 *   - POST / PUT   → arguments become a JSON request body.
 *
 * Tool names are namespaced `svc__<serviceId>__<toolName>` so they never collide
 * with built-ins, MCP tools, or each other.
 *
 * Main-process only (resolves secrets + performs the network call).
 */

import { resolveSecrets } from "./secure-store";

const NS_PREFIX = "svc__";
const NS_SEP = "__";

const CALL_TIMEOUT_MS = 60_000;

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
 * the caller (external-tools) rather than imported directly so this module stays
 * free of the Electron `shell` dependency pulled in by mcp-oauth, keeping it
 * unit-testable in plain Node. Returns null when the service isn't connected or
 * a refresh fails, in which case no Authorization header is added.
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
 * schema. Strict APIs like Exa reject those with a 400 ("expected number,
 * received string"). We walk the schema's top-level `properties` and convert
 * each value to its declared type when it is safely coercible; anything not
 * described by the schema, or not cleanly coercible, is passed through
 * untouched.
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
        // Only accept the parse if its shape matches the declared type — an
        // array string for an "object" param (or vice versa) is a mismatch, so
        // fall back to the original value rather than send the wrong shape.
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
 * name at any depth (mirrors the Pinch optimiser): arrays are mapped, objects
 * keep matching keys *and* recurse into non-matching object/array values so a
 * wanted key nested deeper still surfaces. When `keys` is empty/undefined the
 * value is returned unchanged.
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
        // Only retain the nested container if it yielded something.
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

// ── Execution (impure) ────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a namespaced service tool call. Returns the (filtered) response as a
 * string for the model, or an error string — never throws into the loop.
 */
export async function callService(
  cfg: CustomServiceRuntimeConfig,
  namespaced: string,
  args: Record<string, unknown>,
  resolveBearer?: BearerResolver,
): Promise<string> {
  const parsed = parseServiceToolName(namespaced);
  if (!parsed || parsed.serviceId !== cfg.id) {
    return `Error: "${namespaced}" is not a tool of service ${cfg.id}`;
  }
  try {
    const headers = await withOAuthBearer(cfg, resolveSecrets(cfg.headers ?? {}), resolveBearer);
    const { parameters } = parseToolDefinition(cfg.toolDefinition);
    const { url, init } = buildRequest(cfg, args, headers, parameters);
    const res = await fetchWithTimeout(url, init, CALL_TIMEOUT_MS);
    const text = await res.text();
    if (!res.ok) {
      return `Error: ${cfg.method} ${cfg.apiUrl} returned ${res.status} ${res.statusText}\n${text.slice(0, 1000)}`;
    }
    const parsedBody = tryParseJson(text);
    const filtered = filterResponse(parsedBody, cfg.responseKeys);
    return typeof filtered === "string" ? filtered : JSON.stringify(filtered);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[custom-services] callService ${namespaced} failed:`, msg);
    return `Error calling ${namespaced}: ${msg}`;
  }
}

/**
 * When a service uses OAuth, resolve a fresh bearer and set the Authorization
 * header (overriding any static one). For "none" services, or when no resolver
 * is supplied, the already-resolved headers pass through unchanged. A failed
 * resolve leaves the header unset so the request surfaces a clean 401 rather
 * than sending a stale/absent token — the caller can then prompt a re-connect.
 */
async function withOAuthBearer(
  cfg: CustomServiceRuntimeConfig,
  resolvedHeaders: Record<string, string>,
  resolveBearer?: BearerResolver,
): Promise<Record<string, string>> {
  if (cfg.authMode !== "oauth" || !resolveBearer) return resolvedHeaders;
  const token = await resolveBearer(cfg.id);
  // Strip any existing Authorization header (case-insensitively) up front so a
  // failed resolve can't leave a stale/static token on the request.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(resolvedHeaders)) {
    if (k.toLowerCase() !== "authorization") out[k] = v;
  }
  if (!token) return out;
  out.Authorization = `Bearer ${token}`;
  return out;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text; // non-JSON response — return as-is
  }
}

/**
 * Settings dry-run: execute with sample args and report status. Mirrors
 * callService but surfaces the raw outcome for the test UI.
 */
export async function testService(
  cfg: CustomServiceRuntimeConfig,
  sampleArgs?: Record<string, unknown>,
  resolveBearer?: BearerResolver,
): Promise<{ ok: boolean; status?: number; preview?: string; error?: string }> {
  try {
    const headers = await withOAuthBearer(cfg, resolveSecrets(cfg.headers ?? {}), resolveBearer);
    const { parameters } = parseToolDefinition(cfg.toolDefinition);
    // When the caller doesn't supply args, synthesise a realistic body from the
    // tool's parameter schema so endpoints with required fields (e.g. a /search
    // API needing `query`) aren't rejected with a 400 just for being empty.
    const args =
      sampleArgs && Object.keys(sampleArgs).length > 0
        ? sampleArgs
        : sampleArgsFromSchema(parameters);
    const { url, init } = buildRequest(cfg, args, headers, parameters);
    const res = await fetchWithTimeout(url, init, CALL_TIMEOUT_MS);
    const text = await res.text();
    const filtered = filterResponse(tryParseJson(text), cfg.responseKeys);
    const preview = (typeof filtered === "string" ? filtered : JSON.stringify(filtered)).slice(0, 500);
    return { ok: res.ok, status: res.status, preview };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Build a minimal-but-valid sample argument object from a JSON-schema parameter
 * definition, used by the Settings "Test connection" button. Populates every
 * `required` property (and any property that declares an `example`/`default`)
 * with a representative value of the correct type. Best-effort: unknown shapes
 * fall back to a sensible primitive.
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
    // Only include required fields (plus those with an explicit example/default)
    // so the test request stays minimal and predictable.
    const hasHint = schema.example !== undefined || schema.default !== undefined;
    if (!requiredSet.has(key) && !hasHint) continue;
    out[key] = sampleValue(key, schema);
  }
  return out;
}

function sampleValue(key: string, schema: Record<string, unknown>): unknown {
  // Enum first: a valid enum member is guaranteed to satisfy the schema, whereas
  // an example/default could conflict with the enum. Fall back to example/default
  // only when there's no usable enum.
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
      // A short, human-readable placeholder. Search APIs validate a non-empty
      // query string, so "test" exercises a realistic request.
      return "test";
  }
}
