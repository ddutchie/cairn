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
import { runAutomation, runAutomationNow } from "./heartbeat-runner";

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

    // run_script + write_run_file + deliver_file are wired into the loop: the
    // mock's last three positional args are the handlers, and scripts/ + out/
    // exist for them.
    const loopArgs = runToolLoopMock.mock.calls[0];
    const runScript = loopArgs[loopArgs.length - 3];
    const writeRunFile = loopArgs[loopArgs.length - 2];
    const deliverFile = loopArgs[loopArgs.length - 1];
    expect(typeof runScript).toBe("function");
    expect(typeof writeRunFile).toBe("function");
    expect(typeof deliverFile).toBe("function");
    const autoDir = automationFolderDir(root, automation.id, "P");
    // The write_run_file handler stages a JSON file inside the RUN folder only.
    await (writeRunFile as (a: { path: string; content: string }) => Promise<string>)({ path: "stage.json", content: "{}" });
    expect(fs.readFileSync(path.join(expectedDir, "stage.json"), "utf8")).toBe("{}");
    // The deliver_file handler copies an out/ file into workspace attachments.
    fs.mkdirSync(path.join(autoDir, "out"), { recursive: true });
    fs.writeFileSync(path.join(autoDir, "out", "poster.svg"), "<svg/>");
    const delivered = await (deliverFile as (a: { path: string }) => Promise<string>)({ path: "poster.svg" });
    expect(delivered).toContain("attachments/");
    expect(fs.existsSync(path.join(root, "attachments", automation.id, "poster.svg"))).toBe(true);
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

  it("materializes .env + manifest and injects env into the run_script handler", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    const automation = createAutomation(db, {
      workspaceId: "ws1",
      projectId: "p1",
      name: "Image brief",
      instructions: "Make images",
      scheduleKind: "every",
      scheduleExpr: "1 hour",
      nextRunAt: new Date().toISOString(),
      env: [
        { name: "MY_TOKEN", value: "abc", secret: false },
        { name: "SECRET_KEY", secret: true }, // keychain unavailable in tests → unset
      ],
    });
    const run = createAutomationRun(db, automation.id, "running");
    runToolLoopMock.mockResolvedValue({ exhausted: false, content: "done", reasoning: "" });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-run-"));
    const autoDir = automationFolderDir(root, automation.id, "P");
    // Pre-place a probe script so the runScript handler can execute it.
    fs.mkdirSync(path.join(autoDir, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(autoDir, "scripts", "probe.js"),
      "console.log('TOKEN=' + (process.env.MY_TOKEN || 'missing')); console.log('SECRET=' + (process.env.SECRET_KEY || 'unset'));",
      "utf8",
    );

    await runAutomation({ db, workspacePath: root }, run, automation);

    // .env materialized with the non-secret only (never the secret name).
    const envFile = fs.readFileSync(path.join(autoDir, ".env"), "utf8");
    expect(envFile).toContain('MY_TOKEN="abc"');
    expect(envFile).not.toContain("SECRET_KEY");
    // Manifest created (once).
    expect(fs.existsSync(path.join(autoDir, "manifest.json"))).toBe(true);

    // Invoke the runScript handler with the probe — it must see the resolved env.
    const loopArgs = runToolLoopMock.mock.calls[0];
    const runScript = loopArgs[loopArgs.length - 3] as (a: { name: string }) => Promise<string>;
    const output = await runScript({ name: "probe" });
    expect(output).toContain("TOKEN=abc");
    expect(output).toContain("SECRET=unset");
  });

  it("uses the agent-authored manifest instructions as the recipe instead of the row", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    const automation = makeAutomation(db, { projectId: "p1" }); // row recipe = "Summarise today's Linear activity."
    const run = createAutomationRun(db, automation.id, "running");
    runToolLoopMock.mockResolvedValue({ exhausted: false, content: "done", reasoning: "" });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-run-"));
    const autoDir = automationFolderDir(root, automation.id, "P");
    fs.mkdirSync(autoDir, { recursive: true });
    fs.writeFileSync(
      path.join(autoDir, "manifest.json"),
      JSON.stringify({ instructions: "MANIFEST RECIPE: check the news via the connector, then run generate_images, then write a note." }),
      "utf8",
    );

    await runAutomation({ db, workspacePath: root }, run, automation);

    const loopArgs = runToolLoopMock.mock.calls[0];
    const messages = loopArgs[6] as Array<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("MANIFEST RECIPE");
    expect(userMsg?.content).toContain("run generate_images");
    expect(userMsg?.content).not.toContain("Linear activity");
  });

  it("streams live run activity and persists a run transcript", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    const automation = makeAutomation(db, { projectId: "p1" });
    const run = createAutomationRun(db, automation.id, "running");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-run-"));
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const send = (channel: string, payload: unknown) => sent.push({ channel, payload: payload as Record<string, unknown> });

    // The loop mock fires the tool/token callbacks DURING the run so they land
    // in both the live stream and the persisted transcript.
    runToolLoopMock.mockImplementation((...args: unknown[]) => {
      const emitToolCall = args[7] as (e: { tool: string; label: string; args: Record<string, unknown> }) => void;
      const emitToolCallDone = args[12] as (e: { tool: string; ok: boolean; output: string }) => void;
      const onToken = args[13] as (delta: string) => void;
      emitToolCall({ tool: "run_script", label: "Running gen", args: { name: "gen" } });
      onToken("hello ");
      onToken("world");
      emitToolCallDone({ tool: "run_script", ok: true, output: "made image" });
      return Promise.resolve({ exhausted: false, content: "final summary", reasoning: "" });
    });

    await runAutomation({ db, workspacePath: root, send }, run, automation);

    const events = sent.filter((s) => s.channel === "automation:run");
    expect(events.some((e) => e.payload.event === "started")).toBe(true);
    const deltas = events.filter((e) => e.payload.event === "token").map((e) => e.payload.delta).join("");
    expect(deltas).toBe("hello world");
    expect(events.some((e) => e.payload.event === "tool" && e.payload.tool === "run_script")).toBe(true);
    expect(events.some((e) => e.payload.event === "toolDone" && e.payload.ok === true)).toBe(true);
    expect(events.some((e) => e.payload.event === "finished")).toBe(true);

    // The run transcript is persisted to run-log.json in the run folder.
    const autoDir = automationFolderDir(root, automation.id, "P");
    const runDir = automationRunDir(autoDir, run.id);
    const log = JSON.parse(fs.readFileSync(path.join(runDir, "run-log.json"), "utf8"));
    expect(log.status).toBe("done");
    expect(log.recipe).toBe(automation.instructions);
    expect(log.tokens).toBe("final summary");
    expect(log.tools).toHaveLength(1);
    expect(log.tools[0].name).toBe("run_script");
    expect(log.tools[0].ok).toBe(true);
    expect(log.tools[0].output).toBe("made image");
  });

  it("records an exhausted run as 'exhausted' (row + transcript), not 'done'", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    const automation = makeAutomation(db, { projectId: "p1" });
    const run = createAutomationRun(db, automation.id, "running");
    runToolLoopMock.mockResolvedValue({ exhausted: true, content: "incomplete", reasoning: "" });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-run-"));

    await runAutomation({ db, workspacePath: root }, run, automation);

    const updated = getAutomationRunById(db, run.id)!;
    expect(updated.status).toBe("exhausted");
    expect(updated.error).toMatch(/step limit/i);
    const autoDir = automationFolderDir(root, automation.id, "P");
    const log = JSON.parse(fs.readFileSync(path.join(automationRunDir(autoDir, run.id), "run-log.json"), "utf8"));
    expect(log.status).toBe("exhausted");
  });

  it("flushes the transcript incrementally as tools complete (survives a crash mid-run)", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    const automation = makeAutomation(db, { projectId: "p1" });
    const run = createAutomationRun(db, automation.id, "running");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-run-"));

    // Keep the loop pending after firing a tool completion, so we can inspect
    // the on-disk transcript BEFORE the run finishes.
    let resolveLoop!: (v: unknown) => void;
    const loopPromise = new Promise((r) => { resolveLoop = r; });
    runToolLoopMock.mockImplementation((...args: unknown[]) => {
      const emitToolCall = args[7] as (e: { tool: string; label: string; args: Record<string, unknown> }) => void;
      const emitToolCallDone = args[12] as (e: { tool: string; ok: boolean; output: string }) => void;
      emitToolCall({ tool: "run_script", label: "Running gen", args: { name: "gen" } });
      emitToolCallDone({ tool: "run_script", ok: true, output: "made image" });
      return loopPromise;
    });

    const pending = runAutomation({ db, workspacePath: root }, run, automation);
    await new Promise((r) => setTimeout(r, 20));
    const autoDir = automationFolderDir(root, automation.id, "P");
    const runDir = automationRunDir(autoDir, run.id);
    const midLog = JSON.parse(fs.readFileSync(path.join(runDir, "run-log.json"), "utf8"));
    expect(midLog.status).toBe("running");
    expect(midLog.tools).toHaveLength(1);
    expect(midLog.tools[0].ok).toBe(true);

    resolveLoop({ exhausted: false, content: "final", reasoning: "" });
    await pending;
    const doneLog = JSON.parse(fs.readFileSync(path.join(runDir, "run-log.json"), "utf8"));
    expect(doneLog.status).toBe("done");
  });
});

