/**
 * cairn:context-ring — reasoning-provenance projection ("the Context Ring").
 *
 * A dsh sessionProjections fold that answers: WHOSE thinking is in this
 * session's context, and is it healthy? Upstream persists full reasoning text
 * with producer attribution (`assistant/message.data.message.source`) but
 * surfaces none of it — no token bucket, no round-trip health, and the
 * concrete provider field name is erased at its adapter boundary. This
 * projection maintains exactly that missing view per session:
 *
 *   - per `provider::model`: turns carrying reasoning, block/char volume,
 *     how many blocks still carry their native replay envelope (round-trip
 *     intact) vs how many degraded (envelope absent — cross-model switch,
 *     adapter change, or compaction ate them),
 *   - the model the NEXT request will target (`request/header`).
 *
 * Pure fold over public session events; registered like TokenMeter's units so
 * it replays durably on resume. See project note "Plugin idea: Context Ring".
 */

import type { Context } from "@deepseek-ai/cordis";
import * as z from "zod";

export const CONTEXT_RING_KEY = "contextRing";

// ── Schemas ──────────────────────────────────────────────────────────────────

const ModelBucketSchema = z.object({
  /** Assistant messages (with ≥1 reasoning block) attributed to this model. */
  turns: z.number().int().nonnegative(),
  reasoningBlocks: z.number().int().nonnegative(),
  reasoningChars: z.number().int().nonnegative(),
  /** Blocks whose native replay envelope survived (will round-trip verbatim). */
  replayedBlocks: z.number().int().nonnegative(),
  /** Reasoning present but envelope gone — degrades to plain text next turn. */
  degradedBlocks: z.number().int().nonnegative(),
}).strict();

const ContextRingStateSchema = z.object({
  /** `provider::model` the next request targets (from request/header). */
  currentModel: z.string().nullable(),
  byModel: z.record(z.string(), ModelBucketSchema),
}).strict();

export type ContextRingState = z.infer<typeof ContextRingStateSchema>;
export type ContextRingModelBucket = z.infer<typeof ModelBucketSchema>;

const zeroBucket = (): ContextRingModelBucket => ({
  turns: 0, reasoningBlocks: 0, reasoningChars: 0, replayedBlocks: 0, degradedBlocks: 0,
});

// ── Fold ─────────────────────────────────────────────────────────────────────

/** Pure fold — exported for direct unit testing without a cordis context. */
export function applyContextRingEvent(state: ContextRingState, event: { type: string; data?: unknown }): ContextRingState {
  if (event.type === "request/header") {
    const cfg = (event.data as { config?: { provider?: string; model?: string } } | undefined)?.config;
    const model = cfg?.provider && cfg?.model ? `${cfg.provider}::${cfg.model}` : null;
    if (model === state.currentModel || model === null) return state;
    return { ...state, currentModel: model };
  }

  if (event.type !== "assistant/message") return state;
  const msg = (event.data as { message?: { content?: unknown; source?: { provider?: string; model?: string; replayState?: unknown } } } | undefined)?.message;
  const source = msg?.source;
  if (!msg || !source?.provider || !source?.model) return state;

  const content = Array.isArray(msg.content) ? msg.content as Array<{ type?: string; text?: unknown }> : [];
  const reasoning = content.filter((b) => b && b.type === "reasoning");
  if (reasoning.length === 0) return state;

  const key = `${source.provider}::${source.model}`;
  const prev = state.byModel[key] ?? zeroBucket();
  const chars = reasoning.reduce((n, b) => n + (typeof b.text === "string" ? b.text.length : 0), 0);
  const replayed = source.replayState ? reasoning.length : 0;

  return {
    currentModel: state.currentModel,
    byModel: {
      ...state.byModel,
      [key]: {
        turns: prev.turns + 1,
        reasoningBlocks: prev.reasoningBlocks + reasoning.length,
        reasoningChars: prev.reasoningChars + chars,
        replayedBlocks: prev.replayedBlocks + replayed,
        degradedBlocks: prev.degradedBlocks + (reasoning.length - replayed),
      },
    },
  };
}

export const contextRingProjectionDefinition = {
  key: CONTEXT_RING_KEY,
  stateVersion: 1,
  stateSchema: ContextRingStateSchema,
  init: (): ContextRingState => ({ currentModel: null, byModel: {} }),
  apply: applyContextRingEvent,
  wire: {
    viewSchema: ContextRingStateSchema,
    view: (state: ContextRingState) => state,
  },
};

