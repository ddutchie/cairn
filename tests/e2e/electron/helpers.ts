/** Shared boot + store helpers for the real-Electron QA specs. */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

export const MAIN = path.join(__dirname, "..", "..", "..", "dist-electron", "main.js");

// ── Boot the app ─────────────────────────────────────────────────────────────

export async function bootApp(base: string, model: string): Promise<{ app: ElectronApplication; page: Page; workspace: string }> {
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
        aiConfig: { provider: "openai", baseUrl: base, model, apiKey: "local" },
        agentConfig: { baseUrl: base, model, apiKey: "local", maxSteps: 8, autoApprove: true },
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
export async function storeGet(page: Page): Promise<Record<string, unknown>> {
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
export async function storeCall<T = unknown>(page: Page, action: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(async ({ action, args }) => {
    const w = window as unknown as { __cairnStoreRef?: { getState: () => Record<string, (...a: unknown[]) => unknown> } };
    const fn = w.__cairnStoreRef?.getState()[action];
    if (typeof fn !== "function") throw new Error(`store action ${action} missing`);
    return (await fn(...args)) as unknown;
  }, { action, args }) as Promise<T>;
}

/** Seed a workspace + project + note via the real store (what onboarding does). */
export async function seedProject(page: Page, workspace: string): Promise<{ workspaceId: string; projectId: string }> {
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
export async function configureLlm(page: Page, base: string, model: string): Promise<void> {
  await storeCall(page, "setAIConfig", { provider: "openai", baseUrl: base, model, apiKey: "local" });
  await storeCall(page, "setAgentConfig", { baseUrl: base, model, apiKey: "local", maxSteps: 8, autoApprove: true });
}

