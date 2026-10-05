/**
 * AI helper IPC handlers: a PRD failure (unknown project, model error) or a
 * missing AI configuration rejects through the { error } envelope instead of
 * resolving with an { error } payload the renderer would treat as a PRD.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createProject, createWorkspace } from "../db/queries";

const { handles, runOneShotMock, cachedConfig } = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  runOneShotMock: vi.fn(),
  cachedConfig: { aiConfig: undefined as unknown, agentConfig: undefined as unknown },
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
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../lib/config-cache", () => ({
  getCachedConfig: () => cachedConfig,
  cacheLlmConnection: vi.fn(),
}));
vi.mock("../lib/secure-store", () => ({ resolveLlmApiKey: (ref?: string) => ref ?? "" }));
vi.mock("../cordis/one-shot", () => ({ runOneShot: runOneShotMock }));
vi.mock("../cordis/agent-host", () => ({ getAgentHost: () => ({ runOneShot: runOneShotMock }) }));
vi.mock("../notes-files", () => ({ writeNoteFile: vi.fn() }));

import { registerAiHandlers } from "./ai-handlers";

const db = new BetterSqlite3(":memory:");
applySchema(db);
createWorkspace(db, { id: "ws1", name: "Workspace" });
createProject(db, { id: "proj1", workspaceId: "ws1", name: "Project" });
registerAiHandlers({ db, workspacePath: "/tmp/cairn-test-ws" } as Parameters<typeof registerAiHandlers>[0]);

const invoke = (channel: string, args?: unknown) => {
  const fn = handles.get(channel);
  if (!fn) throw new Error(`no handle registered for ${channel}`);
  return fn({}, args) as Promise<{ data: unknown } | { error: string }>;
};

const config = { baseUrl: "https://api.example.test", model: "m", apiKey: "secret://llm/p/apiKey" };
const prd = (projectId: string) => ({ projectId, title: "Spec", requirements: "Do the thing", config });

describe("AI IPC handlers", () => {
  beforeEach(() => { runOneShotMock.mockReset(); });

  it("rejects a PRD for an unknown project", async () => {
    expect(await invoke("ai:generatePrd", prd("nope"))).toEqual({ error: "Project not found" });
  });

  it("rejects when the model call fails", async () => {
    runOneShotMock.mockImplementation(async () => { throw new Error("rate limited"); });
    expect(await invoke("ai:generatePrd", prd("proj1"))).toEqual({ error: "Failed to generate PRD: rate limited" });
  });

  it("returns the saved PRD note", async () => {
    runOneShotMock.mockResolvedValue("# Spec\n\nBody");
    const res = await invoke("ai:generatePrd", prd("proj1"));
    expect(res).toMatchObject({ data: { title: "Spec", projectId: "proj1", content: "# Spec\n\nBody" } });
  });

  it("rejects a helper call when AI isn't configured", async () => {
    const res = await invoke("ai:generateCommitMessage", { diff: "x", config: { baseUrl: "https://api.example.test", model: "", apiKey: "" } });
    expect(res).toEqual({ error: "AI is not configured. Add an API key in Settings, or use a local endpoint." });
    expect(runOneShotMock).not.toHaveBeenCalled();
  });
});
