/**
 * AI Tool Builder engine — primitives for "describe an endpoint, get a working
 * tool". An interactive, smarter version of the Pinch community
 * `scripts/optimize_service.js`.
 *
 * Everything here runs in the MAIN process so probes use real network access and
 * secrets never reach the renderer or the LLM. The LLM only ever sees
 * `bodySample` / `jsonKeys` / `authHint` and writes secret *placeholders*.
 *
 * The pure helpers (key extraction, optimizer, param synthesis, placeholder +
 * auth-hint parsing, finalize validation) are unit-tested; `probeEndpoint` is
 * the only networked function.
 */

import { encode } from "gpt-tokenizer";
import { isPlaceholder } from "./secure-store";

// ── Constants (ported from optimize_service.js) ──────────────────────────────

/**
 * Keys that carry no useful signal for the LLM and should never be suggested as
 * responseKeys. Ported verbatim from the community optimizer.
 */
export const NOISY_KEYS = new Set([
  "success",
  "status",
  "api",
  "version",
  "query",
  "search_query",
  "type",
  "page",
  "number_of_results",
]);

/** Secret placeholder tokens (mirrors secure-store + adds builder context). */
const PLACEHOLDER_RE = /<API_KEY>|YOUR_API_KEY|<ACCESS_TOKEN>|<TOKEN>/;

/** Max bytes of response body ever handed to the LLM. */
export const BODY_SAMPLE_LIMIT = 4096;

/**
 * Hard ceiling on bytes read from a probe response. Bounds memory for huge
 * payloads while still being large enough to parse typical JSON for jsonKeys.
 */
const MAX_PROBE_READ = 256 * 1024;

const PROBE_TIMEOUT_MS = 20_000;

// ── JSON key extraction (pure) ───────────────────────────────────────────────

/**
 * Recursively collect the set of object keys in a JSON value, descending into
 * `results` / `items` arrays the way the optimizer does (so the keys of list
 * elements surface, not just the wrapper). Returns insertion-ordered unique keys.
 */
export function extractJsonKeys(value: unknown, acc: Set<string> = new Set()): string[] {
  walkKeys(value, acc);
  return [...acc];
}

function walkKeys(value: unknown, acc: Set<string>): void {
  if (Array.isArray(value)) {
    // Sample the first element (lists are homogeneous in practice).
    if (value.length > 0) walkKeys(value[0], acc);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k);
      // Descend into result-bearing containers so their element keys surface.
      if (Array.isArray(v) || (v && typeof v === "object")) walkKeys(v, acc);
    }
  }
}

// ── Optimizer port (pure) ─────────────────────────────────────────────────────

export interface ResponseKeySuggestion {
  responseKeys: string[];
  tokensBefore: number;
  tokensAfter: number;
  savedPct: number;
}

/**
 * Suggest a trimmed `responseKeys` set + token savings, porting
 * optimize_service.js: extract all keys (results/items-aware), drop NOISY_KEYS,
 * keep the rest. Token estimate compares the full JSON vs the deep-filtered JSON.
 */
export function suggestResponseKeys(jsonSample: unknown): ResponseKeySuggestion {
  const allKeys = extractJsonKeys(jsonSample);
  const responseKeys = allKeys.filter((k) => !NOISY_KEYS.has(k));

  const tokensBefore = countTokens(JSON.stringify(jsonSample));
  const filtered = deepPick(jsonSample, new Set(responseKeys));
  const tokensAfter = countTokens(JSON.stringify(filtered));
  const savedPct = tokensBefore > 0 ? Math.round((1 - tokensAfter / tokensBefore) * 100) : 0;

  return { responseKeys, tokensBefore, tokensAfter, savedPct };
}

function countTokens(s: string): number {
  try {
    return encode(s).length;
  } catch {
    return Math.ceil(s.length / 4); // rough fallback
  }
}

/** Deep allow-list pick — keeps wanted keys and recurses into their containers
 * so nested non-wanted fields are still filtered out (accurate token estimate). */
function deepPick(value: unknown, wanted: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => deepPick(v, wanted));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (wanted.has(k)) {
        // Keep the key, but still recurse into container values so unwanted
        // nested fields don't inflate the kept payload.
        out[k] = v && typeof v === "object" ? deepPick(v, wanted) : v;
      } else if (v && typeof v === "object") {
        const nested = deepPick(v, wanted);
        if (!isEmpty(nested)) out[k] = nested;
      }
    }
    return out;
  }
  return value;
}

