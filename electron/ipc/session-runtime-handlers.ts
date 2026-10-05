/**
 * Cairn coding session runtime — IPC handlers
 *
 * Registers session command, raw-event, and projection channels. Each session is a stateful AgentSession
 * (message history + AbortController) held in a Map for the app lifetime.
 *
 * Channels (fire-and-forget, renderer → main):
 *   session:prompt  { sessionId, prompt, projectId, cwd, taskTitle?, config }
 *   session:abort   { sessionId }
 *
 * Events (main → renderer): session:event (raw DSH events) and
 * session:projection (typed presentation updates).
 */

import { registerIpcHandle, registerContractHandle, registerIpcOn, broadcastEvent } from "./registry";
import { handle } from "./result-helpers";
import type { AgentSession, AgentLLMConfig, AgentToolContext } from "../lib/session-runtime-types";
import type { ChatRequest } from "../lib/tools";
import { buildAgentSystemPrompt } from "../lib/coding-session-prompt";
import { discoverSkills } from "../lib/skills";
import { normaliseBaseUrl } from "../lib/llm";
import type { DbContext } from "./handlers";
import * as q from "../db/queries";
import { ts } from "../db/utils";
import { getCachedConfig, cacheLlmConnection } from "../lib/config-cache";
import { resolveLlmApiKey } from "../lib/secure-store";
import { validateAttachmentDataUrl } from "../../shared/models/pdf-attach";
import { addWorkspaceApprovalGrant } from "../db/approval-grant-queries";
import { assertSafeId, isSafeId, resolveWithinRoot } from "./path-safety";
import fs from "node:fs";
import path from "node:path";
import { withToolCallView, withToolResultView } from "../cordis/run-cordis-loop";
import { getAgentHost } from "../cordis/agent-host";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { makeSessionProjection } from "../../shared/agent/session-projection";
import { selectSessionProfile, type SessionProfileId } from "../../shared/agent/session-profile";
import { runChatPrompt } from "./chat";
import { errMsg } from "../host-shared/errors";
import { isMode, modeFromAutoApprove, type Mode } from "../../shared/agent/approval-mode";
import { isShellTool } from "../../shared/agent/tool-risk";
import { runSession } from "./session-run";

// ── Session registry ──────────────────────────────────────────────────────────

const sessions = new Map<string, AgentSession>();
const clearingSessions = new Set<string>();

// ── Cordis engine wiring ────────────────────────────────────────────────────
// Per-turn pending resolvers for the dsh loop's HITL seams live in the Cordis
// engine (approval + question brokers) and are reached through AgentHost, so
// the (single) respond handlers can reach any session's turn regardless of
// which profile created the ask.

/**
 * Outstanding QUESTION asks (ask_questions / exit_plan_mode's plan-review),
 * so a reloading renderer can pull the question payload back via
 * session:is-running. The tool-approval registry (pending asks) only
 * records name/callId — questions need the full payload preserved so the
 * PlanReviewCard can re-render its plan-under-review after reload.
 */

/**
 * Per-ask random nonce so session:respond-tool must present proof it
 * received the original tool-confirm-required push. Without this, any
 * renderer-side script (a compromised web content, a UI plugin) could
 * call window.electron.session.respondTool(sid, cid, true) for a
 * callId it saw broadcast — approving every pending ask silently and
 * defeating the entire approval gate. Nonces are minted in main-side
 * when the ask is emitted, sent to the renderer in the confirm-required
 * event, and required on the respond-tool payload. Legacy
 * window.electron.piAgent alias is also covered.
 *
 * Store lives in the Cordis engine (approval runtime) behind AgentHost, so
 * chat.ts and this module mint/verify the same map without a circular import
 * (session-runtime-handlers ↔ chat).
 */

/** Drop every pending resolver + approval grant belonging to one session. */
function sweepSessionPendings(sessionId: string): void {
  getAgentHost().clearSessionApprovalState(sessionId);
  getAgentHost().clearApprovalState(sessionId);
  getAgentHost().clearSessionQuestions(sessionId);
  getAgentHost().forgetSessionApprovalArgs(sessionId);
  getAgentHost().unbindConfirmTransport(sessionId);
}

// ── Request shape ──────────────────────────────────────────────────────────────

interface AgentPromptRequest {
  sessionId: string;
  prompt: string;
  /** Required when creating a session; existing sessions use persisted metadata. */
  profile?: SessionProfileId;
  projectId?: string;
  workspaceId?: string;
  cwd: string;
  taskTitle?: string;
  mode?: "plan" | "execute";
  /** Image/PDF attachments staged in the input — serialized to content parts. */
  attachments?: Array<{ kind?: "image" | "pdf"; dataUrl: string; name?: string }>;
  history?: ChatRequest["history"];
  systemPrompt?: string;
  personality?: ChatRequest["personality"];
  approvalPolicy?: ChatRequest["approvalPolicy"];
  useSubagents?: boolean;
  config?: {
    provider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
    autoApprove?: boolean;
    mode?: Mode;
    isReasoningModel?: boolean;
    /** The agent's context-window size — drives the sliding-window pruner. */
    contextWindow?: number;
    /** Chat's legacy name for the same context limit. */
    contextLimit?: number;
    reasoningEffort?: "off" | "low" | "medium" | "high";
    apiMode?: "responses" | "completions" | "anthropic-messages";
  };
}

interface AgentApprovePlanRequest {
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
    mode?: Mode;
    isReasoningModel?: boolean;
    /** The agent's context-window size — drives the sliding-window pruner. */
    contextWindow?: number;
    reasoningEffort?: "off" | "low" | "medium" | "high";
    apiMode?: "responses" | "completions" | "anthropic-messages";
  };
}

