/**
 * Cairn — Shared OpenAI-compatible LLM streaming / message-preparation layer.
 *
 * Extracted from `chat-loop.ts` and `pi-agent-loop.ts` so the two tool-call
 * loops cannot silently drift again. Anything parity-critical lives here and is
 * consumed by both:
 *
 *   - `consumeAssistantStream`   — SSE parse → { content, reasoning, tool calls,
 *     finish_reason, reasoning field }. Records WHICH reasoning field the
 *     provider used (`reasoning_content` / `reasoning` / `reasoning_text`) so it
 *     can be round-tripped verbatim (pi behaviour).
 *   - `buildChatCompletionsBody` — request body shape (the system prompt travels
 *     as a `role: "system"` message — or `role: "developer"` for reasoning models
 *     on providers that support it, see `resolveSystemRole` — never a top-level
 *     `system:` field).
 *   - `failToolCallsFromTruncatedMessage` — `finish_reason: "length"` guard:
 *     refuse to execute ANY tool call from a turn the model had to cut short.
 *   - `prepareContextMessages`   — system prepend (via `systemRole`, defaulting
 *     to `"system"`) + reasoning round-trip + empty-turn filtering around an
 *     optional context pruner.
 *
 * The two loops keep their own orchestration (both run tool calls in parallel;
 * the agent additionally has approval gates / plan mode / subagents), but they
 * share this layer.
 */

import { iterSseData } from "./sse";
import { isSendableMessage, type OpenAIMessage } from "./llm";
import { extractCacheTokens } from "./usage-recorder";
import { randomUUID } from "node:crypto";
import type { ContentPart } from "../../shared/models/pdf-attach";
import { AUTO_OUTPUT_TOKEN_CAP } from "../../shared/models/model-catalog";

export { AUTO_OUTPUT_TOKEN_CAP };

/** Reasoning field names used by OpenAI-compatible providers, in priority order. */
export const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

// `AUTO_OUTPUT_TOKEN_CAP` (32K) lives in shared/models/model-catalog.ts — the
// renderer's resolver and the main-process loops share the same ceiling. When
// the model's declared output limit is smaller, the renderer sends that instead;
// when the model is unknown, these loops fall back to AUTO_OUTPUT_TOKEN_CAP.

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

// ── Output-token-limit truncation guard ──────────────────────────────────────

/** Error text used when a `finish_reason: "length"` turn's tool calls are refused. */
export function truncatedToolCallError(maxTokens?: number): string {
  // maxTokens is the cap that WAS sent (the user's manual value or the 32K
  // Auto default) — the model hit it. Guide the fix accordingly.
  const capHint = maxTokens
    ? `Try raising the Max output tokens setting (currently ${maxTokens}).`
    : "Max output tokens is set to Auto (no cap is sent), so this is the provider's own output limit — try a manual Max output tokens value or a model with a larger output cap.";
  return (
    `Tool call not executed: the model hit its output-token limit, so the arguments may be truncated. ` +
    `Re-issue the tool call with complete arguments. ${capHint}`
  );
}

/** Error text used when a stream ended without any finish_reason (connection cut mid-call). */
export function interruptedStreamToolCallError(): string {
  return (
    `Tool call not executed: the response stream ended before the model finished (no finish_reason received), ` +
    `so the arguments may be truncated. Re-issue the tool call with complete arguments.`
  );
}

/**
 * Synthetic user-role notice fed back to the model after a truncated turn so it
 * re-issues the tool call(s) with complete arguments. Used INSTEAD of replaying
 * the truncated assistant message + synthesized tool results — replaying that
 * turn poisons the next request with invalid JSON arguments, reasoning attached
 * to tool_calls, and duplicate/orphaned tool_call_ids (→ provider 400).
 */
export function truncationRetryNotice(toolCallCount: number, maxTokens?: number): string {
  const plural = toolCallCount !== 1;
  const hint = maxTokens
    ? `or raise the Max output tokens setting (currently ${maxTokens})`
    : "or set a manual Max output tokens value (Auto relies on the endpoint's default)";
  return (
    `[System: your last tool call${plural ? "s" : ""} hit the output-token limit and ${plural ? "were" : "was"} ` +
    `NOT executed — the arguments may be truncated. Re-issue ${plural ? "them" : "it"} with complete arguments (${hint}).]`
  );
}

export interface TruncatedToolCall {
  id: string;
  function: { name: string };
}

