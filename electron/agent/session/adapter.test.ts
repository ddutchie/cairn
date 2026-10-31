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

describe("note writes", () => {
  it("projects fresh note content after ensure_note / edit_note", () => {
    const adapt = createAdapter("s", () => 1, (id) => (id === "n1" ? "# plan" : undefined));
    const out = adapt({ type: "tool/result", callId: "c", name: "edit_note", text: JSON.stringify({ id: "n1" }), isError: false } as unknown as AgentEvent);
    expect(out.projections.map((p) => [p.kind, (p.data as { content: string }).content])).toEqual([["note-updated", "# plan"]]);
    expect(adapt({ type: "tool/result", callId: "d", name: "edit_note", text: JSON.stringify({ id: "zz" }), isError: false } as unknown as AgentEvent).projections).toEqual([]);
  });
});
