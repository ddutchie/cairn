/**
 * cairn session-stats — token throughput & latency, folded from the durable
 * session log (ported from DeepSeek Harness's `@deepseek-ai/dsh-session-stats`).
 *
 * Whole-log semantics mirror upstream `sessionStatsProjectionDefinition`:
 *   - a step opens at `step/start` (turn+step+time),
 *   - first token = the first `isTokenDelta` `assistant/chunk` in that step,
 *   - the assembled `assistant/message` closes the step: model time =
 *     message.time − step.start; TTFT = firstToken − step.start; decode =
 *     message.time − firstToken (only when the step reports output tokens),
 *   - `step/end` counts closed steps + turns (authoritative step lifecycle),
 *   - `tool/call`→`tool/result` pairs by callId accumulate tool wall time
 *     (excluded from throughput).
 *
 * The upstream `sessionStats` projection unit is mounted post-bootstrap in
 * `cordis-context.ts` (it injects only `sessionProjections`, which itself
 * mounts post-bootstrap). The mounted unit is the PRIMARY source for the
 * whole-session totals: read paths use `readSessionStats` (snapshot-first via
 * `sessionProjections.stateOf`, `foldSessionStats` fallback when the registry
 * is absent) and derive the Cairn extras from the snapshot.
 *
 * Cairn extras the unit does NOT track (no per-turn state upstream):
 * `byTurn` (per-turn TTFT/tok/s) stays a local supplement folded from the
 * same events, and aggregate `tokensPerSecond` is derived from the snapshot's
 * decode fields with the same formula as the fold. The local fold therefore
 * survives in two roles only: registry-absent fallback, and `byTurn`
 * supplement — never the totals source when a snapshot exists.
 *
 * Also derives PER-TURN metrics (TTFT of the turn's first step + throughput
 * over the turn's usage-reporting steps) so the renderer can show a compact
 * per-assistant-message stats line, matching upstream `deriveTurnMetrics`.
 */

/**
 * Inlined `isTokenDelta` (was `import { isTokenDelta } from
 * "@deepseek-ai/dsh-llm"` — removed upstream in `0.1.2-alpha.4`). Mirrors
 * `shared/session-stats.ts`; keep the two in sync.
 */
function isTokenDelta(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  const c = chunk as { type?: unknown; text?: unknown; argumentsDelta?: unknown; name?: unknown };
  switch (c.type) {
    case "text-delta":
    case "reasoning-delta":
      return typeof c.text === "string" && c.text !== "";
    case "tool-call-delta":
      return (typeof c.argumentsDelta === "string" && c.argumentsDelta !== "") || c.name !== undefined;
    default:
      return false;
  }
}

/** Whole-session aggregate throughput/latency totals. */
export interface SessionStatsTotals {
  /** Distinct turns with ≥1 closed step. */
  turns: number;
  /** Closed steps. */
  steps: number;
  /** Summed model wall time over message-assembling steps, ms. */
  llmMs: number;
  /** Summed matched tool call→result wall time, ms. */
  toolMs: number;
  /** Summed first-token latency over ttftSteps, ms. */
  ttftMs: number;
  /** Steps carrying a recorded first token. */
  ttftSteps: number;
  /** Summed decode wall time over usage-reporting steps, ms. */
  decodeMs: number;
  /** Summed provider output tokens over the same steps. */
  decodeTokens: number;
}

/** Per-turn latency/throughput reading for a single assistant bubble. */
export interface TurnStats {
  /** First-step TTFT in ms (absent when unrecorded). */
  ttftMs?: number;
  /** Decode throughput (output tokens / decode seconds) over usage-reporting steps. */
  tokensPerSecond?: number;
  /** Summed provider output tokens across the turn's usage-reporting steps. */
  outputTokens?: number;
}

export interface SessionStats {
  totals: SessionStatsTotals;
  /** turn number → per-turn metrics (turns with no derivable metric are absent). */
  byTurn: Record<number, TurnStats>;
  /** Session aggregate throughput (decodeTokens / decodeMs), for the composer line. */
  tokensPerSecond?: number;
}

type Ev = { type: string; time?: unknown; data?: unknown };

