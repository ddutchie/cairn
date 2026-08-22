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
