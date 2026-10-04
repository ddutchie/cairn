/**
 * Automation IPC handlers: failures reject through the { error } envelope
 * (rather than resolving with an { error } payload the renderer would treat as
 * data), and automation:approve is an invoke handle preload can actually reach.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createProject, createWorkspace } from "../db/queries";
import { listAutomations } from "../db/automation-queries";

const { handles, listeners, resolveApprovalMock } = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  resolveApprovalMock: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handles.set(channel, fn)),
    on: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => listeners.set(channel, fn)),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => "/tmp" },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../lib/heartbeat-runner", () => ({
  runAutomationNow: vi.fn(() => null),
  resolveAutomationApproval: resolveApprovalMock,
}));

import { registerAutomationHandlers } from "./db-automation-handlers";

const db = new BetterSqlite3(":memory:");
applySchema(db);
createWorkspace(db, { id: "ws1", name: "Workspace" });
createProject(db, { id: "proj1", workspaceId: "ws1", name: "Project" });
registerAutomationHandlers({ db, workspacePath: "/tmp/cairn-test-ws" } as Parameters<typeof registerAutomationHandlers>[0]);

const invoke = (channel: string, args?: unknown) => {
  const fn = handles.get(channel);
  if (!fn) throw new Error(`no handle registered for ${channel}`);
  return fn({}, args) as Promise<{ data: unknown } | { error: string }>;
};

const baseInput = {
  workspaceId: "ws1",
  projectId: "proj1",
  name: "Nightly",
  instructions: "Summarise the board.",
  scheduleKind: "once" as const,
};

describe("automation IPC handlers", () => {
  beforeEach(() => resolveApprovalMock.mockClear());

  it("rejects a schedule with no future run instead of returning it as data", async () => {
    const res = await invoke("db:automation:create", { ...baseInput, scheduleExpr: "once 2000-01-01T00:00:00Z" });
    expect(res).toEqual({ error: "Schedule has no future run time." });
    expect(listAutomations(db, "ws1")).toHaveLength(0);
  });

  it("rejects an invalid schedule expression", async () => {
    const res = await invoke("db:automation:create", { ...baseInput, scheduleExpr: "whenever" });
    expect(res).toHaveProperty("error");
  });

  it("creates with a computed nextRunAt", async () => {
    const res = await invoke("db:automation:create", { ...baseInput, scheduleKind: "every", scheduleExpr: "every 1 hours" });
    expect("data" in res && (res.data as { nextRunAt: string }).nextRunAt).toBeTruthy();
  });

  it("rejects lookups of a missing automation", async () => {
    expect(await invoke("db:automation:folder", { id: "nope" })).toEqual({ error: "Automation not found." });
    expect(await invoke("db:automation:env", { automationId: "nope" })).toEqual({ error: "Automation not found." });
  });

  it("registers automation:approve as an invoke handle (not an on-listener) and resolves the approval", async () => {
    expect(listeners.has("automation:approve")).toBe(false);
    const res = await invoke("automation:approve", { callId: "c1", approved: true, grant: "always" });
    expect(res).toEqual({ data: undefined });
    expect(resolveApprovalMock).toHaveBeenCalledWith("c1", true, "always");
  });
});