// ── Registration ───────────────────────────────────────────────────────────────
export function registerSessionRuntimeHandlers(
  ctx: DbContext,
): void {
  // Read db/workspacePath from ctx at call-time so workspace reinitialise is transparent
  const getWin = ctx.getWin;

  // ── session:is-running ──────────────────────────────────────────────────
  // Invoke-style query so a (re)mounting AgentChatPane can restore its busy
  // state from the main process — the loop's lifecycle lives here, not in the
  // renderer's local state. Also returns the session's outstanding approval
  // asks so a reload that swallowed the original push can re-render the cards.
  //
  // Nonces are intentionally returned here for reload recovery — the renderer
  // lost the original push (and its nonce) on reload. Returning the nonce
  // does NOT bypass the gate: verifyAskNonce still requires the caller to
  // present the correct per-ask nonce for that callId, and a poll without a
  // prior push is useless without a valid callId. Nonces are cleared on
  // settle/sweep so this surface is only live while the ask is outstanding.
  registerContractHandle("session:is-running", (_event, { sessionId }) => handle(async () => {
     const running = getAgentHost().isTurnRunning(sessionId);
    return {
      running,
       pendingAsks: getAgentHost().listPendingApprovalAsks(sessionId),
      // Outstanding question asks (ask_questions / plan-review). The renderer
      // uses this to re-open a PlanReviewCard after a reload that swallowed
      // the original session:ask-questions push.
      pendingQuestions: getAgentHost().listPendingQuestions(sessionId).map((q) => ({
        callId: q.callId,
        questions: q.questions,
        nonce: getAgentHost().getApprovalNonce(sessionId, q.callId),
      })),
    };
  }));

  // ── session:running-ids ───────────────────────────────────────────────────
  // Bulk snapshot of every session whose loop is genuinely in flight right now.
  // Session-browser rows use this to show a live "active" state instead of the
  // persisted `running` metadata flag, which goes stale when a session is never
  // cleanly closed. Cheap: just materialises the in-memory Set.
  // Wrapped in handle() so a transient DB or runtime failure doesn't leave the
  // renderer's coalesced poller frozen on a stale "running" set (loop stays
  // green forever).
  registerContractHandle("session:running-ids", () => handle(async () => {
     return { ids: getAgentHost().getRunningTurnIds() };
  }));

  // ── session:context-ring ─────────────────────────────────────────────────
  // Reasoning-provenance snapshot ("whose thinking is in context") for the
  // agent panel's ring badge. Unavailable → renderer hides the pill.
  registerContractHandle("session:context-ring", (_event, { sessionId }) => handle(async () => {
    return getAgentHost().readContextRing(sessionId);
  }));

  // ── subagent:* — human continuable-child controls ───────────────────────
  // Model-side equivalents are send_message / interrupt_agent / list_agents;
  // these are the renderer-driven host path (catalog popover, per-trace
  // message/Stop). Errors surface as { ok:false, code } for toasts — the
  // stable control vocabulary (parent-unavailable, not-resumable,
  // unauthorized, delivery-unavailable, bad-request, cancelled, internal).
  const subagentResult = async <T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string; message: string }> => {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "internal";
      return { ok: false, code, message: err instanceof Error ? err.message : "subagent control failed" };
    }
  };
  registerContractHandle("subagent:list", (_event, { parentSessionId, scope }) => handle(async () => {
    const { normalizeSubagentScope } = await import("../cordis/subagent-control");
    return subagentResult(() => getAgentHost().listSubagentChildren(parentSessionId, normalizeSubagentScope(scope)));
  }));
  registerContractHandle("subagent:interrupt", (_event, { parentSessionId, childId }) => handle(async () => {
    return subagentResult(() => getAgentHost().interruptSubagentChild(parentSessionId, childId));
  }));
  registerContractHandle("subagent:message", (_event, { parentSessionId, childId, text }) => handle(async () => {
    return subagentResult(() => getAgentHost().messageSubagentChild(parentSessionId, childId, text));
  }));

  // ── session:job-kill ─────────────────────────────────────────────────────
  // Renderer-driven Kill for a dsh background job (jobs dock). Same
  // {ok:false, code} envelope as subagent:* (owner-unavailable when the owner
  // turn ended, not-owner on a cross-session stop, registry passthrough
  // otherwise). The requesting session id is mandatory — the bridge only
  // stops jobs the caller's dock would show (unowned, or its own).
  registerContractHandle("session:job-kill", (_event, { jobId, sessionId }) => handle(async () => {
    return subagentResult(() => Promise.resolve(getAgentHost().killJob(jobId, sessionId)));
  }));

  // ── session:goal ─────────────────────────────────────────────────────────
  // On-demand current-goal snapshot for the renderer goal chip (initial mount;
  // live changes arrive via session:projection kind:"goal" from goal-bridge).
  // Null goal = no current goal (pre-create / cleared) → chip hides. Same
  // {ok:true,value}|{ok:false,code,message} envelope as subagent:*.
  registerContractHandle("session:goal", (_event, { sessionId }) => handle(async () => {
    return subagentResult(() => getAgentHost().readGoalSnapshot(sessionId));
  }));

  // ── session:feedback{,-get} ─────────────────────────────────────────────
  // Per-message thumbs ratings + notes on assistant bubbles (dsh
  // message-feedback sidecar). Same {ok:true,value}|{ok:false,code,message}
  // envelope as subagent:*. The /feedback command needs no handler — it is an
  // ENTRY_LIST-mounted command and surfaces via cordis:listCommands.
  registerContractHandle("session:feedback", (_event, req) => handle(async () => {
    return subagentResult(() => getAgentHost().putMessageFeedback(req));
  }));
  registerContractHandle("session:feedback-get", (_event, req) => handle(async () => {
    return subagentResult(() => getAgentHost().getMessageFeedback(req.sessionId, req.messageId));
  }));

  // ── session:schedule-list ────────────────────────────────────────────────
  // On-demand active-reminder snapshot for the header alarm pill (polled on
  // header mount + turn end — no standing subscription). Empty list = overlay
  // off or no reminders → pill hides. Same envelope as subagent:*.
  registerContractHandle("session:schedule-list", (_event, req) => handle(async () => {
    return subagentResult(() => getAgentHost().listSchedules(req.sessionId));
  }));

  // ── session:abort ────────────────────────────────────────────────────────
  registerIpcOn("session:abort", (_event, { sessionId }: { sessionId: string }) => {
    getAgentHost().abortTurn(sessionId);
  });

  // ── session:prompt ───────────────────────────────────────────────────────
  registerIpcOn("session:prompt", async (event, req: AgentPromptRequest) => {
    try {
      assertSafeId(req.sessionId, "sessionId");
    } catch {
      broadcastEvent("session:projection", makeSessionProjection(String(req.sessionId ?? "unknown"), "error", { message: "Invalid session id.", code: "invalid-id" }));
      broadcastEvent("session:busy", { sessionId: String(req.sessionId ?? "unknown"), reason: "invalid-id" });
      return;
    }
    const storedProfile = q.getSessionProfile(ctx.db, req.sessionId)?.profile;
    const selected = selectSessionProfile(storedProfile, req.profile);
    if (!selected.profile) {
      broadcastEvent("session:projection", makeSessionProjection(req.sessionId, "error", { message: "Unknown session profile — cannot route prompt.", code: "unknown-profile" }));
      broadcastEvent("session:busy", { sessionId: req.sessionId, reason: "unknown-profile", message: "Unknown session profile — cannot route prompt." });
      return;
    }
    const profile = selected.profile;
    if (profile === "chat") {
      const chatReq = {
        message: req.prompt,
        threadId: req.sessionId.startsWith("chat-") ? req.sessionId.slice(5) : req.sessionId,
        projectId: req.projectId,
        workspaceId: req.workspaceId,
        images: req.attachments?.map((attachment) => ({ ...attachment, name: attachment.name ?? "attachment" })),
        history: req.history,
        systemPrompt: req.systemPrompt,
        personality: req.personality,
        approvalPolicy: req.approvalPolicy,
        useSubagents: req.useSubagents,
        config: req.config,
      };
      await runChatPrompt(ctx, event, chatReq);
      return;
    }
    const { sessionId, prompt, projectId, workspaceId, cwd, taskTitle, mode = "execute" } = req;

    const send = (channel: string, payload: unknown) => {
      if (channel === "session:projection") {
        broadcastEvent(channel, payload);
        return;
      }
      // Raw DSH events and typed projections are the parent lifecycle APIs.
      // Other session channels are reserved for commands/recovery transports.
      broadcastEvent(channel, payload);
    };

    // Reject a second prompt for a session whose loop is already running —
    // starting a new loop would replace session.abortCtrl mid-flight and leave
    // the is-running state inconsistent. The renderer queues prompts while busy,
    // so this is a defensive guard, not the normal path.
    if (getAgentHost().isTurnRunning(sessionId)) {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — already running.", code: "already-running" }));
      broadcastEvent("session:busy", { sessionId, reason: "already-running" });
      return;
    }

    // Runtime-validate staged attachments BEFORE they are persisted into the
    // session or turned into content parts — a malformed/oversized data URL must
    // never reach the provider (or the transcript).
    if (req.attachments?.length) {
      for (const a of req.attachments) {
        const problem = validateAttachmentDataUrl(a?.dataUrl);
        if (problem) {
          broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: problem, code: "invalid-attachment" }));
          broadcastEvent("session:busy", { sessionId, reason: "invalid-attachment", message: problem });
          return;
        }
      }
    }

    if (req.config?.provider === "localllm") {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Local LLM provider is disabled.", code: "localllm-disabled" }));
      broadcastEvent("session:busy", { sessionId, reason: "localllm-disabled", message: "Local LLM provider is disabled." });
      return;
    }

    // Cache the connection + behavioural fields (apiKey scrubbed to a ref-or-clear
    // by the cache layer, never a raw key). Mode + autoApprove are co-persisted
    // so old renderers reading `autoApprove` and new code reading `mode` stay aligned.
    cacheLlmConnection("agent", {
      baseUrl: req.config?.baseUrl,
      model: req.config?.model,
      apiKey: req.config?.apiKey,
      maxSteps: req.config?.maxSteps,
      temperature: req.config?.temperature,
      maxTokens: req.config?.maxTokens,
      autoApprove: req.config?.autoApprove,
      mode: (req.config as { mode?: Mode })?.mode,
    } as never);

    let reqConfig = req.config;
    const cached = getCachedConfig().agentConfig;
    if (!reqConfig?.apiKey && cached?.apiKey) {
      reqConfig = {
        ...reqConfig,
        baseUrl: reqConfig?.baseUrl || cached.baseUrl,
        model: reqConfig?.model || cached.model,
        apiKey: cached.apiKey,
        maxSteps: reqConfig?.maxSteps || cached.maxSteps,
        // Temperature is renderer-authoritative (it resolves the capability gate
        // and the plan-mode override). Never fall back to a cached 0.3: an
        // explicit 0 must survive, and unset/unsupported must stay omitted.
        temperature: reqConfig?.temperature,
        maxTokens: reqConfig?.maxTokens ?? (cached as { maxTokens?: number }).maxTokens,
        autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : cached.autoApprove,
        mode: (reqConfig as { mode?: Mode })?.mode ?? (cached as { mode?: Mode })?.mode,
      } as typeof reqConfig;
    } else if (cached) {
      reqConfig = {
        ...reqConfig,
        autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : cached.autoApprove,
        mode: (reqConfig as { mode?: Mode })?.mode ?? (cached as { mode?: Mode })?.mode,
      } as typeof reqConfig;
    }

    const _reqMode = (reqConfig as { mode?: unknown })?.mode;
    const _reqModeValid = typeof _reqMode === "string" && isMode(_reqMode as Mode) ? _reqMode as Mode : undefined;
    const _cachedMode = (cached as { mode?: unknown })?.mode;
    const _cachedModeValid = typeof _cachedMode === "string" && isMode(_cachedMode as Mode) ? _cachedMode as Mode : undefined;
    // Resolve Mode from explicit mode, then legacy autoApprove, then cached mode, then default.
    const resolvedMode: Mode = _reqModeValid
      ?? (typeof reqConfig?.autoApprove === "boolean" ? modeFromAutoApprove(reqConfig.autoApprove) : undefined)
      ?? _cachedModeValid
      ?? (typeof cached?.autoApprove === "boolean" ? modeFromAutoApprove(cached.autoApprove) : undefined)
      ?? "interactive";
    const llmConfig: AgentLLMConfig = {
      baseUrl:     normaliseBaseUrl(reqConfig?.baseUrl || "https://api.openai.com"),
      model:       reqConfig?.model       || "gpt-5.6-luna",
      apiKey:      resolveLlmApiKey(reqConfig?.apiKey),
      maxSteps:    reqConfig?.maxSteps    ?? 20,
      // The renderer resolved the effective temperature (capability-gated;
      // undefined = omit → vendor default).
      temperature: reqConfig?.temperature,
      maxTokens:   reqConfig?.maxTokens,
      autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : _cachedModeValid ? _cachedModeValid === "auto" : cached?.autoApprove !== undefined ? cached.autoApprove : false,
      mode: resolvedMode,
      isReasoningModel: reqConfig?.isReasoningModel,
      // No provider coercion: a custom local endpoint (Ollama, LM Studio,
      // user-run llama.cpp) keeps its own baseUrl and plain "openai" shape.
      provider: reqConfig?.provider,
      contextWindow: reqConfig?.contextWindow,
      reasoningEffort: reqConfig?.reasoningEffort,
      apiMode: reqConfig?.apiMode,
    };

    let session = sessions.get(sessionId);
    if (!session) {
      session = { abortCtrl: new AbortController() };
      sessions.set(sessionId, session);
    } else {
      session.abortCtrl = new AbortController();
    }

    const projectName = projectId
      ? (ctx.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? "Project"
      : "Project";

    const sessionRow = q.getCodingSessionById(ctx.db, sessionId);
    const planNoteId = sessionRow?.planNoteId;
    // Plan carried into execute-mode's system prompt: prefer the plan text
    // captured when the model called dsh-plan-mode's `exit_plan_mode`
    // (session_row.plan_content), fall back to the legacy PRD-note lookup
    // for sessions that predate the dsh flow or that used ensure_note only.
    const planContent = sessionRow?.planContent?.trim()
      ? sessionRow.planContent
      : planNoteId
        ? (ctx.db.prepare("SELECT content FROM notes WHERE id = ?").get(planNoteId) as { content: string } | undefined)?.content ?? ""
        : undefined;

    // Session persona (persisted on the row) — "automation-dev" restricts the
    // toolset to file tools so a Develop session can't touch notes/tasks.
    // Validated: an unknown persisted value fails closed to the restricted
    // persona rather than the unrestricted default.
    const role = q.normalizeSessionRole(sessionRow?.role);
    session.role = role;

    const skills = discoverSkills(cwd);
    const systemPrompt = buildAgentSystemPrompt({
      projectName, cwd, taskTitle, workspaceId, projectId, mode, planContent,
       role,
    });

    const toolCtx: AgentToolContext = {
      cwd, db: ctx.db, workspacePath: ctx.workspacePath, sessionId, send, getWin, skills,
      req: { message: prompt, threadId: sessionId, projectId, workspaceId,
             config: { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey } },
    };

    await runSession(session, systemPrompt, llmConfig, mode, toolCtx, ctx, send, {
      message: prompt,
      images: req.attachments,
      projectId,
      workspaceId,
      autoApprove: llmConfig.autoApprove,
      mode: llmConfig.mode,
      // Confine fs mutations to cwd for every coding session. automation-dev
      // has its own persona-scoped tool filter (see role below) that removes
      // bash + Cairn data tools, restoring the pre-Cordis AUTOMATION_DEV_TOOLS
      // restriction — the fs sandbox stays workspace-write so the persona can
      // still edit its scripts.
      sandboxMode: "workspace-write",
       role,
       onSessionEvent: (sessionEvent: SessionEvent) => broadcastEvent("session:event", { sessionId, event: withToolResultView(withToolCallView(sessionEvent)) }),
    });
  });

  // ── session:approve-plan ─────────────────────────────────────────────────
  // Renderer fires this when the user clicks "Approve Plan". Fetches the PRD
  // note, injects the approval message, then continues in execute mode.
  registerIpcOn("session:approve-plan", async (_event, req: AgentApprovePlanRequest) => {
    try {
      assertSafeId(req.sessionId, "sessionId");
    } catch {
      broadcastEvent("session:projection", makeSessionProjection(String(req.sessionId ?? "unknown"), "error", { message: "Invalid session id.", code: "invalid-id" }));
      broadcastEvent("session:busy", { sessionId: String(req.sessionId ?? "unknown"), reason: "invalid-id" });
      return;
    }
    const { sessionId, planNoteId, projectId, workspaceId, cwd, taskTitle } = req;

    const send = (channel: string, payload: unknown) => {
      broadcastEvent(channel, payload);
    };

    // Same concurrency guard as session:prompt — a plan approval is also a
    // loop run and must never stack on an in-flight loop for this session.
    if (getAgentHost().isTurnRunning(sessionId)) {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — already running.", code: "already-running" }));
      broadcastEvent("session:busy", { sessionId, reason: "already-running" });
      return;
    }

    if (req.config?.provider === "localllm") {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Local LLM provider is disabled.", code: "localllm-disabled" }));
      broadcastEvent("session:busy", { sessionId, reason: "localllm-disabled", message: "Local LLM provider is disabled." });
      return;
    }

    // Cache the connection + behavioural fields (apiKey scrubbed to a ref-or-clear
    // by the cache layer, never a raw key). Mode + autoApprove are co-persisted.
    cacheLlmConnection("agent", {
      baseUrl: req.config?.baseUrl,
      model: req.config?.model,
      apiKey: req.config?.apiKey,
      maxSteps: req.config?.maxSteps,
      temperature: req.config?.temperature,
      maxTokens: req.config?.maxTokens,
      autoApprove: req.config?.autoApprove,
      mode: (req.config as { mode?: Mode })?.mode,
    } as never);

    let reqConfig = req.config;
    const cached = getCachedConfig().agentConfig;
    if (!reqConfig?.apiKey && cached?.apiKey) {
      reqConfig = {
        ...reqConfig,
        baseUrl: reqConfig?.baseUrl || cached.baseUrl,
        model: reqConfig?.model || cached.model,
        apiKey: cached.apiKey,
        maxSteps: reqConfig?.maxSteps || cached.maxSteps,
        // Temperature is renderer-authoritative (it resolves the capability gate
        // and the plan-mode override). Never fall back to a cached 0.3: an
        // explicit 0 must survive, and unset/unsupported must stay omitted.
        temperature: reqConfig?.temperature,
        maxTokens: reqConfig?.maxTokens ?? (cached as { maxTokens?: number }).maxTokens,
        autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : cached.autoApprove,
        mode: (reqConfig as { mode?: Mode })?.mode ?? (cached as { mode?: Mode })?.mode,
      } as typeof reqConfig;
    } else if (cached) {
      reqConfig = {
        ...reqConfig,
        autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : cached.autoApprove,
        mode: (reqConfig as { mode?: Mode })?.mode ?? (cached as { mode?: Mode })?.mode,
      } as typeof reqConfig;
    }

    const _reqMode2 = (reqConfig as { mode?: unknown })?.mode;
    const _reqModeValid2 = typeof _reqMode2 === "string" && isMode(_reqMode2 as Mode) ? _reqMode2 as Mode : undefined;
    const _cachedMode2 = (cached as { mode?: unknown })?.mode;
    const _cachedModeValid2 = typeof _cachedMode2 === "string" && isMode(_cachedMode2 as Mode) ? _cachedMode2 as Mode : undefined;
    const resolvedMode2: Mode = _reqModeValid2
      ?? (typeof reqConfig?.autoApprove === "boolean" ? modeFromAutoApprove(reqConfig.autoApprove) : undefined)
      ?? _cachedModeValid2
      ?? (typeof cached?.autoApprove === "boolean" ? modeFromAutoApprove(cached.autoApprove) : undefined)
      ?? "interactive";
    const llmConfig: AgentLLMConfig = {
      baseUrl:     normaliseBaseUrl(reqConfig?.baseUrl || "https://api.openai.com"),
      model:       reqConfig?.model       || "gpt-5.6-luna",
      apiKey:      resolveLlmApiKey(reqConfig?.apiKey),
      maxSteps:    reqConfig?.maxSteps    ?? 20,
      // The renderer resolved the effective temperature (capability-gated;
      // undefined = omit → vendor default).
      temperature: reqConfig?.temperature,
      maxTokens:   reqConfig?.maxTokens,
      autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : _cachedModeValid2 ? _cachedModeValid2 === "auto" : cached?.autoApprove !== undefined ? cached.autoApprove : false,
      mode: resolvedMode2,
      isReasoningModel: reqConfig?.isReasoningModel,
      // Same no-coercion rule as session:prompt (see above).
      provider: reqConfig?.provider,
      contextWindow: reqConfig?.contextWindow,
      reasoningEffort: reqConfig?.reasoningEffort,
      apiMode: reqConfig?.apiMode,
    };

    let session = sessions.get(sessionId);
    if (!session) {
      session = { abortCtrl: new AbortController() };
      sessions.set(sessionId, session);
    } else {
      session.abortCtrl = new AbortController();
    }

    const planContent = (ctx.db.prepare("SELECT content FROM notes WHERE id = ?").get(planNoteId) as { content: string } | undefined)?.content ?? "";

    send("session:mode-change", { sessionId, mode: "execute", planNoteId });
    const projectName = projectId
      ? (ctx.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? "Project"
      : "Project";

    // Restore the persisted persona for this session (e.g. "automation-dev" for
    // a Develop session) so plan approval can't silently broaden its toolset.
    const sessionRow = q.getCodingSessionById(ctx.db, sessionId);
    const role = q.normalizeSessionRole(sessionRow?.role);
    session.role = role;

    const skills = discoverSkills(cwd);
    const systemPrompt = buildAgentSystemPrompt({ projectName, cwd, taskTitle, workspaceId, projectId, mode: "execute", planContent, role });

    const toolCtx: AgentToolContext = {
      cwd, db: ctx.db, workspacePath: ctx.workspacePath, sessionId, send, getWin, skills,
      req: { message: "", threadId: sessionId, projectId, workspaceId,
             config: { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey } },
    };

    await runSession(session, systemPrompt, llmConfig, "execute", toolCtx, ctx, send, {
      message: `The plan has been approved. Begin implementation now, following the approved PRD exactly. The PRD note ID is ${planNoteId} — you can re-read it via get_note if needed.`,
      projectId,
      workspaceId,
      autoApprove: llmConfig.autoApprove,
      mode: llmConfig.mode,
      sandboxMode: "workspace-write",
      role,
      // Raw-event broadcast (same as the session:prompt path): without this,
      // live deltas forwarded via onSessionEvent never reach the renderer on
      // post-approval turns.
      onSessionEvent: (sessionEvent: SessionEvent) => broadcastEvent("session:event", { sessionId, event: withToolResultView(withToolCallView(sessionEvent)) }),
    });
  });

  // ── session:compact-now ─────────────────────────────────────────────────
  // Triggered by the /compact slash command. Auto-compaction (BasicCompactionEngine,
  // thresholdRatio 0.8) runs between steps automatically; this is the explicit
  // user-triggered variant. It opens the session's agent from its persisted jsonl
  // (idle), runs ctx.compaction.compactNow(agent), then disposes it.
  registerIpcOn("session:compact-now", async (_event, req: { sessionId: string; config?: { baseUrl?: string; model?: string; apiKey?: string; contextWindow?: number; apiMode?: "responses" | "completions" | "anthropic-messages" } }) => {
    try {
      assertSafeId(req.sessionId, "sessionId");
    } catch {
      broadcastEvent("session:projection", makeSessionProjection(String(req.sessionId ?? "unknown"), "error", { message: "Invalid session id.", code: "invalid-id" }));
      broadcastEvent("session:busy", { sessionId: String(req.sessionId ?? "unknown"), reason: "invalid-id" });
      return;
    }
    const { sessionId } = req;
    const send = (channel: string, payload: unknown) => {
      broadcastEvent(channel, payload);
    };
    if (getAgentHost().isTurnRunning(sessionId)) {
      send("session:compact-result", { sessionId, messageCount: 0, summary: "Can't compact while the agent is working — try again when it finishes." });
      return;
    }
    const sessionRow = q.getCodingSessionById(ctx.db, sessionId) as { cwd?: string } | undefined;
    const cwd = sessionRow?.cwd ?? "/";
    const llmConfig: AgentLLMConfig = {
      baseUrl: normaliseBaseUrl(req.config?.baseUrl || "https://api.openai.com"),
      model: req.config?.model || "gpt-5.6-luna",
      apiKey: resolveLlmApiKey(req.config?.apiKey),
      maxSteps: 20,
      temperature: 0.1,
      contextWindow: req.config?.contextWindow,
      apiMode: req.config?.apiMode,
    };
    send("session:compact", { sessionId, status: "start" });
    try {
      const result = await getAgentHost().compactSession({
        sessionId,
        cwd,
        baseUrl: llmConfig.baseUrl,
        model: llmConfig.model,
        apiKey: llmConfig.apiKey,
        apiMode: llmConfig.apiMode,
      });
      if (result) {
        send("session:compact-result", { sessionId, ...result });
      } else {
        send("session:compact-result", { sessionId, messageCount: 0, summary: "Nothing to compact." });
      }
    } catch (e) {
      send("session:compact-result", { sessionId, messageCount: 0, summary: `Compaction unavailable: ${(e as Error).message}` });
    } finally {
      send("session:compact", { sessionId, status: "end" });
    }
  });

  // ── session:set-mode ─────────────────────────────────────────────────────
  // Plan mode is dsh-owned. The toggle executes dsh's /plan command through
  // ctx.commands on a short-lived resumed agent. The session log is the source
  // of truth; SQLite is updated only after a successful command and a committed
  // plan/mode event have been observed.
  registerIpcOn("session:set-mode", (_event, { sessionId, mode }: { sessionId: string; mode: "plan" | "execute" }) => {
    try {
      assertSafeId(sessionId, "sessionId");
    } catch {
      broadcastEvent("session:projection", makeSessionProjection(String(sessionId ?? "unknown"), "error", { message: "Invalid session id.", code: "invalid-id" }));
      broadcastEvent("session:busy", { sessionId: String(sessionId ?? "unknown"), reason: "invalid-id" });
      return;
    }
    if (getAgentHost().isTurnRunning(sessionId)) {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — cannot toggle plan mode while running.", code: "already-running" }));
      broadcastEvent("session:busy", { sessionId, reason: "already-running" });
      return;
    }
    void (async () => {
      try {
        const agentConfig = getCachedConfig().agentConfig;
        const committedMode = await getAgentHost().setSessionMode({
          sessionId,
          cwd: ctx.workspacePath || process.cwd(),
          baseUrl: agentConfig?.baseUrl ?? "",
          model: agentConfig?.model ?? "",
          apiKey: agentConfig?.apiKey ?? "",
          mode,
        });
        try {
          q.updateCodingSession(ctx.db, sessionId, { mode: committedMode, updatedAt: ts() });
        } catch (e) {
          console.warn("[session] failed to update session mode index:", e);
        }
        broadcastEvent("session:mode-change", { sessionId, mode: committedMode });
        broadcastEvent("session:projection", makeSessionProjection(sessionId, "mode-change", { mode: committedMode }));
      } catch (e) {
        // Do not update or broadcast a requested mode when dsh rejected it.
        // The durable session log remains authoritative and the UI can retry.
        const msg = errMsg(e);
        if (msg.includes("while it is live") || msg.includes("already-running")) {
          broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — try again when the agent finishes.", code: "already-running" }));
          broadcastEvent("session:busy", { sessionId, reason: "already-running" });
        } else {
          broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: msg, code: "plan-toggle-failed" }));
        }
        console.warn("[session] /plan execution failed:", msg);
      }
    })();
  });

  // ── session:respond-tool ──────────────────────────────────────────────────
  // Resolve the Cordis loop's approval adapter (keyed `${sessionId}::${callId}`).
  // grant:"command" records the exact canonicalized bash command in the
  // session's durable grants — using the TRUSTED args recorded at
  // tools/pre-execute time (main-side), NOT the renderer's echo. A compromised
  // renderer / UI plugin can send anything in `command`; the actual command
  // dsh will execute is what we stashed via recordPendingApprovalArgs. If the
  // two disagree (or the renderer's command is absent), the grant is a no-op:
  // fail-closed on the record path.
  registerIpcOn("session:respond-tool", (_event, { sessionId, callId, approved, grant, nonce }: { sessionId: string; callId: string; approved: boolean; grant?: "session" | "command" | "workspace"; command?: string; nonce?: string }) => {
    try {
      assertSafeId(sessionId, "sessionId");
      assertSafeId(callId, "callId");
    } catch {
      console.warn(`[session] respond-tool rejected: invalid id for ${String(sessionId)}/${String(callId)}`);
      return;
    }
    // Require the per-ask nonce — a compromised renderer (XSS from a
    // rendered note, an installed UI plugin) that only saw the callId
    // broadcast on session:tool-confirm-required must NOT be able to
    // auto-approve every ask. The nonce is minted main-side and returned
    // in the confirm-required event; only a legitimate consumer of that
    // event has it. Fail-closed on absence / mismatch.
    if (!getAgentHost().verifyApprovalNonce(sessionId, callId, nonce)) {
      console.warn(`[session] respond-tool rejected: bad or missing nonce for ${sessionId}/${callId}`);
      return;
    }
     const pendingMetaForGrant = getAgentHost().listPendingApprovalAsks(sessionId).find((m) => m.callId === callId);
     // Sandbox escalations are one-shot: drop any renderer-supplied grant.
     const effectiveGrant = pendingMetaForGrant?.escalation ? undefined : grant;
     const resolved = getAgentHost().resolvePendingApproval(sessionId, callId, { approved, grant: approved ? effectiveGrant : undefined });
     if (!resolved) return;
     getAgentHost().resolvePendingApprovalAsk(sessionId, callId);
    getAgentHost().dropApprovalNonce(sessionId, callId);
    if (approved && effectiveGrant === "command") {
      // Read the trusted command from the pre-execute stash — the renderer's
      // command field is ignored (parameter kept in the type signature only
      // so old renderers don't get a payload-validation error at the IPC
      // boundary; it's intentionally unused). grantSessionBash canonicalizes,
      // so a cosmetic mismatch still matches the grant.
      const cmd = getAgentHost().readTrustedBashCommand(sessionId, callId);
       if (cmd) getAgentHost().grantSessionBash(sessionId, cmd);
    }
    if (approved && effectiveGrant === "workspace") {
      // Persistent workspace grant — survives across sessions. The tool name is
      // stashed in the pending-ask registry main-side, so a compromised
      // renderer can't grant a different tool than the one that was asked.
      const toolName = pendingMetaForGrant?.name;
      if (toolName) {
        try {
          // WorkspaceId is durable per session; resolve it from session_profiles
          // first (chat+coding), then fall back to the chat-thread row (pre-v53
          // threads) — whatever is available for this sessionId's workspace.
          const wsRow =
            (ctx.db.prepare("SELECT workspace_id FROM session_profiles WHERE session_id = ?").get(sessionId) as { workspace_id?: string } | undefined)?.workspace_id
            ?? (sessionId.startsWith("chat-") ? (ctx.db.prepare("SELECT workspace_id FROM chat_threads WHERE id = ?").get(sessionId.slice(5)) as { workspace_id?: string } | undefined)?.workspace_id : undefined);
          const workspaceId = wsRow ?? undefined;
          if (workspaceId) {
            const commandScoped = isShellTool(toolName);
            const target = commandScoped ? getAgentHost().readTrustedBashCommand(sessionId, callId) : null;
            const grantRec = addWorkspaceApprovalGrant(ctx.db, workspaceId, toolName, target);
            // Also grant this session immediately so the current turn proceeds
            // without needing to re-read the DB before the next ask.
            if (grantRec) {
               if (commandScoped) { if (target) getAgentHost().grantSessionBash(sessionId, target); }
               else getAgentHost().grantSessionTool(sessionId, toolName);
            }
          }
        } catch (e) {
          console.warn(`[session] workspace grant persist failed for ${sessionId}/${callId}:`, (e as Error)?.message ?? e);
        }
      }
    }
  });

  // ── session:respond-questions ─────────────────────────────────────────────
  // Answers to a blocked ask_questions call. The formatted answer text is fed
  // back to the model as the tool result so it reasons over the answers in the
  // same turn. Cordis keys by requestId (which the renderer echoes as callId).
  registerIpcOn("session:respond-questions", (_event, { sessionId, callId, answers, nonce }: { sessionId: string; callId: string; answers: string; nonce?: string }) => {
    try {
      assertSafeId(sessionId, "sessionId");
      assertSafeId(callId, "callId");
    } catch {
      console.warn(`[session] respond-questions rejected: invalid id for ${String(sessionId)}/${String(callId)}`);
      return;
    }
    if (!getAgentHost().verifyApprovalNonce(sessionId, callId, nonce)) {
      console.warn(`[session] respond-questions rejected: bad or missing nonce for ${sessionId}/${callId}`);
      return;
    }
    if (!getAgentHost().respondToQuestion(sessionId, callId, answers)) {
      // The tool is no longer waiting (timed out, aborted, or already
      // settled) — the answer has nowhere to go. Warn loudly: a silent drop
      // here strands the user with a submitted form and a hung turn.
      console.warn(`[session] respond-questions dropped: no pending question for ${sessionId}/${callId}`);
      return;
    }
    getAgentHost().dropApprovalNonce(sessionId, callId);
    // Drop the recovery registry entry: whether the user answered normally
    // or dismissed via { __dismissed__: true }, the ask has settled and a
    // subsequent is-running poll must NOT re-surface it.
  });

  // ── session:clear ────────────────────────────────────────────────────────
  // Clears a session's message history (new conversation within same session).
  // Also resets the compaction transformer so the new conversation starts
  // with a fresh cachedSummary.
  registerIpcOn("session:clear", (_event, { sessionId }: { sessionId: string }) => {
    // Reject renderer-supplied ids that could path-traverse before they reach
    // fs.rmSync() below. Any legitimate session id (pi-<nanoid>, subagent uuid)
    // passes; `..`, `/`, `\`, empty, over-length, control chars all fail here.
    try {
      assertSafeId(sessionId, "sessionId");
    } catch (_err) {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Invalid session id.", code: "invalid-id" }));
      broadcastEvent("session:busy", { sessionId, reason: "invalid-id" });
      return;
    }
    // Clearing the persisted log while a loop is running would desync its
    // in-flight context. The renderer stops the run before clearing, so this is
    // defensive. Clear is rejected if running or already clearing (atomic gate).
    if (getAgentHost().isTurnRunning(sessionId) || clearingSessions.has(sessionId)) {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — cannot clear while running.", code: "already-running" }));
      broadcastEvent("session:busy", { sessionId, reason: "already-running" });
      return;
    }
    clearingSessions.add(sessionId);
    try {
      // TOCTOU re-check: re-validate runningLoops after assertSafeId and immediately
      // before the destructive sweep/file deletion. A concurrent prompt could have
      // started between the first guard and now; clear is rejected if still running.
      if (getAgentHost().isTurnRunning(sessionId)) {
        broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — cannot clear while running.", code: "already-running" }));
        broadcastEvent("session:busy", { sessionId, reason: "already-running" });
        return;
      }
      // The Cordis JSONL session is the transcript source of truth. The in-memory
      // session entry only retains the abort controller and persona.
      // Grants + any stray pendings die with the conversation.
      sweepSessionPendings(sessionId);
      // Explicit session clearing wipes persisted todos too (the todowrite
      // replacement contract otherwise leaves them until the next write).
      q.saveSessionTodos(ctx.db, sessionId, []);
      // Clear the dsh jsonl transcript so a resumed session doesn't see old
      // messages. The transcript lives in <userData>/sessions/<sessionId>.jsonl
      // via dsh-session-persistence-jsonl. Best-effort: delete the file/dir if it exists.
      try {
        const primaryRoot = getAgentHost().getSessionRoot();
        const fallbackRoot = path.join(process.cwd(), ".cairn-sessions");
        const roots = [primaryRoot, fallbackRoot].filter((r, i, a) => r && a.indexOf(r) === i);
        let deleted = false;
        for (const root of roots) {
          // dsh nests as <root>/<encoded-cwd>/<sessionId>/session.jsonl.zstd — brute-force
          // every project dir and check the session id inside it, plus the flat fallbacks.
          // The sessionId was assertSafeId-validated above; every path composed here
          // is additionally containment-checked via resolveWithinRoot as
          // defence-in-depth against future refactors of `roots`.
          try {
            const projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d: { isDirectory: () => boolean }) => d.isDirectory()).map((d: { name: string }) => d.name);
            for (const proj of projectDirs) {
              if (!isSafeId(proj) || !isSafeId(sessionId)) continue;
              const base = resolveWithinRoot(root, proj, sessionId);
              if (!base) continue;
              for (const p of [path.join(base, "session.jsonl.zstd"), path.join(base, "session.jsonl"), base + ".jsonl", path.join(base, "session.jsonl"), base]) {
                if (getAgentHost().isTurnRunning(sessionId)) {
                  broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — cannot clear while running.", code: "already-running" }));
                  broadcastEvent("session:busy", { sessionId, reason: "already-running" });
                  return;
                }
                try {
                  if (fs.existsSync(p)) {
                    const stat = fs.statSync(p);
                    if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
                    else fs.unlinkSync(p);
                    deleted = true;
                  }
                } catch { /* ignore */ }
              }
            }
          } catch { /* root not readable */ }
          // Flat fallbacks (old layout or if projectDir is _no-cwd)
          const flatBase = resolveWithinRoot(root, sessionId);
          if (!flatBase) continue;
          for (const p of [flatBase + ".jsonl", path.join(flatBase, "session.jsonl"), path.join(flatBase, "session.jsonl.zstd"), flatBase]) {
            if (getAgentHost().isTurnRunning(sessionId)) {
              broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — cannot clear while running.", code: "already-running" }));
              broadcastEvent("session:busy", { sessionId, reason: "already-running" });
              return;
            }
            try {
              if (fs.existsSync(p)) {
                const stat = fs.statSync(p);
                if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
                else fs.unlinkSync(p);
                deleted = true;
              }
            } catch { /* ignore */ }
          }
        }
        if (!deleted) {
          // No dsh file found — not an error, the session may have been in-memory only or already cleared.
        }
        void getAgentHost().releaseSessionAgent(sessionId);
      } catch { /* best-effort */ }
    } finally {
      clearingSessions.delete(sessionId);
    }
  });

  // ── session:destroy ──────────────────────────────────────────────────────
  // Called when a coding session tab is closed — frees memory
  registerIpcOn("session:destroy", (_event, { sessionId }: { sessionId: string }) => {
    try {
      assertSafeId(sessionId, "sessionId");
    } catch (_err) {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Invalid session id.", code: "invalid-id" }));
      broadcastEvent("session:busy", { sessionId, reason: "invalid-id" });
      return;
    }
    if (clearingSessions.has(sessionId)) {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — cannot destroy while clearing.", code: "already-running" }));
      broadcastEvent("session:busy", { sessionId, reason: "already-running" });
      return;
    }
    const session = sessions.get(sessionId);
    if (session) {
      getAgentHost().abortTurn(sessionId);
      sessions.delete(sessionId);
    }
    // The abort listeners inside the plugins resolve their own pendings on
    // abort; sweep whatever remains (e.g. an ask whose listeners were torn
    // down abnormally) so nothing leaks across sessions.
    sweepSessionPendings(sessionId);
  });

  // ── approval grants (workspace-persistent "Always allow") ─────────────────
  // Device-local, not synced: a trust decision on this machine must not
  // silently apply on another. One row per (workspace, tool, target) — target
  // is the exact command for "bash"/"pwsh", otherwise null (whole tool).
  registerIpcHandle("approval-grants:list", (_event, { workspaceId }: { workspaceId: string }) =>
    handle(async () => {
      assertSafeId(workspaceId, "workspaceId");
      const { getWorkspaceApprovalGrants } = await import("../db/approval-grant-queries");
      return getWorkspaceApprovalGrants(ctx.db, workspaceId);
    }),
  );
  registerIpcHandle("approval-grants:delete", (_event, { id }: { id: string }) =>
    handle(async () => {
      assertSafeId(id, "id");
      const { deleteWorkspaceApprovalGrant } = await import("../db/approval-grant-queries");
      return { deleted: deleteWorkspaceApprovalGrant(ctx.db, id) };
    }),
  );
  registerIpcHandle("approval-grants:clear-workspace", (_event, { workspaceId }: { workspaceId: string }) =>
    handle(async () => {
      assertSafeId(workspaceId, "workspaceId");
      const { clearWorkspaceApprovalGrants } = await import("../db/approval-grant-queries");
      return { deleted: clearWorkspaceApprovalGrants(ctx.db, workspaceId) };
    }),
  );

  // ── session:restore-context ───────────────────────────────────────────────────────
  // On the Cordis engine, session context resumes automatically via the dsh
  // jsonl log (ctx.sessionPersistence.inspect → ctx.agents.resume in
  // run-cordis-coding.ts) — there is no pi_agent_llm_history on this path.
  // This handler just restores the persisted session persona so a re-prompt
  // keeps the session's tool restrictions (validated, failing closed).
  registerIpcOn("session:restore-context", (_event, { sessionId }: { sessionId: string }) => {
    try {
      assertSafeId(sessionId, "sessionId");
    } catch {
      broadcastEvent("session:projection", makeSessionProjection(String(sessionId ?? "unknown"), "error", { message: "Invalid session id.", code: "invalid-id" }));
      broadcastEvent("session:busy", { sessionId: String(sessionId ?? "unknown"), reason: "invalid-id" });
      return;
    }
    if (sessions.has(sessionId)) return; // already in memory
    try {
      const sessionRow = q.getCodingSessionById(ctx.db, sessionId);
      sessions.set(sessionId, {
        abortCtrl: new AbortController(),
        role: q.normalizeSessionRole(sessionRow?.role),
      });
    } catch (e) {
      console.warn("[session] restore-context failed for", sessionId, e);
    }
  });
}
