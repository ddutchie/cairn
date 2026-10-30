/**
 * Chat session rename — `session:renameTitle` renames through the engine host
 * (the session log is the title's source of truth) and mirrors the title into
 * the thread row without disturbing its other fields.
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

const { renameMock } = vi.hoisted(() => ({
  renameMock: vi.fn(async (_id: string, title: string) => title),
}));

vi.mock("./engine-bridge", () => ({
  engineOwns: vi.fn(async () => true),
  getEngineHost: () => ({ rename: renameMock, title: vi.fn(async () => null) }),
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

const call = (name: string, args: unknown) =>
  (getIpcHandler(name) as (e: unknown, args: unknown) => Promise<unknown>)({}, args);

beforeEach(() => {
  vi.clearAllMocks();
  renameMock.mockImplementation(async (_id: string, title: string) => title);
});

describe("session:renameTitle", () => {
  it("renames the chat session through the engine host", async () => {
    registerChatSessionHandlers(makeCtxDb());
    const result = await call("session:renameTitle", { threadId: "t1", title: "New Title" });

    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(renameMock.mock.calls[0]?.[0]).toBe("chat-t1");
    expect(result).toEqual({ data: { title: "New Title" } });
  });

  it("keeps the thread's subagents flag when it syncs the renamed title", async () => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { applySchema } = await import("../db/schema");
    const q = await import("../db/queries");
    const db = new BetterSqlite3(":memory:");
    applySchema(db);
    q.createWorkspace(db, { id: "ws1", name: "WS" });
    q.upsertChatThread(db, { id: "t1", scope: "workspace", workspaceId: "ws1", title: "Old", useSubagents: true });

    registerChatSessionHandlers({ db, workspacePath: "/tmp/ws", getWin: () => null });
    await call("session:renameTitle", { threadId: "t1", title: "Renamed" });

    const [thread] = q.getChatThreads(db, "ws1");
    expect(thread.title).toBe("Renamed");
    expect(thread.useSubagents).toBe(true);
  });

  it("rejects empty titles without touching the session", async () => {
    registerChatSessionHandlers(makeCtxDb());
    const result = await call("session:renameTitle", { threadId: "t1", title: "   " });

    expect(renameMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining("non-empty") }));
  });
});