describe("runAutomationNow crash recovery (failRun)", () => {
  it("records a throwing run as error with a run-log.json and a finished event", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    const automation = makeAutomation(db, { projectId: "p1" });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-run-"));
    runToolLoopMock.mockRejectedValue(new Error("provider exploded"));
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const send = (channel: string, payload: unknown) => sent.push({ channel, payload: payload as Record<string, unknown> });

    const runId = runAutomationNow({ db, workspacePath: root, send }, automation.id);
    expect(runId).toBeTruthy();
    // Wait for the async IIFE to settle.
    for (let i = 0; i < 100; i++) {
      const row = getAutomationRunById(db, runId!)!;
      if (row.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const updated = getAutomationRunById(db, runId!)!;
    expect(updated.status).toBe("error");
    expect(updated.error).toMatch(/provider exploded/);
    // A run-log.json was written so the failed run stays inspectable.
    const autoDir = automationFolderDir(root, automation.id, "P");
    const log = JSON.parse(fs.readFileSync(path.join(automationRunDir(autoDir, runId!), "run-log.json"), "utf8"));
    expect(log.status).toBe("error");
    expect(log.error).toMatch(/provider exploded/);
    // The finished event was emitted so a watcher doesn't spin forever.
    const finished = sent.find((s) => s.channel === "automation:run" && s.payload.event === "finished");
    expect(finished).toBeTruthy();
    expect(finished!.payload.error).toMatch(/provider exploded/);
  });
});
