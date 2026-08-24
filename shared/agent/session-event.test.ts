import { describe, expect, it } from "vitest";
import { sessionEventEnvelope } from "./session-event";

describe("session event transport", () => {
  it("preserves the raw DSH event under one typed session envelope", () => {
    const event = { type: "assistant/chunk", seq: 4, time: 12, data: { chunk: { type: "text-delta", text: "hi" } }, extra: { keep: true } };
    const envelope = sessionEventEnvelope("chat-thread-1", event);
    expect(envelope).toEqual({ sessionId: "chat-thread-1", event });
    expect(envelope.event).toBe(event);
  });
});
