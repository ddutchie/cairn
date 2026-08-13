/**
 * LLM transport — the single seam the chat / agent / subagent loops and the
 * one-shot callers go through to talk to a model provider.
 *
 * Two wire protocols behind one interface:
 *
 *   - `completions` — the de-facto industry standard `/v1/chat/completions`
 *     surface (OpenRouter, Together, Groq, LM Studio, Ollama, llama.cpp, …).
 *   - `responses`    — the Responses API (`/v1/responses`), now standardised as
 *     the multi-provider Open Responses spec (openresponses.org), backed by
 *     OpenAI, OpenRouter, LM Studio, Ollama, vLLM, NVIDIA, AWS, Hugging Face,
 *     Databricks, Red Hat, Llama Stack, and Vercel's AI SDK.
 *
 * `resolveTransport` chooses one per base URL and CACHES the answer:
 *
 *   1. static allowlist (`isResponsesEndpoint`) — ONLY api.openai.com and Azure
 *      resolve to `responses` with no network I/O; the opencode zen proxy is
 *      NOT allowlisted, so it follows the probe path like any other provider;
 *   2. otherwise probe `/responses` ONCE (a route-semantics check — an empty
 *      body that a Responses endpoint rejects on missing-model validation, so
 *      nothing metered ever runs) — a 404/405 or non-confirming response means
 *      the provider only speaks chat-completions, a validation/auth/200 reply
 *      means the route exists;
 *   3. remember the result for the process lifetime so every subsequent turn
 *      for that base URL is free.
 *
 * The capability is cached in-memory (per app session) rather than persisted:
 * the probe is a single small request, and re-probing once per launch avoids
 * stale on-disk state when a provider ships `/responses` later. `markCompletions`
 * also lets a caller downgrade a provider mid-flight (a 404 on a previously
 * "responses" provider) without re-probing.
 *
 * Both transports converge on the same output shape (`StreamedTurn`), so the
 * loops never see a wire-protocol difference — they only branch on which
 * transport to use.
 */

import { buildApiUrl, isLocalEndpoint, normaliseBaseUrl, type OpenAIMessage } from "./llm";
import {
  buildChatCompletionsBody,
  consumeAssistantStream,
  type StreamedTurn,
  type StreamOptions,
} from "./llm-stream";
import {
  buildResponsesBody,
  consumeResponsesStream,
  isResponsesEndpoint,
  isEndpointNotFound,
  classifyResponsesProbe,
} from "./responses";
export { isEndpointNotFound };

export type ApiMode = "responses" | "completions";

