/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { foldSessionStats } from "./session-stats";

// Minimal event builders — the fold reads event.type, event.time, and
// event.data.{turn,step,chunk,usage,message,callId}. `seq` is irrelevant here.
const stepStart = (turn: number, step: number, time: number) => ({ type: "step/start", time, data: { turn, step } });
const textDelta = (turn: number, step: number, time: number, text = "hi") => ({ type: "assistant/chunk", time, data: { turn, step, chunk: { type: "text-delta", text } } });
const reasoningDelta = (turn: number, step: number, time: number, text = "think") => ({ type: "assistant/chunk", time, data: { turn, step, chunk: { type: "reasoning-delta", text } } });
const blockStart = (turn: number, step: number, time: number) => ({ type: "assistant/chunk", time, data: { turn, step, chunk: { type: "block-start" } } });
const message = (turn: number, step: number, time: number, outputTokens?: number) => ({ type: "assistant/message", time, data: { turn, step, message: {}, ...(outputTokens !== undefined ? { usage: { outputTokens } } : {}) } });
const stepEnd = (turn: number, step: number, time: number) => ({ type: "step/end", time, data: { turn, step } });
const toolCall = (callId: string, time: number) => ({ type: "tool/call", time, data: { callId } });
const toolResult = (callId: string, time: number) => ({ type: "tool/result", time, data: { message: { source: { callId } } } });
const turnEnd = (turn: number, time: number) => ({ type: "turn/end", time, data: { turn } });

