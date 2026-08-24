/**
 * Cairn — Cordis QA e2e (boots the REAL Electron app)
 *
 * Drives each Cordis loop end-to-end through the actual app — renderer → preload
 * → main process → Cordis engine → events back — against the live model bridge.
 * This is the "confirm everything works in the real app" tier that sits between
 * the unit/live tests (which call runCordisLoop directly) and the mocked-IPC
 * browser smoke tests (which never run a loop).
 *
 * Loops covered:
 *   - Chat loop:      window.electron.chat.stream → runCordisLoop → chat:done
  *   - Coding loop:    window.electron.session.prompt → runCordisCodingLoop → pi-agent:done
 *   - Heartbeat loop: automation.runNow → runAutomationNow → runAutomation → finished
 *
 * Gated behind CORDIS_LIVE=1 (+ CORDIS_DUMMY_KEY=local), like the unit live
 * tests. Without the env every test is a no-op skip so `test:e2e` / CI is safe.
 *
 * Run:
 *   npm run compile
 *   CORDIS_LIVE=1 CORDIS_DUMMY_KEY=local npm run test:e2e:electron
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

const BASE = process.env.CORDIS_TEST_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.CORDIS_TEST_MODEL ?? "claude-sonnet-4-5";

// The env gate — checked once. When the live bridge isn't available the whole
// suite is skipped.
const LIVE = process.env.CORDIS_LIVE === "1" && process.env.CORDIS_DUMMY_KEY !== undefined;

const MAIN = path.join(__dirname, "..", "..", "..", "dist-electron", "main.js");

// ── Boot the app ─────────────────────────────────────────────────────────────

async function bootApp(): Promise<{ app: ElectronApplication; page: Page; workspace: string }> {
  // A throwaway userData dir (app redirects here via CAIRN_USER_DATA_DIR) and a
  // throwaway workspace folder this test fully owns — never touches real data.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-qa-userdata-"));
  const workspace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-qa-ws-")), "vault");
  fs.mkdirSync(workspace, { recursive: true });

  // Point the app at our fixture workspace BEFORE it boots so the onboarding
  // gate (needsWorkspaceSetup) is satisfied and the main process resolves its
  // DB to our folder. Also seed the LLM cache so the main-process loops resolve
  // the connection even before the renderer calls setAIConfig/setAgentConfig.
  fs.writeFileSync(
    path.join(userData, "workspace-config.json"),
    JSON.stringify({ workspacePath: workspace }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(userData, "ai-settings-cache.json"),
    JSON.stringify(
      {
        aiConfig: { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" },
        agentConfig: { baseUrl: BASE, model: MODEL, apiKey: "local", maxSteps: 8, autoApprove: true },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const app = await electron.launch({
    args: [MAIN],
    env: {
      ...(process.env as Record<string, string>),
      CORDIS_LIVE: process.env.CORDIS_LIVE ?? "1",
      CORDIS_DUMMY_KEY: process.env.CORDIS_DUMMY_KEY ?? "local",
      CAIRN_USER_DATA_DIR: userData,
      NODE_ENV: "development",
    },
  });

  // Dev mode opens a detached DevTools window; grab the real renderer window
  // (the one loading the Next dev server), not the devtools one.
  let page: Page | undefined;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    page = app.windows().find((w) => w.url().startsWith("http://localhost:3000"));
    if (page) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw new Error("Could not find the app renderer window (localhost:3000)");

  // Wait until the Cairn store is attached (page.tsx mounts it shortly after
  // the shell/onboarding decision). The shell sidebar itself only renders after
  // a workspace+project is seeded, so we wait for the store, not the sidebar.
  const storeDeadline = Date.now() + 60_000;
  while (Date.now() < storeDeadline) {
    const ready = await page.evaluate(() => !!(
      (window as unknown as { __cairnStoreRef?: unknown }).__cairnStoreRef
    )).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  return { app, page, workspace };
}

/** Access the Zustand store from the renderer. */
async function storeGet(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    // The real app attaches __cairnStoreRef on mount; the smoke-test getter
    // (__cairnStore) may or may not be present, so check both.
    const w = window as unknown as {
      __cairnStoreRef?: { getState: () => Record<string, unknown> };
      __cairnStore?: { getState: () => Record<string, unknown> };
    };
    const store = w.__cairnStoreRef ?? w.__cairnStore;
    if (!store) throw new Error("Cairn store not attached yet");
    return store.getState();
  });
}

