/**
 * Shared LLM HTTP helper (Q9 — narrows issue #179).
 *
 * Single home for the hand-built OpenAI-compatible Bearer requests that
 * survived the A2 transport removal:
 *   - `ipc/ai-handlers.ts` (`ai:fetchModels`, `ai:probeProtocols`)
 *   - `ipc/tool-builder-handlers.ts` (`callModel`)
 *   - `lib/provider-credits.ts` (`probeCredits`)
 *   - `lib/bench-endpoint.ts` (`endpointUp`)
 *
 * Deliberately NOT covered: `lib/tool-builder.ts` `probeEndpoint` — that is a
 * generic user-URL probe with its own bespoke capped reader, not an LLM call.
 *
 * Timeout: one default (`LLM_HTTP_TIMEOUT_MS`) for all of the above. Before,
 * the sites disagreed (12s model list / key-info, 10s protocol probe, 2.5s
 * reachability, no timeout on the builder model call). No test pinned any of
 * those values; 10s matches the most deliberate existing usage (the protocol
 * probe's `AbortSignal.timeout(10_000)`).
 */

export const LLM_HTTP_TIMEOUT_MS = 10_000;

/**
 * Authorization headers for an OpenAI-compatible endpoint. Bearer always;
 * `x-api-key` as well when `apiKeyHeader` is set (Anthropic-style gateways —
 * today only the `ai:probeProtocols` probes need both). Empty key → no headers.
 */
export function authHeaders(
  apiKey?: string | null,
  opts?: { apiKeyHeader?: boolean },
): Record<string, string> {
  if (!apiKey) return {};
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (opts?.apiKeyHeader) headers["x-api-key"] = apiKey;
  return headers;
}

export interface LlmFetchOptions extends Omit<RequestInit, "signal" | "headers"> {
  /** Raw API key. Never a keychain ref — callers resolve via `resolveLlmApiKey` first. */
  apiKey?: string | null;
  /** Also send `x-api-key` alongside `Authorization: Bearer`. */
  apiKeyHeader?: boolean;
  headers?: Record<string, string>;
  /** Outer signal (e.g. a session abort); combined with the timeout, not replaced. */
  signal?: AbortSignal | null;
  /** Per-call override; defaults to `LLM_HTTP_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * `fetch` for OpenAI-compatible endpoints: applies `authHeaders` and bounds the
 * request with `timeoutMs` (combined with an outer `signal` when given).
 * Returns the `Response` as-is — status/body handling stays with the caller
 * (probes classify non-2xx statuses instead of throwing on them).
 */
export async function fetchJson(url: string, opts: LlmFetchOptions = {}): Promise<Response> {
  const { apiKey, apiKeyHeader, signal, timeoutMs = LLM_HTTP_TIMEOUT_MS, headers, ...init } = opts;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return fetch(url, {
    ...init,
    headers: { ...authHeaders(apiKey, { apiKeyHeader }), ...headers },
    signal: combined,
  });
}