describe("foldSessionStats", () => {
  it("returns undefined on empty log", () => {
    expect(foldSessionStats([])).toBeUndefined();
  });

  it("normal single-step turn: TTFT, decode, tok/s", () => {
    // step 1000ms; first token 1200ms; message 2200ms; 100 output tokens.
    const s = foldSessionStats([
      stepStart(1, 1, 1000),
      blockStart(1, 1, 1100),        // not a token → ignored for TTFT
      textDelta(1, 1, 1200),         // first token
      textDelta(1, 1, 1500),
      message(1, 1, 2200, 100),
      stepEnd(1, 1, 2200),
      turnEnd(1, 2200),
    ])!;
    expect(s.totals.turns).toBe(1);
    expect(s.totals.steps).toBe(1);
    expect(s.totals.ttftMs).toBe(200);         // 1200 - 1000
    expect(s.totals.ttftSteps).toBe(1);
    expect(s.totals.decodeMs).toBe(1000);       // 2200 - 1200
    expect(s.totals.decodeTokens).toBe(100);
    expect(s.totals.llmMs).toBe(1200);          // 2200 - 1000
    // 100 tokens / 1.0s = 100 tok/s
    expect(s.tokensPerSecond).toBeCloseTo(100, 5);
    expect(s.byTurn[1].ttftMs).toBe(200);
    expect(s.byTurn[1].tokensPerSecond).toBeCloseTo(100, 5);
    expect(s.byTurn[1].outputTokens).toBe(100);
  });

  it("reasoning-delta counts as the first token", () => {
    const s = foldSessionStats([
      stepStart(1, 1, 0),
      reasoningDelta(1, 1, 300),     // reasoning is a token delta → TTFT anchor
      textDelta(1, 1, 800),
      message(1, 1, 1300, 50),
      stepEnd(1, 1, 1300),
    ])!;
    expect(s.totals.ttftMs).toBe(300);
    expect(s.totals.decodeMs).toBe(1000);       // 1300 - 300
    expect(s.byTurn[1].ttftMs).toBe(300);
  });

  it("multi-step turn sums decode tokens + time; TTFT is the first step's", () => {
    const s = foldSessionStats([
      // turn 1, step 1: tool round (has tokens)
      stepStart(1, 1, 0),
      textDelta(1, 1, 100),
      message(1, 1, 600, 40),
      stepEnd(1, 1, 600),
      // turn 1, step 2: final answer
      stepStart(1, 2, 700),
      textDelta(1, 2, 900),
      message(1, 2, 1900, 60),
      stepEnd(1, 2, 1900),
      turnEnd(1, 1900),
    ])!;
    expect(s.totals.turns).toBe(1);             // same turn, two steps
    expect(s.totals.steps).toBe(2);
    expect(s.totals.decodeTokens).toBe(100);    // 40 + 60
    // decode: step1 (600-100=500) + step2 (1900-900=1000) = 1500ms → 100/1.5 ≈ 66.7
    expect(s.totals.decodeMs).toBe(1500);
    expect(s.byTurn[1].outputTokens).toBe(100);
    expect(s.byTurn[1].tokensPerSecond).toBeCloseTo(100 / 1.5, 4);
    expect(s.byTurn[1].ttftMs).toBe(100);       // first step's TTFT (100-0)
  });

  it("missing usage: TTFT recorded but no throughput (no zero/NaN)", () => {
    const s = foldSessionStats([
      stepStart(1, 1, 0),
      textDelta(1, 1, 200),
      message(1, 1, 1200),           // NO usage
      stepEnd(1, 1, 1200),
    ])!;
    expect(s.totals.ttftMs).toBe(200);
    expect(s.totals.ttftSteps).toBe(1);
    expect(s.totals.decodeMs).toBe(0);
    expect(s.totals.decodeTokens).toBe(0);
    expect(s.tokensPerSecond).toBeUndefined();  // decodeMs 0 → omitted, never NaN
    expect(s.byTurn[1].ttftMs).toBe(200);
    expect(s.byTurn[1].tokensPerSecond).toBeUndefined();
  });

  it("interrupted step (no assistant/message) contributes no misleading throughput", () => {
    const s = foldSessionStats([
      stepStart(1, 1, 0),
      textDelta(1, 1, 200),          // started decoding…
      // …cancelled: step/end without an assistant/message
      stepEnd(1, 1, 900),
      turnEnd(1, 900),
    ])!;
    expect(s.totals.steps).toBe(1);
    expect(s.totals.ttftSteps).toBe(0);         // never assembled → no TTFT counted
    expect(s.totals.decodeMs).toBe(0);
    expect(s.totals.decodeTokens).toBe(0);
    expect(s.tokensPerSecond).toBeUndefined();
    expect(s.byTurn[1]).toBeUndefined();         // no derivable metric
  });

  it("tool wall time is tracked separately and excluded from decode", () => {
    const s = foldSessionStats([
      stepStart(1, 1, 0),
      textDelta(1, 1, 100),
      toolCall("c1", 300),
      message(1, 1, 600, 20),
      stepEnd(1, 1, 600),
      toolResult("c1", 1600),         // 1300ms tool wait
      stepStart(1, 2, 1700),
      textDelta(1, 2, 1800),
      message(1, 2, 2300, 30),
      stepEnd(1, 2, 2300),
      turnEnd(1, 2300),
    ])!;
    expect(s.totals.toolMs).toBe(1300);         // 1600 - 300
    // decode only spans first-token→message per step, never the tool wait
    expect(s.totals.decodeMs).toBe((600 - 100) + (2300 - 1800)); // 500 + 500 = 1000
    expect(s.totals.decodeTokens).toBe(50);
  });

  it("multiple turns count distinctly", () => {
    const s = foldSessionStats([
      stepStart(1, 1, 0), textDelta(1, 1, 100), message(1, 1, 500, 10), stepEnd(1, 1, 500), turnEnd(1, 500),
      stepStart(2, 1, 1000), textDelta(2, 1, 1100), message(2, 1, 1500, 10), stepEnd(2, 1, 1500), turnEnd(2, 1500),
    ])!;
    expect(s.totals.turns).toBe(2);
    expect(s.totals.steps).toBe(2);
    expect(Object.keys(s.byTurn).sort()).toEqual(["1", "2"]);
  });
});
