/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unread thread pins — background turns land in their own thread while
 * another is open; the thread pins as unread until opened.
 *
 * Runs in the node env (isElectron() === false), so IPC/storage are no-ops.
 */

import { describe, it, expect } from "vitest";
import { createChatSlice } from "./chat";

function setup(activeChatThreadId: string | null = "t1") {
  let state: any = { persist: () => {}, activeChatThreadId, chatThreads: [], chatMessages: [] };
  const mockSet = (updater: any) => {
    const next = typeof updater === "function" ? updater(state) : updater;
    state = { ...state, ...next };
  };
  const mockGet = () => state;
  const slice = createChatSlice(mockSet, mockGet, {} as any);
  state = { ...state, ...slice, activeChatThreadId };
  return { get: () => state };
}

describe("unreadThreadIds", () => {
  it("marks a background assistant message's thread unread", () => {
    const { get } = setup("t1");
    get().addMessage("t2", "assistant", "hello");
    expect(get().unreadThreadIds).toEqual(["t2"]);
  });

  it("does not mark the active thread or user messages", () => {
    const { get } = setup("t1");
    get().addMessage("t1", "assistant", "hello");
    get().addMessage("t2", "user", "question");
    expect(get().unreadThreadIds).toEqual([]);
  });

  it("clears when the thread becomes active", () => {
    const { get } = setup("t1");
    get().addMessage("t2", "assistant", "hello");
    get().addMessage("t3", "system", "Turn ended: error");
    expect(get().unreadThreadIds).toEqual(["t2", "t3"]);
    get().setActiveChatThreadId("t2");
    expect(get().unreadThreadIds).toEqual(["t3"]);
  });
});
