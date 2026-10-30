import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../events";
import { createAdapter } from "./adapter";

describe("turn stats", () => {
  it("emits ttft, tok/s and output tokens before turn/end", () => {
    let t = 1000;
    const adapt = createAdapter("s", () => t);
    const run = (e: unknown) => adapt(e as AgentEvent).events;
    run({ type: "turn/start", sessionId: "s", profile: "chat" });
    t = 1500; run({ type: "assistant/delta", text: "hi" });
    t = 3500;
    run({ type: "assistant/message", message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 101, cost: { total: 0 } } } });
    const end = run({ type: "turn/end", reason: "stop" });
    expect(end.map((e) => e.type)).toEqual(["assistant/chunk", "turn/end"]);
    expect((end[0].data as { chunk: { stats: unknown } }).chunk.stats).toEqual({ ttftMs: 500, tokensPerSecond: 50, outputTokens: 100 });
  });
});
