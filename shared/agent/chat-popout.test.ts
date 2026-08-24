import { describe, expect, it } from "vitest";
import { bindChatPopoutSession } from "./chat-popout";

describe("bindChatPopoutSession", () => {
  it("preserves the handed-off session and project identity", () => {
    expect(bindChatPopoutSession({ sessionId: "chat-thread-7", activeProjectId: "project-2" }))
      .toEqual({ sessionId: "chat-thread-7", activeProjectId: "project-2" });
  });

  it("rejects missing or malformed identity instead of selecting global state", () => {
    expect(bindChatPopoutSession({ activeProjectId: "project-2" })).toBeNull();
    expect(bindChatPopoutSession({ sessionId: "chat-thread-7", activeProjectId: 42 })).toBeNull();
    expect(bindChatPopoutSession(null)).toBeNull();
  });
});