function isEmpty(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmpty);
  if (v && typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

// ── Parameter synthesis (pure) ────────────────────────────────────────────────

/**
 * Synthesize default argument values from a tool definition's JSON-schema
 * parameters, so a probe can be made with realistic-ish inputs. Ported from the
 * optimizer: string → "test", anything else → 1, unless the schema supplies a
 * `default` or `example`.
 */
export function synthesizeParams(parameters: unknown): Record<string, unknown> {
  const schema = parameters as { properties?: Record<string, Record<string, unknown>> } | undefined;
  const props = schema?.properties;
  if (!props || typeof props !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(props)) {
    if (prop && typeof prop === "object" && "default" in prop) {
      out[name] = prop.default;
    } else if (prop && typeof prop === "object" && "example" in prop) {
      out[name] = prop.example;
    } else {
      out[name] = prop?.type === "string" ? "test" : 1;
    }
  }
  return out;
}

// ── Secret placeholders (pure) ────────────────────────────────────────────────

/** True if any header value contains an unfilled secret placeholder. */
export function hasPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value ?? "") || isPlaceholder(value);
}

/**
 * Find every header whose value is a secret placeholder — the UI prompts for
 * each and stores the real value via the secure store keyed to the new tool id.
 */
export function detectSecretHeaders(headers: Record<string, string>): string[] {
  return Object.entries(headers ?? {})
    .filter(([, v]) => hasPlaceholder(v))
    .map(([k]) => k);
}

// ── Auth hint parsing (pure) ──────────────────────────────────────────────────

export interface AuthHint {
  /** True when the probe response looks like an auth failure. */
  needsAuth: boolean;
  /** Best-guess scheme. */
  scheme?: "bearer" | "apikey" | "basic" | "query" | "unknown";
  /** Suggested header name (when scheme is header-based). */
  headerName?: string;
  /** Human-readable reason. */
  detail?: string;
}

/**
 * Inspect a probe outcome (status + WWW-Authenticate + body) to guess the auth
 * requirement, so the builder asks the user for exactly the right secret.
 */
