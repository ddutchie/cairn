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
}

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
 * Build the final URL + fetch init for a call. GET/DELETE put args on the query
 * string; POST/PUT put them in a JSON body. Header secret refs are resolved by
 * the caller before this runs (kept pure here for testing) — pass already-
 * resolved headers.
 */
export function buildRequest(
  cfg: CustomServiceRuntimeConfig,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>
): { url: string; init: RequestInit } {
  const usesQuery = cfg.method === "GET" || cfg.method === "DELETE";
  const url = new URL(cfg.apiUrl);
  const headers: Record<string, string> = { ...resolvedHeaders };
  let body: string | undefined;

  if (usesQuery) {
    for (const [k, v] of Object.entries(args ?? {})) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  } else {
    body = JSON.stringify(args ?? {});
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
  args: Record<string, unknown>
): Promise<string> {
  const parsed = parseServiceToolName(namespaced);
  if (!parsed || parsed.serviceId !== cfg.id) {
    return `Error: "${namespaced}" is not a tool of service ${cfg.id}`;
  }
  try {
    const headers = resolveSecrets(cfg.headers ?? {});
    const { url, init } = buildRequest(cfg, args, headers);
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
  sampleArgs: Record<string, unknown> = {}
): Promise<{ ok: boolean; status?: number; preview?: string; error?: string }> {
  try {
    const headers = resolveSecrets(cfg.headers ?? {});
    const { url, init } = buildRequest(cfg, sampleArgs, headers);
    const res = await fetchWithTimeout(url, init, CALL_TIMEOUT_MS);
    const text = await res.text();
    const filtered = filterResponse(tryParseJson(text), cfg.responseKeys);
    const preview = (typeof filtered === "string" ? filtered : JSON.stringify(filtered)).slice(0, 500);
    return { ok: res.ok, status: res.status, preview };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
