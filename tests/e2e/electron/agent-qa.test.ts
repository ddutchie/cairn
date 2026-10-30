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

import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { bootApp, configureLlm, seedProject } from "./helpers";

const BASE = process.env.CAIRN_TEST_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.CAIRN_TEST_MODEL ?? "claude-sonnet-4-5";

// The env gate — checked once. When the live bridge isn't available the whole
// suite is skipped.
const LIVE = process.env.CAIRN_LIVE === "1" && process.env.CAIRN_DUMMY_KEY !== undefined;


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
    const booted = await bootApp(BASE, MODEL);
    app = booted.app;
    page = booted.page;
    workspace = booted.workspace;
    await configureLlm(page, BASE, MODEL);
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
