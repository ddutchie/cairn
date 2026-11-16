/**
 * LLM utility helpers shared across the Electron main process.
 *
 * Slim module: URL helpers, config/message types and the sendability guard.
 * Model calls go through electron/agent/provider.ts (streaming) and
 * electron/agent/one-shot.ts (single reply) — there is no other transport.
 */

export function normaliseBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

/**
 * Build a full OpenAI-compatible endpoint URL from a (normalised) base URL and
 * an API path such as "chat/completions", "models", or "key".
 *
 * The "/v1" version segment is added automatically, but only when the base URL
 * does not already contain a "/v1" path segment. This supports both:
 *   - "https://api.openai.com"                → ".../v1/chat/completions"
 *   - "https://api.openai.com/v1"             → ".../v1/chat/completions"
 *   - "https://api-gateway.merge.dev/v1/openai" → ".../v1/openai/chat/completions"
 *
 * Any query string or fragment on the base URL is preserved and re-appended
 * AFTER the path (e.g. "https://host/v1?token=x" → ".../v1/chat/completions?token=x").
 */
export function buildApiUrl(baseUrl: string, path: string): string {
  // Peel off any ?query / #fragment so it doesn't land in the middle of the path.
  const suffixStart = baseUrl.search(/[?#]/);
  const suffix = suffixStart === -1 ? "" : baseUrl.slice(suffixStart);
  const base = (suffixStart === -1 ? baseUrl : baseUrl.slice(0, suffixStart)).replace(/\/+$/, "");
  const cleanPath = path.replace(/^\/+/, "");
  let pathname: string;
  try {
    pathname = new URL(/^https?:\/\//i.test(base) ? base : `http://${base}`).pathname;
  } catch {
    pathname = base;
  }
  const hasVersion = /(^|\/)v\d+(\/|$)/.test(pathname);
  const endpoint = hasVersion ? `${base}/${cleanPath}` : `${base}/v1/${cleanPath}`;
  return `${endpoint}${suffix}`;
}

/** Returns true if the given base URL points to a local server. */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    let urlString = baseUrl.trim();
    if (!/^https?:\/\//i.test(urlString)) {
      urlString = "http://" + urlString;
    }
    const parsed = new URL(urlString);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host === "::1"
    );
  } catch {
    return false;
  }
}

export interface LLMConfig {
  provider?: "openai";
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Reasoning effort for reasoning-capable models. Uses the pi-ai / engine
   *  thinking vocabulary consumed by installModelSelection → resolveReasoningLevel
   *  ("off" omits reasoning; low/medium/high are universally supported). Absent =
   *  the model's own default. */
  reasoningEffort?: "off" | "low" | "medium" | "high";
  /** Whether the model reasons (models.dev `reasoning: true`). Drives the pi-ai
   *  model declaration's `reasoningEfforts` so the harness offers effort levels
   *  instead of treating the hand-declared model as non-reasoning (which makes
   *  any explicit effort throw UNSUPPORTED_REASONING_EFFORT). */
  isReasoningModel?: boolean;
  /** Explicit wire protocol for this endpoint (Cairn never auto-probes for the
   *  engine path). Maps to the pi-ai `api`: completions→openai-completions,
   *  responses→openai-responses, anthropic-messages→anthropic-messages. Absent =
   *  completions. */
  apiMode?: "responses" | "completions" | "anthropic-messages";
  /** OpenWorker-style approval Mode. When set it takes precedence over autoApprove. */
  mode?: import("../../shared/agent/approval-mode").ApprovalMode;
  /** @deprecated — use `mode`. Kept as alias: true→"auto", false→"interactive". */
  autoApprove?: boolean;
}

export type OpenAIMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  /**
   * Raw Responses reasoning items to replay on the next turn (same model). Set
   * by the chat/agent loops and consumed by the Responses `mapMessagesToInput`;
   * never sent to a chat-completions endpoint.
   */
  reasoningItems?: Array<Record<string, unknown>>;
  /** Chain-of-thought text recorded from the provider's reasoning field. */
  reasoning?: string;
  /** The provider field the reasoning arrived in (round-trip target). */
  reasoningField?: string;
  /** Model key (`baseUrl::model`) that produced this message's reasoning. */
  reasoningModel?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    /**
     * Gemini 3.x thought signature — opaque blob returned by the model on
     * tool-call parts when thinking is enabled. Must be round-tripped back
     * on subsequent requests so the model can resume its reasoning state.
     * Other providers ignore this field.
     */
    thought_signature?: string;
  }>;
};

/**
 * An assistant turn is unusable to the provider when it carries neither
 * `content` nor `tool_calls` — OpenAI-compatible APIs reject the whole request
 * with `Invalid assistant message: content or tool_calls must be set` (400).
 *
 * This happens with "thinking"/reasoning models: if the model times out or
 * stops streaming mid-reasoning, the turn's only payload was reasoning (which
 * is deliberately stripped before re-send, since replaying reasoning also
 * 400s). Replaying that stripped, empty turn on the next message poisons the
 * request. Drop such turns before sending.
 */
export function isSendableMessage(m: {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  reasoningItems?: unknown[];
}): boolean {
  if (m.role !== "assistant") return true;
  return Boolean(m.content?.trim()) || Boolean(m.tool_calls?.length) || Boolean(m.reasoningItems?.length);
}
