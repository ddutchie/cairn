/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { buildSessionRegistry } from "./session-registry";

describe("buildSessionRegistry", () => {
  it("normalizes project sessions and sorts them by recency", () => {
    const sessions = buildSessionRegistry({
      chatThreads: [
        { id: "chat-old", projectId: "project-1", title: "", updatedAt: "2026-01-01T00:00:00.000Z" } as any,
        { id: "chat-new", projectId: "project-1", title: "Named chat", updatedAt: "2026-01-03T00:00:00.000Z" } as any,
        { id: "chat-other", projectId: "project-2", title: "Other", updatedAt: "2026-01-04T00:00:00.000Z" } as any,
      ],
      chatMessages: [
        { threadId: "chat-old", role: "user", content: "Build the old thing" } as any,
      ],
      codingSessions: [
        { id: "coding-mid", projectId: "project-1", taskTitle: "Coding task", updatedAt: "2026-01-02T00:00:00.000Z", status: "exited", mode: "execute" } as any,
      ],
      terminalSessions: [
        { sessionId: "pty-1", projectId: "project-1", sessionType: "pty", taskTitle: "Terminal", spawnedAt: "2025-12-01T00:00:00.000Z", status: "running" } as any,
        { sessionId: "coding-1", projectId: "project-1", sessionType: "coding", taskTitle: "Not a PTY", spawnedAt: "2026-01-05T00:00:00.000Z", status: "running" } as any,
      ],
      projectId: "project-1",
    });

    expect(sessions.map((session) => session.id)).toEqual([
      "chat:chat-new",
      "coding:coding-mid",
      "chat:chat-old",
      "terminal:pty-1",
    ]);
    expect(sessions[2]?.title).toBe("Build the old thing");
    expect(sessions.every((session) => session.projectId === "project-1")).toBe(true);
  });

  it("returns no sessions when no project scope is selected", () => {
    const sessions = buildSessionRegistry({
      chatThreads: [{ id: "chat-1", projectId: "project-1" } as any],
      chatMessages: [],
      codingSessions: [],
      terminalSessions: [],
      projectId: null,
    });

    expect(sessions).toEqual([]);
  });
});
