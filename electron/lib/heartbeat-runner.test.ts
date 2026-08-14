/**
 * Heartbeat runner — connector-requirement gating.
 *
 * A connector-aware automation whose `requires` list references a connector
 * that is no longer installed or attached must be recorded as skipped with a
 * connector-specific error — NOT run silently without its tools (the fail-open
 * behaviour the review flagged).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, saveMcpServer, setToolAttachment } from "../db/queries";
import { createAutomation, createAutomationRun, getAutomationRunById } from "../db/automation-queries";
import { automationFolderDir, automationRunDir } from "./automation-folder";
// vi.mock calls are hoisted above this import, so the static import sees the
// mocked config-cache / chat-loop / external-tools modules.
import { runAutomation } from "./heartbeat-runner";

const { runToolLoopMock, getExternalToolDefsMock } = vi.hoisted(() => ({
  runToolLoopMock: vi.fn(),
  getExternalToolDefsMock: vi.fn(async () => []),
}));

vi.mock("./config-cache", () => ({
  getCachedConfig: () => ({ aiConfig: { baseUrl: "https://api.test.invalid", model: "gpt-test" } }),
}));

vi.mock("./chat-loop", () => ({
  runToolLoop: (...args: unknown[]) => runToolLoopMock(...args),
}));

// Keep the REAL checkRequirements (that's the gate under test) but stub the
// live MCP tool discovery so the "attached → runs" case never hits the network.
vi.mock("./external-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./external-tools")>();
  return {
    ...actual,
    getExternalToolDefs: getExternalToolDefsMock,
  };
});

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function makeAutomation(db: Database.Database, opts: { projectId?: string; requires?: Array<{ kind: "mcp" | "service"; name: string }> }) {
  return createAutomation(db, {
    workspaceId: "ws1",
    projectId: opts.projectId,
    name: "Linear digest",
    instructions: "Summarise today's Linear activity.",
    scheduleKind: "every",
    scheduleExpr: "1 hour",
    nextRunAt: new Date().toISOString(),
    requires: opts.requires,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runAutomation connector requirements", () => {
  it("skips the run when a required connector is not attached, with a connector-specific error", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    // No MCP server / attachment exists at all.
    const automation = makeAutomation(db, { projectId: "p1", requires: [{ kind: "mcp", name: "linear" }] });
    const run = createAutomationRun(db, automation.id, "running");

    await runAutomation({ db, workspacePath: "/tmp" }, run, automation);

    const updated = getAutomationRunById(db, run.id)!;
    expect(updated.status).toBe("skipped");
    expect(updated.error).toMatch(/linear/i);
    expect(updated.error).toMatch(/not installed/);
    expect(runToolLoopMock).not.toHaveBeenCalled();
  });

  it("skips the run when a required connector is installed but detached", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    saveMcpServer(db, {
      id: "m-linear", workspaceId: "ws1", name: "Linear", transport: "http",
      baseUrl: "https://mcp.linear.app/mcp", enabled: true, source: "community",
      communityId: "linear",
    });
    // Installed + enabled but NOT attached to the project.
    const automation = makeAutomation(db, { projectId: "p1", requires: [{ kind: "mcp", name: "linear" }] });
    const run = createAutomationRun(db, automation.id, "running");

    await runAutomation({ db, workspacePath: "/tmp" }, run, automation);

    const updated = getAutomationRunById(db, run.id)!;
    expect(updated.status).toBe("skipped");
    expect(updated.error).toMatch(/not attached/);
    expect(runToolLoopMock).not.toHaveBeenCalled();
  });

  it("runs normally when the required connector is installed and attached", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    saveMcpServer(db, {
      id: "m-linear", workspaceId: "ws1", name: "Linear", transport: "http",
      baseUrl: "https://mcp.linear.app/mcp", enabled: true, source: "community",
      communityId: "linear",
    });
    setToolAttachment(db, { projectId: "p1", toolType: "mcp", toolId: "m-linear", enabled: true });
    const automation = makeAutomation(db, { projectId: "p1", requires: [{ kind: "mcp", name: "linear" }] });
    const run = createAutomationRun(db, automation.id, "running");
    runToolLoopMock.mockResolvedValue({ exhausted: false, content: "done", reasoning: "" });

    await runAutomation({ db, workspacePath: "/tmp" }, run, automation);

    expect(runToolLoopMock).toHaveBeenCalled();
    expect(getAutomationRunById(db, run.id)!.status).toBe("done");
  });

  it("errors the run when required-tool loading fails, without running the loop", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    saveMcpServer(db, {
      id: "m-linear", workspaceId: "ws1", name: "Linear", transport: "http",
      baseUrl: "https://mcp.linear.app/mcp", enabled: true, source: "community",
      communityId: "linear",
    });
    setToolAttachment(db, { projectId: "p1", toolType: "mcp", toolId: "m-linear", enabled: true });
    const automation = makeAutomation(db, { projectId: "p1", requires: [{ kind: "mcp", name: "linear" }] });
    const run = createAutomationRun(db, automation.id, "running");
    getExternalToolDefsMock.mockRejectedValueOnce(new Error("connector exploded"));

    await runAutomation({ db, workspacePath: "/tmp" }, run, automation);

    expect(runToolLoopMock).not.toHaveBeenCalled();
    const updated = getAutomationRunById(db, run.id)!;
    expect(updated.status).toBe("error");
    expect(updated.error).toMatch(/connector exploded/);
  });
});

describe("runAutomation folder plumbing", () => {
  it("creates a per-run working folder under <project>/.automations/<id>/runs/ and records it on the run row", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    const automation = makeAutomation(db, { projectId: "p1" });
    const run = createAutomationRun(db, automation.id, "running");
    runToolLoopMock.mockResolvedValue({ exhausted: false, content: "done", reasoning: "" });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-run-"));

    await runAutomation({ db, workspacePath: root }, run, automation);

    const updated = getAutomationRunById(db, run.id)!;
    expect(updated.status).toBe("done");
    const expectedDir = automationRunDir(automationFolderDir(root, automation.id, "P"), run.id);
    expect(updated.runDir).toBe(expectedDir);
    expect(fs.existsSync(expectedDir)).toBe(true);

    // run_script is wired into the loop: the mock's last positional arg is the
    // handler, and the scripts/ + out/ folders exist for it.
    const loopArgs = runToolLoopMock.mock.calls[0];
    expect(typeof loopArgs[loopArgs.length - 1]).toBe("function");
    const autoDir = automationFolderDir(root, automation.id, "P");
    expect(fs.existsSync(path.join(autoDir, "scripts"))).toBe(true);
    expect(fs.existsSync(path.join(autoDir, "out"))).toBe(true);
  });

  it("records a run folder at the workspace root for workspace-scoped automations", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    const automation = makeAutomation(db, {}); // no project → workspace scope
    const run = createAutomationRun(db, automation.id, "running");
    runToolLoopMock.mockResolvedValue({ exhausted: false, content: "done", reasoning: "" });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-run-"));

    await runAutomation({ db, workspacePath: root }, run, automation);

    const updated = getAutomationRunById(db, run.id)!;
    expect(updated.status).toBe("done");
    const expectedDir = automationRunDir(automationFolderDir(root, automation.id, null), run.id);
    expect(updated.runDir).toBe(expectedDir);
    expect(fs.existsSync(expectedDir)).toBe(true);
  });
});