function outputTokensOf(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const v = (usage as { outputTokens?: unknown }).outputTokens;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Fold session events into aggregate + per-turn throughput/latency stats.
 * Pure and order-dependent (the append-only log order). Returns undefined only
 * when there are no events.
 */
export function foldSessionStats(events: readonly Ev[]): SessionStats | undefined {
  if (!events || events.length === 0) return undefined;

  const totals: SessionStatsTotals = {
    turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
  };
  let lastTurn: number | null = null;
  let openStep: { turn: number; step: number; startTime: number; firstTokenTime: number | null } | null = null;
  const pendingCalls = new Map<string, number>();

  // Per-turn accumulation (mirrors deriveTurnMetrics but folded server-side).
  interface TurnFold { firstStep: number; firstStepTtftMs: number | null; decodeMs: number; outputTokens: number; sampled: boolean }
  const turnFolds = new Map<number, TurnFold>();

  for (const ev of events) {
    const time = num(ev.time);
    const d = (ev.data ?? {}) as Record<string, unknown>;

    switch (ev.type) {
      case "step/start": {
        const turn = num(d.turn); const step = num(d.step);
        if (time === null || turn === null || step === null) break;
        openStep = { turn, step, startTime: time, firstTokenTime: null };
        break;
      }
      case "assistant/chunk": {
        if (openStep === null || time === null) break;
        const turn = num(d.turn); const step = num(d.step);
        if (turn !== openStep.turn || step !== openStep.step) break;
        if (openStep.firstTokenTime !== null) break;
        // "First token" = the first content-bearing chunk. The responses/streaming
        // wire sends incremental token deltas (isTokenDelta); the chat-completions
        // wire streams whole blocks and emits a `block-start` when the first block
        // begins — the closest analog to first-token there. Anchor TTFT on either
        // so BOTH protocols report a first-token latency (else completions text
        // turns, which carry no text-delta, would show no stats at all).
        const chunkType = (d.chunk as { type?: unknown } | undefined)?.type;
        if (chunkType !== "block-start" && !isTokenDelta(d.chunk as never)) break;
        openStep.firstTokenTime = time;
        break;
      }
      case "assistant/message": {
        if (openStep === null || time === null) break;
        const turn = num(d.turn); const step = num(d.step);
        if (turn !== openStep.turn || step !== openStep.step) break;
        totals.llmMs += Math.max(0, time - openStep.startTime);

        const tf = turnFolds.get(openStep.turn) ?? { firstStep: openStep.step, firstStepTtftMs: null, decodeMs: 0, outputTokens: 0, sampled: false };
        if (!turnFolds.has(openStep.turn)) turnFolds.set(openStep.turn, tf);

        if (openStep.firstTokenTime !== null) {
          const ttft = Math.max(0, openStep.firstTokenTime - openStep.startTime);
          totals.ttftMs += ttft;
          totals.ttftSteps += 1;
          // Turn TTFT = the turn's lowest step's reading.
          if (openStep.step <= tf.firstStep) { tf.firstStep = openStep.step; tf.firstStepTtftMs = ttft; }
          const out = outputTokensOf(d.usage);
          if (out !== null) {
            const decode = Math.max(0, time - openStep.firstTokenTime);
            totals.decodeMs += decode;
            totals.decodeTokens += out;
            tf.decodeMs += decode;
            tf.outputTokens += out;
            tf.sampled = true;
          }
        }
        openStep = null;
        break;
      }
      case "tool/call": {
        const callId = typeof d.callId === "string" ? d.callId : undefined;
        if (callId && time !== null) pendingCalls.set(callId, time);
        break;
      }
      case "tool/result": {
        const msg = (d.message ?? {}) as { source?: { callId?: unknown } };
        const callId = typeof msg.source?.callId === "string" ? msg.source.callId : undefined;
        if (!callId || !pendingCalls.has(callId) || time === null) break;
        totals.toolMs += Math.max(0, time - pendingCalls.get(callId)!);
        pendingCalls.delete(callId);
        break;
      }
      case "step/end": {
        const turn = num(d.turn);
        totals.turns = lastTurn === turn ? totals.turns : totals.turns + 1;
        totals.steps += 1;
        lastTurn = turn;
        openStep = null;
        break;
      }
      case "turn/end":
        pendingCalls.clear();
        break;
      default:
        break;
    }
  }

  const byTurn: Record<number, TurnStats> = {};
  for (const [turn, tf] of turnFolds) {
    const entry: TurnStats = {};
    if (tf.firstStepTtftMs !== null) entry.ttftMs = tf.firstStepTtftMs;
    if (tf.sampled && tf.decodeMs > 0) {
      entry.tokensPerSecond = tf.outputTokens / (tf.decodeMs / 1000);
      entry.outputTokens = tf.outputTokens;
    }
    if (entry.ttftMs !== undefined || entry.tokensPerSecond !== undefined) byTurn[turn] = entry;
  }

  const tokensPerSecond = totals.decodeMs > 0 ? totals.decodeTokens / (totals.decodeMs / 1000) : undefined;
  return { totals, byTurn, tokensPerSecond };
}

/**
 * Upstream `sessionStats` wire view: the 8 whole-log totals served through
 * the session-projection seam. No per-turn state — see the module header.
 */
export interface SessionStatsSnapshot {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
}

const SNAPSHOT_FIELDS = [
  "turns", "steps", "llmMs", "toolMs", "ttftMs", "ttftSteps", "decodeMs", "decodeTokens",
] as const;

/** Structural guard for a `sessionStats` view of unknown provenance. */
export function isSessionStatsSnapshot(value: unknown): value is SessionStatsSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return SNAPSHOT_FIELDS.every((f) => typeof v[f] === "number" && Number.isFinite(v[f]) && (v[f] as number) >= 0);
}

