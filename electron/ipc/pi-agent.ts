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

import { registerIpcHandle, registerIpcOn, broadcastEvent } from "./registry";

import { runAgentLoop, pendingApprovals, pendingDoomLoop, pendingQuestionAnswers, type PiAgentSession, type AgentLLMConfig, type AgentToolContext } from "../lib/pi-agent-loop";
import { buildCompactionTransformer, compactNow } from "../lib/compaction";
import { buildPiAgentSystemPrompt } from "../lib/pi-agent-prompt";
import { discoverSkills, renderSkillsXml } from "../lib/skills";
import { normaliseBaseUrl, isLocalEndpoint } from "../lib/llm";
import type { DbContext } from "./handlers";
import * as q from "../db/queries";
import { ts } from "../db/utils";
import { getCachedConfig, cacheLlmConnection } from "../lib/config-cache";
import { resolveLlmApiKey } from "../lib/secure-store";
import { buildAttachmentParts, validateAttachmentDataUrl } from "../../shared/models/pdf-attach";
import { createDeltaBatcher } from "../lib/delta-batcher";

// ── Session registry ──────────────────────────────────────────────────────────

const sessions = new Map<string, PiAgentSession>();

/**
 * Session IDs with a runAgentLoop currently in flight. The renderer polls this
 * via `pi-agent:is-running` when a pane (re)mounts so a session that kept
 * working while its UI was closed (e.g. the automation Develop modal) comes
 * back already showing the busy state, instead of briefly looking idle.
 */
const runningLoops = new Set<string>();

// ── Debounced history persistence ─────────────────────────────────────────────
// saveLlmHistory is a synchronous (better-sqlite3) transaction that
// JSON-serialises every message in the session — on a long turn that's a
// non-trivial main-thread block. Defer it off the done/error delivery path and
// coalesce rapid saves (a done immediately followed by an error) so the renderer
// gets its turn-complete event without waiting on the DB write. The message
// snapshot is taken at schedule time, so a new turn can never be half-saved.
const pendingHistorySaves = new Map<string, { timer: NodeJS.Timeout; msgs: PiAgentSession["messages"] }>();

