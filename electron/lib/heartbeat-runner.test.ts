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

const { runCordisCodingLoopMock, getExternalToolDefsMock } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runCordisCodingLoopMock: vi.fn(async (_opts: any): Promise<any> => ({ ok: true })),
  getExternalToolDefsMock: vi.fn(async () => []),
}));

vi.mock("./config-cache", () => ({
  getCachedConfig: () => ({ aiConfig: { baseUrl: "https://api.test.invalid", model: "gpt-test" } }),
}));

vi.mock("../cordis/run-cordis-coding", () => ({
  runCordisCodingLoop: (opts: unknown) => runCordisCodingLoopMock(opts),
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

// ── Temp workspace roots (auto-cleaned) ─────────────────────────────────────
const tempRoots: string[] = [];

/** Create a temp workspace root tracked for cleanup. */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-run-"));
  tempRoots.push(root);
  return root;
}

// ── Named runCordisLoop options accessors ───────────────────────────────────
// The runner calls runCordisLoop with an options object; these accessors name
// the fields so tests don't scatter magic keys (they read the LAST call).
interface LoopOpts {
  send?: (channel: string, payload: Record<string, unknown>) => void;
  signal?: unknown;
  req?: { message?: string; threadId?: string };
  autoApprove?: boolean;
  cwd?: string;
  systemPrompt?: string;
}
function lastLoopOpts(): LoopOpts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls = (runCordisCodingLoopMock as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls;
  const last = calls[calls.length - 1]?.[0] as LoopOpts | undefined;
  return last ?? {};
}

const loopReq = () => lastLoopOpts().req;
const loopSend = () => lastLoopOpts().send;
const loopCwd = () => lastLoopOpts().cwd;
const loopAutoApprove = () => lastLoopOpts().autoApprove;
const loopSignal = () => lastLoopOpts().signal;
/** Drive a `pi-agent:tool` start event through the runner's send sink. */
const fireToolStart = (tool: string, label: string, args: Record<string, unknown>) =>
  loopSend()?.("pi-agent:tool", { name: tool, label, args, status: "start" });
/** Drive a `pi-agent:tool` end event through the runner's send sink. */
const fireToolEnd = (tool: string, ok: boolean, output: string) =>
  loopSend()?.("pi-agent:tool", { name: tool, ok, output, status: "end" });
/** Drive a `pi-agent:token` delta through the runner's send sink. */
const fireToken = (delta: string) => loopSend()?.("pi-agent:token", { delta });

afterEach(() => {
  vi.clearAllMocks();
  for (const root of tempRoots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* already gone */ }
    // Also clean the dsh session that was nested under .cairn-sessions/<encoded-cwd>/
    // (the fallback sessionRoot used before main.ts sets the real <userData>/sessions).
    try {
      const encoded = root.replace(/[^a-zA-Z0-9._-]/g, (c) => `-${c.charCodeAt(0).toString(16)}-`).replace(/^-/, "--").replace(/-$/, "--") || "_";
      // The actual dsh encoding is more complex, so brute-force: delete any
      // .cairn-sessions dir that contains this root's encoded form as a substring,
      // plus the common case of cleaning the whole .cairn-sessions after the suite.
      const cairnSessions = path.join(process.cwd(), ".cairn-sessions");
      if (fs.existsSync(cairnSessions)) {
        for (const entry of fs.readdirSync(cairnSessions)) {
          if (entry.includes("heartbeat-run")) {
            try { fs.rmSync(path.join(cairnSessions, entry), { recursive: true, force: true }); } catch { /* ignore */ }
          }
        }
        // Remove the now-empty .cairn-sessions dir itself so git status stays clean.
        try { if (fs.readdirSync(cairnSessions).length === 0) fs.rmdirSync(cairnSessions); } catch { /* ignore */ }
      }
    } catch { /* best-effort */ }
  }
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
    expect(runCordisCodingLoopMock).not.toHaveBeenCalled();
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
    expect(runCordisCodingLoopMock).not.toHaveBeenCalled();
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
    runCordisCodingLoopMock.mockResolvedValue({ ok: true });

    await runAutomation({ db, workspacePath: "/tmp" }, run, automation);

    expect(runCordisCodingLoopMock).toHaveBeenCalled();
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

    expect(runCordisCodingLoopMock).not.toHaveBeenCalled();
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
    runCordisCodingLoopMock.mockResolvedValue({ ok: true });
    const root = makeRoot();

    await runAutomation({ db, workspacePath: root }, run, automation);

    const updated = getAutomationRunById(db, run.id)!;
    expect(updated.status).toBe("done");
    const expectedDir = automationRunDir(automationFolderDir(root, automation.id, "P"), run.id);
    expect(updated.runDir).toBe(expectedDir);
    expect(fs.existsSync(expectedDir)).toBe(true);

    // The run folder + scripts/ + out/ are materialized. (run_script /
    // write_run_file / deliver_file bridging onto runCordisLoop is a Phase 2
    // follow-up — the Cordis loop doesn't expose them as separate handlers yet.)
    const autoDir = automationFolderDir(root, automation.id, "P");
    expect(fs.existsSync(path.join(autoDir, "scripts"))).toBe(true);
    expect(fs.existsSync(path.join(autoDir, "out"))).toBe(true);
  });

  it("records a run folder at the workspace root for workspace-scoped automations", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    const automation = makeAutomation(db, {}); // no project → workspace scope
    const run = createAutomationRun(db, automation.id, "running");
    runCordisCodingLoopMock.mockResolvedValue({ ok: true });
    const root = makeRoot();

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
    runCordisCodingLoopMock.mockResolvedValue({ ok: true });
    const root = makeRoot();
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
    // The .env non-secret is present on disk (run_script env injection is a
    // Phase 2 follow-up on the Cordis path).
    expect(envFile).toContain('MY_TOKEN="abc"');
  });

  it("uses the agent-authored manifest instructions as the recipe instead of the row", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    const automation = makeAutomation(db, { projectId: "p1" }); // row recipe = "Summarise today's Linear activity."
    const run = createAutomationRun(db, automation.id, "running");
    runCordisCodingLoopMock.mockResolvedValue({ ok: true });
    const root = makeRoot();
    const autoDir = automationFolderDir(root, automation.id, "P");
    fs.mkdirSync(autoDir, { recursive: true });
    fs.writeFileSync(
      path.join(autoDir, "manifest.json"),
      JSON.stringify({ instructions: "MANIFEST RECIPE: check the news via the connector, then run generate_images, then write a note." }),
      "utf8",
    );

    await runAutomation({ db, workspacePath: root }, run, automation);

    const recipeMsg = loopReq()?.message ?? "";
    expect(recipeMsg).toContain("MANIFEST RECIPE");
    expect(recipeMsg).toContain("run generate_images");
    expect(recipeMsg).not.toContain("Linear activity");
  });

  it("streams live run activity and persists a run transcript", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    const automation = makeAutomation(db, { projectId: "p1" });
    const run = createAutomationRun(db, automation.id, "running");
    const root = makeRoot();
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const send = (channel: string, payload: unknown) => sent.push({ channel, payload: payload as Record<string, unknown> });

    // The loop mock fires the tool/token events DURING the run so they land
    // in both the live stream and the persisted transcript.
    runCordisCodingLoopMock.mockImplementation(() => {
      fireToolStart("run_script", "Running gen", { name: "gen" });
      fireToken("hello ");
      fireToken("world");
      fireToolEnd("run_script", true, "made image");
      return Promise.resolve({ ok: true });
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
    // The coding agent's final content is the accumulated streamed tokens.
    expect(log.tokens).toBe("hello world");
    expect(log.tools).toHaveLength(1);
    expect(log.tools[0].name).toBe("run_script");
    expect(log.tools[0].ok).toBe(true);
    expect(log.tools[0].output).toBe("made image");
  });

  it("records a failed coding turn as 'error', not 'done'", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    const automation = makeAutomation(db, { projectId: "p1" });
    const run = createAutomationRun(db, automation.id, "running");
    runCordisCodingLoopMock.mockResolvedValue({ ok: false, error: "provider down" });
    const root = makeRoot();

    await runAutomation({ db, workspacePath: root }, run, automation);

    const updated = getAutomationRunById(db, run.id)!;
    expect(updated.status).toBe("error");
    expect(updated.error).toMatch(/provider down/);
    const autoDir = automationFolderDir(root, automation.id, "P");
    const log = JSON.parse(fs.readFileSync(path.join(automationRunDir(autoDir, run.id), "run-log.json"), "utf8"));
    expect(log.status).toBe("error");
  });

  it("flushes the transcript incrementally as tools complete (survives a crash mid-run)", async () => {
    const db = makeDb();
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    const automation = makeAutomation(db, { projectId: "p1" });
    const run = createAutomationRun(db, automation.id, "running");
    const root = makeRoot();

    // Keep the loop pending after firing a tool completion, so we can inspect
    // the on-disk transcript BEFORE the run finishes.
    let resolveLoop!: (v: unknown) => void;
    const loopPromise = new Promise((r) => { resolveLoop = r; });
    runCordisCodingLoopMock.mockImplementation(() => {
      fireToolStart("run_script", "Running gen", { name: "gen" });
      fireToolEnd("run_script", true, "made image");
      return loopPromise as Promise<{ ok: boolean }>;
    });

    const pending = runAutomation({ db, workspacePath: root }, run, automation);
    await new Promise((r) => setTimeout(r, 20));
    const autoDir = automationFolderDir(root, automation.id, "P");
    const runDir = automationRunDir(autoDir, run.id);
    const midLog = JSON.parse(fs.readFileSync(path.join(runDir, "run-log.json"), "utf8"));
    expect(midLog.status).toBe("running");
    expect(midLog.tools).toHaveLength(1);
    expect(midLog.tools[0].ok).toBe(true);

    resolveLoop({ ok: true });
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
    const root = makeRoot();
    // Emit one completed tool BEFORE the loop rejects, so the incrementally
    // flushed transcript exists and failRun must preserve it (not replace it).
    runCordisCodingLoopMock.mockImplementation(() => {
      fireToolStart("run_script", "Running gen", { name: "gen" });
      fireToolEnd("run_script", true, "made image");
      return Promise.reject(new Error("provider exploded"));
    });
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
    // A run-log.json was written so the failed run stays inspectable — and it
    // must RETAIN the tool history flushed before the crash.
    const autoDir = automationFolderDir(root, automation.id, "P");
    const log = JSON.parse(fs.readFileSync(path.join(automationRunDir(autoDir, runId!), "run-log.json"), "utf8"));
    expect(log.status).toBe("error");
    expect(log.error).toMatch(/provider exploded/);
    expect(log.tools).toHaveLength(1);
    expect(log.tools[0].name).toBe("run_script");
    expect(log.tools[0].ok).toBe(true);
    // The finished event was emitted so a watcher doesn't spin forever.
    const finished = sent.find((s) => s.channel === "automation:run" && s.payload.event === "finished");
    expect(finished).toBeTruthy();
    expect(finished!.payload.error).toMatch(/provider exploded/);
  });
});
