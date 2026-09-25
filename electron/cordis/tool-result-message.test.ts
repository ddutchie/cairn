import { describe, expect, it } from "vitest";
import { isToolResultMessage, readToolResult, readToolResults } from "./tool-result-message";

describe("tool-result-message", () => {
  it("reads a v4 role:tool message", () => {
    const message = {
      role: "tool",
      toolCallId: "call-1",
      isError: true,
      content: [{ type: "text", text: "boom" }, { type: "image" }, { type: "text", text: "!" }],
    };
    expect(isToolResultMessage(message)).toBe(true);
    expect(readToolResult(message)).toEqual({ callId: "call-1", output: "boom!", isError: true });
  });

  it("falls back to source.callId when the message has no toolCallId", () => {
    const message = { role: "tool", source: { callId: "call-2" }, content: [{ type: "text", text: "ok" }] };
    expect(readToolResult(message)).toEqual({ callId: "call-2", output: "ok", isError: false });
  });

  it("reads v3 tool-result wrappers", () => {
    const message = {
      role: "user",
      content: [
        { type: "tool-result", toolCallId: "a", content: [{ type: "text", text: "one" }] },
        { type: "tool-result", toolCallId: "b", isError: true, content: [{ type: "text", text: "two" }] },
      ],
    };
    expect(isToolResultMessage(message)).toBe(true);
    expect(readToolResults(message)).toEqual([
      { callId: "a", output: "one", isError: false },
      { callId: "b", output: "two", isError: true },
    ]);
    expect(readToolResult(message)?.callId).toBe("a");
  });

  it("ignores messages that carry no tool result", () => {
    const message = { role: "assistant", content: [{ type: "text", text: "hi" }] };
    expect(isToolResultMessage(message)).toBe(false);
    expect(readToolResults(message)).toEqual([]);
    expect(readToolResult(undefined)).toBeUndefined();
  });
});