/**
 * Refuse to execute ANY tool call from a turn the model had to cut short
 * (`finish_reason: "length"`, or a stream that ended without any finish_reason).
 * A cut that lands on a well-formed JSON boundary would otherwise execute with
 * silently missing fields — no JSON parser can detect that. Emits the
 * start/end callbacks so the chip appears failed, and returns the tool-result
 * messages to feed back so the model re-issues.
 */
export function failToolCallsFromTruncatedMessage(
  toolCalls: TruncatedToolCall[],
  opts: {
    maxTokens?: number;
    /** Override the error text fed back to the model (e.g. interrupted-stream wording). */
    error?: string;
    labelFor: (name: string) => string;
    /** Map a tool call to the callId used by its live chip (defaults to `tc.id`). */
    callIdFor?: (tc: TruncatedToolCall, position: number) => string | undefined;
    emitStart: (name: string, label: string, callId: string | undefined, args: Record<string, unknown>) => void;
    emitEnd: (name: string, label: string, ok: boolean, output: string, callId: string | undefined, args: Record<string, unknown>) => void;
  },
): Array<{ role: "tool"; tool_call_id: string; content: string }> {
  const error = opts.error ?? truncatedToolCallError(opts.maxTokens);
  return toolCalls.map((tc, i) => {
    const label = opts.labelFor(tc.function.name);
    // A truncated/interrupted stream can cut before the id chunk arrives —
    // synthesize a stable id so the emitted chip and the returned tool result
    // share one identifier (empty ids would collide across tools). consumeAssistantStream
    // already normalizes ids upstream, so this is a defensive fallback.
    const resolvedId = tc.id || `${tc.function.name || "tool"}:truncated:${i}`;
    const callId = opts.callIdFor?.(tc, i) ?? resolvedId;
    opts.emitStart(tc.function.name, label, callId, {});
    opts.emitEnd(tc.function.name, label, false, error, callId, {});
    return { role: "tool", tool_call_id: resolvedId, content: JSON.stringify({ error }) };
  });
}

