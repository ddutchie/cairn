import { describe, expect, it } from "vitest";
import { createSessionEventFold } from "./session-event-fold";

const event = (type: string, data: unknown) => ({ type, seq: 1, time: 1, data });

describe("renderer session event fold", () => {
  it("folds streamed assistant content, usage, tool calls/results, and turn end", () => {
    const seen: Record<string, unknown[]> = { text: [], reasoning: [], usage: [], calls: [], results: [], ends: [] };
    const fold = createSessionEventFold({
      onText: (value) => seen.text.push(value),
      onReasoning: (value) => seen.reasoning.push(value),
      onUsage: (value) => seen.usage.push(value),
      onToolCall: (value) => seen.calls.push(value),
      onToolResult: (value) => seen.results.push(value),
      onTurnEnd: (value) => seen.ends.push(value),
    });

    fold(event("turn/start", {}));
    fold(event("assistant/chunk", { chunk: { type: "text-delta", text: "hello" } }));
    fold(event("assistant/chunk", { chunk: { type: "reasoning-delta", text: "think" } }));
    fold(event("assistant/chunk", { chunk: { type: "usage", usage: { inputTokens: 4, outputTokens: 2, reasoningTokens: 1 } } }));
    fold(event("tool/call", { callId: "c1", name: "read", arguments: '{"path":"x"}' }));
    fold(event("tool/result", { message: { source: { callId: "c1" }, content: [{ content: [{ type: "text", text: "ok" }] }] }, meta: { safe: true } }));
    fold(event("turn/end", { reason: { kind: "completed" } }));

    expect(seen.text).toEqual(["hello"]);
    expect(seen.reasoning).toEqual(["think"]);
    expect(seen.usage[0]).toMatchObject({ promptTokens: 4, completionTokens: 2, reasoningTokens: 1 });
    expect(seen.calls[0]).toMatchObject({ callId: "c1", name: "read", args: { path: "x" } });
    expect(seen.results[0]).toMatchObject({ callId: "c1", name: "read", output: "ok", ok: true, meta: { safe: true } });
    expect(seen.ends).toEqual(["completed"]);
  });

  it("does not duplicate final assistant content after streamed chunks", () => {
    const text: string[] = [];
    const fold = createSessionEventFold({ onText: (value) => text.push(value) });
    fold(event("turn/start", {}));
    fold(event("assistant/chunk", { chunk: { type: "text-delta", text: "live" } }));
    fold(event("assistant/message", { message: { content: [{ type: "text", text: "live" }] } }));
    expect(text).toEqual(["live"]);
  });

  it("passes validated tool views through calls and results", () => {
    const seen: Record<string, unknown[]> = { calls: [], results: [] };
    const fold = createSessionEventFold({
      onToolCall: (value) => seen.calls.push(value),
      onToolResult: (value) => seen.results.push(value),
    });
    fold(event("tool/call", { callId: "c1", name: "bash", arguments: "{}", view: { card: "terminal", title: "ls" } }));
    fold(event("tool/result", {
      message: { source: { callId: "c1" }, content: [{ content: [{ type: "text", text: "x" }] }] },
      resultView: { card: "terminal", title: "ls", output: "x", exitCode: 0 },
    }));
    expect(seen.calls[0]).toMatchObject({ view: { card: "terminal", title: "ls" } });
    expect(seen.results[0]).toMatchObject({ resultView: { card: "terminal", output: "x", exitCode: 0 } });
    // Malformed views are dropped, not crashed on.
    const fold2 = createSessionEventFold({
      onToolCall: (value) => seen.calls.push(value),
      onToolResult: (value) => seen.results.push(value),
    });
    fold2(event("tool/call", { callId: "c2", name: "bash", arguments: "{}", view: { card: "terminal" } }));
    fold2(event("tool/result", { message: { source: { callId: "c2" }, content: [{ content: [{ type: "text", text: "y" }] }] }, resultView: "nope" }));
    expect(seen.calls[1]).not.toHaveProperty("view");
    expect(seen.results[1]).not.toHaveProperty("resultView");
  });
});