/** Seed a workspace + project + note via the real store (what onboarding does). */
async function seedProject(page: Page, workspace: string): Promise<{ workspaceId: string; projectId: string }> {
  const state = await storeGet(page);
  await (state.initWorkspacePath as (p: string) => Promise<void>)(workspace);
  const s2 = await storeGet(page);
  const workspaceObj = await (s2.createWorkspace as (name: string, icon?: string) => Promise<{ id: string }>)("QA Workspace", "🧪");
  const project = await (s2.createProject as (wid: string, name: string, icon?: string) => Promise<{ id: string }>)(
    workspaceObj.id,
    "QA Project",
    "📓",
  );
  await (s2.createNote as (pid: string, title: string, type?: string, folder?: string, content?: string) => unknown)(
    project.id,
    "Readme",
    "note",
    "",
    "# QA Project\n\nThis is a small fixture project used to verify the Cordis loops.\n\n- Key fact: Cairn is a notes + tasks desktop app.\n- The chat loop should summarise these bullets.\n- Agent loop can read this file.\n- Heartbeat loop can scan it.",
  );

  // Seed a couple of tasks so task-related prompts return real content. The
  // project auto-creates default columns (Backlog/Todo/In Progress/Review/Done).
  const s3 = await storeGet(page);
  const cols = (s3.columns as Array<{ id: string; projectId: string; name: string }>)
    .filter((c) => c.projectId === project.id);
  const colByName = Object.fromEntries(cols.map((c) => [c.name, c.id]));
  const makeCard = s3.createCard as (cid: string, pid: string, title: string, extras?: { dueDate?: string; assignee?: string }) => unknown;
  if (colByName["In Progress"]) makeCard(colByName["In Progress"], project.id, "Port chat loop onto Cordis runtime", { dueDate: "2026-08-22", assignee: "Sam" });
  if (colByName["Todo"]) makeCard(colByName["Todo"], project.id, "Write onboarding copy", { dueDate: "2026-08-25" });
  if (colByName["Done"]) makeCard(colByName["Done"], project.id, "Ship local-first notes", { assignee: "Maya" });

  // Note: we do NOT wait for the sidebar here — the onboarding overlay (set at
  // boot before seeding) stays mounted. The QA loops are driven via the IPC /
  // store (page.evaluate), which work regardless of the overlay, so it's fine.
  return { workspaceId: workspaceObj.id, projectId: project.id };
}

/** Point the in-memory store ai/agent config at the live bridge. */
async function configureLlm(page: Page): Promise<void> {
  const state = await storeGet(page);
  await (state.setAIConfig as (p: Record<string, unknown>) => void)({
    provider: "openai",
    baseUrl: BASE,
    model: MODEL,
    apiKey: "local",
  });
  await (state.setAgentConfig as (p: Record<string, unknown>) => void)({
    baseUrl: BASE,
    model: MODEL,
    apiKey: "local",
    maxSteps: 8,
    autoApprove: true,
  });
}

// ── Suite ────────────────────────────────────────────────────────────────────

