/**
 * Shared session-stats — token throughput & latency, folded from durable log.
 * Vendored from electron/cordis/session-stats.ts so both main (replay) and
 * renderer (live) share one implementation. Keep the two files in sync.
 *
 * Client-safe: inlined isTokenDelta (was `import { isTokenDelta } from
 * "@deepseek-ai/dsh-llm"` which pulls `node:module` and breaks Next.js
 * client chunking).
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

export interface SessionStatsTotals {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
}
export interface TurnStats {
  ttftMs?: number;
  tokensPerSecond?: number;
  outputTokens?: number;
}
export interface SessionStats {
  totals: SessionStatsTotals;
  byTurn: Record<number, TurnStats>;
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
export function foldSessionStats(events: readonly Ev[]): SessionStats | undefined {
  if (!events || events.length === 0) return undefined;
  const totals: SessionStatsTotals = {
    turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
  };
  let lastTurn: number | null = null;
  let openStep: { turn: number; step: number; startTime: number; firstTokenTime: number | null } | null = null;
  const pendingCalls = new Map<string, number>();
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
