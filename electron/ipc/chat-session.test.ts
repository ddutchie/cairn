/**
 * Chat session rename — shared opener coverage.
 *
 * `session:renameTitle` must open a not-yet-live chat session through the
 * canonical coding-loop opener (`openCordisAgent` from
 * `../cordis/run-cordis-coding`, which delegates to `openCordisSessionAgent`
 * with internal adapter pinning) — not via a direct `session-agent` import
 * plus a duplicated `ensureAgentAiAdapter` call. These tests mock the shared
 * helper and assert the rename path calls it with the same session id.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

const {
  getContextMock,
  openCordisAgentMock,
  getSessionRootMock,
  getCachedConfigMock,
  renameMock,
  sessionsGetMock,
  disposeMock,
} = vi.hoisted(() => ({
  getContextMock: vi.fn(),
  openCordisAgentMock: vi.fn(),
  getSessionRootMock: vi.fn(() => "/tmp/ws/sessions"),
  getCachedConfigMock: vi.fn(() => ({
    agentConfig: { baseUrl: "http://test.invalid", model: "test-model", apiKey: "k" },
  })),
  renameMock: vi.fn(( _sess: unknown, title: string) => ({ title })),
  sessionsGetMock: vi.fn(),
  disposeMock: vi.fn(async () => {}),
}));

vi.mock("../cordis/run-cordis-loop", () => ({
  getContext: getContextMock,
}));

vi.mock("../cordis/run-cordis-coding", () => ({
  openCordisAgent: openCordisAgentMock,
}));

vi.mock("../cordis/cordis-context", () => ({
  getSessionRoot: getSessionRootMock,
}));

vi.mock("../lib/config-cache", () => ({
  getCachedConfig: getCachedConfigMock,
}));

import { registerChatSessionHandlers } from "./chat-session";
import { getIpcHandler } from "./registry";
import type { DbContext } from "./result-helpers";

function makeCtxDb(): DbContext {
  const db = {
    prepare: () => ({ get: () => undefined }),
  } as unknown as DbContext["db"];
  return { db, workspacePath: "/tmp/ws", getWin: () => null };
}

function liveCtx() {
  return {
    sessions: { get: sessionsGetMock },
    sessionTitle: { rename: renameMock },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionRootMock.mockReturnValue("/tmp/ws/sessions");
  getCachedConfigMock.mockReturnValue({
    agentConfig: { baseUrl: "http://test.invalid", model: "test-model", apiKey: "k" },
  });
  renameMock.mockImplementation((_sess: unknown, title: string) => ({ title }));
  disposeMock.mockResolvedValue(undefined);
});

describe("session:renameTitle uses the shared opener", () => {
  it("opens a not-yet-live session via openCordisAgent with the same session id", async () => {
    sessionsGetMock.mockReturnValue(undefined);
    getContextMock.mockResolvedValue(liveCtx());
    openCordisAgentMock.mockResolvedValue({
      agent: { session: { id: "chat-t1" } },
      dispose: disposeMock,
    });

    registerChatSessionHandlers(makeCtxDb());
    const handler = getIpcHandler("session:renameTitle");
    expect(handler).toBeDefined();

    const result = await (handler as (e: unknown, args: unknown) => Promise<unknown>)(
      {},
      { threadId: "t1", title: "New Title" },
    );

    expect(openCordisAgentMock).toHaveBeenCalledTimes(1);
    const opts = openCordisAgentMock.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
    expect(opts?.sessionId).toBe("chat-t1");
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: { title: "New Title" } });
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("skips the opener when the session is already live", async () => {
    const live = { id: "chat-t1" };
    sessionsGetMock.mockReturnValue(live);
    getContextMock.mockResolvedValue(liveCtx());

    registerChatSessionHandlers(makeCtxDb());
    const handler = getIpcHandler("session:renameTitle");
    const result = await (handler as (e: unknown, args: unknown) => Promise<unknown>)(
      {},
      { threadId: "t1", title: "Live Rename" },
    );

    expect(openCordisAgentMock).not.toHaveBeenCalled();
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: { title: "Live Rename" } });
  });

  it("rejects empty titles without opening a session", async () => {
    sessionsGetMock.mockReturnValue(undefined);
    getContextMock.mockResolvedValue(liveCtx());

    registerChatSessionHandlers(makeCtxDb());
    const handler = getIpcHandler("session:renameTitle");
    const result = await (handler as (e: unknown, args: unknown) => Promise<unknown>)(
      {},
      { threadId: "t1", title: "   " },
    );

    expect(openCordisAgentMock).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining("non-empty") }),
    );
  });
});