test.describe("Cordis loops in the real Electron app", () => {
  test.skip(!LIVE, "Requires the live model bridge (CORDIS_LIVE=1 CORDIS_DUMMY_KEY=local)");

  let app: ElectronApplication;
  let page: Page;
  let workspace: string;
  let wsId: string;
  let projectId: string;

  test.beforeAll(async () => {
    const booted = await bootApp();
    app = booted.app;
    page = booted.page;
    workspace = booted.workspace;
    await configureLlm(page);
    const seeded = await seedProject(page, workspace);
    wsId = seeded.workspaceId;
    projectId = seeded.projectId;
  });

  test.afterAll(async () => {
    try {
      await app?.close();
    } catch {
      // already closed
    }
    try {
      fs.rmSync(path.join(path.dirname(workspace)), { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  });

  test("chat loop — 'summarize this project' produces a non-empty reply", async () => {
    const threadId = "qa-chat-" + Date.now();

    // Subscribe to the shared session:done lifecycle event, then send Chat.
    const done = page.evaluate(async ({ threadId, projectId, workspaceId }) => {
      const w = window as unknown as { __cairnStoreRef?: { getState: () => Record<string, unknown> } };
      const store = w.__cairnStoreRef?.getState();
      const el = window.electron as NonNullable<typeof window.electron>;
      const ai = (store as { aiConfig: { provider: string; baseUrl: string; model: string; apiKey: string } }).aiConfig;

      return new Promise<{ content: string; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for session:done")), 120_000);
        const unsub = el.session.onDone((e) => {
          if (e.sessionId !== `chat-${threadId}`) return;
          if (e.threadId && e.threadId !== threadId) return;
          clearTimeout(timer);
          unsub();
          resolve({ content: e.content ?? "", error: e.error });
        });
        el.chat.stream({
          threadId,
          workspaceId,
          projectId,
          message: "Summarize this project in 2-3 bullet points. Keep it brief.",
          history: [],
          personality: "helpful",
          config: {
            provider: ai.provider,
            baseUrl: ai.baseUrl,
            model: ai.model,
            apiKey: ai.apiKey,
          },
        });
      });
    }, { threadId, projectId, workspaceId: wsId });

    const result = await done;

    expect(result.error).toBeUndefined();
    expect(result.content.trim().length).toBeGreaterThan(0);
  });

  test("coding loop — agent reads the fixture note and reports back", async () => {
    const sessionId = "qa-agent-" + Date.now();

    const outcome = page.evaluate(async ({ sessionId, projectId, workspaceId, cwd }) => {
      const w = window as unknown as { __cairnStoreRef?: { getState: () => Record<string, unknown> } };
      const el = window.electron as NonNullable<typeof window.electron>;
      const agent = (w.__cairnStoreRef?.getState() as { agentConfig: { baseUrl: string; model: string; apiKey: string; maxSteps?: number } }).agentConfig;

      return new Promise<{ tokens: number; toolEnds: number; done: boolean; error?: string }>((resolve, reject) => {
        let tokens = 0;
        let toolEnds = 0;
        const timer = setTimeout(() => reject(new Error("Timed out waiting for pi-agent:done")), 120_000);
        const unsubToken = el.session.onToken((e) => {
          if (e.sessionId === sessionId) tokens += e.delta.length;
        });
        const unsubTool = el.session.onTool((e) => {
          if (e.sessionId === sessionId && e.status === "end") toolEnds += 1;
        });
        const finish = (done: boolean, error?: string) => {
          clearTimeout(timer);
          unsubToken(); unsubTool(); unsubDone(); unsubError();
          resolve({ tokens, toolEnds, done, error });
        };
        const unsubDone = el.session.onDone((e) => {
          if (e.sessionId === sessionId) finish(true);
        });
        const unsubError = el.session.onError((e) => {
          if (e.sessionId === sessionId) finish(false, e.error);
        });
        el.session.prompt({
          sessionId,
          prompt: "Open the note titled 'Readme' (use the read_note tool) and tell me the first bullet point.",
          projectId,
          workspaceId,
          cwd,
          mode: "execute",
          config: {
            provider: "openai",
            baseUrl: agent.baseUrl,
            model: agent.model,
            apiKey: agent.apiKey,
            maxSteps: agent.maxSteps ?? 8,
            autoApprove: true,
          },
        });
      });
    }, { sessionId, projectId, workspaceId: wsId, cwd: workspace });

    const result = await outcome;

    expect(result.error).toBeUndefined();
    expect(result.done).toBe(true);
    expect(result.tokens).toBeGreaterThan(0);
  });

  test("heartbeat loop — a data-only automation runs to completion", async () => {
    const { automationId } = await page.evaluate(({ wsId, projectId }) => {
      const el = window.electron as NonNullable<typeof window.electron>;
      return el.automation.create({
        workspaceId: wsId,
        projectId,
        name: "QA Heartbeat",
        description: "Automation QA test",
        instructions: "List the notes in this project and summarise their titles in one line.",
        scheduleKind: "manual",
        scheduleExpr: "manual",
        nextRunAt: new Date().toISOString(),
        approvalMode: "auto",
        source: "custom",
      }).then((res: unknown) => {
        const data = (res as { data?: { id?: string } }).data;
        if (!data?.id) throw new Error("Automation create returned no id: " + JSON.stringify(res));
        return { automationId: data.id };
      });
    }, { wsId, projectId });

    const finished = page.evaluate(({ automationId }) => {
      const el = window.electron as NonNullable<typeof window.electron>;
      return new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for automation finished")), 120_000);
        const unsub = el.automation.onRunEvent((e) => {
          if (e.event === "finished") {
            clearTimeout(timer);
            unsub();
            resolve({ ok: true, error: (e as { error?: string }).error });
          }
        });
        el.automation.runNow(automationId);
      });
    }, { automationId });

    const result = await finished;

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
