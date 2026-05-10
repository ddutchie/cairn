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
import { normaliseBaseUrl } from "../lib/llm";
import type { ChatRequest } from "../lib/tools";
import type { DbContext } from "./handlers";
import * as q from "../db/queries";
import { ts } from "../db/utils";

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
  mode?: "plan" | "execute";
  config?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
}

interface PiAgentApprovePlanRequest {
  sessionId: string;
  planNoteId: string;
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
    const { sessionId, prompt, projectId, workspaceId, cwd, taskTitle, mode = "execute" } = req;

    const send = (channel: string, payload: unknown) => {
      const win = getWin();
      if (win && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    };

    // Resolve LLM config — renderer passes config from its aiConfig store
    const llmConfig: AgentLLMConfig = {
      baseUrl: normaliseBaseUrl(req.config?.baseUrl || "https://api.openai.com"),
      model:   req.config?.model   || "gpt-4o",
      apiKey:  req.config?.apiKey  || "",
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
      mode,
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
        onToken:         (delta) => send("pi-agent:token",      { sessionId, delta }),
        onToolsReady:    ()     => send("pi-agent:tools-ready", { sessionId }),
        onToolPending:   (name, callId) => send("pi-agent:tool", { sessionId, name, label: name, callId, status: "pending" }),
        onToolStart:     (name, label, callId) => send("pi-agent:tool", { sessionId, name, label, callId, status: "start" }),
        onToolEnd:       (name, label, ok, output, callId) => send("pi-agent:tool", { sessionId, name, label, callId, status: "end", ok, output }),
        onStepStart:     () => send("pi-agent:step",  { sessionId }),
        onUsage:         (promptTokens, completionTokens) => send("pi-agent:usage", { sessionId, promptTokens, completionTokens }),
        onDone: () => {
          try {
            const llmRows = session.messages.map((m) => ({ role: m.role, content: ("content" in m && m.content != null) ? String(m.content) : "" }));
            q.saveLlmHistory(ctx.db, sessionId, llmRows);
            q.updatePiSession(ctx.db, sessionId, { updatedAt: ts() });
          } catch (e) {
            console.warn("[pi-agent] failed to persist session after done:", e);
          }
          send("pi-agent:done", { sessionId });
        },
        onError: (error) => {
          try {
            const llmRows = session.messages.map((m) => ({ role: m.role, content: ("content" in m && m.content != null) ? String(m.content) : "" }));
            q.saveLlmHistory(ctx.db, sessionId, llmRows);
            q.updatePiSession(ctx.db, sessionId, { status: "exited", updatedAt: ts() });
          } catch (e) {
            console.warn("[pi-agent] failed to persist session after error:", e);
          }
          send("pi-agent:error", { sessionId, error });
        },
        onPlanNoteFound: (noteId) => send("pi-agent:plan-note", { sessionId, noteId }),
      },
      getWin,
      sessionId,
      send,
      mode,
    );
  });

  // ── pi-agent:approve-plan ─────────────────────────────────────────────────
  // Renderer fires this when the user clicks "Approve Plan".
  // Main fetches the PRD note content, switches the session to execute mode,
  // injects a system message, and kicks off a new execute-mode loop turn.
  ipcMain.on("pi-agent:approve-plan", async (_event, req: PiAgentApprovePlanRequest) => {
    const { sessionId, planNoteId, projectId, workspaceId, cwd, taskTitle } = req;

    const send = (channel: string, payload: unknown) => {
      const win = getWin();
      if (win && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    };

    const llmConfig: AgentLLMConfig = {
      baseUrl: normaliseBaseUrl(req.config?.baseUrl || "https://api.openai.com"),
      model:   req.config?.model   || "gpt-4o",
      apiKey:  req.config?.apiKey  || "",
    };

    let session = sessions.get(sessionId);
    if (!session) {
      session = { messages: [], abortCtrl: new AbortController() };
      sessions.set(sessionId, session);
    } else {
      session.abortCtrl = new AbortController();
    }

    // Fetch the PRD note content from SQLite
    const noteRow = ctx.db
      .prepare("SELECT content FROM notes WHERE id = ?")
      .get(planNoteId) as { content: string } | undefined;
    const planContent = noteRow?.content ?? "";

    // Notify renderer the mode has switched
    send("pi-agent:mode-change", { sessionId, mode: "execute", planNoteId });

    // Inject the approval message into history
    session.messages.push({
      role: "user",
      content: `The plan has been approved. Begin implementation now, following the approved PRD exactly. The PRD note ID is ${planNoteId} — you can re-read it via get_note if needed.`,
    });

    const projectName = projectId
      ? (ctx.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? "Project"
      : "Project";

    const systemPrompt = buildPiAgentSystemPrompt({
      projectName,
      cwd,
      taskTitle,
      workspaceId,
      projectId,
      mode: "execute",
      planContent,
    });

    const chatReq: ChatRequest = {
      message: "",
      threadId: sessionId,
      projectId,
      workspaceId,
      config: { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey },
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
        onToken:       (delta) => send("pi-agent:token",      { sessionId, delta }),
        onToolsReady:  ()     => send("pi-agent:tools-ready", { sessionId }),
        onToolPending:   (name, callId) => send("pi-agent:tool", { sessionId, name, label: name, callId, status: "pending" }),
        onToolStart:     (name, label, callId) => send("pi-agent:tool", { sessionId, name, label, callId, status: "start" }),
        onToolEnd:       (name, label, ok, output, callId) => send("pi-agent:tool", { sessionId, name, label, callId, status: "end", ok, output }),
        onStepStart:     () => send("pi-agent:step",  { sessionId }),
        onUsage:         (promptTokens, completionTokens) => send("pi-agent:usage", { sessionId, promptTokens, completionTokens }),
        onDone: () => {
          try {
            const llmRows = session.messages.map((m) => ({ role: m.role, content: ("content" in m && m.content != null) ? String(m.content) : "" }));
            q.saveLlmHistory(ctx.db, sessionId, llmRows);
            q.updatePiSession(ctx.db, sessionId, { updatedAt: ts() });
          } catch (e) {
            console.warn("[pi-agent] failed to persist session after done:", e);
          }
          send("pi-agent:done", { sessionId });
        },
        onError: (error) => {
          try {
            const llmRows = session.messages.map((m) => ({ role: m.role, content: ("content" in m && m.content != null) ? String(m.content) : "" }));
            q.saveLlmHistory(ctx.db, sessionId, llmRows);
            q.updatePiSession(ctx.db, sessionId, { status: "exited", updatedAt: ts() });
          } catch (e) {
            console.warn("[pi-agent] failed to persist session after error:", e);
          }
          send("pi-agent:error", { sessionId, error });
        },
        onPlanNoteFound: (noteId) => send("pi-agent:plan-note", { sessionId, noteId }),
      },
      getWin,
      sessionId,
      send,
      "execute",
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

  // ── pi-agent:restore-context ───────────────────────────────────────────────────────
  // Loads the persisted LLM message history for a session back into the
  // in-memory sessions Map so the model can continue from where it left off.
  ipcMain.on("pi-agent:restore-context", (_event, { sessionId }: { sessionId: string }) => {
    if (sessions.has(sessionId)) return; // already in memory
    try {
      const history = q.getLlmHistory(ctx.db, sessionId);
      if (history.length > 0) {
        // Cast the stored { role, content } rows back to AgentMessage —
        // the loop only needs role + content for multi-turn context.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const messages = history.map((h) => ({ role: h.role, content: h.content })) as any[];
        sessions.set(sessionId, {
          messages,
          abortCtrl: new AbortController(),
        });
      }
    } catch (e) {
      console.warn("[pi-agent] restore-context failed for", sessionId, e);
    }
  });
}
