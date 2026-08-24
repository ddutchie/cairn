import { describe, expect, it } from "vitest";
import {
  appendSessionToolCall,
  matchesSessionConversation,
  resolveSessionToolResult,
} from "./useSessionConversation";

describe("session conversation controller helpers", () => {
  it("filters scoped and legacy unscoped envelopes", () => {
    expect(matchesSessionConversation("chat-a", "chat-a")).toBe(true);
    expect(matchesSessionConversation("chat-a", "chat-b")).toBe(false);
    expect(matchesSessionConversation("chat-a", undefined)).toBe(false);
    expect(matchesSessionConversation("chat-a", undefined, true)).toBe(true);
  });

  it("closes the previous running tool when a new call starts", () => {
    const next = appendSessionToolCall([{ tool: "read", label: "read", status: "running", callId: "one" }], {
      name: "write", args: { apiKey: "private" }, callId: "two",
    });
    expect(next).toEqual([
      { tool: "read", label: "read", status: "done", callId: "one" },
      { tool: "write", label: "write", status: "running", callId: "two", args: '{"apiKey":"[redacted]"}' },
    ]);
  });

  it("resolves a tool by call id and redacts failures", () => {
    const next = resolveSessionToolResult([{ tool: "bash", label: "bash", status: "running", callId: "one" }], {
      name: "bash", callId: "one", output: "token=secret", error: "token=secret", ok: false,
    });
    expect(next[0]).toMatchObject({ status: "done", ok: false });
    expect(next[0].error).not.toContain("secret");
  });
});
