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
import { foldSessionUsage as dshFoldSessionUsage } from "dsh-context-ring";
import { contextPressureTokens } from "../../../shared/agent/context-pressure";

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
  contextLimit?: number;
  contextWindow?: number;
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
  // dsh-context-ring's fold accepts its own SessionEvent shape; ours carries
  // the same discriminators (`type` + `data`) but is nominally typed. Cast
  // through unknown to satisfy the structural boundary — dsh reads only the
  // `type` + `data.usage` fields we already provide.
  const usage = dshFoldSessionUsage(normalizeRingEvents(events) as unknown as Parameters<typeof dshFoldSessionUsage>[0]);
  if (!usage) return undefined;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costUsd: usage.costUsd,
    contextLimit: usage.contextLimit,
    contextWindow: usage.contextWindow,
    breakdown: usage.breakdown,
  };
}


type RingEvent = { type: string; seq?: number; data?: unknown };

/**
 * Adapt a dsh ≥0.2 event log to the shapes the dsh-context-ring fold reads.
 * The fold predates three upstream changes, each of which zeroed a ring slice:
 *
 *   1. Usage is DISJOINT (`inputTokens` = uncached only). The fold took
 *      `max(inputTokens)` as the context size, so with prompt caching on the
 *      prompt collapsed to the uncached delta and the system/tools estimates
 *      swallowed it — conversation + tool outputs read 0. Rewrite each usage to
 *      the full prompt pressure (input + cache read + cache write, as dsh
 *      token-meter computes it) and keep ONLY the latest settlement's usage:
 *      context size is the latest request, not the max (compaction shrinks it).
 *   2. The system prompt moved from `request/header.header.system` (now
 *      forbidden) to `system/message` surface nodes — re-expose the latest
 *      one as a header-system so the system slice is measured, not guessed.
 *   3. Injected user context is tagged by `source.kind` (`skill-catalog`,
 *      `agent-instructions`, …) + `form`, not `kind: "plugin"` — map those to
 *      the plugin source the fold buckets as skills/system instead of
 *      counting them as conversation.
 */
export function normalizeRingEvents(events: readonly RingEvent[]): RingEvent[] {
  let lastUsageIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "assistant/message" && (ev.data as { usage?: unknown } | undefined)?.usage) { lastUsageIdx = i; break; }
  }
  const out: RingEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === "assistant/message") {
      const d = ev.data as { usage?: Record<string, unknown> } | undefined;
      if (!d?.usage) { out.push(ev); continue; }
      if (i !== lastUsageIdx) { const { usage: _drop, ...rest } = d; void _drop; out.push({ ...ev, data: rest }); continue; }
      const u = d.usage;
      out.push({
        ...ev,
        data: {
          ...d,
          usage: {
            ...u,
            inputTokens: contextPressureTokens(u),
            ...(typeof u.cacheWriteTokens !== "number" && typeof u.cacheCreationTokens === "number" ? { cacheWriteTokens: u.cacheCreationTokens } : {}),
          },
        },
      });
      continue;
    }
    if (ev.type === "system/message") {
      const msg = (ev.data as { message?: { content?: unknown } } | undefined)?.message;
      const blocks = Array.isArray(msg?.content) ? msg.content as Array<{ type?: string; text?: unknown }> : [];
      const text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
      out.push({ type: "request/header", seq: ev.seq, data: { header: { system: text } } });
      continue;
    }
    if (ev.type === "user/message") {
      const d = ev.data as { source?: { kind?: unknown } } | undefined;
      const kind = d?.source?.kind;
      if (typeof kind === "string" && kind !== "user" && kind !== "plugin") {
        out.push({ ...ev, data: { ...d, source: { ...d!.source, kind: "plugin", plugin: kind } } });
        continue;
      }
    }
    out.push(ev);
  }
  return out;
}

/**
 * A synthetic `assistant/chunk` usage event carrying the full server-computed
 * breakdown (foldSessionUsage over the whole log), for the renderer's live
 * fold. `promptTokens` (not `inputTokens`) marks the count as already the full
 * context size, so the renderer does not re-add cache tokens. Null when the
 * log yields no usage.
 */
export function breakdownUsageEvent(events: readonly RingEvent[]): RingEvent | null {
  const usage = foldSessionUsage(events);
  if (!usage?.breakdown) return null;
  return {
    type: "assistant/chunk",
    seq: -1,
    data: {
      chunk: {
        type: "usage",
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          reasoningTokens: usage.reasoningTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          costUsd: usage.costUsd,
          breakdown: usage.breakdown,
        },
      },
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

