/**
 * LLM connection config resolution (F4).
 *
 * Single home for the default endpoint/model, the cached-key reuse rule and
 * the agent behavioural merge (mode vs autoApprove precedence, renderer-
 * authoritative temperature). Callers:
 *   - `ipc/chat.ts` (`resolveAIConfig`) → {@link resolveConnection}("ai")
 *   - `ipc/session-runtime-handlers.ts` (prompt / approve-plan) →
 *     {@link resolveAgentLlmConfig}; (compact-now) → DEFAULT_LLM + key resolve
 *   - `ipc/tool-builder.ts` (cache-only connection) → {@link resolveConnection}("ai", undefined)
 *   - `ipc/ai-handlers.ts`, `ipc/flow-handlers.ts`,
 *     `ipc/user-style-handlers.ts` → DEFAULT_LLM literals (their merge
 *     semantics are unchanged by this module)
 *
 * Must not change (pinned by `llm-config.test.ts`):
 *   - mode precedence (explicit mode > autoApprove > cached mode >
 *     cached autoApprove > "interactive")
 *   - "temperature is renderer-authoritative" (explicit 0 survives; unset is
 *     never back-filled from the cache)
 *   - keychain ref resolution (via `resolveLlmApiKey`)
 *   - `normaliseBaseUrl` / `buildApiUrl` outputs (untouched in `lib/llm.ts`)
 *
 * Security note (Q2): the agent merge reuses a cached key only for the SAME
 * endpoint (unified with the chat rule). A keyless request to a different
 * endpoint stays keyless instead of inheriting another endpoint's key.
 */

import { normaliseBaseUrl, isLocalEndpoint } from "./llm";
import type { AgentLLMConfig } from "./session-runtime-types";
import { getCachedConfig, cacheLlmConnection } from "./config-cache";
import { resolveLlmApiKey } from "./secure-store";
import { isApprovalMode, approvalModeFromAutoApprove, type ApprovalMode } from "../../shared/agent/approval-mode";
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from "../../shared/models/defaults";

/** Default LLM connection (base URL + model). No key — keyless means local. */
export const DEFAULT_LLM = {
  baseUrl: DEFAULT_LLM_BASE_URL,
  model: DEFAULT_LLM_MODEL,
} as const;