export function parseAuthHint(
  status: number,
  responseHeaders: Record<string, string>,
  bodySample: string
): AuthHint {
  if (status !== 401 && status !== 403) return { needsAuth: false };

  const wwwAuth = headerValue(responseHeaders, "www-authenticate") ?? "";
  const body = (bodySample ?? "").toLowerCase();

  if (/bearer/i.test(wwwAuth) || /bearer token|access token/.test(body)) {
    return { needsAuth: true, scheme: "bearer", headerName: "Authorization", detail: "Bearer token required" };
  }
  if (/basic/i.test(wwwAuth)) {
    return { needsAuth: true, scheme: "basic", headerName: "Authorization", detail: "Basic auth required" };
  }
  // API-key style: look for a header name hint in body/headers.
  const apiKeyHeader = guessApiKeyHeader(responseHeaders, body);
  if (apiKeyHeader) {
    return { needsAuth: true, scheme: "apikey", headerName: apiKeyHeader, detail: `API key header ${apiKeyHeader} required` };
  }
  if (/api[_-]?key|apikey/.test(body)) {
    // Could be a query-param key (common for search APIs).
    if (/query|param|url/.test(body)) {
      return { needsAuth: true, scheme: "query", detail: "API key likely required as a query parameter" };
    }
    return { needsAuth: true, scheme: "apikey", headerName: "X-Api-Key", detail: "API key required" };
  }
  return { needsAuth: true, scheme: "unknown", detail: `Auth required (HTTP ${status})` };
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function guessApiKeyHeader(headers: Record<string, string>, body: string): string | undefined {
  for (const h of ["x-api-key", "x-apikey", "api-key", "apikey"]) {
    if (headerValue(headers, h) !== undefined) return canonicalHeader(h);
    if (body.includes(h)) return canonicalHeader(h);
  }
  return undefined;
}

function canonicalHeader(lower: string): string {
  return lower
    .split("-")
    .map((p) => (p === "api" ? "Api" : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("-");
}

// ── Probe (impure — the only network call) ────────────────────────────────────

export interface ProbeRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface ProbeResult {
  status: number;
  ok: boolean;
  contentType: string;
  headers: Record<string, string>;
  /** Truncated to BODY_SAMPLE_LIMIT before reaching the LLM. */
  bodySample: string;
  /** Parsed JSON keys (recursive, results/items-aware) — empty for non-JSON. */
  jsonKeys: string[];
  authHint: AuthHint;
  error?: string;
}

/**
 * Read a fetch Response body up to `maxBytes`, then stop pulling chunks (and
 * cancel the stream) so an oversized payload is never fully materialized. Falls
 * back to `res.text()` if the body isn't a readable stream.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== "function") {
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }
  return out.length > maxBytes ? out.slice(0, maxBytes) : out;
}

/**
 * Make a real request from the main process. GET/DELETE append `query` to the
 * URL; POST/PUT JSON-encode `body`. Returns a bounded sample + analysis. Never
 * throws — network failures surface as `{ ok:false, error }`.
 */
export async function probeEndpoint(req: ProbeRequest): Promise<ProbeResult> {
  const empty: ProbeResult = {
    status: 0,
    ok: false,
    contentType: "",
    headers: {},
    bodySample: "",
    jsonKeys: [],
    authHint: { needsAuth: false },
  };
  let url: string;
  try {
    const u = new URL(req.url);
    if ((req.method === "GET" || req.method === "DELETE") && req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v === undefined || v === null) continue;
        u.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
    }
    url = u.toString();
  } catch (e) {
    return { ...empty, error: `Invalid URL: ${e instanceof Error ? e.message : String(e)}` };
  }

  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.method === "POST" || req.method === "PUT") {
    body = JSON.stringify(req.body ?? {});
    if (headerValue(headers, "content-type") === undefined) headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(url, { method: req.method, headers, body, signal: controller.signal });
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    const contentType = res.headers.get("content-type") ?? "";
    // Read with a hard ceiling so a probe never buffers an unbounded payload.
    // We read up to MAX_PROBE_READ (enough to parse normal JSON for jsonKeys),
    // then derive the LLM-facing bodySample from the capped text.
    const rawText = await readCapped(res, MAX_PROBE_READ);
    const bodySample = rawText.slice(0, BODY_SAMPLE_LIMIT);

    let jsonKeys: string[] = [];
    if (contentType.includes("json")) {
      try {
        jsonKeys = extractJsonKeys(JSON.parse(rawText));
      } catch {
        /* malformed or truncated JSON — leave keys empty */
      }
    }

    return {
      status: res.status,
      ok: res.ok,
      contentType,
      headers: respHeaders,
      bodySample,
      jsonKeys,
      authHint: parseAuthHint(res.status, respHeaders, bodySample),
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Finalize validation (pure) ────────────────────────────────────────────────

export interface ServiceDraft {
  name: string;
  description?: string;
  apiUrl: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  toolDefinition: string;
  responseKeys?: string[];
  apiKeyUrl?: string;
}

export interface McpDraft {
  name: string;
  description?: string;
  baseUrl: string;
  transport?: "sse" | "http";
  headers?: Record<string, string>;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

/** Validate an assembled Service config before saving (disabled by default). */
export function validateServiceDraft(draft: ServiceDraft): ValidationResult<ServiceDraft> {
  const errors: string[] = [];
  if (!draft.name?.trim()) errors.push("name is required");
  if (!isHttpUrl(draft.apiUrl)) errors.push("apiUrl must be a valid http(s) URL");
  if (!["GET", "POST", "PUT", "DELETE"].includes(draft.method)) errors.push("method is invalid");
  // toolDefinition must be parseable JSON with a function name.
  try {
    const parsed = JSON.parse(draft.toolDefinition) as Record<string, unknown>;
    const fn = (parsed.function ?? parsed) as Record<string, unknown>;
    if (!fn || typeof fn.name !== "string" || !fn.name.trim()) {
      errors.push("toolDefinition must contain a function name");
    }
  } catch {
    errors.push("toolDefinition is not valid JSON");
  }
  return errors.length === 0 ? { ok: true, value: draft, errors: [] } : { ok: false, errors };
}

/** Validate an assembled MCP server config. */
export function validateMcpDraft(draft: McpDraft): ValidationResult<McpDraft> {
  const errors: string[] = [];
  if (!draft.name?.trim()) errors.push("name is required");
  if (!isHttpUrl(draft.baseUrl)) errors.push("baseUrl must be a valid http(s) URL");
  if (draft.transport && !["sse", "http"].includes(draft.transport)) errors.push("transport is invalid");
  return errors.length === 0 ? { ok: true, value: draft, errors: [] } : { ok: false, errors };
}

/** Derive the transport from a URL when not explicit (/sse → sse, else http). */
export function inferTransport(baseUrl: string): "sse" | "http" {
  return /\/sse(\b|\/|$)/i.test(baseUrl) ? "sse" : "http";
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
