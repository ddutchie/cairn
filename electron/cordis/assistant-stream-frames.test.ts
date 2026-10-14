import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { createTurnStreamStats, onAssistantStream, statsChunkEvent } from "./assistant-stream-frames";

function clock() {
  let t = 1000;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

describe("createTurnStreamStats", () => {
  it("measures TTFT, decode throughput and output tokens for one stream", () => {
    const c = clock();
    const s = createTurnStreamStats(c.now);
    s.onFrame("start");
    c.tick(800);
    s.onDelta();
    c.tick(2000);
    s.onUsage({ outputTokens: 100 });
    s.onFrame("end");
    expect(s.snapshot()).toEqual({ ttftMs: 800, tokensPerSecond: 50, outputTokens: 100 });
  });

  it("keeps the first stream's TTFT and sums later streams (tool turns)", () => {
    const c = clock();
    const s = createTurnStreamStats(c.now);
    s.onFrame("start"); c.tick(500); s.onDelta(); c.tick(1000); s.onUsage({ outputTokens: 40 }); s.onFrame("end");
    c.tick(3000); // tool runs; not decode time
    s.onFrame("start"); c.tick(200); s.onDelta(); c.tick(1000); s.onUsage({ outputTokens: 60 }); s.onFrame("end");
    expect(s.snapshot()).toEqual({ ttftMs: 500, tokensPerSecond: 50, outputTokens: 100 });
  });

  it("uses the latest usage within one stream rather than adding repeats", () => {
    const c = clock();
    const s = createTurnStreamStats(c.now);
    s.onFrame("start"); c.tick(100); s.onDelta(); c.tick(1000);
    s.onUsage({ outputTokens: 10 }); s.onUsage({ outputTokens: 20 });
    s.onFrame("end");
    expect(s.snapshot()?.outputTokens).toBe(20);
  });

  it("settles an unterminated stream on snapshot", () => {
    const c = clock();
    const s = createTurnStreamStats(c.now);
    s.onFrame("start"); c.tick(100); s.onDelta(); c.tick(1000); s.onUsage({ outputTokens: 30 });
    expect(s.snapshot()).toEqual({ ttftMs: 100, tokensPerSecond: 30, outputTokens: 30 });
  });

  it("omits throughput without usage and returns undefined when nothing happened", () => {
    const c = clock();
    const s = createTurnStreamStats(c.now);
    expect(s.snapshot()).toBeUndefined();
    s.onFrame("start"); c.tick(250); s.onDelta(); s.onFrame("end");
    expect(s.snapshot()).toEqual({ ttftMs: 250 });
  });

  it("builds a renderer-fold stats chunk", () => {
    expect(statsChunkEvent({ ttftMs: 1 }).data.chunk).toEqual({ type: "stats", stats: { ttftMs: 1 } });
  });
});

describe("onAssistantStream frames", () => {
  it("reports every frame type and routes deltas, honouring the match predicate", () => {
    let listener: ((p: unknown) => void) | undefined;
    const ctx = { on: (_e: string, l: (p: unknown) => void) => { listener = l; return () => {}; } } as unknown as Context;
    const frames: string[] = [];
    const text: string[] = [];
    const usage: number[] = [];
    onAssistantStream(ctx, (id) => id === "chat-1", {
      onFrame: (t) => frames.push(t),
      onText: (t) => text.push(t),
      onUsage: (u) => usage.push(u.outputTokens ?? -1),
    });
    const send = (id: string, frame: unknown) => listener!({ frame, agent: { session: { id } } });
    send("chat-1", { type: "start" });
    send("chat-1", { type: "chunk", chunk: { type: "text-delta", text: "hi" } });
    send("other", { type: "chunk", chunk: { type: "text-delta", text: "no" } });
    send("chat-1", { type: "chunk", chunk: { type: "usage", usage: { outputTokens: 7 } } });
    send("chat-1", { type: "end" });
    expect(frames).toEqual(["start", "chunk", "chunk", "end"]);
    expect(text).toEqual(["hi"]);
    expect(usage).toEqual([7]);
  });
});
