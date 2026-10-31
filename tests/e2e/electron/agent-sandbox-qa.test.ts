/**
 * Cairn — sandbox, approvals and session-search e2e (boots the REAL Electron app).
 *
 * Deterministic: the "model" is a scripted local server (mock-model.ts), so these assert
 * on what the app does with a tool call, not on what a real model decides.
 *
 * Run:  npm run compile && npx playwright test -c playwright.electron.config.ts -g "sandbox|session search"
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { bootApp, configureLlm, seedProject } from "./helpers";
import { startMockModel, type MockModel } from "./mock-model";

const SANDBOX_SUPPORTED = process.platform === "darwin" || process.platform === "linux";

interface TurnOutcome { reason?: string; approvals: Array<{ callId: string; reason?: string; grants?: unknown; name?: string }> }

/** Run one prompt to the end of its turn, answering approval asks with `decide`. */
async function runTurn(
  page: Page,
  args: { sessionId: string; profile: "chat" | "coding"; prompt: string; workspaceId: string; projectId: string; cwd: string; baseUrl: string; decide?: "approve" | "deny" },
): Promise<TurnOutcome> {
  return page.evaluate((a) => new Promise<TurnOutcome>((resolve, reject) => {
    const el = window.electron as NonNullable<typeof window.electron>;
    const approvals: TurnOutcome["approvals"] = [];
    const timer = setTimeout(() => reject(new Error("turn timed out")), 90_000);
    const offProj = el.session.onProjection((p) => {
      if (p.sessionId !== a.sessionId || p.kind !== "approval") return;
      const d = p.data as { status: string; callId: string; nonce?: string; reason?: string; grants?: unknown; name?: string };
      if (d.status !== "required") return;
      approvals.push({ callId: d.callId, reason: d.reason, grants: d.grants, name: d.name });
      el.session.respondTool(a.sessionId, d.callId, a.decide === "approve", undefined, undefined, d.nonce);
    });
    const offEvt = el.session.onEvent((e) => {
      if (e.sessionId !== a.sessionId || e.event.type !== "turn/end") return;
      clearTimeout(timer); offProj(); offEvt();
      resolve({ reason: (e.event.data as { reason?: { kind?: string } }).reason?.kind, approvals });
    });
    el.session.prompt({
      sessionId: a.sessionId, profile: a.profile, prompt: a.prompt, workspaceId: a.workspaceId, projectId: a.projectId, cwd: a.cwd, mode: "execute",
      // yolo: everything is auto-approved except what must always ask (the sandbox escalation).
      config: { provider: "openai", baseUrl: a.baseUrl, model: "mock", apiKey: "local", maxSteps: 6, autoApprove: true },
    });
  }), args);
}

test.describe("sandbox, approvals and session search in the real Electron app", () => {
  test.setTimeout(180_000);
  let mock: MockModel;
  let app: ElectronApplication;
  let page: Page;
  let workspace: string;
  let wsId: string;
  let projectId: string;
  const outside: string[] = [];

  test.beforeAll(async () => {
    mock = await startMockModel();
    const booted = await bootApp(mock.baseUrl, "mock");
    app = booted.app; page = booted.page; workspace = booted.workspace;
    await configureLlm(page, mock.baseUrl, "mock");
    const seeded = await seedProject(page, workspace);
    wsId = seeded.workspaceId; projectId = seeded.projectId;
  });

  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    await mock?.close().catch(() => undefined);
    for (const f of outside) fs.rmSync(f, { force: true });
    fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
  });

  const turn = (sessionId: string, prompt: string, decide?: "approve" | "deny", profile: "chat" | "coding" = "coding") =>
    runTurn(page, { sessionId, profile, prompt, workspaceId: wsId, projectId, cwd: workspace, baseUrl: mock.baseUrl, decide });

  test("sandbox: a write outside the working directory is blocked and the model is told how to escalate", async () => {
    test.skip(!SANDBOX_SUPPORTED, "no OS sandbox on this platform");
    const target = path.join(os.homedir(), `.cairn-e2e-${Date.now()}.txt`);
    outside.push(target);
    mock.plan = { name: "bash", args: { command: `echo hi > '${target}'`, description: "Write outside the workspace" } };
    const out = await turn(`qa-sbx-${Date.now()}`, "write a file in my home folder");
    expect(out.reason).toBe("stop");
    expect(out.approvals).toHaveLength(0); // sandboxed commands run without asking in yolo
    expect(fs.existsSync(target)).toBe(false);
    expect(mock.lastToolResult()).toMatch(/Operation not permitted|Read-only|Permission denied/i);
    expect(mock.lastToolResult()).toContain("unsandboxed");
  });

  test("sandbox: a write inside the working directory works", async () => {
    test.skip(!SANDBOX_SUPPORTED, "no OS sandbox on this platform");
    mock.plan = { name: "bash", args: { command: "echo inside > inside.txt && cat inside.txt", description: "Write inside the workspace" } };
    const out = await turn(`qa-sbx-in-${Date.now()}`, "write a file here");
    expect(out.reason).toBe("stop");
    expect(fs.readFileSync(path.join(workspace, "inside.txt"), "utf8")).toBe("inside\n");
  });

  test("sandbox: unsandboxed always asks, even with auto-approve, and Deny keeps the file from being written", async () => {
    test.skip(!SANDBOX_SUPPORTED, "no OS sandbox on this platform");
    const target = path.join(os.homedir(), `.cairn-e2e-esc-${Date.now()}.txt`);
    outside.push(target);
    mock.plan = { name: "bash", args: { command: `echo hi > '${target}'`, description: "Write outside, unsandboxed", unsandboxed: true } };
    const out = await turn(`qa-esc-deny-${Date.now()}`, "write it anyway", "deny");
    expect(out.approvals).toHaveLength(1);
    expect(out.approvals[0].reason).toMatch(/outside the sandbox|escalate sandbox/i);
    expect(out.approvals[0].grants).toEqual([]); // never rememberable
    expect(fs.existsSync(target)).toBe(false);
  });

  test("sandbox: approving an unsandboxed command runs it outside the sandbox", async () => {
    test.skip(!SANDBOX_SUPPORTED, "no OS sandbox on this platform");
    const target = path.join(os.homedir(), `.cairn-e2e-esc-ok-${Date.now()}.txt`);
    outside.push(target);
    mock.plan = { name: "bash", args: { command: `echo hi > '${target}'`, description: "Write outside, unsandboxed", unsandboxed: true } };
    const out = await turn(`qa-esc-ok-${Date.now()}`, "write it anyway", "approve");
    expect(out.approvals).toHaveLength(1);
    expect(fs.readFileSync(target, "utf8")).toBe("hi\n");
  });

  test("session search: a later chat finds an earlier one in the same workspace", async () => {
    const marker = `zebracrossing${Date.now()}`;
    const first = `chat-qa-first-${Date.now()}`;
    mock.plan = { text: `We agreed the export format is CSV (${marker}).` };
    expect((await turn(first, `What export format should we use? ${marker}`, undefined, "chat")).reason).toBe("stop");

    mock.plan = { name: "search_sessions", args: { query: marker } };
    const second = `chat-qa-second-${Date.now()}`;
    expect((await turn(second, "what did we decide earlier?", undefined, "chat")).reason).toBe("stop");
    const result = mock.lastToolResult() ?? "";
    expect(result).toContain(first);
    expect(result).toContain(marker);
    expect(result).not.toContain(second);
  });
});
