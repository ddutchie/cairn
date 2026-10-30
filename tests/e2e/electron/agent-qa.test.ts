/**
 * Cairn — agent QA e2e (boots the REAL Electron app)
 *
 * Drives each agent loop end-to-end through the actual app — renderer → preload
 * → main process → agent engine → events back — against the live model bridge.
 * This is the "confirm everything works in the real app" tier that sits between
 * the unit/live tests (which call the chat loop directly) and the mocked-IPC
 * browser smoke tests (which never run a loop).
 *
 * Loops covered:
 *   - Chat loop:      window.electron.session.prompt → the chat loop → raw turn/end
  *   - Coding loop:    window.electron.session.prompt → the coding loop → pi-agent:done
 *   - Heartbeat loop: automation.runNow → runAutomationNow → runAutomation → finished
 *
 * Gated behind CAIRN_LIVE=1 (+ CAIRN_DUMMY_KEY=local), like the unit live
 * tests. Without the env every test is a no-op skip so `test:e2e` / CI is safe.
 *
 * Run:
 *   npm run compile
 *   CAIRN_LIVE=1 CAIRN_DUMMY_KEY=local npm run test:e2e:electron
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

const BASE = process.env.CAIRN_TEST_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.CAIRN_TEST_MODEL ?? "claude-sonnet-4-5";

// The env gate — checked once. When the live bridge isn't available the whole
// suite is skipped.
const LIVE = process.env.CAIRN_LIVE === "1" && process.env.CAIRN_DUMMY_KEY !== undefined;

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
      CAIRN_LIVE: process.env.CAIRN_LIVE ?? "1",
      CAIRN_DUMMY_KEY: process.env.CAIRN_DUMMY_KEY ?? "local",
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

/** Call a store action inside the page (functions don't survive page.evaluate serialisation). */
async function storeCall<T = unknown>(page: Page, action: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(async ({ action, args }) => {
    const w = window as unknown as { __cairnStoreRef?: { getState: () => Record<string, (...a: unknown[]) => unknown> } };
    const fn = w.__cairnStoreRef?.getState()[action];
    if (typeof fn !== "function") throw new Error(`store action ${action} missing`);
    return (await fn(...args)) as unknown;
  }, { action, args }) as Promise<T>;
}

/** Seed a workspace + project + note via the real store (what onboarding does). */
async function seedProject(page: Page, workspace: string): Promise<{ workspaceId: string; projectId: string }> {
  await storeCall(page, "initWorkspacePath", workspace);
  const workspaceObj = await storeCall<{ id: string }>(page, "createWorkspace", "QA Workspace", "🧪");
  const project = await storeCall<{ id: string }>(page, "createProject", workspaceObj.id, "QA Project", "📓");
  await storeCall(
    page, "createNote", project.id, "Readme", "note", "",
    "# QA Project\n\nThis is a small fixture project used to verify the agent loops.\n\n- Key fact: Cairn is a notes + tasks desktop app.\n- The chat loop should summarise these bullets.\n- Agent loop can read this file.\n- Heartbeat loop can scan it.",
  );

  // Seed a couple of tasks so task-related prompts return real content. The
  // project auto-creates default columns (Backlog/Todo/In Progress/Review/Done).
  const state = await storeGet(page);
  const cols = (state.columns as Array<{ id: string; projectId: string; name: string }>).filter((c) => c.projectId === project.id);
  const colByName = Object.fromEntries(cols.map((c) => [c.name, c.id]));
  if (colByName["In Progress"]) await storeCall(page, "createCard", colByName["In Progress"], project.id, "Port chat loop onto agent runtime", { dueDate: "2026-08-22", assignee: "Sam" });
  if (colByName["Todo"]) await storeCall(page, "createCard", colByName["Todo"], project.id, "Write onboarding copy", { dueDate: "2026-08-25" });
  if (colByName["Done"]) await storeCall(page, "createCard", colByName["Done"], project.id, "Ship local-first notes", { assignee: "Maya" });

  // The onboarding overlay stays mounted; the loops are driven via IPC / the store, which work regardless.
  return { workspaceId: workspaceObj.id, projectId: project.id };
}