// ── Message preparation ──────────────────────────────────────────────────────

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
export function supportsDeveloperRole(opts: { baseUrl?: string; provider?: string; modelId?: string }): boolean {
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

/** A message that may carry reasoning metadata for round-tripping. */
export interface OutgoingMessage {
  role: string;
  content: string | null | ContentPart[];
  tool_calls?: unknown[];
  tool_call_id?: string;
  /** Chain-of-thought text recorded from the provider's reasoning field. */
  reasoning?: string;
  /** The provider field the reasoning arrived in (round-trip target). */
  reasoningField?: string;
  /** Model key (`baseUrl::model`) that produced this message. */
  reasoningModel?: string;
  /** Raw Responses reasoning items to round-trip (Responses only). */
  reasoningItems?: Array<Record<string, unknown>>;
}

const REASONING_KEY_SET = new Set<string>(REASONING_FIELDS);

/** Internal message metadata persisted for reasoning round-trip — never sent to the provider. */
const INTERNAL_MESSAGE_KEYS = ["reasoning", "reasoningField", "reasoningModel", "reasoningItems"] as const;

/**
 * Drop internal round-trip metadata from a message before it leaves the process.
 * These fields are meaningful only to Cairn (which model produced the reasoning);
 * a stray `reasoningModel` etc. on an outgoing message can 400 on strict
 * OpenAI-compatible endpoints that reject unknown fields.
 */
function stripInternalMessageFields(m: Record<string, unknown>): Record<string, unknown> {
  const out = { ...m };
  for (const key of INTERNAL_MESSAGE_KEYS) delete out[key];
  return out;
}

/** True when an assistant message is safe to send: content, tool calls, or round-tripped reasoning. */
function isOutgoingSendable(m: Record<string, unknown>): boolean {
  if (m.role !== "assistant") return true;
  if (typeof m.content === "string" && m.content.trim()) return true;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
  for (const field of REASONING_KEY_SET) {
    const v = m[field];
    if (typeof v === "string" && v.trim().length > 0) return true;
  }
  return false;
}

/**
 * Build the outgoing request messages:
 *   1. Run the optional context pruner/compaction over reasoning-stripped
 *      messages (so a compaction summary can never see chain-of-thought).
 *   2. Round-trip reasoning back under its native field — but ONLY for the same
 *      model that produced it (matching pi). Cross-model reasoning is dropped
 *      rather than sent as a text blob, so a provider switch mid-session can't
 *      400 on an unknown field.
 *   3. Drop empty assistant turns (neither content, nor tool calls, nor
 *      reasoning) that would poison the request with "content or tool_calls
 *      must be set".
 *   4. Prepend the system prompt under `systemRole` — `"system"` by default,
 *      or `"developer"` for reasoning models on providers that support it.
 *
 * NOTE: reasoning round-trip depends on the pruner preserving message object
 * references (identity). The built-in sliding-window pruner returns the same
 * objects it was given, so round-trip works. A custom `pruner` that replaces or
 * re-creates messages (e.g. a compaction summarizer) will lose those messages'
 * reasoning by design — the summary is what gets sent instead.
 */
export async function prepareContextMessages<M extends OutgoingMessage>(opts: {
  systemPrompt: string;
  messages: M[];
  currentModelKey: string;
  /** Role for the system prompt message (defaults to "system"). */
  systemRole?: "system" | "developer";
  /** Round-trip Responses reasoning items (same-model) instead of dropping them. */
  roundTripItems?: boolean;
  pruner?: (messages: M[]) => M[] | Promise<M[]>;
}): Promise<OpenAIMessage[]> {
  const reasoningByMsg = new Map<M, { reasoning: string; field: string; modelKey: string; items?: Array<Record<string, unknown>> }>();
  const stripped = opts.messages.map((m): M => {
    if (m.role !== "assistant") return m;
    const hasText = typeof m.reasoning === "string" && m.reasoning.length > 0;
    const hasItems = Array.isArray(m.reasoningItems) && m.reasoningItems.length > 0;
    if (!hasText && !hasItems) return m;
    if (typeof m.reasoningField === "string" && typeof m.reasoningModel === "string") {
      // Has round-trip metadata — remember the STRIPPED object (the one the
      // pruner operates on) so reasoning can be re-attached after pruning.
      const { reasoning: _r, reasoningField: _rf, reasoningModel: _rm, reasoningItems: _ri, ...rest } = m as M & { reasoningItems?: unknown };
      reasoningByMsg.set(rest as M, {
        reasoning: m.reasoning ?? "",
        field: m.reasoningField,
        modelKey: m.reasoningModel,
        ...(hasItems ? { items: m.reasoningItems } : {}),
      });
      return rest as M;
    }
    // Bare reasoning with no round-trip metadata (legacy/persisted without
    // the field name) — strip it rather than leak it to a provider that may
    // reject or mis-handle an unknown assistant field.
    const { reasoning: _r, reasoningItems: _ri, ...rest } = m as M & { reasoningItems?: unknown };
    return rest as M;
  });

  const pruned = opts.pruner ? await opts.pruner(stripped) : stripped;

  const out: OpenAIMessage[] = [{ role: opts.systemRole ?? "system", content: opts.systemPrompt }];
  for (const m of pruned) {
    if (m.role !== "assistant") {
      out.push(m as unknown as OpenAIMessage);
      continue;
    }
    const ri = reasoningByMsg.get(m);
    const raw = m as unknown as Record<string, unknown>;
    let outgoing: Record<string, unknown>;
    if (ri) {
      if (ri.modelKey === opts.currentModelKey) {
        // Same model → round-trip reasoning under its native field (pi behaviour),
        // plus the Responses reasoning items when the caller wants them.
        outgoing = { ...raw };
        if (ri.reasoning) outgoing[ri.field] = ri.reasoning;
        if (opts.roundTripItems && ri.items && ri.items.length > 0) {
          outgoing.reasoningItems = ri.items;
        }
      } else {
        // Different model → convert reasoning to plain text content (pi behaviour),
        // never sent as a foreign field the new provider may reject. Reasoning
        // items are dropped (they're opaque to a different model).
        const existing = typeof raw.content === "string" && raw.content.trim() ? raw.content.trim() : "";
        outgoing = { ...raw, content: [existing, ri.reasoning].filter(Boolean).join("\n\n") };
      }
    } else {
      outgoing = stripInternalMessageFields(raw);
    }
    if (!isOutgoingSendable(outgoing)) continue;
    out.push(outgoing as unknown as OpenAIMessage);
  }
  return out;
}

// Re-exported for convenience — the sendable-message predicate lives in llm.ts
// and is the same one chat.ts uses for thread history.
export { isSendableMessage };
