/**
 * db:chat:clearAllThreads deletes only the threads the renderer cleared, and never one outside the
 * scope it names, even when that thread's id is passed.
 */

import { describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createProject, createWorkspace, getChatThreads, upsertChatThread } from "../db/queries";

const { handles, destroyEngineSession } = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  destroyEngineSession: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handles.set(channel, fn)),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => "/tmp" },
}));
vi.mock("./engine-bridge", () => ({ destroyEngineSession }));

import { registerChatDbHandlers } from "./chat-db-handlers";

const db = new BetterSqlite3(":memory:");
applySchema(db);
createWorkspace(db, { id: "ws1", name: "Workspace" });
createProject(db, { id: "p1", workspaceId: "ws1", name: "One" });
createProject(db, { id: "p2", workspaceId: "ws1", name: "Two" });
registerChatDbHandlers({ db, workspacePath: "/tmp/cairn-test-ws" } as Parameters<typeof registerChatDbHandlers>[0]);

const clearAll = (req: unknown) => handles.get("db:chat:clearAllThreads")!({}, req) as Promise<{ data?: { deletedThreads: number }; error?: string }>;

describe("db:chat:clearAllThreads", () => {
  it("deletes only the listed threads, inside the scope", async () => {
    upsertChatThread(db, { id: "cleared", scope: "project", workspaceId: "ws1", projectId: "p1" });
    upsertChatThread(db, { id: "kept-since", scope: "project", workspaceId: "ws1", projectId: "p1" });
    upsertChatThread(db, { id: "other-project", scope: "project", workspaceId: "ws1", projectId: "p2" });

    const res = await clearAll({ workspaceId: "ws1", projectId: "p1", threadIds: ["cleared", "other-project"] });

    expect(res.data?.deletedThreads).toBe(1);
    expect(getChatThreads(db, "ws1").map((t) => t.id).sort()).toEqual(["kept-since", "other-project"]);
    expect(destroyEngineSession).toHaveBeenCalledTimes(1);
  });
});
