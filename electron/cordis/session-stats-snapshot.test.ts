import { describe, it, expect } from "vitest";
import {
  foldSessionStats,
  isSessionStatsSnapshot,
  readSessionStats,
  readSessionStatsSnapshot,
  sessionStatsFromSnapshot,
  SESSION_STATS_PROJECTION_KEY,
  type SessionStatsSnapshot,
} from "./session-stats";

// Same minimal event builders as session-stats.test.ts — the snapshot
// agreement test folds these AND feeds a fake registry returning the same
// totals, proving the snapshot read matches the fold on identical input.
const stepStart = (turn: number, step: number, time: number) => ({ type: "step/start", time, data: { turn, step } });
const textDelta = (turn: number, step: number, time: number, text = "hi") => ({ type: "assistant/chunk", time, data: { turn, step, chunk: { type: "text-delta", text } } });
const message = (turn: number, step: number, time: number, outputTokens?: number) => ({ type: "assistant/message", time, data: { turn, step, message: {}, ...(outputTokens !== undefined ? { usage: { outputTokens } } : {}) } });
const stepEnd = (turn: number, step: number, time: number) => ({ type: "step/end", time, data: { turn, step } });
const turnEnd = (turn: number, time: number) => ({ type: "turn/end", time, data: { turn } });

function turnEvents(): Array<{ type: string; time: number; data: Record<string, unknown> }> {
  return [
    stepStart(1, 1, 1000),
    textDelta(1, 1, 1200),
    message(1, 1, 2200, 100),
    stepEnd(1, 1, 2200),
    turnEnd(1, 2200),
  ];
}

describe("sessionStats snapshot read (mounted unit primary, fold fallback)", () => {
  it("snapshot-read agrees with the fold (fake registry)", () => {
    const events = turnEvents();
    const folded = foldSessionStats(events)!;
    // A converged registry serves exactly the fold's totals as the view.
    const registry = { stateOf: () => ({ ...folded.totals }) };
    const read = readSessionStats({ registry, session: { id: "s1" }, events });
    expect(read).toBeDefined();
    expect(read!.totals).toEqual(folded.totals);
    expect(read!.tokensPerSecond).toBeCloseTo(folded.tokensPerSecond!, 9);
    expect(read!.byTurn).toEqual(folded.byTurn);
  });

  it("falls back to the fold with no registry (or no session)", () => {
    const events = turnEvents();
    const folded = foldSessionStats(events)!;
    expect(readSessionStats({ registry: undefined, session: { id: "s1" }, events })).toEqual(folded);
    expect(readSessionStats({ session: { id: "s1" }, events })).toEqual(folded);
    expect(readSessionStats({ registry: { stateOf: () => ({ ...folded.totals }) }, events })).toEqual(folded);
  });

  it("falls back to the fold when stateOf throws or serves garbage", () => {
    const events = turnEvents();
    const folded = foldSessionStats(events)!;
    const throwing = { stateOf: () => { throw new Error("unit not registered"); } };
    expect(readSessionStats({ registry: throwing, session: { id: "s1" }, events })).toEqual(folded);
    const garbage = { stateOf: () => ({ turns: "many", nope: true }) };
    expect(readSessionStats({ registry: garbage, session: { id: "s1" }, events })).toEqual(folded);
    const partial = { stateOf: () => ({ turns: 1, steps: 1 }) };
    expect(readSessionStats({ registry: partial, session: { id: "s1" }, events })).toEqual(folded);
  });

  it("snapshot is primary for totals even when the events diverge", () => {
    // Registry converged on a LATER log than the caller's event window (e.g.
    // live session kept committing while the durable prefix was inspected):
    // totals must follow the snapshot, not the stale fold.
    const snapshot: SessionStatsSnapshot = {
      turns: 5, steps: 9, llmMs: 42000, toolMs: 3000,
      ttftMs: 1500, ttftSteps: 5, decodeMs: 20000, decodeTokens: 2000,
    };
    const read = readSessionStats({
      registry: { stateOf: () => ({ ...snapshot }) },
      session: { id: "s1" },
      events: turnEvents(),
    })!;
    expect(read.totals).toEqual(snapshot);
    // Cairn extras computed FROM the snapshot: 2000 tok / 20s = 100 tok/s.
    expect(read.tokensPerSecond).toBeCloseTo(100, 9);
    // byTurn is the documented supplement: still folded from the events the
    // caller has (the unit tracks no per-turn state), never empty-invented.
    expect(read.byTurn[1].ttftMs).toBe(200);
  });

  it("sessionStatsFromSnapshot derives extras with no events (empty byTurn, never NaN)", () => {
    const snapshot: SessionStatsSnapshot = {
      turns: 0, steps: 0, llmMs: 0, toolMs: 0,
      ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
    };
    const read = sessionStatsFromSnapshot(snapshot);
    expect(read.totals).toEqual(snapshot);
    expect(read.tokensPerSecond).toBeUndefined();
    expect(read.byTurn).toEqual({});
  });

  it("isSessionStatsSnapshot rejects non-views", () => {
    expect(isSessionStatsSnapshot(undefined)).toBe(false);
    expect(isSessionStatsSnapshot(null)).toBe(false);
    expect(isSessionStatsSnapshot({})).toBe(false);
    expect(isSessionStatsSnapshot({ turns: 1, steps: 1, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: NaN })).toBe(false);
    expect(isSessionStatsSnapshot({ turns: 1, steps: 1, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: -1 })).toBe(false);
    expect(isSessionStatsSnapshot({ turns: 1, steps: 1, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 })).toBe(true);
  });

  it("readSessionStatsSnapshot never throws and keys on sessionStats", () => {
    const seen: string[] = [];
    const registry = { stateOf: (s: unknown, key: string) => { seen.push(key); return undefined; } };
    expect(readSessionStatsSnapshot(registry, { id: "s1" })).toBeUndefined();
    expect(seen).toEqual([SESSION_STATS_PROJECTION_KEY]);
    expect(readSessionStatsSnapshot(undefined, { id: "s1" })).toBeUndefined();
    expect(readSessionStatsSnapshot(registry, undefined)).toBeUndefined();
    expect(readSessionStatsSnapshot({} as never, { id: "s1" })).toBeUndefined();
  });

  it("upstream plugin wires the sessionStats unit onto sessionProjections", async () => {
    // Proves the cordis-context mount shape (function plugin with
    // sessionProjections-only inject → post-bootstrap mount, NOT ENTRY_LIST):
    // apply() must register exactly the `sessionStats` key.
    const { apply, inject, name } = await import("@deepseek-ai/dsh-session-stats");
    expect(name).toBe("session-stats");
    expect(inject).toEqual(["sessionProjections"]);
    const registered: unknown[] = [];
    const fakeCtx = { sessionProjections: { register: (def: unknown) => { registered.push(def); } } };
    (apply as (ctx: unknown) => void)(fakeCtx as never);
    expect(registered).toHaveLength(1);
    expect((registered[0] as { key?: string }).key).toBe(SESSION_STATS_PROJECTION_KEY);
  });
});
