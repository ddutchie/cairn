/**
 * Cairn — Shared OpenAI-compatible LLM streaming layer.
 *
 * Consumed by the Cordis runners' chat-completions transport and by `callLLM`:
 *
 *   - `consumeAssistantStream`   — SSE parse → { content, reasoning, tool calls,
 *     finish_reason, reasoning field }. Records WHICH reasoning field the
 *     provider used (`reasoning_content` / `reasoning` / `reasoning_text`) so it
 *     can be round-tripped verbatim.
 *   - `buildChatCompletionsBody` — request body shape (the system prompt travels
 *     as a `role: "system"` message — or `role: "developer"` for reasoning models
 *     on providers that support it, see `resolveSystemRole` — never a top-level
 *     `system:` field).
 */

import { iterSseData } from "./sse";
import { extractCacheTokens } from "./usage-recorder";
import { randomUUID } from "node:crypto";

/** Reasoning field names used by OpenAI-compatible providers, in priority order. */
export const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

// ── Streaming ────────────────────────────────────────────────────────────────

export interface StreamToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Gemini 3.x thought signature — opaque blob to round-trip back. */
  thought_signature?: string;
}

export interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** Prompt tokens served from the provider's cache (Anthropic-style / OpenAI cached_tokens). */
  cacheReadTokens: number;
  /** Prompt tokens written to the provider's cache (Anthropic-style). 0 when not split out. */
  cacheCreationTokens: number;
  /** Raw provider `usage` object (may carry provider-specific fields like cost). */
  raw: unknown;
  /** Raw top-level `cost` field on the chunk, if the provider reports it there. */
  chunkCost?: unknown;
  /** finish_reason of the turn at the time the usage chunk arrived (diagnostics). */
  finishReason?: string | null;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Streamed text delta (UI). */
  onToken?: (delta: string) => void;
  /** Streamed reasoning/thinking delta (UI). */
  onThought?: (delta: string) => void;
  /** Streamed reasoning *summary* delta (Responses `reasoning.summary`), when the provider emits one. */
  onSummary?: (delta: string) => void;
  /** Fired as soon as a tool call's name is first seen (live "pending" chip). */
  onToolPending?: (name: string, callId: string) => void;
  /** Fired on the trailing usage chunk. */
  onUsage?: (usage: StreamUsage) => void;
  /** Override callId generation for pending chips. Default `${name}:${Date.now()}:${index}`. */
  makeCallId?: (index: number, name: string) => string;
}

export interface StreamedTurn {
  content: string;
  reasoning: string;
  /** Which reasoning field the provider used, if any. */
  reasoningField: string | null;
  /** Condensed reasoning summary (Responses `reasoning.summary`), empty when the provider emits none. */
  reasoningSummary: string;
  /** Raw Responses reasoning items to round-trip on the next turn. Empty for completions. */
  reasoningItems: Array<Record<string, unknown>>;
  /** finish_reason of the last chunk that carried one (null if the stream ended without it). */
  finishReason: string | null;
  /** API-ready tool calls in stream order. */
  toolCalls: StreamToolCall[];
  /** Per toolCalls position, the original stream index (for callId lookup / tracing). */
  toolCallIndexes: number[];
  /** Original stream index → generated callId for live pending chips. */
  streamCallIds: Map<number, string>;
}

/**
 * Consume an OpenAI-compatible SSE assistant stream and assemble the turn.
 * Shared by chat and the agent loop so reasoning-field capture, finish_reason
 * tracking, and tool-call buffering can never diverge again.
 */