/**
 * Build the renderer-facing `SessionStats` from a mounted-unit snapshot.
 * Totals come from the snapshot (never re-folded); the Cairn extras are
 * computed from it: aggregate `tokensPerSecond` via the same decode formula
 * as the fold, and `byTurn` via a local fold of the same events (the unit
 * tracks no per-turn state, so the fold survives ONLY as this supplement —
 * pass no events and `byTurn` is empty rather than wrong).
 */
export function sessionStatsFromSnapshot(
  snapshot: SessionStatsSnapshot,
  events?: readonly Ev[],
): SessionStats {
  const totals: SessionStatsTotals = {
    turns: snapshot.turns,
    steps: snapshot.steps,
    llmMs: snapshot.llmMs,
    toolMs: snapshot.toolMs,
    ttftMs: snapshot.ttftMs,
    ttftSteps: snapshot.ttftSteps,
    decodeMs: snapshot.decodeMs,
    decodeTokens: snapshot.decodeTokens,
  };
  const tokensPerSecond = totals.decodeMs > 0 ? totals.decodeTokens / (totals.decodeMs / 1000) : undefined;
  const byTurn = events ? (foldSessionStats(events)?.byTurn ?? {}) : {};
  return { totals, byTurn, tokensPerSecond };
}

/** Minimal structural type for the projection registry (avoids a cordis import). */
export interface SessionStatsRegistryLike {
  stateOf?: (session: unknown, key: string) => unknown;
}

/** Projection key of the upstream unit (mirrors `sessionStatsProjectionDefinition.key`). */
export const SESSION_STATS_PROJECTION_KEY = "sessionStats";

/**
 * Best-effort snapshot read through the mounted unit. Returns undefined when
 * the registry is absent, the session is not resident, the unit is not
 * registered, or the view fails validation — every case falls back to
 * `foldSessionStats` in `readSessionStats`. Never throws.
 */
export function readSessionStatsSnapshot(
  registry: SessionStatsRegistryLike | undefined | null,
  session: unknown,
): SessionStatsSnapshot | undefined {
  try {
    if (!registry || typeof registry.stateOf !== "function" || !session) return undefined;
    const view = registry.stateOf(session, SESSION_STATS_PROJECTION_KEY);
    if (!isSessionStatsSnapshot(view)) return undefined;
    return {
      turns: view.turns,
      steps: view.steps,
      llmMs: view.llmMs,
      toolMs: view.toolMs,
      ttftMs: view.ttftMs,
      ttftSteps: view.ttftSteps,
      decodeMs: view.decodeMs,
      decodeTokens: view.decodeTokens,
    };
  } catch {
    return undefined;
  }
}

/**
 * Snapshot-first session-stats read for the replay/load path: totals from the
 * mounted `sessionStats` unit when available, `foldSessionStats` over the
 * durable log otherwise. `byTurn`/aggregate `tokensPerSecond` are always
 * computed from whichever totals source wins (see `sessionStatsFromSnapshot`).
 */
export function readSessionStats(opts: {
  registry?: SessionStatsRegistryLike | undefined | null;
  session?: unknown;
  events: readonly Ev[];
}): SessionStats | undefined {
  const snapshot = readSessionStatsSnapshot(opts.registry, opts.session);
  if (snapshot) return sessionStatsFromSnapshot(snapshot, opts.events);
  return foldSessionStats(opts.events);
}