/** The inputs every transport body-builder shares. */
export interface BodyOpts {
  model: string;
  messages: OpenAIMessage[];
  tools?: unknown[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: "none" | "low" | "high" | "max";
  /** Responses-only: request a condensed reasoning summary. */
  reasoningSummary?: "concise" | "detailed";
}

export interface LlmTransport {
  mode: ApiMode;
  /** Full endpoint URL for the given (already-normalised) base URL. */
  endpoint(baseUrl: string): string;
  /** Build the wire request body for this protocol. */
  buildBody(opts: BodyOpts): Record<string, unknown>;
  /** Parse the streamed reply into the shared `StreamedTurn` shape. */
  consume(reader: ReadableStreamDefaultReader<Uint8Array>, opts: StreamOptions): Promise<StreamedTurn>;
}

export const COMPLETIONS_TRANSPORT: LlmTransport = {
  mode: "completions",
  endpoint: (baseUrl) => buildApiUrl(baseUrl, "chat/completions"),
  buildBody: (opts) =>
    buildChatCompletionsBody({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools ?? [],
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      reasoningEffort: opts.reasoningEffort,
    }),
  consume: consumeAssistantStream,
};

export const RESPONSES_TRANSPORT: LlmTransport = {
  mode: "responses",
  endpoint: (baseUrl) => buildApiUrl(baseUrl, "responses"),
  buildBody: (opts) =>
    buildResponsesBody({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools ?? [],
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      reasoningEffort: opts.reasoningEffort,
      reasoningSummary: opts.reasoningSummary,
    }),
  consume: consumeResponsesStream,
};

// ── Capability cache (in-memory, per app session) ────────────────────────────

const capability = new Map<string, ApiMode>();
/** In-flight resolutions, keyed by base URL, so concurrent callers share one probe. */
const inFlightResolutions = new Map<string, Promise<LlmTransport>>();

function cacheKey(baseUrl: string): string {
  return normaliseBaseUrl(baseUrl).toLowerCase();
}

/** The cached mode for a base URL, if already resolved this session. */
export function readCachedMode(baseUrl: string): ApiMode | undefined {
  return capability.get(cacheKey(baseUrl));
}

/** Record a base URL's resolved mode (and skip future probes). */
export function recordMode(baseUrl: string, mode: ApiMode): void {
  capability.set(cacheKey(baseUrl), mode);
}

/** Downgrade a provider to chat-completions (e.g. after a mid-flight 404). */
export function markCompletionsOnly(baseUrl: string): void {
  recordMode(baseUrl, "completions");
  console.warn(`[llm] ${normaliseBaseUrl(baseUrl)} downgraded to chat-completions (Responses endpoint returned 404/405)`);
}

/**
 * Probe whether a provider serves `/v1/responses`. Sends an EMPTY body — a
 * route-semantics check rather than a metered inference request: a Responses
 * endpoint rejects the missing-model body with a 400 validation error (before
 * any model runs), which positively confirms the route exists; a completions-
 * only provider 404s/405s the route. `classifyResponsesProbe` decides, and any
 * network failure conservatively resolves to "completions".
 */
export async function probeResponses(baseUrl: string, apiKey = ""): Promise<boolean> {
  try {
    const res = await fetch(buildApiUrl(baseUrl, "responses"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    const bodyText = await res.text().catch(() => "");
    return classifyResponsesProbe(res.status, bodyText);
  } catch {
    return false;
  }
}

/**
 * Resolve the transport for a base URL, probing once and caching the answer.
 * OpenAI-native / Azure endpoints skip the probe via the static allowlist;
 * local servers (Ollama, LM Studio, llama.cpp, in-process test mocks) resolve to
 * chat-completions without a probe — they don't serve `/responses` today.
 *
 * `probe` is injectable for tests; production always uses `probeResponses`.
 * Concurrent resolutions for the same base URL share one in-flight probe.
 */
export async function resolveTransport(
  baseUrl: string,
  apiKey = "",
  probe: (baseUrl: string, apiKey: string) => Promise<boolean> = probeResponses,
): Promise<LlmTransport> {
  const key = cacheKey(baseUrl);
  const cached = capability.get(key);
  if (cached) return cached === "responses" ? RESPONSES_TRANSPORT : COMPLETIONS_TRANSPORT;

  // Reuse the in-flight probe for concurrent callers of the same base URL so
  // only one network request is issued (then re-resolve from the cache).
  const inFlight = inFlightResolutions.get(key);
  if (inFlight) return inFlight;

  const pending = (async (): Promise<LlmTransport> => {
    try {
      // Resolve the mode, remembering WHY so the dev log can explain the decision.
      let mode: ApiMode;
      let reason: string;
      if (isResponsesEndpoint(baseUrl)) {
        mode = "responses";
        reason = "known Responses endpoint";
      } else if (isLocalEndpoint(baseUrl)) {
        mode = "completions";
        reason = "local server";
      } else {
        const available = await probe(baseUrl, apiKey);
        mode = available ? "responses" : "completions";
        reason = available ? "probe: /responses available" : "probe: no /responses (chat-completions)";
      }

      // One line per provider per session so `npm run dev` shows which wire
      // protocol each connection resolves to (and a live downgrade logs via
      // markCompletionsOnly).
      console.log(`[llm] ${normaliseBaseUrl(baseUrl)} → ${mode} (${reason})`);

      capability.set(key, mode);
      return mode === "responses" ? RESPONSES_TRANSPORT : COMPLETIONS_TRANSPORT;
    } finally {
      inFlightResolutions.delete(key);
    }
  })();

  inFlightResolutions.set(key, pending);
  return pending;
}
