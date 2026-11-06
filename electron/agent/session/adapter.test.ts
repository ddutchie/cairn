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

describe("turn/end failure detail", () => {
  const turnEnd = (out: { events: { type: string; data: unknown }[] }) => out.events.find((e) => e.type === "turn/end")?.data;

  it("carries the error message on a failed turn", () => {
    const adapt = createAdapter("s", () => 1);
    adapt({ type: "turn/start", sessionId: "s", profile: "chat" } as unknown as AgentEvent);
    adapt({ type: "error", message: "401 bad key" } as AgentEvent);
    expect(turnEnd(adapt({ type: "turn/end", reason: "error" } as AgentEvent))).toEqual({ reason: { kind: "error", error: { message: "401 bad key" } } });
  });

  it("does not attach an earlier error to a turn that ended cleanly", () => {
    const adapt = createAdapter("s", () => 1);
    adapt({ type: "error", message: "Compaction failed" } as AgentEvent);
    expect(turnEnd(adapt({ type: "turn/end", reason: "stop" } as AgentEvent))).toEqual({ reason: { kind: "stop" } });
  });

  it("does not carry a failure into the next turn", () => {
    const adapt = createAdapter("s", () => 1);
    adapt({ type: "error", message: "old" } as AgentEvent);
    adapt({ type: "turn/end", reason: "error" } as AgentEvent);
    adapt({ type: "turn/start", sessionId: "s", profile: "chat" } as unknown as AgentEvent);
    expect(turnEnd(adapt({ type: "turn/end", reason: "error" } as AgentEvent))).toEqual({ reason: { kind: "error" } });
  });
});
