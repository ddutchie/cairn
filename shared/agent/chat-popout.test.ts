import { describe, expect, it } from "vitest";
import { bindChatPopoutSession } from "./chat-popout";

describe("bindChatPopoutSession", () => {
  it("preserves the handed-off session and project identity", () => {
    expect(bindChatPopoutSession({ sessionId: "chat-thread-7", activeProjectId: "project-2", profile: "chat" }))
      .toEqual({ sessionId: "chat-thread-7", activeProjectId: "project-2", profile: "chat" });
    expect(bindChatPopoutSession({ sessionId: "coding-7", activeProjectId: null, profile: "coding" }))
      .toEqual({ sessionId: "coding-7", activeProjectId: null, profile: "coding" });
    expect(bindChatPopoutSession({ sessionId: "automation-7", activeProjectId: "project-2", profile: "automation-dev" }))
      .toEqual({ sessionId: "automation-7", activeProjectId: "project-2", profile: "automation-dev" });
  });

  it("rejects missing or malformed identity instead of selecting global state", () => {
    expect(bindChatPopoutSession({ activeProjectId: "project-2" })).toBeNull();
    expect(bindChatPopoutSession({ sessionId: "chat-thread-7", activeProjectId: 42 })).toBeNull();
    expect(bindChatPopoutSession({ sessionId: "chat-thread-7", activeProjectId: null, profile: "other" })).toBeNull();
    expect(bindChatPopoutSession({ sessionId: "chat-thread-7", activeProjectId: null, profile: "automation" })).toBeNull();
    expect(bindChatPopoutSession(null)).toBeNull();
  });

  it("selects transport without selecting a renderer", async () => {
    const { sessionPopoutCommand } = await import("./chat-popout");
    expect(sessionPopoutCommand("chat")).toBe("chat:stream");
    expect(sessionPopoutCommand("coding")).toBe("session:prompt");
  });
});