function scheduleHistorySave(
  db: Parameters<typeof q.saveLlmHistory>[0],
  sessionId: string,
  msgs: PiAgentSession["messages"],
  status?: "exited",
): void {
  const existing = pendingHistorySaves.get(sessionId);
  if (existing) clearTimeout(existing.timer);
  const snapshot = [...msgs];
  pendingHistorySaves.set(sessionId, {
    msgs: snapshot,
    timer: setTimeout(() => {
      pendingHistorySaves.delete(sessionId);
      try {
        q.saveLlmHistory(db, sessionId, snapshot);
        q.updatePiSession(db, sessionId, { ...(status ? { status } : {}), updatedAt: ts() });
      } catch (e) {
        console.warn("[pi-agent] failed to persist session:", e);
      }
    }, 50),
  });
}

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
  /** Image/PDF attachments staged in the input — serialized to content parts. */
  attachments?: Array<{ kind?: "image" | "pdf"; dataUrl: string; name?: string }>;
  config?: {
    provider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
    autoApprove?: boolean;
    isReasoningModel?: boolean;
    /** The agent's context-window size — drives the sliding-window pruner. */
    contextWindow?: number;
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
    provider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
    autoApprove?: boolean;
    isReasoningModel?: boolean;
    /** The agent's context-window size — drives the sliding-window pruner. */
    contextWindow?: number;
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
  runningLoops.add(sessionId);

  // Reuse existing transformer to preserve cachedSummary across prompts.
  // Signal is read live from session.abortCtrl inside the transformer.
  session.compactionTransformer ??= buildCompactionTransformer(
    session,
    llmConfig,
    () => send("pi-agent:compact", { sessionId, status: "start" }),
    () => send("pi-agent:compact", { sessionId, status: "end", auto: true }),
  );

  // Coalesce streamed deltas into ~20 IPC events/sec instead of one per token.
  const tokens = createDeltaBatcher((delta) => send("pi-agent:token", { sessionId, delta }));
  const thoughts = createDeltaBatcher((delta) => send("pi-agent:thought", { sessionId, delta }));

  await runAgentLoop(
    session,
    systemPrompt,
    llmConfig,
    {
      // Batch streamed deltas — one IPC event per flush instead of per token,
      // so a dense stream (reasoning models, long replies) can't flood the
      // renderer. Flushed on done/error below.
      onToken:        (delta) => tokens.push(delta),
      onThought:      (delta) => thoughts.push(delta),
      onToolsReady:   ()      => send("pi-agent:tools-ready", { sessionId }),
      onToolPending:  (name, callId) => send("pi-agent:tool", { sessionId, name, label: name, callId, status: "pending" }),
       onToolStart:    (name, label, callId, args) => send("pi-agent:tool", { sessionId, name, label, args, callId, status: "start" }),
       onToolConfirmRequired: (name, label, callId, args) => send("pi-agent:tool-confirm-required", { sessionId, name, label, args, callId }),
       onDoomLoop: (info) => send("pi-agent:doom-loop", { sessionId, ...info }),
       onToolEnd:      (name, label, ok, output, callId, args) => {
         send("pi-agent:tool", { sessionId, name, label, args, callId, status: "end", ok, output });
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
        // After the todowrite tool succeeds, broadcast the persisted list so the
        // todo dock updates live as the agent works.
        if (ok && name === "todowrite") {
          send("pi-agent:todos", { sessionId, todos: q.getSessionTodos(ctx.db, sessionId) });
        }
      },
      onStepStart:    () => send("pi-agent:step",  { sessionId }),
      onUsage:        (promptTokens, completionTokens, reasoningTokens, breakdown, _cost, cacheRead, cacheCreate) => send("pi-agent:usage", { sessionId, promptTokens, completionTokens, reasoningTokens, breakdown, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreate }),
      onRetry:        (attempt, maxRetries, delayMs, error) => send("pi-agent:retry", { sessionId, attempt, maxRetries, delayMs, error }),
      transformContext: session.compactionTransformer,
      onDone: () => {
        runningLoops.delete(sessionId);
        tokens.flush();
        thoughts.flush();
        // Persist off the done-delivery path (see scheduleHistorySave).
        scheduleHistorySave(ctx.db, sessionId, session.messages);
        send("pi-agent:done", { sessionId });
      },
      onError: (error) => {
        runningLoops.delete(sessionId);
        tokens.flush();
        thoughts.flush();
        scheduleHistorySave(ctx.db, sessionId, session.messages, "exited");
        send("pi-agent:error", { sessionId, error });
      },
      onPlanNoteFound: (noteId) => {
        send("pi-agent:plan-note", { sessionId, noteId });
        try { q.updatePiSession(ctx.db, sessionId, { planNoteId: noteId, updatedAt: ts() }); } catch { /* non-critical */ }
      },
    },
    toolCtx,
    mode,
  ).catch((err) => {
    // A crashed loop must still resolve the turn: flush buffered tokens,
    // persist the (exited) session, and send a terminal error so the renderer
    // never stays stuck in its loading state.
    runningLoops.delete(sessionId);
    tokens.flush();
    thoughts.flush();
    scheduleHistorySave(ctx.db, sessionId, session.messages, "exited");
    send("pi-agent:error", { sessionId, error: (err as Error)?.message ?? String(err) });
  });
}

// ── Registration ───────────────────────────────────────────────────────────────

