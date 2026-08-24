import { describe, expect, it } from "vitest";
import { bindChatPopoutSession, chatParticipantIdsExcept, resolveChatPopoutSession } from "./chat-popout";

describe("bindChatPopoutSession", () => {
  it("preserves the handed-off session and project identity", () => {
    expect(bindChatPopoutSession({ sessionId: "chat-thread-7", activeProjectId: "project-2", profile: "chat", workspaceId: "workspace-1", cwd: null }))
      .toEqual({ sessionId: "chat-thread-7", activeProjectId: "project-2", profile: "chat", workspaceId: "workspace-1", cwd: null });
    expect(bindChatPopoutSession({ sessionId: "coding-7", activeProjectId: null, profile: "coding", workspaceId: null, cwd: "/repo" }))
      .toEqual({ sessionId: "coding-7", activeProjectId: null, profile: "coding", workspaceId: null, cwd: "/repo" });
    expect(bindChatPopoutSession({ sessionId: "automation-7", activeProjectId: "project-2", profile: "automation-dev", workspaceId: "workspace-1", cwd: "/repo" }))
      .toEqual({ sessionId: "automation-7", activeProjectId: "project-2", profile: "automation-dev", workspaceId: "workspace-1", cwd: "/repo" });
  });

  it("rejects missing or malformed identity instead of selecting global state", () => {
    expect(bindChatPopoutSession({ activeProjectId: "project-2" })).toBeNull();
    expect(bindChatPopoutSession({ sessionId: "chat-thread-7", activeProjectId: 42, profile: "chat" })).toBeNull();
    expect(bindChatPopoutSession({ sessionId: "chat-thread-7", activeProjectId: null, profile: "other" })).toBeNull();
    expect(bindChatPopoutSession({ sessionId: "chat-thread-7", activeProjectId: null, profile: "automation" })).toBeNull();
    expect(bindChatPopoutSession(null)).toBeNull();
  });

  it("uses durable metadata and rejects a profile mismatch", () => {
    const payload = bindChatPopoutSession({ sessionId: "coding-7", activeProjectId: "handoff-project", profile: "coding", workspaceId: "handoff-workspace", cwd: "/handoff" })!;
    expect(resolveChatPopoutSession(payload, { profile: "coding", projectId: "stored-project", workspaceId: "stored-workspace", cwd: "/stored" }))
      .toMatchObject({ activeProjectId: "stored-project", workspaceId: "stored-workspace", cwd: "/stored" });
    expect(resolveChatPopoutSession(payload, { profile: "chat", projectId: null, workspaceId: null, cwd: null })).toBeNull();
  });

  it("selects transport without selecting a renderer", async () => {
    const { sessionPopoutCommand } = await import("./chat-popout");
    expect(sessionPopoutCommand("chat")).toBe("session:prompt");
    expect(sessionPopoutCommand("coding")).toBe("session:prompt");
    expect(sessionPopoutCommand("automation-dev")).toBe("session:prompt");
  });

  it("routes a broadcast to both session windows but not its origin", () => {
    expect(chatParticipantIdsExcept(new Set([11, 22]), 11)).toEqual([22]);
    expect(chatParticipantIdsExcept(new Set([11, 22]))).toEqual([11, 22]);
  });
});