// ── Mount ────────────────────────────────────────────────────────────────────

// ── Live snapshot cache ──────────────────────────────────────────────────────
// Turn end DISPOSES the agent and detaches its session from ctx.sessions, so
// post-turn registry lookups by handle fail. Mirror token-meter instead: fold
// on every committed event and keep the latest state per sessionId for reads.

const ringCache = new Map<string, ContextRingState>();

/** Register the projection + keep the live snapshot warm for reads. */
export function mountContextRing(ctx: Context): void {
  (ctx as unknown as {
    inject: (deps: string[], fn: (c: unknown) => void) => void;
  }).inject(["sessionProjections"], (c: unknown) => {
    const projectionCtx = c as { sessionProjections: { register: (d: unknown) => void } };
    projectionCtx.sessionProjections.register(contextRingProjectionDefinition);
  });
  (ctx as unknown as { on: (ev: string, fn: (session: unknown) => void) => () => void }).on(
    "session/event",
    (session: unknown) => {
      try {
        const id = String((session as { id?: unknown }).id ?? "");
        if (!id) return;
        const registry = (ctx as unknown as { sessionProjections?: { stateOf: (s: unknown, key: string) => unknown } }).sessionProjections;
        const state = registry?.stateOf(session, CONTEXT_RING_KEY) as ContextRingState | undefined;
        if (state) ringCache.set(id, state);
      } catch { /* badge is decoration — never break the stream */ }
    },
  );
}

/** Latest known ring for a session (undefined when never seen this process). */
export function cachedContextRing(sessionId: string): ContextRingState | undefined {
  return ringCache.get(sessionId);
}

// ── Session Telemetry & Usage Folds ──────────────────────────────────────────

export interface SessionUsageMetrics {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  breakdown?: {
    systemPrompt?: number;
    tools?: number;
    rules?: number;
    skills?: number;
    mcp?: number;
    subagentDefinitions?: number;
    toolOutputs?: number;
    conversation?: number;
  };
}

export interface SessionTodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}

/** Fold complete ContextRing state across all session events. */
export function foldContextRing(events: readonly { type: string; data?: unknown }[]): ContextRingState {
  let state = contextRingProjectionDefinition.init();
  for (const ev of events) {
    state = applyContextRingEvent(state, ev);
  }
  return state;
}

/**
 * Fold latest/accumulated session token usage and metrics directly from the
 * append-only event log. This guarantees ContextRing and token counters survive
 * app restarts and thread reloads.
 */