/** Point the in-memory store ai/agent config at the live bridge. */
async function configureLlm(page: Page): Promise<void> {
  await storeCall(page, "setAIConfig", { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" });
  await storeCall(page, "setAgentConfig", { baseUrl: BASE, model: MODEL, apiKey: "local", maxSteps: 8, autoApprove: true });
}

// ── Suite ────────────────────────────────────────────────────────────────────

test.describe("agent loops in the real Electron app", () => {
  test.setTimeout(180_000);
  test.skip(!LIVE, "Requires the live model bridge (CAIRN_LIVE=1 CAIRN_DUMMY_KEY=local)");

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

    // Subscribe to the raw session event stream, then send Chat.
    const done = page.evaluate(async ({ threadId, projectId, workspaceId }) => {
      const w = window as unknown as { __cairnStoreRef?: { getState: () => Record<string, unknown> } };
      const store = w.__cairnStoreRef?.getState();
      const el = window.electron as NonNullable<typeof window.electron>;
      const ai = (store as { aiConfig: { provider: string; baseUrl: string; model: string; apiKey: string } }).aiConfig;

      return new Promise<{ content: string; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for session completion")), 120_000);
        let content = "";
        const types: string[] = [];
        const unsub = el.session.onEvent((e) => {
          if (e.sessionId !== `chat-${threadId}`) return;
          types.push(e.event.type);
          if (e.event.type === "assistant/message") {
            const data = e.event.data as { message?: { content?: Array<{ type?: string; text?: string }> } };
            content += data.message?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
          }
          // A reply may start with tool calls; the turn is only over at turn/end.
          if (e.event.type === "turn/end") {
            clearTimeout(timer);
            unsub();
            const reason = (e.event.data as { reason?: { kind?: string } }).reason?.kind;
            resolve({ content, error: reason && reason !== "stop" && reason !== "completed" ? `${reason} (${[...new Set(types)].join(",")})` : undefined });
          }
        });
        el.session.prompt({
          sessionId: `chat-${threadId}`,
          profile: "chat",
          prompt: "Summarize this project in 2-3 bullet points. Keep it brief.",
          workspaceId,
          projectId,
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
        const seen: string[] = [];
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for turn/end; saw: ${[...new Set(seen)].join(",")}`)), 120_000);
        const unsub = el.session.onEvent((e) => {
          if (e.sessionId !== sessionId) return;
          seen.push(e.event.type + (e.event.type === "tool/call" ? `:${(e.event.data as { name?: string }).name}` : ""));
          if (e.event.type === "assistant/chunk") {
            const chunk = e.event.data as { chunk?: { type?: string; text?: string } };
            if (chunk.chunk?.type === "text-delta") tokens += chunk.chunk.text?.length ?? 0;
          }
          if (e.event.type === "tool/result") toolEnds += 1;
          if (e.event.type === "turn/end") {
            const reason = (e.event.data as { reason?: { kind?: string } }).reason?.kind;
            finish(reason === "stop" || reason === "completed", reason && reason !== "stop" && reason !== "completed" ? reason : undefined);
          }
        });
        const finish = (done: boolean, error?: string) => {
          clearTimeout(timer);
          unsub();
          resolve({ tokens, toolEnds, done, error });
        };
        el.session.prompt({
          sessionId,
          profile: "coding",
          prompt: "Open the note titled 'Readme' (use your tools to read it) and tell me the first bullet point.",
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
        // Not a real schedule kind: nextRunAt is given so it's never parsed,
        // and the test fires the run itself with runNow.
        scheduleKind: "manual" as string as "once",
        scheduleExpr: "manual",
        nextRunAt: new Date().toISOString(),
        approvalMode: "auto",
        source: "custom",
      }).then((automation) => {
        // preload unwraps the { data } envelope, so this is the saved row.
        if (!automation?.id) throw new Error("Automation create returned no id: " + JSON.stringify(automation));
        return { automationId: automation.id };
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
            resolve({ ok: true, error: e.error });
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
