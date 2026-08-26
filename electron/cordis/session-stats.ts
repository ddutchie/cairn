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
 * We fold once here (like foldSessionUsage) instead of mounting the upstream
 * projection unit, because Cairn reads stats on the replay/load path and the
 * event shape (`event.time`, `data.turn`, `data.step`, `data.usage.outputTokens`)
 * is identical to what upstream folds.
 *
 * Also derives PER-TURN metrics (TTFT of the turn's first step + throughput
 * over the turn's usage-reporting steps) so the renderer can show a compact
 * per-assistant-message stats line, matching upstream `deriveTurnMetrics`.
 */

import { isTokenDelta } from "@deepseek-ai/dsh-llm";

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
        if (!isTokenDelta(d.chunk as never)) break;
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
