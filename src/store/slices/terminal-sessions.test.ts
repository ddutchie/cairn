/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { createTerminalSessionsSlice } from "./terminal-sessions";

describe("createTerminalSessionsSlice — openSession", () => {
  function setup() {
    let state: any = {
      setActiveChatThreadId: (id: string) => { state.activeChatThreadId = id; },
      setSessionPresentation: (presentation: string) => { state.sessionPresentation = presentation; },
    };
    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;
    const slice = createTerminalSessionsSlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };
    return { get: () => state };
  }

  it("selects a Chat thread and its requested presentation together", () => {
    const { get } = setup();

    get().openSession("thread-1", "chat", "center");

    expect(get().activeChatThreadId).toBe("thread-1");
    expect(get().activeSessionId).toBe("chat");
    expect(get().sessionPresentation).toBe("center");
  });

  it("selects Coding and Terminal sessions without rewriting their ids", () => {
    const { get } = setup();

    get().openSession("coding-1", "coding");
    expect(get().activeSessionId).toBe("coding-1");
    expect(get().sessionPresentation).toBe("drawer");

    get().openSession("pty-1", "terminal", "workbench");
    expect(get().activeSessionId).toBe("pty-1");
    expect(get().sessionPresentation).toBe("workbench");
  });

  it("tracks transient session loading state", () => {
    const { get } = setup();

    get().setSessionLoad({ status: "loading", sessionId: "coding-1" });
    expect(get().sessionLoad).toEqual({ status: "loading", sessionId: "coding-1" });

    get().setSessionLoad({ status: "ready", sessionId: "coding-1" });
    expect(get().sessionLoad).toEqual({ status: "ready", sessionId: "coding-1" });
  });
});