export function registerPiAgentHandler(
  ctx: DbContext,
): void {
  // Read db/workspacePath from ctx at call-time so workspace reinitialise is transparent
  const getWin = ctx.getWin;

  // ── pi-agent:is-running ──────────────────────────────────────────────────
  // Invoke-style query so a (re)mounting AgentChatPane can restore its busy
  // state from the main process — the loop's lifecycle lives here, not in the
  // renderer's local state.
  registerIpcHandle("pi-agent:is-running", (_event, { sessionId }: { sessionId: string }) => {
    return runningLoops.has(sessionId);
  });

  // ── pi-agent:abort ────────────────────────────────────────────────────────
  registerIpcOn("pi-agent:abort", (_event, { sessionId }: { sessionId: string }) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.abortCtrl.abort();
    }
  });

  // ── pi-agent:prompt ───────────────────────────────────────────────────────
  registerIpcOn("pi-agent:prompt", async (event, req: PiAgentPromptRequest) => {
    const { sessionId, prompt, projectId, workspaceId, cwd, taskTitle, mode = "execute" } = req;

    const send = (channel: string, payload: unknown) => {
      broadcastEvent(channel, payload);
    };

    // Reject a second prompt for a session whose loop is already running —
    // starting a new loop would replace session.abortCtrl mid-flight and leave
    // the is-running state inconsistent. The renderer queues prompts while busy,
    // so this is a defensive guard, not the normal path.
    if (runningLoops.has(sessionId)) {
      send("pi-agent:error", { sessionId, error: "This agent session is already running — wait for the current turn to finish before sending another prompt." });
      return;
    }

    // Runtime-validate staged attachments BEFORE they are persisted into the
    // session or turned into content parts — a malformed/oversized data URL must
    // never reach the provider (or the transcript).
    if (req.attachments?.length) {
      for (const a of req.attachments) {
        const problem = validateAttachmentDataUrl(a?.dataUrl);
        if (problem) {
          send("pi-agent:error", {
            sessionId,
            error: `Invalid attachment${a?.name ? ` "${a.name}"` : ""}: ${problem}`,
          });
          return;
        }
      }
    }

    if (req.config?.provider === "localllm") {
      send("pi-agent:error", {
        sessionId,
        error: "Local Engine (on-device model) is not supported for the coding agent. The coding agent requires a larger cloud model or a capable local model (Ollama, LM Studio) to handle complex multi-file edits. Please switch your provider in Settings to use a cloud model or a local model with tool support."
      });
      return;
    }

    // Cache the connection + behavioural fields (apiKey scrubbed to a ref-or-clear
    // by the cache layer, never a raw key).
    cacheLlmConnection("agent", {
      baseUrl: req.config?.baseUrl,
      model: req.config?.model,
      apiKey: req.config?.apiKey,
      maxSteps: req.config?.maxSteps,
      temperature: req.config?.temperature,
      maxTokens: req.config?.maxTokens,
      autoApprove: req.config?.autoApprove,
    });

    let reqConfig = req.config;
    const cached = getCachedConfig().agentConfig;
    if (!reqConfig?.apiKey && cached?.apiKey) {
      reqConfig = {
        ...reqConfig,
        baseUrl: reqConfig?.baseUrl || cached.baseUrl,
        model: reqConfig?.model || cached.model,
        apiKey: cached.apiKey,
        maxSteps: reqConfig?.maxSteps || cached.maxSteps,
        temperature: reqConfig?.temperature || cached.temperature,
        maxTokens: reqConfig?.maxTokens ?? (cached as { maxTokens?: number }).maxTokens,
        autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : cached.autoApprove,
      };
    } else if (cached) {
      reqConfig = {
        ...reqConfig,
        autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : cached.autoApprove,
      };
    }

    const llmConfig: AgentLLMConfig = {
      baseUrl:     normaliseBaseUrl(reqConfig?.baseUrl || "https://api.openai.com"),
      model:       reqConfig?.model       || "gpt-5.6-luna",
      apiKey:      resolveLlmApiKey(reqConfig?.apiKey),
      maxSteps:    reqConfig?.maxSteps    ?? 20,
      temperature: reqConfig?.temperature ?? 0.3,
      maxTokens:   reqConfig?.maxTokens,
      autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : true,
      isReasoningModel: reqConfig?.isReasoningModel,
      provider: reqConfig?.provider ?? (isLocalEndpoint(reqConfig?.baseUrl ?? "") ? "localllm" : undefined),
      contextWindow: reqConfig?.contextWindow,
    };

    let session = sessions.get(sessionId);
    if (!session) {
      session = { messages: [], abortCtrl: new AbortController() };
      sessions.set(sessionId, session);
    } else {
      session.abortCtrl = new AbortController();
    }

    session.messages.push({
      role: "user",
      content: req.attachments?.length
        ? buildAttachmentParts(prompt, req.attachments)
        : prompt,
    });

    const projectName = projectId
      ? (ctx.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? "Project"
      : "Project";

    const sessionRow = q.getPiSessionById(ctx.db, sessionId);
    const planNoteId = sessionRow?.planNoteId;
    const planContent = planNoteId
      ? (ctx.db.prepare("SELECT content FROM notes WHERE id = ?").get(planNoteId) as { content: string } | undefined)?.content ?? ""
      : undefined;

    // Session persona (persisted on the row) — "automation-dev" restricts the
    // toolset to file tools so a Develop session can't touch notes/tasks.
    // Validated: an unknown persisted value fails closed to the restricted
    // persona rather than the unrestricted default.
    const role = q.normalizeSessionRole(sessionRow?.role);
    session.role = role;

    const skills = discoverSkills(cwd);
    const systemPrompt = buildPiAgentSystemPrompt({
      projectName, cwd, taskTitle, workspaceId, projectId, mode, planContent,
      skillsXml: renderSkillsXml(skills),
      role,
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
  registerIpcOn("pi-agent:approve-plan", async (_event, req: PiAgentApprovePlanRequest) => {
    const { sessionId, planNoteId, projectId, workspaceId, cwd, taskTitle } = req;

    const send = (channel: string, payload: unknown) => {
      broadcastEvent(channel, payload);
    };

    // Same concurrency guard as pi-agent:prompt — a plan approval is also a
    // loop run and must never stack on an in-flight loop for this session.
    if (runningLoops.has(sessionId)) {
      send("pi-agent:error", { sessionId, error: "This agent session is already running — wait for the current turn to finish before approving the plan." });
      return;
    }

    if (req.config?.provider === "localllm") {
      send("pi-agent:error", {
        sessionId,
        error: "Local Engine (on-device model) is not supported for the coding agent. The coding agent requires a larger cloud model or a capable local model (Ollama, LM Studio) to handle complex multi-file edits. Please switch your provider in Settings to use a cloud model or a local model with tool support."
      });
      return;
    }

    // Cache the connection + behavioural fields (apiKey scrubbed to a ref-or-clear
    // by the cache layer, never a raw key).
    cacheLlmConnection("agent", {
      baseUrl: req.config?.baseUrl,
      model: req.config?.model,
      apiKey: req.config?.apiKey,
      maxSteps: req.config?.maxSteps,
      temperature: req.config?.temperature,
      maxTokens: req.config?.maxTokens,
      autoApprove: req.config?.autoApprove,
    });

    let reqConfig = req.config;
    const cached = getCachedConfig().agentConfig;
    if (!reqConfig?.apiKey && cached?.apiKey) {
      reqConfig = {
        ...reqConfig,
        baseUrl: reqConfig?.baseUrl || cached.baseUrl,
        model: reqConfig?.model || cached.model,
        apiKey: cached.apiKey,
        maxSteps: reqConfig?.maxSteps || cached.maxSteps,
        temperature: reqConfig?.temperature || cached.temperature,
        maxTokens: reqConfig?.maxTokens ?? (cached as { maxTokens?: number }).maxTokens,
        autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : cached.autoApprove,
      };
    } else if (cached) {
      reqConfig = {
        ...reqConfig,
        autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : cached.autoApprove,
      };
    }

    const llmConfig: AgentLLMConfig = {
      baseUrl:     normaliseBaseUrl(reqConfig?.baseUrl || "https://api.openai.com"),
      model:       reqConfig?.model       || "gpt-5.6-luna",
      apiKey:      resolveLlmApiKey(reqConfig?.apiKey),
      maxSteps:    reqConfig?.maxSteps    ?? 20,
      temperature: reqConfig?.temperature ?? 0.3,
      maxTokens:   reqConfig?.maxTokens,
      autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : true,
      isReasoningModel: reqConfig?.isReasoningModel,
      provider: reqConfig?.provider ?? (isLocalEndpoint(reqConfig?.baseUrl ?? "") ? "localllm" : undefined),
      contextWindow: reqConfig?.contextWindow,
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

    // Restore the persisted persona for this session (e.g. "automation-dev" for
    // a Develop session) so plan approval can't silently broaden its toolset.
    const sessionRow = q.getPiSessionById(ctx.db, sessionId);
    const role = q.normalizeSessionRole(sessionRow?.role);
    session.role = role;

    const skills = discoverSkills(cwd);
    const systemPrompt = buildPiAgentSystemPrompt({ projectName, cwd, taskTitle, workspaceId, projectId, mode: "execute", planContent, skillsXml: renderSkillsXml(skills), role });

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
  registerIpcOn("pi-agent:compact-now", async (_event, req: { sessionId: string; config?: { baseUrl?: string; model?: string; apiKey?: string; contextWindow?: number } }) => {
    const { sessionId } = req;
    // A running loop is reading session.messages live — replacing them mid-run
    // would desync its in-flight context. The renderer only sends /compact
    // when idle, so this is a defensive guard.
    if (runningLoops.has(sessionId)) {
      broadcastEvent("pi-agent:compact-result", {
        sessionId,
        messageCount: 0,
        summary: "Can't compact while the agent is working — try again when it finishes.",
      });
      return;
    }
    const session = sessions.get(sessionId);
    if (!session || session.messages.length === 0) return;

    const send = (channel: string, payload: unknown) => {
      broadcastEvent(channel, payload);
    };

    // Cache the connection (apiKey scrubbed to a ref-or-clear by the cache layer).
    cacheLlmConnection("agent", {
      baseUrl: req.config?.baseUrl,
      model: req.config?.model,
      apiKey: req.config?.apiKey,
    });

    let reqConfig = req.config;
    if (!reqConfig?.apiKey) {
      const cached = getCachedConfig().agentConfig;
      if (cached?.apiKey) {
        reqConfig = {
          ...reqConfig,
          baseUrl: reqConfig?.baseUrl || cached.baseUrl,
          model: reqConfig?.model || cached.model,
          apiKey: cached.apiKey,
        };
      }
    }

    const llmConfig: AgentLLMConfig = {
      baseUrl:     normaliseBaseUrl(reqConfig?.baseUrl || "https://api.openai.com"),
      model:       reqConfig?.model  || "gpt-5.6-luna",
      apiKey:      resolveLlmApiKey(reqConfig?.apiKey),
      maxSteps:    20,
      temperature: 0.1,
      contextWindow: reqConfig?.contextWindow,
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

  // ── pi-agent:set-mode ─────────────────────────────────────────────────────
  registerIpcOn("pi-agent:set-mode", (_event, { sessionId, mode }: { sessionId: string; mode: "plan" | "execute" }) => {
    try {
      q.updatePiSession(ctx.db, sessionId, { mode, updatedAt: ts() });
      broadcastEvent("pi-agent:mode-change", { sessionId, mode });
    } catch (e) {
      console.warn("[pi-agent] failed to update session mode:", e);
    }
  });

  // ── pi-agent:respond-tool ──────────────────────────────────────────────────
  registerIpcOn("pi-agent:respond-tool", (_event, { sessionId, callId, approved, grant }: { sessionId: string; callId: string; approved: boolean; grant?: "session" | "command" }) => {
    void sessionId;
    const pending = pendingApprovals.get(callId);
    if (pending) {
      pending.resolve({ approved, grant: approved ? grant : undefined });
      pendingApprovals.delete(callId);
    }
  });

  // ── pi-agent:respond-doom-loop ─────────────────────────────────────────────
  // User decision on a repeated-identical-call pause. Allow → the call runs and
  // the session stops re-pausing; deny → the loop halts with an error.
  registerIpcOn("pi-agent:respond-doom-loop", (_event, { sessionId, callId, allow }: { sessionId: string; callId: string; allow: boolean }) => {
    void sessionId;
    const pending = pendingDoomLoop.get(callId);
    if (pending) {
      pending.resolve(allow);
      pendingDoomLoop.delete(callId);
    }
  });

  // ── pi-agent:respond-questions ─────────────────────────────────────────────
  // Answers to a blocked ask_questions call. The formatted answer text is fed
  // back to the model as the tool result so it reasons over the answers in the
  // same turn.
  registerIpcOn("pi-agent:respond-questions", (_event, { sessionId, callId, answers }: { sessionId: string; callId: string; answers: string }) => {
    void sessionId;
    const pending = pendingQuestionAnswers.get(callId);
    if (pending) {
      pending.resolve(answers);
      pendingQuestionAnswers.delete(callId);
    }
  });

  // ── pi-agent:clear ────────────────────────────────────────────────────────
  // Clears a session's message history (new conversation within same session).
  // Also resets the compaction transformer so the new conversation starts
  // with a fresh cachedSummary.
  registerIpcOn("pi-agent:clear", (_event, { sessionId }: { sessionId: string }) => {
    // Same guard as the other session mutators: replacing messages while a loop
    // is running would desync its in-flight context. The renderer stops the run
    // before clearing, so this is defensive.
    if (runningLoops.has(sessionId)) {
      broadcastEvent("pi-agent:error", { sessionId, error: "Can't clear while the agent is working — stop the run first." });
      return;
    }
    const session = sessions.get(sessionId);
    if (session) {
      session.messages = [];
      session.compactionTransformer = undefined;
      session.lastPromptTokens = undefined;
      session.approvedTools = new Set();
      session.recentToolCalls = [];
      session.doomLoopApproved = false;
    }
    // Explicit session clearing wipes persisted todos too (the todowrite
    // replacement contract otherwise leaves them until the next write).
    q.saveSessionTodos(ctx.db, sessionId, []);
  });

  // ── pi-agent:destroy ──────────────────────────────────────────────────────
  // Called when a pi session tab is closed — frees memory
  registerIpcOn("pi-agent:destroy", (_event, { sessionId }: { sessionId: string }) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.abortCtrl.abort();
      sessions.delete(sessionId);
    }
  });

  // ── pi-agent:preview-prompt ───────────────────────────────────────────────────────
  // Used by Settings → Agent Settings to show the full assembled system prompt
  // and list discovered skills for the given cwd.
  registerIpcHandle("pi-agent:preview-prompt", (_event, req: {
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
  registerIpcOn("pi-agent:restore-context", (_event, { sessionId }: { sessionId: string }) => {
    if (sessions.has(sessionId)) return; // already in memory
    try {
      const history = q.getLlmHistory(ctx.db, sessionId);
      if (history.length > 0) {
        // getLlmHistory now returns the full AgentMessage objects (role, content,
        // tool_calls, tool_call_id, etc.) so multi-turn context is fully restored.
        // Restore the persisted persona too so a subsequent prompt/approval keeps
        // the session's tool restrictions (validated, failing closed).
        const sessionRow = q.getPiSessionById(ctx.db, sessionId);
        sessions.set(sessionId, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: history as any[],
          abortCtrl: new AbortController(),
          role: q.normalizeSessionRole(sessionRow?.role),
        });
      }
    } catch (e) {
      console.warn("[pi-agent] restore-context failed for", sessionId, e);
    }
  });
}