export async function consumeAssistantStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: StreamOptions,
): Promise<StreamedTurn> {
  const { signal } = opts;
  let content = "";
  let reasoning = "";
  let reasoningField: string | null = null;
  let finishReason: string | null = null;
  const toolBuffers: Map<number, { id: string; name: string; args: string; thought_signature?: string }> = new Map();
  const streamCallIds: Map<number, string> = new Map();

  for await (const jsonStr of iterSseData(reader, signal)) {
    // Only JSON.parse is guarded — malformed lines are skipped, but any error
    // from a consumer callback below propagates instead of being swallowed.
    let chunk: unknown;
    try {
      chunk = JSON.parse(jsonStr);
    } catch {
      continue; // skip malformed SSE JSON line
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = chunk as any;

    const choice = c.choices?.[0];
    // Capture the finish reason BEFORE the usage callback so a usage chunk that
    // carries both fields (the common stream_options.include_usage case) reports
    // the current chunk's finish reason, not the stale value from a previous
    // chunk. "length" means the model hit max_tokens.
    if (choice?.finish_reason) finishReason = choice.finish_reason;

    // Usage chunk — sent as the final SSE chunk when stream_options.include_usage is set.
    if (c.usage) {
      const cache = extractCacheTokens(c.usage);
      opts.onUsage?.({
        promptTokens: c.usage.prompt_tokens ?? 0,
        completionTokens: c.usage.completion_tokens ?? 0,
        reasoningTokens: c.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        cacheReadTokens: cache.cacheReadTokens,
        cacheCreationTokens: cache.cacheCreationTokens,
        raw: c.usage,
        chunkCost: c.cost,
        finishReason,
      });
    }

    const delta = choice?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      opts.onToken?.(delta.content);
    }

    // Some endpoints return reasoning in reasoning_content (llama.cpp), or
    // reasoning / reasoning_text (other OpenAI-compatible endpoints). Use the
    // first non-empty field and remember WHICH one so the reasoning can be
    // round-tripped under the same field name on the next request.
    let thoughtField: string | null = null;
    for (const field of REASONING_FIELDS) {
      const value = (delta as Record<string, unknown>)[field];
      if (typeof value === "string" && value.length > 0) { thoughtField = field; break; }
    }
    if (thoughtField) {
      reasoningField ??= thoughtField;
      const thought = (delta as Record<string, unknown>)[thoughtField] as string;
      reasoning += thought;
      opts.onThought?.(thought);
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx: number = tc.index ?? 0;
        const isNew = !toolBuffers.has(idx);
        if (isNew) {
          toolBuffers.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
        }
        const buf = toolBuffers.get(idx)!;
        if (tc.id) buf.id = tc.id;
        if (tc.function?.name) buf.name = tc.function.name;
        if (tc.function?.arguments) buf.args += tc.function.arguments;
        // Gemini 3.x thought signature — opaque blob to round-trip back.
        if (tc.thought_signature) buf.thought_signature = tc.thought_signature;

        // Fire pending chip as soon as we see the tool name during streaming.
        if (buf.name && !streamCallIds.has(idx)) {
          const callId = opts.makeCallId?.(idx, buf.name) ?? `${buf.name}:${Date.now()}:${idx}`;
          streamCallIds.set(idx, callId);
          opts.onToolPending?.(buf.name, callId);
        }
      }
    }
  }

  const entries = Array.from(toolBuffers.entries()).sort(([a], [b]) => a - b);
  const toolCalls: StreamToolCall[] = entries.map(([, buf]) => ({
    // An interrupted stream can cut before the id chunk arrives — synthesize a
    // UNIQUE id (per-call random suffix) so the assistant message's tool_calls
    // and its tool results reference it consistently, and so two truncation
    // turns can never collide on the same id (duplicate tool_call_id → 400).
    id: buf.id || `${buf.name || "tool"}:${randomUUID().slice(0, 8)}`,
    type: "function",
    function: { name: buf.name, arguments: buf.args },
    ...(buf.thought_signature ? { thought_signature: buf.thought_signature } : {}),
  }));
  const toolCallIndexes = entries.map(([idx]) => idx);

  return { content, reasoning, reasoningField, reasoningSummary: "", reasoningItems: [], finishReason, toolCalls, toolCallIndexes, streamCallIds };
}

// ── Request body ─────────────────────────────────────────────────────────────

export function buildChatCompletionsBody(opts: {
  model: string;
  messages: unknown[];
  tools: unknown[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: "none" | "low" | "high" | "max";
}): Record<string, unknown> {
  return {
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: "auto",
    // Always send max_tokens. Callers pass AUTO_OUTPUT_TOKEN_CAP (32K) when the
    // user leaves output tokens on Auto; omitting the field lets the endpoint
    // apply a tiny server-side default (often 4096) that truncates tool calls.
    ...(opts.maxTokens && opts.maxTokens > 0 ? { max_tokens: opts.maxTokens } : {}),
    temperature: opts.temperature,
    stream: true,
    stream_options: { include_usage: true },
    // One-shot generation can drop reasoning entirely (faster, cheaper, and the
    // guide is a direct transform) — measured ~2x faster with 0 reasoning tokens.
    ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
  };
}

// ── System role ──────────────────────────────────────────────────────────────

/**
 * Base-URL fragments known to accept the OpenAI `developer` system role for
 * reasoning models. Every OTHER provider gets `system`: an unknown or custom
 * endpoint (a gateway, opencode's Console Go, LM Studio, …) may reject the
 * `developer` role outright with a 400 — "unknown variant developer, expected
 * one of system/user/assistant" — and `system` is universally accepted, so the
 * safe default is `system` unless we know the target supports `developer`.
 */
const DEVELOPER_ROLE_URL_FRAGMENTS = [
  "api.openai.com",
  "openai.azure.com",
  "api.azure.com",
];

/**
 * Whether a provider/baseUrl is a known-good `developer`-role target. An
 * allowlist (not a denylist): only OpenAI / Azure OpenAI and OpenRouter
 * Anthropic/OpenAI models opt in to `developer`; everything else conservatively
 * uses `system` so a provider that doesn't understand the role can't 400 the
 * whole request. Reasoning still works under `system` — the `developer` role is
 * only an instruction-hierarchy nicety, not a requirement.
 */
function supportsDeveloperRole(opts: { baseUrl?: string; provider?: string; modelId?: string }): boolean {
  const baseUrl = opts.baseUrl ?? "";
  const provider = opts.provider ?? "";
  // OpenRouter maps the `developer` role only for Anthropic/OpenAI models.
  if (provider === "openrouter" || baseUrl.includes("openrouter.ai")) {
    return (opts.modelId?.startsWith("anthropic/") ?? false) || (opts.modelId?.startsWith("openai/") ?? false);
  }
  return DEVELOPER_ROLE_URL_FRAGMENTS.some((frag) => baseUrl.includes(frag));
}

/**
 * The `role` to send the system prompt under — `developer` for reasoning models
 * on providers that support it (the OpenAI convention pi follows), else
 * `system`. `isReasoningModel` comes from the models.dev catalog's `reasoning`
 * flag (resolved in the renderer, which owns the catalog).
 */
export function resolveSystemRole(opts: { isReasoningModel?: boolean; baseUrl?: string; provider?: string; modelId?: string }): "system" | "developer" {
  if (!opts.isReasoningModel) return "system";
  return supportsDeveloperRole(opts) ? "developer" : "system";
}