export function foldSessionUsage(events: readonly { type: string; data?: unknown }[]): SessionUsageMetrics | undefined {
  let latestPrompt = 0;
  let totalCompletion = 0;
  let totalReasoning = 0;
  let latestCacheRead = 0;
  let latestCacheWrite = 0;
  let latestCostUsd: number | undefined = undefined;
  let hasUsage = false;
  let toolOutputChars = 0;
  let reasoningCharsTotal = 0;

  for (const ev of events) {
    if (ev.type === "tool/result") {
      const d = ev.data as { message?: { content?: Array<{ type?: string; text?: string; content?: Array<{ type?: string; text?: string }> }> }; error?: { message?: string } } | undefined;
      const blocks = d?.message?.content ?? [];
      for (const block of blocks) {
        if (typeof block.text === "string") {
          toolOutputChars += block.text.length;
        }
        if (Array.isArray(block.content)) {
          for (const sub of block.content) {
            if (sub && typeof sub.text === "string") {
              toolOutputChars += sub.text.length;
            }
          }
        }
      }
      if (d?.error?.message) {
        toolOutputChars += d.error.message.length;
      }
    }

    if (ev.type === "assistant/chunk") {
      const chunk = (ev.data as { chunk?: { type?: string; usage?: { inputTokens?: number; promptTokens?: number; outputTokens?: number; completionTokens?: number; reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cachedTokens?: number; costUsd?: number } } } | undefined)?.chunk;
      if (chunk?.type === "usage" && chunk.usage) {
        hasUsage = true;
        const u = chunk.usage;
        if (typeof u.inputTokens === "number" && u.inputTokens > 0) latestPrompt = u.inputTokens;
        else if (typeof u.promptTokens === "number" && u.promptTokens > 0) latestPrompt = u.promptTokens;

        if (typeof u.outputTokens === "number") totalCompletion += u.outputTokens;
        else if (typeof u.completionTokens === "number") totalCompletion += u.completionTokens;

        if (typeof u.reasoningTokens === "number") totalReasoning += u.reasoningTokens;
        if (typeof u.cacheReadTokens === "number") latestCacheRead = u.cacheReadTokens;
        else if (typeof u.cachedTokens === "number") latestCacheRead = u.cachedTokens;
        if (typeof u.cacheWriteTokens === "number") latestCacheWrite = u.cacheWriteTokens;
        if (typeof u.costUsd === "number") latestCostUsd = u.costUsd;
      }
    }

    if (ev.type === "assistant/message") {
      const d = ev.data as { message?: { content?: Array<{ type?: string; text?: string }>; usage?: Record<string, unknown> }; usage?: Record<string, unknown> } | undefined;
      const u = (d?.message?.usage ?? d?.usage) as {
        inputTokens?: number; promptTokens?: number; outputTokens?: number; completionTokens?: number;
        reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cachedTokens?: number; costUsd?: number;
      } | undefined;

      if (u) {
        hasUsage = true;
        if (typeof u.inputTokens === "number" && u.inputTokens > 0) latestPrompt = u.inputTokens;
        else if (typeof u.promptTokens === "number" && u.promptTokens > 0) latestPrompt = u.promptTokens;

        if (typeof u.outputTokens === "number") totalCompletion = Math.max(totalCompletion, u.outputTokens);
        else if (typeof u.completionTokens === "number") totalCompletion = Math.max(totalCompletion, u.completionTokens);

        if (typeof u.reasoningTokens === "number") totalReasoning = Math.max(totalReasoning, u.reasoningTokens);
        if (typeof u.cacheReadTokens === "number") latestCacheRead = u.cacheReadTokens;
        else if (typeof u.cachedTokens === "number") latestCacheRead = u.cachedTokens;
        if (typeof u.cacheWriteTokens === "number") latestCacheWrite = u.cacheWriteTokens;
        if (typeof u.costUsd === "number") latestCostUsd = u.costUsd;
      }

      const content = d?.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === "reasoning" && typeof b.text === "string") {
            reasoningCharsTotal += b.text.length;
          }
        }
      }
    }
  }

  if (!hasUsage && latestPrompt === 0 && totalCompletion === 0) {
    return undefined;
  }

  const derivedReasoningTokens = totalReasoning > 0 ? totalReasoning : Math.round(reasoningCharsTotal / 4);
  const toolOutputsTokens = Math.round(toolOutputChars / 4);
  const systemPromptTokens = Math.min(latestPrompt > 0 ? latestPrompt : 350, 350);
  const toolsTokens = Math.min(Math.max(0, latestPrompt - systemPromptTokens), 2650);
  const skillsTokens = Math.min(Math.max(0, latestPrompt - systemPromptTokens - toolsTokens), 150);
  const conversationTokens = Math.max(0, latestPrompt - systemPromptTokens - toolsTokens - skillsTokens - toolOutputsTokens);

  return {
    promptTokens: latestPrompt,
    completionTokens: totalCompletion,
    reasoningTokens: derivedReasoningTokens > 0 ? derivedReasoningTokens : undefined,
    cacheReadTokens: latestCacheRead > 0 ? latestCacheRead : undefined,
    cacheCreationTokens: latestCacheWrite > 0 ? latestCacheWrite : undefined,
    costUsd: latestCostUsd,
    breakdown: {
      systemPrompt: systemPromptTokens,
      tools: toolsTokens,
      skills: skillsTokens,
      toolOutputs: toolOutputsTokens,
      conversation: conversationTokens,
    },
  };
}

/** Fold in-flight session TODO checklist items from todo/write events (last write wins). */
export function foldSessionTodos(events: readonly { type: string; data?: unknown }[]): SessionTodoItem[] {
  let latestTodos: SessionTodoItem[] = [];
  for (const ev of events) {
    if (ev.type === "todo/write") {
      const d = ev.data as { todos?: Array<{ id?: string; title?: string; content?: string; status?: string }> } | undefined;
      const raw = d?.todos ?? [];
      if (Array.isArray(raw)) {
        latestTodos = raw.map((item, idx) => ({
          id: item.id || `todo-${idx + 1}`,
          title: item.title || item.content || `Task ${idx + 1}`,
          status: (item.status === "completed" || item.status === "in_progress" ? item.status : "pending") as "pending" | "in_progress" | "completed",
        }));
      }
    }
  }
  return latestTodos;
}