/** Minimal connection fields every resolver accepts. */
export interface LlmConnectionRequest {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** Agent connection fields: connection + behavioural (all optional). */
export interface AgentLlmRequest extends LlmConnectionRequest {
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  autoApprove?: boolean;
  mode?: ApprovalMode;
  isReasoningModel?: boolean;
  /** The agent's context-window size — drives the sliding-window pruner. */
  contextWindow?: number;
  /** Chat's legacy name for the same context limit (accepted, not forwarded). */
  contextLimit?: number;
  reasoningEffort?: "off" | "low" | "medium" | "high";
  apiMode?: "responses" | "completions" | "anthropic-messages";
}

/** Resolved connection: normalised endpoint + model + the real key ("" = keyless). */
export interface ResolvedLlmConnection {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

interface CachedConnection {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  maxSteps?: number;
  maxTokens?: number;
  autoApprove?: boolean;
  mode?: ApprovalMode;
}

/**
 * Same-endpoint check (the chat rule): a keyless request reuses the cached key
 * only when it targets the SAME endpoint. An empty request baseUrl inherits the
 * cached endpoint (and its key) whole, as before.
 */
export function isSameEndpoint(reqBaseUrl: string | undefined, cachedBaseUrl: string | undefined): boolean {
  const reqUrl = (reqBaseUrl ?? "").trim();
  const cachedUrl = (cachedBaseUrl ?? "").trim();
  return !reqUrl || !cachedUrl || normaliseBaseUrl(cachedUrl) === normaliseBaseUrl(reqUrl);
}

/**
 * Merge a request over its cached connection. No cache I/O: the caller caches
 * first, then reads the snapshot (same cache-then-read order as the inline
 * resolvers this replaces).
 *
 * - "ai": chat rule — reuse the cached key only for the same endpoint, and
 *   never for a local endpoint request path (local needs no key; the chat
 *   resolver skips the cache lookup entirely for local requests).
 * - "agent": same rule (Q2) — a keyless request reuses the cached key only
 *   for the same endpoint; a different endpoint stays keyless. Behavioural
 *   prefs (autoApprove/mode) still fall back to the cache — they are not
 *   secrets.
 */
function mergeConnection(
  kind: "ai" | "agent",
  req: AgentLlmRequest | undefined,
  cached: CachedConnection | undefined,
): AgentLlmRequest | undefined {
  if (kind === "ai") {
    const isLocal = req?.baseUrl ? isLocalEndpoint(normaliseBaseUrl(req.baseUrl)) : false;
    if (!req?.apiKey && !isLocal) {
      if (cached?.apiKey && isSameEndpoint(req?.baseUrl, cached?.baseUrl)) {
        return {
          ...req,
          provider: req?.provider || cached.provider,
          baseUrl: req?.baseUrl || cached.baseUrl,
          model: req?.model || cached.model,
          apiKey: cached.apiKey,
        };
      }
    }
    return req;
  }
  // Agent merge (session:prompt / session:approve-plan): Q2 — same-endpoint
  // rule, matching chat. A keyless request to a different endpoint must never
  // inherit another endpoint's key (secret leak across endpoints).
  if (!req?.apiKey && cached?.apiKey && isSameEndpoint(req?.baseUrl, cached?.baseUrl)) {
    return {
      ...req,
      baseUrl: req?.baseUrl || cached.baseUrl,
      model: req?.model || cached.model,
      apiKey: cached.apiKey,
      maxSteps: req?.maxSteps || cached.maxSteps,
      // Temperature is renderer-authoritative (it resolves the capability gate
      // and the plan-mode override). Never fall back to a cached 0.3: an
      // explicit 0 must survive, and unset/unsupported must stay omitted.
      temperature: req?.temperature,
      maxTokens: req?.maxTokens ?? cached.maxTokens,
      autoApprove: req?.autoApprove !== undefined ? req.autoApprove : cached.autoApprove,
      mode: req?.mode ?? cached?.mode,
    };
  } else if (cached) {
    return {
      ...req,
      autoApprove: req?.autoApprove !== undefined ? req.autoApprove : cached.autoApprove,
      mode: req?.mode ?? cached?.mode,
    };
  }
  return req;
}

/**
 * Resolve an "ai" (chat/tool-builder style) or "agent" connection: persist the
 * request connection (apiKey scrubbed to a ref-or-clear by the cache layer,
 * never a raw key), merge over the cached snapshot, normalise and resolve the
 * keychain ref to the real key for this request only.
 */
export function resolveConnection(
  kind: "ai" | "agent",
  req?: LlmConnectionRequest,
): ResolvedLlmConnection {
  // Persist the connection (provider/baseUrl/model + a keychain-ref apiKey only;
  // cacheLlmConnection scrubs any raw key). The renderer sends a ref, not a key.
  cacheLlmConnection(kind, req);
  const cached = (kind === "ai" ? getCachedConfig().aiConfig : getCachedConfig().agentConfig) as CachedConnection | undefined;
  const reqConfig = mergeConnection(kind, req, cached);
  return {
    provider: reqConfig?.provider ?? "openai",
    baseUrl: normaliseBaseUrl(reqConfig?.baseUrl ?? DEFAULT_LLM.baseUrl),
    model: reqConfig?.model ?? DEFAULT_LLM.model,
    // Resolve the keychain ref (or pass a literal through) to the real key used
    // for this request only. Never stored anywhere from here on.
    apiKey: resolveLlmApiKey(reqConfig?.apiKey),
  };
}

/**
 * Resolve the full agent LLM config for a session turn: connection merge plus
 * the behavioural fields (mode precedence, renderer-authoritative temperature).
 * Returns both the engine config and the resolved mode (they always agree).
 */
export function resolveAgentLlmConfig(req?: AgentLlmRequest): { llmConfig: AgentLLMConfig; mode: ApprovalMode } {
  // Cache the connection + behavioural fields (apiKey scrubbed to a ref-or-clear
  // by the cache layer, never a raw key). Mode + autoApprove are co-persisted
  // so old renderers reading `autoApprove` and new code reading `mode` stay aligned.
  cacheLlmConnection("agent", {
    baseUrl: req?.baseUrl,
    model: req?.model,
    apiKey: req?.apiKey,
    maxSteps: req?.maxSteps,
    temperature: req?.temperature,
    maxTokens: req?.maxTokens,
    autoApprove: req?.autoApprove,
    mode: req?.mode,
  });
  const cached = getCachedConfig().agentConfig as CachedConnection | undefined;
  const reqConfig = mergeConnection("agent", req, cached);

  const _reqMode = (reqConfig as { mode?: unknown })?.mode;
  const _reqModeValid = typeof _reqMode === "string" && isApprovalMode(_reqMode as ApprovalMode) ? _reqMode as ApprovalMode : undefined;
  const _cachedMode = (cached as { mode?: unknown })?.mode;
  const _cachedModeValid = typeof _cachedMode === "string" && isApprovalMode(_cachedMode as ApprovalMode) ? _cachedMode as ApprovalMode : undefined;
  // Resolve ApprovalMode from explicit mode, then legacy autoApprove, then cached mode, then default.
  const resolvedMode: ApprovalMode = _reqModeValid
    ?? (typeof reqConfig?.autoApprove === "boolean" ? approvalModeFromAutoApprove(reqConfig.autoApprove) : undefined)
    ?? _cachedModeValid
    ?? (typeof cached?.autoApprove === "boolean" ? approvalModeFromAutoApprove(cached.autoApprove) : undefined)
    ?? "interactive";
  const llmConfig: AgentLLMConfig = {
    baseUrl:     normaliseBaseUrl(reqConfig?.baseUrl || DEFAULT_LLM.baseUrl),
    model:       reqConfig?.model       || DEFAULT_LLM.model,
    apiKey:      resolveLlmApiKey(reqConfig?.apiKey),
    maxSteps:    reqConfig?.maxSteps    ?? 20,
    // The renderer resolved the effective temperature (capability-gated;
    // undefined = omit → vendor default).
    temperature: reqConfig?.temperature,
    maxTokens:   reqConfig?.maxTokens,
    autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : _cachedModeValid ? _cachedModeValid === "auto" : cached?.autoApprove !== undefined ? cached.autoApprove : false,
    mode: resolvedMode,
    isReasoningModel: reqConfig?.isReasoningModel,
    // No provider coercion: a custom local endpoint (Ollama, LM Studio,
    // user-run llama.cpp) keeps its own baseUrl and plain "openai" shape.
    provider: reqConfig?.provider,
    contextWindow: reqConfig?.contextWindow,
    reasoningEffort: reqConfig?.reasoningEffort,
    apiMode: reqConfig?.apiMode,
  };
  return { llmConfig, mode: resolvedMode };
}
