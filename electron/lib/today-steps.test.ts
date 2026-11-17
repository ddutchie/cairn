import { describe, expect, it } from "vitest";
import { summariseRunSteps } from "./today";

describe("summariseRunSteps", () => {
  it("times each reply from the prompt or the last tool result, and adds up its output", () => {
    const reply = (output: number, thinking: string, calls: string[]) => ({
      role: "assistant", stopReason: calls.length ? "toolUse" : "stop", usage: { input: 100, output, cacheRead: 0 },
      content: [{ type: "thinking", thinking }, ...calls.map((name) => ({ type: "toolCall", name })), { type: "text", text: "ok" }],
    });
    const { steps, totals } = summariseRunSteps([
      { type: "session" },
      { time: 1_000, event: { type: "user/message" } },
      { time: 8_000, event: { type: "assistant/message", message: reply(20, "abc", ["today_read"]) } },
      { time: 9_000, event: { type: "tool/result" } },
      { time: 51_000, event: { type: "assistant/message", message: reply(13_800, "x".repeat(50), []) } },
    ]);
    expect(steps.map((s) => [s.step, s.seconds, s.output, s.thinkingChars, s.textChars, s.calls])).toEqual([
      [1, 7, 20, 3, 2, ["today_read"]],
      [2, 42, 13_800, 50, 2, []],
    ]);
    expect(totals).toEqual({ steps: 2, modelSeconds: 49, outputTokens: 13_820, thinkingChars: 53, toolCalls: 1 });
  });
});
