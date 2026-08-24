import { describe, expect, it } from "vitest";
import { applyApprovalProjection, normalizeSessionMessages, unwrapSessionMessages } from "./conversation-session";

describe("conversation session normalization", () => {
  it("unwraps both direct and data.messages session responses", () => {
    const message = { id: "1", threadId: "t", role: "user", content: "hello", createdAt: "now" };
    expect(unwrapSessionMessages([message])).toEqual([message]);
    expect(unwrapSessionMessages({ data: { messages: [message] } })).toEqual([message]);
    expect(unwrapSessionMessages({ data: "invalid" })).toEqual([]);
  });

  it("normalizes chat records for the shared renderer", () => {
    const [message] = normalizeSessionMessages([{ id: "1", threadId: "t", role: "user", content: "hello", createdAt: "now" }]);
    expect(message).toMatchObject({ id: "1", role: "user", content: "hello", createdAt: "now" });
  });

  it("changes only the projected approval call", () => {
    const messages = normalizeSessionMessages([{
      id: "1", threadId: "t", role: "assistant", content: "", createdAt: "now",
      toolCalls: [{ tool: "write", label: "write", callId: "call-1", args: "{}" }],
    }]);
    const [updated] = applyApprovalProjection(messages, { callId: "call-1", status: "required", nonce: "nonce-1" });
    expect(updated.toolCalls?.[0]).toMatchObject({ confirmRequired: true, approvalNonce: "nonce-1" });
  });
});
