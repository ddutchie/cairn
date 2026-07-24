/**
 * Custom HTTP Services executor (Electron) — network + secret-resolution layer.
 *
 * The PURE request-shaping + tool-definition core now lives in
 * `shared/chat/service-exec.ts` so desktop and mobile share one implementation
 * (name namespacing, tool-def parsing, arg coercion, request building, response
 * filtering, sample args). This module keeps only the IMPURE Electron parts:
 * resolving keychain header secrets, injecting an OAuth bearer, and performing
 * the network call.
 *
 * Main-process only (resolves secrets + performs the network call).
 */

import { resolveSecrets } from "./secure-store";
import {
  parseToolDefinition,
  resolveOperation,
  normalizeOperations,
  buildOperationRequest,
  filterResponse,
  sampleArgsFromSchema,
  type CustomServiceRuntimeConfig,
  type BearerResolver,
} from "../../shared/chat/service-exec";

// Re-export the shared pure surface so existing `import * as services` call
// sites (external-tools.ts, ipc/tools.ts) keep resolving every symbol here.
export {
  namespaceServiceTool,
  parseServiceToolName,
  isServiceToolName,
  parseToolDefinition,
  serviceToOpenAI,
  serviceOperationsToOpenAI,
  resolveOperation,
  normalizeOperations,
  coerceArgs,
  buildRequest,
  buildOperationRequest,
  filterResponse,
  sampleArgsFromSchema,
  type OpenAIToolDef,
  type CustomServiceRuntimeConfig,
  type ServiceOperation,
  type BearerResolver,
} from "../../shared/chat/service-exec";

const CALL_TIMEOUT_MS = 60_000;

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
  const op = resolveOperation(cfg, namespaced);
  if (!op) {
    return `Error: "${namespaced}" is not a tool of service ${cfg.id}`;
  }
  try {
    const headers = await withOAuthBearer(cfg, resolveSecrets(cfg.headers ?? {}), resolveBearer);
    const { parameters } = parseToolDefinition(op.toolDefinition);
    const { url, init } = buildOperationRequest(op, args, headers, parameters);
    const res = await fetchWithTimeout(url, init, CALL_TIMEOUT_MS);
    const text = await res.text();
    if (!res.ok) {
      return `Error: ${op.method} ${op.url} returned ${res.status} ${res.statusText}\n${text.slice(0, 1000)}`;
    }
    const parsedBody = tryParseJson(text);
    const filtered = filterResponse(parsedBody, op.responseKeys);
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
  /** Which operation to test (namespaced tool name); defaults to the first. */
  namespaced?: string,
): Promise<{ ok: boolean; status?: number; preview?: string; error?: string }> {
  try {
    const op = namespaced
      ? resolveOperation(cfg, namespaced)
      : normalizeOperations(cfg)[0];
    if (!op) return { ok: false, error: "Service has no operations to test." };
    const headers = await withOAuthBearer(cfg, resolveSecrets(cfg.headers ?? {}), resolveBearer);
    const { parameters } = parseToolDefinition(op.toolDefinition);
    // When the caller doesn't supply args, synthesise a realistic body from the
    // tool's parameter schema so endpoints with required fields (e.g. a /search
    // API needing `query`) aren't rejected with a 400 just for being empty.
    const args =
      sampleArgs && Object.keys(sampleArgs).length > 0
        ? sampleArgs
        : sampleArgsFromSchema(parameters);
    const { url, init } = buildOperationRequest(op, args, headers, parameters);
    const res = await fetchWithTimeout(url, init, CALL_TIMEOUT_MS);
    const text = await res.text();
    const filtered = filterResponse(tryParseJson(text), op.responseKeys);
    const preview = (typeof filtered === "string" ? filtered : JSON.stringify(filtered)).slice(0, 500);
    return { ok: res.ok, status: res.status, preview };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
