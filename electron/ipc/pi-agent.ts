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
 *   pi-agent:retry     { sessionId, attempt: number, maxRetries: number, delayMs: number, error: string }
 *   pi-agent:compact   { sessionId, status: "start" | "end" }
 */

import { ipcMain } from "electron";
import { runAgentLoop, type PiAgentSession, type AgentLLMConfig, type AgentToolContext } from "../lib/pi-agent-loop";
import { buildCompactionTransformer, compactNow } from "../lib/compaction";
import { buildPiAgentSystemPrompt } from "../lib/pi-agent-prompt";
import { discoverSkills, renderSkillsXml } from "../lib/skills";
import { normaliseBaseUrl } from "../lib/llm";
import type { DbContext } from "./handlers";
import * as q from "../db/queries";
import { ts } from "../db/utils";

// ── Session registry ──────────────────────────────────────────────────────────

const sessions = new Map<string, PiAgentSession>();

// ── Note-writing tool names ────────────────────────────────────────────────────
const NOTE_WRITE_TOOLS = new Set(["ensure_note", "patch_note", "append_to_note"]);

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
    maxSteps?: number;
    temperature?: number;
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
    maxSteps?: number;
    temperature?: number;
  };
}

// ── Shared session runner ──────────────────────────────────────────────────────

/**
 * Wires the compaction transformer, builds all IPC-forwarding callbacks, and
 * calls runAgentLoop. Extracted to eliminate duplication between the
 * pi-agent:prompt and pi-agent:approve-plan handlers — both handlers resolve
 * their differences (system prompt, initial message) before calling this.
 */
