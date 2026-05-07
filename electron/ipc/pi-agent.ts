/**
 * Cairn Native Agent — IPC handler
 *
 * Registers pi-agent:* channels. Each session is a stateful PiAgentSession
 * (message history + AbortController) held in a Map for the app lifetime.
 *
 * Channels (fire-and-forget, renderer → main):
 *   pi-agent:prompt  { sessionId, prompt, projectId, cwd, taskTitle?, config }
 *   pi-agent:abort   { sessionId }
 *
 * Events (main → renderer):
 *   pi-agent:token     { sessionId, delta: string }
 *   pi-agent:tool      { sessionId, name: string, label: string, status: "start"|"end", ok?: boolean }
 *   pi-agent:done      { sessionId }
 *   pi-agent:error     { sessionId, error: string }
 */

import { ipcMain } from "electron";
import { runAgentLoop, type PiAgentSession, type AgentLLMConfig } from "../lib/pi-agent-loop";
import { buildPiAgentSystemPrompt } from "../lib/pi-agent-prompt";
import type { ChatRequest } from "../lib/tools";
import type { DbContext } from "./handlers";

// ── Session registry ──────────────────────────────────────────────────────────

const sessions = new Map<string, PiAgentSession>();

// ── Request shape ──────────────────────────────────────────────────────────────

interface PiAgentPromptRequest {
  sessionId: string;
  prompt: string;
  projectId?: string;
  workspaceId?: string;
  cwd: string;
  taskTitle?: string;
  config?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
}

// ── Registration ───────────────────────────────────────────────────────────────

export function registerPiAgentHandler(
  ctx: DbContext,
): void {
  // Read db/workspacePath from ctx at call-time so workspace reinitialise is transparent
  const getWin = ctx.getWin;

  // ── pi-agent:abort ────────────────────────────────────────────────────────
  ipcMain.on("pi-agent:abort", (_event, { sessionId }: { sessionId: string }) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.abortCtrl.abort();
    }
  });

  // ── pi-agent:prompt ───────────────────────────────────────────────────────
  ipcMain.on("pi-agent:prompt", async (event, req: PiAgentPromptRequest) => {
    const { sessionId, prompt, projectId, workspaceId, cwd, taskTitle } = req;

    const send = (channel: string, payload: unknown) => {
      const win = getWin();
      if (win && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    };

    // Resolve LLM config from settings stored in DB
    const settingsRow = ctx.db
      .prepare("SELECT value FROM settings WHERE key = 'aiConfig' LIMIT 1")
      .get() as { value: string } | undefined;

    let storedConfig: { baseUrl?: string; model?: string; apiKey?: string } = {};
    if (settingsRow?.value) {
      try { storedConfig = JSON.parse(settingsRow.value); } catch { /* ignore */ }
    }

    const llmConfig: AgentLLMConfig = {
      baseUrl: (req.config?.baseUrl || storedConfig.baseUrl || "https://api.openai.com").replace(/\/$/, ""),
      model:   req.config?.model   || storedConfig.model   || "gpt-4o",
      apiKey:  req.config?.apiKey  || storedConfig.apiKey  || "",
    };

    // Get or create session
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        messages: [],
        abortCtrl: new AbortController(),
      };
      sessions.set(sessionId, session);
    } else {
      // New prompt in existing session — create fresh abort controller
      session.abortCtrl = new AbortController();
    }

    // Append the user message to history
    session.messages.push({ role: "user", content: prompt });

    // Resolve project name for system prompt
    const projectName = projectId
      ? (ctx.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? "Project"
      : "Project";

    const systemPrompt = buildPiAgentSystemPrompt({
      projectName,
      cwd,
      taskTitle,
      workspaceId,
      projectId,
    });

    // Build a minimal ChatRequest for Cairn tool execution
    const chatReq: ChatRequest = {
      message: prompt,
      threadId: sessionId,
      projectId,
      workspaceId,
      config: {
        baseUrl: llmConfig.baseUrl,
        model: llmConfig.model,
        apiKey: llmConfig.apiKey,
      },
    };

    await runAgentLoop(
      session,
      systemPrompt,
      cwd,
      llmConfig,
      ctx.db,
      chatReq,
      ctx.workspacePath,
      {
        onToken: (delta) => send("pi-agent:token", { sessionId, delta }),
        onToolStart: (name, label) => send("pi-agent:tool", { sessionId, name, label, status: "start" }),
        onToolEnd: (name, label, ok) => send("pi-agent:tool", { sessionId, name, label, status: "end", ok }),
        onDone: () => send("pi-agent:done", { sessionId }),
        onError: (error) => send("pi-agent:error", { sessionId, error }),
      },
      getWin,
    );
  });

  // ── pi-agent:clear ────────────────────────────────────────────────────────
  // Clears a session's message history (new conversation within same session)
  ipcMain.on("pi-agent:clear", (_event, { sessionId }: { sessionId: string }) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.messages = [];
    }
  });

  // ── pi-agent:destroy ──────────────────────────────────────────────────────
  // Called when a pi session tab is closed — frees memory
  ipcMain.on("pi-agent:destroy", (_event, { sessionId }: { sessionId: string }) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.abortCtrl.abort();
      sessions.delete(sessionId);
    }
  });
}