async function runSession(
  session: PiAgentSession,
  systemPrompt: string,
  llmConfig: AgentLLMConfig,
  mode: "plan" | "execute",
  toolCtx: AgentToolContext,
  ctx: DbContext,
  send: (channel: string, payload: unknown) => void,
): Promise<void> {
  const { sessionId } = toolCtx;

  // Reuse existing transformer to preserve cachedSummary across prompts.
  // Signal is read live from session.abortCtrl inside the transformer.
  session.compactionTransformer ??= buildCompactionTransformer(
    session,
    llmConfig,
    () => send("pi-agent:compact", { sessionId, status: "start" }),
    () => send("pi-agent:compact", { sessionId, status: "end", auto: true }),
  );

  await runAgentLoop(
    session,
    systemPrompt,
    llmConfig,
    {
      onToken:        (delta) => send("pi-agent:token",      { sessionId, delta }),
      onToolsReady:   ()      => send("pi-agent:tools-ready", { sessionId }),
      onToolPending:  (name, callId) => send("pi-agent:tool", { sessionId, name, label: name, callId, status: "pending" }),
      onToolStart:    (name, label, callId) => send("pi-agent:tool", { sessionId, name, label, callId, status: "start" }),
      onToolEnd:      (name, label, ok, output, callId) => {
        send("pi-agent:tool", { sessionId, name, label, callId, status: "end", ok, output });
        // After any note-write tool, push fresh note content to the renderer
        // so the plan task list can update live without a full re-hydration.
        if (ok && NOTE_WRITE_TOOLS.has(name)) {
          try {
            const parsed = JSON.parse(output) as { id?: string };
            if (parsed?.id) {
              const row = ctx.db.prepare("SELECT content FROM notes WHERE id = ?").get(parsed.id) as { content: string } | undefined;
              if (row) send("pi-agent:note-updated", { sessionId, noteId: parsed.id, content: row.content ?? "" });
            }
          } catch { /* non-JSON output — ignore */ }
        }
      },
      onStepStart:    () => send("pi-agent:step",  { sessionId }),
      onUsage:        (promptTokens, completionTokens) => send("pi-agent:usage", { sessionId, promptTokens, completionTokens }),
      onRetry:        (attempt, maxRetries, delayMs, error) => send("pi-agent:retry", { sessionId, attempt, maxRetries, delayMs, error }),
      transformContext: session.compactionTransformer,
      onDone: () => {
        try {
          q.saveLlmHistory(ctx.db, sessionId, session.messages);
          q.updatePiSession(ctx.db, sessionId, { updatedAt: ts() });
        } catch (e) {
          console.warn("[pi-agent] failed to persist session after done:", e);
        }
        send("pi-agent:done", { sessionId });
      },
      onError: (error) => {
        try {
          q.saveLlmHistory(ctx.db, sessionId, session.messages);
          q.updatePiSession(ctx.db, sessionId, { status: "exited", updatedAt: ts() });
        } catch (e) {
          console.warn("[pi-agent] failed to persist session after error:", e);
        }
        send("pi-agent:error", { sessionId, error });
      },
      onPlanNoteFound: (noteId) => {
        send("pi-agent:plan-note", { sessionId, noteId });
        try { q.updatePiSession(ctx.db, sessionId, { planNoteId: noteId, updatedAt: ts() }); } catch { /* non-critical */ }
      },
    },
    toolCtx,
    mode,
  );
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
      if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
    };

    if (req.config?.provider === "localllm") {
      send("pi-agent:error", {
        sessionId,
        error: "Local Engine (on-device model) is not supported for the coding agent. The coding agent requires a larger cloud model or a capable local model (Ollama, LM Studio) to handle complex multi-file edits. Please switch your provider in Settings to use a cloud model or a local model with tool support."
      });
      return;
    }

    const llmConfig: AgentLLMConfig = {
      baseUrl:     normaliseBaseUrl(req.config?.baseUrl || "https://api.openai.com"),
      model:       req.config?.model       || "gpt-4o",
      apiKey:      req.config?.apiKey      || "",
      maxSteps:    req.config?.maxSteps    ?? 20,
      temperature: req.config?.temperature ?? 0.3,
    };

    let session = sessions.get(sessionId);
    if (!session) {
      session = { messages: [], abortCtrl: new AbortController() };
      sessions.set(sessionId, session);
    } else {
      session.abortCtrl = new AbortController();
    }

    session.messages.push({ role: "user", content: prompt });

    const projectName = projectId
      ? (ctx.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? "Project"
      : "Project";

    const sessionRow = q.getPiSessionById(ctx.db, sessionId);
    const planNoteId = sessionRow?.planNoteId;
    const planContent = planNoteId
      ? (ctx.db.prepare("SELECT content FROM notes WHERE id = ?").get(planNoteId) as { content: string } | undefined)?.content ?? ""
      : undefined;

    const skills = discoverSkills(cwd);
    const systemPrompt = buildPiAgentSystemPrompt({
      projectName, cwd, taskTitle, workspaceId, projectId, mode, planContent,
      skillsXml: renderSkillsXml(skills)
    });

    const toolCtx: AgentToolContext = {
      cwd, db: ctx.db, workspacePath: ctx.workspacePath, sessionId, send, getWin, skills,
      req: { message: prompt, threadId: sessionId, projectId, workspaceId,
             config: { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey } },
    };

    await runSession(session, systemPrompt, llmConfig, mode, toolCtx, ctx, send);
  });

  // ── pi-agent:approve-plan ─────────────────────────────────────────────────
  // Renderer fires this when the user clicks "Approve Plan". Fetches the PRD
  // note, injects the approval message, then continues in execute mode.
  ipcMain.on("pi-agent:approve-plan", async (_event, req: PiAgentApprovePlanRequest) => {
    const { sessionId, planNoteId, projectId, workspaceId, cwd, taskTitle } = req;

    const send = (channel: string, payload: unknown) => {
      const win = getWin();
      if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
    };

    if (req.config?.provider === "localllm") {
      send("pi-agent:error", {
        sessionId,
        error: "Local Engine (on-device model) is not supported for the coding agent. The coding agent requires a larger cloud model or a capable local model (Ollama, LM Studio) to handle complex multi-file edits. Please switch your provider in Settings to use a cloud model or a local model with tool support."
      });
      return;
    }

    const llmConfig: AgentLLMConfig = {
      baseUrl:     normaliseBaseUrl(req.config?.baseUrl || "https://api.openai.com"),
      model:       req.config?.model       || "gpt-4o",
      apiKey:      req.config?.apiKey      || "",
      maxSteps:    req.config?.maxSteps    ?? 20,
      temperature: req.config?.temperature ?? 0.3,
    };

    let session = sessions.get(sessionId);
    if (!session) {
      session = { messages: [], abortCtrl: new AbortController() };
      sessions.set(sessionId, session);
    } else {
      session.abortCtrl = new AbortController();
    }

    const planContent = (ctx.db.prepare("SELECT content FROM notes WHERE id = ?").get(planNoteId) as { content: string } | undefined)?.content ?? "";

    send("pi-agent:mode-change", { sessionId, mode: "execute", planNoteId });
    session.messages.push({
      role: "user",
      content: `The plan has been approved. Begin implementation now, following the approved PRD exactly. The PRD note ID is ${planNoteId} — you can re-read it via get_note if needed.`,
    });

    const projectName = projectId
      ? (ctx.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? "Project"
      : "Project";

    const skills = discoverSkills(cwd);
    const systemPrompt = buildPiAgentSystemPrompt({ projectName, cwd, taskTitle, workspaceId, projectId, mode: "execute", planContent, skillsXml: renderSkillsXml(skills) });

    const toolCtx: AgentToolContext = {
      cwd, db: ctx.db, workspacePath: ctx.workspacePath, sessionId, send, getWin, skills,
      req: { message: "", threadId: sessionId, projectId, workspaceId,
             config: { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey } },
    };

    await runSession(session, systemPrompt, llmConfig, "execute", toolCtx, ctx, send);
  });

  // ── pi-agent:compact-now ─────────────────────────────────────────────────
  // Triggered by the /compact slash command. Immediately summarises the session
  // history and returns the result. The renderer shows a status message.
  ipcMain.on("pi-agent:compact-now", async (_event, req: { sessionId: string; config?: { baseUrl?: string; model?: string; apiKey?: string } }) => {
    const { sessionId } = req;
    const session = sessions.get(sessionId);
    if (!session || session.messages.length === 0) return;

    const send = (channel: string, payload: unknown) => {
      const win = getWin();
      if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
    };

    const llmConfig: AgentLLMConfig = {
      baseUrl:     normaliseBaseUrl(req.config?.baseUrl || "https://api.openai.com"),
      model:       req.config?.model  || "gpt-4o",
      apiKey:      req.config?.apiKey || "",
      maxSteps:    20,
      temperature: 0.1,
    };

    send("pi-agent:compact", { sessionId, status: "start" });
    try {
      const result = await compactNow(session, llmConfig);
      if (result) {
        session.messages = result.messages;
        // Update the transformer's cache so the next runAgentLoop call uses the summary
        session.compactionTransformer = undefined; // reset so it rebuilds with new context
        q.saveLlmHistory(ctx.db, sessionId, session.messages);
        send("pi-agent:compact-result", { sessionId, messageCount: result.messages.length, summary: result.summary });
      } else {
        send("pi-agent:compact-result", { sessionId, messageCount: 0, summary: "" });
      }
    } catch (e) {
      send("pi-agent:error", { sessionId, error: `Compaction failed: ${(e as Error).message}` });
    } finally {
      send("pi-agent:compact", { sessionId, status: "end" });
    }
  });

  // ── pi-agent:clear ────────────────────────────────────────────────────────
  // Clears a session's message history (new conversation within same session).
  // Also resets the compaction transformer so the new conversation starts
  // with a fresh cachedSummary.
  ipcMain.on("pi-agent:clear", (_event, { sessionId }: { sessionId: string }) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.messages = [];
      session.compactionTransformer = undefined;
      session.lastPromptTokens = undefined;
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

  // ── pi-agent:preview-prompt ───────────────────────────────────────────────────────
  // Used by Settings → Agent Settings to show the full assembled system prompt
  // and list discovered skills for the given cwd.
  ipcMain.handle("pi-agent:preview-prompt", (_event, req: {
    cwd: string;
    projectId?: string;
    mode?: "plan" | "execute";
  }) => {
    try {
      const { cwd, projectId, mode = "execute" } = req;
      const projectName = projectId
        ? (ctx.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? "Project"
        : "Project";
      const skills = discoverSkills(cwd);
      const systemPrompt = buildPiAgentSystemPrompt({
        projectName, cwd, mode,
        skillsXml: renderSkillsXml(skills),
      });
      return { data: { systemPrompt, skills } };
    } catch (e) {
      return { error: (e as Error).message };
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
        // getLlmHistory now returns the full AgentMessage objects (role, content,
        // tool_calls, tool_call_id, etc.) so multi-turn context is fully restored.
        sessions.set(sessionId, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: history as any[],
          abortCtrl: new AbortController(),
        });
      }
    } catch (e) {
      console.warn("[pi-agent] restore-context failed for", sessionId, e);
    }
  });
}
