/**
 * Cairn coding session runtime — IPC handlers
 *
 * Registers session command and projection channels over the agent engine.
 *
 * Channels (fire-and-forget, renderer → main):
 *   session:prompt  { sessionId, prompt, projectId, cwd, taskTitle?, config }
 *   session:abort   { sessionId }
 *
 * Events (main → renderer): session:projection (typed presentation updates).
 */

import { registerContractHandle, registerIpcOn, broadcastEvent } from "./registry";
import { handle } from "./result-helpers";
import type { AgentSession, AgentLLMConfig } from "../lib/session-runtime-types";
import type { ChatRequest } from "../lib/tools";
import { buildAgentSystemPrompt } from "../lib/coding-session-prompt";
import { normaliseBaseUrl } from "../lib/llm";
import type { DbContext } from "./handlers";
import * as q from "../db/queries";
import { ts } from "../db/utils";
import { getCachedConfig, cacheLlmConnection } from "../lib/config-cache";
import { resolveLlmApiKey } from "../lib/secure-store";
import { validateAttachmentDataUrl } from "../../shared/models/pdf-attach";
import { assertSafeId } from "./path-safety";
import { makeSessionProjection } from "../../shared/agent/session-projection";
import { selectSessionProfile, type SessionProfileId } from "../../shared/agent/session-profile";
import { agentFallback, isMobileCaller, sanitizeMobileRequest } from "./mobile-caller";
import { errMsg } from "../host-shared/errors";
import { isMode, modeFromAutoApprove, type Mode } from "../../shared/agent/approval-mode";
import { answerQuestion, cancelQuestions, compactEngineSession, listPendingQuestions, engineOwns, forgetEngineSession, removeLegacySessions, getEngineHost, getJobRegistry, listEngineSchedules, readEngineGoal, interruptEngineSubagent, listEngineSubagents, messageEngineSubagent, runEngineChat, runEnginePrompt } from "./engine-bridge";

// ── Session registry ──────────────────────────────────────────────────────────

const sessions = new Map<string, AgentSession>();
const clearingSessions = new Set<string>();

/** A phone asked to run a coding session that has no stored working directory. */
function rejectMobileRequest(sessionId: string): void {
  const message = "This session can't be started from Mobile Access. Start it on the desktop first.";
  broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message, code: "mobile-refused" }));
  broadcastEvent("session:busy", { sessionId, reason: "mobile-refused", message });
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
    const engine = getEngineHost(ctx);
    const engineAsks = engine.pendingAsks(sessionId).map((a) => ({ sessionId, name: a.tool, label: a.title, callId: a.callId, nonce: a.nonce, reason: a.reason }));
    return {
      running: engine.isRunning(sessionId),
      pendingAsks: engineAsks,
      // Outstanding question asks (ask_questions / plan-review), so a reload can re-open a PlanReviewCard.
      pendingQuestions: listPendingQuestions(sessionId),
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
     return { ids: [...new Set(getEngineHost(ctx).runningIds())] };
  }));

  // ── session:context-ring ─────────────────────────────────────────────────
  // Reasoning-provenance snapshot ("whose thinking is in context") for the
  // agent panel's ring badge. Unavailable → renderer hides the pill.
  registerContractHandle("session:context-ring", (_event, { sessionId }) => handle(async () => {
    if (!await engineOwns(ctx, sessionId)) return { available: false };
    const ring = (await getEngineHost(ctx).loadMessages(sessionId)).contextRing;
    return ring ? { available: true, ring } : { available: false };
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
    void scope;
    return subagentResult(() => listEngineSubagents(ctx, parentSessionId));
  }));
  registerContractHandle("subagent:interrupt", (_event, { parentSessionId, childId }) => handle(async () => {
    return subagentResult(async () => interruptEngineSubagent(ctx, parentSessionId, childId));
  }));
  registerContractHandle("subagent:message", (_event, { parentSessionId, childId, text }) => handle(async () => {
    return subagentResult(() => messageEngineSubagent(ctx, parentSessionId, childId, text));
  }));

  // ── session:job-kill ─────────────────────────────────────────────────────
  // Renderer-driven Kill for a engine background job (jobs dock). Same
  // {ok:false, code} envelope as subagent:* (owner-unavailable when the owner
  // turn ended, not-owner on a cross-session stop, registry passthrough
  // otherwise). The requesting session id is mandatory — the bridge only
  // stops jobs the caller's dock would show (unowned, or its own).
  registerContractHandle("session:job-kill", (_event, { jobId, sessionId }) => handle(async () => {
    return subagentResult(async () => {
      if (!getJobRegistry().kill(jobId, sessionId)) throw Object.assign(new Error(`job ${jobId} is not running`), { code: "owner-unavailable" });
      return { accepted: true };
    });
  }));

  // ── session:goal ─────────────────────────────────────────────────────────
  // On-demand current-goal snapshot for the renderer goal chip (initial mount;
  // live changes arrive via session:projection kind:"goal" from goal-bridge).
  // Null goal = no current goal (pre-create / cleared) → chip hides. Same
  // {ok:true,value}|{ok:false,code,message} envelope as subagent:*.
  registerContractHandle("session:goal", (_event, { sessionId }) => handle(async () => {
    return subagentResult(() => readEngineGoal(ctx, sessionId));
  }));

  // ── session:schedule-list ────────────────────────────────────────────────
  // On-demand active-reminder snapshot for the header alarm pill (polled on
  // header mount + turn end — no standing subscription). Empty list = overlay
  // off or no reminders → pill hides. Same envelope as subagent:*.
  registerContractHandle("session:schedule-list", (_event, req) => handle(async () => {
    return subagentResult(() => listEngineSchedules(ctx, req.sessionId));
  }));

  // ── session:abort ────────────────────────────────────────────────────────
  registerIpcOn("session:abort", (_event, { sessionId }: { sessionId: string }) => {
    getEngineHost(ctx).abort(sessionId);
    cancelQuestions(sessionId);
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
    const mobile = isMobileCaller(event);
    if (mobile) {
      const storedCwd = q.getCodingSessionById(ctx.db, req.sessionId)?.cwd;
      if (profile !== "chat" && !storedCwd) {
        rejectMobileRequest(req.sessionId);
        return;
      }
      const config = getCachedConfig();
      req = sanitizeMobileRequest(req, { config, fallback: profile === "chat" ? config.aiConfig : agentFallback(config), storedCwd });
    }
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
      await runEngineChat(ctx, chatReq);
      return;
    }
    const { sessionId, prompt, projectId, workspaceId, cwd, taskTitle, mode = "execute" } = req;

    // Reject a second prompt for a session whose loop is already running —
    // starting a new loop would replace session.abortCtrl mid-flight and leave
    // the is-running state inconsistent. The renderer queues prompts while busy,
    // so this is a defensive guard, not the normal path.
    if (getEngineHost(ctx).isRunning(sessionId)) {
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
    if (!mobile) cacheLlmConnection("agent", {
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
    // captured when the model called `exit_plan_mode`
    // (session_row.plan_content), fall back to the legacy PRD-note lookup
    // for sessions that predate the engine flow or that used ensure_note only.
    const planContent = sessionRow?.planContent?.trim()
      ? sessionRow.planContent
      : planNoteId
        ? (ctx.db.prepare("SELECT content FROM notes WHERE id = ?").get(planNoteId ?? "") as { content: string } | undefined)?.content ?? ""
        : undefined;

    // Session persona (persisted on the row) — "automation-dev" restricts the
    // toolset to file tools so a Develop session can't touch notes/tasks.
    // Validated: an unknown persisted value fails closed to the restricted
    // persona rather than the unrestricted default.
    const role = q.normalizeSessionRole(sessionRow?.role);
    session.role = role;

    const systemPrompt = buildAgentSystemPrompt({
      projectName, cwd, taskTitle, workspaceId, projectId, mode, planContent,
       role,
    });

    await runEnginePrompt({ ctx, sessionId, prompt, cwd, projectId, workspaceId, systemPrompt, llmConfig, role, attachments: req.attachments, sessionMode: mode });
  });


  // ── session:approve-plan ─────────────────────────────────────────────────
  // Renderer fires this when the user clicks "Approve Plan". Fetches the PRD
  // note, injects the approval message, then continues in execute mode.
  registerIpcOn("session:approve-plan", async (event, req: AgentApprovePlanRequest) => {
    try {
      assertSafeId(req.sessionId, "sessionId");
    } catch {
      broadcastEvent("session:projection", makeSessionProjection(String(req.sessionId ?? "unknown"), "error", { message: "Invalid session id.", code: "invalid-id" }));
      broadcastEvent("session:busy", { sessionId: String(req.sessionId ?? "unknown"), reason: "invalid-id" });
      return;
    }
    const mobile = isMobileCaller(event);
    if (mobile) {
      const storedCwd = q.getCodingSessionById(ctx.db, req.sessionId)?.cwd;
      if (!storedCwd) {
        rejectMobileRequest(req.sessionId);
        return;
      }
      const config = getCachedConfig();
      req = sanitizeMobileRequest(req, { config, fallback: agentFallback(config), storedCwd });
    }
    const { sessionId, planNoteId, projectId, workspaceId, cwd, taskTitle } = req;

    const send = (channel: string, payload: unknown) => {
      broadcastEvent(channel, payload);
    };

    // Same concurrency guard as session:prompt — a plan approval is also a
    // loop run and must never stack on an in-flight loop for this session.
    if (getEngineHost(ctx).isRunning(sessionId)) {
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
    if (!mobile) cacheLlmConnection("agent", {
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

    const planContent = (ctx.db.prepare("SELECT content FROM notes WHERE id = ?").get(planNoteId ?? "") as { content: string } | undefined)?.content ?? "";

    send("session:mode-change", { sessionId, mode: "execute", planNoteId });
    const projectName = projectId
      ? (ctx.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? "Project"
      : "Project";

    // Restore the persisted persona for this session (e.g. "automation-dev" for
    // a Develop session) so plan approval can't silently broaden its toolset.
    const sessionRow = q.getCodingSessionById(ctx.db, sessionId);
    const role = q.normalizeSessionRole(sessionRow?.role);
    session.role = role;

    {
      // The plan the model submitted with exit_plan_mode is stored on the session row; a PRD note is the older route.
      const approvedPlan = sessionRow?.planContent?.trim() || planContent;
      await runEnginePrompt({
        ctx, sessionId, cwd, projectId, workspaceId, llmConfig, role, sessionMode: "execute",
        systemPrompt: buildAgentSystemPrompt({ projectName, cwd, taskTitle, workspaceId, projectId, mode: "execute", planContent: approvedPlan, role }),
        prompt: planNoteId
          ? `The plan has been approved. Begin implementation now, following the approved PRD exactly. The PRD note ID is ${planNoteId} — you can re-read it via get_item if needed.`
          : "The plan has been approved. Begin implementation now, following the approved plan in your instructions exactly.",
      });
      return;
    }
  });

  // ── session:compact-now ─────────────────────────────────────────────────
  // Triggered by the /compact slash command. Auto-compaction (BasicCompactionEngine,
  // thresholdRatio 0.8) runs between steps automatically; this is the explicit
  // user-triggered variant. It opens the session's agent from its persisted jsonl
  // (idle), runs ctx.compaction.compactNow(agent), then disposes it.
  registerIpcOn("session:compact-now", async (event, req: { sessionId: string; config?: { baseUrl?: string; model?: string; apiKey?: string; contextWindow?: number; apiMode?: "responses" | "completions" | "anthropic-messages" } }) => {
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
    if (getEngineHost(ctx).isRunning(sessionId)) {
      send("session:compact-result", { sessionId, messageCount: 0, summary: "Can't compact while the agent is working — try again when it finishes." });
      return;
    }
    const sessionRow = q.getCodingSessionById(ctx.db, sessionId) as { cwd?: string } | undefined;
    const cwd = sessionRow?.cwd ?? "/";
    if (isMobileCaller(event)) {
      const config = getCachedConfig();
      req = sanitizeMobileRequest(req, { config, fallback: agentFallback(config), storedCwd: cwd });
    }
    const llmConfig: AgentLLMConfig = {
      baseUrl: normaliseBaseUrl(req.config?.baseUrl || "https://api.openai.com"),
      model: req.config?.model || "gpt-5.6-luna",
      apiKey: resolveLlmApiKey(req.config?.apiKey),
      maxSteps: 20,
      temperature: 0.1,
      contextWindow: req.config?.contextWindow,
      apiMode: req.config?.apiMode,
    };
    {
      try {
        const outcome = await compactEngineSession(ctx, { sessionId, cwd, llmConfig });
        if (outcome === "nothing") {
          send("session:compact-result", { sessionId, messageCount: 0, summary: "Nothing to compact." });
          send("session:compact", { sessionId, status: "end" });
        }
      } catch (e) {
        send("session:compact-result", { sessionId, messageCount: 0, summary: `Compaction unavailable: ${(e as Error).message}` });
      }
      return;
    }
  });

  // ── session:set-mode ─────────────────────────────────────────────────────
  // The engine picks the mode per prompt, so toggling only records it and tells the UI.
  registerIpcOn("session:set-mode", (_event, { sessionId, mode }: { sessionId: string; mode: "plan" | "execute" }) => {
    try {
      assertSafeId(sessionId, "sessionId");
    } catch {
      broadcastEvent("session:projection", makeSessionProjection(String(sessionId ?? "unknown"), "error", { message: "Invalid session id.", code: "invalid-id" }));
      broadcastEvent("session:busy", { sessionId: String(sessionId ?? "unknown"), reason: "invalid-id" });
      return;
    }
    if (getEngineHost(ctx).isRunning(sessionId)) {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — cannot toggle plan mode while running.", code: "already-running" }));
      broadcastEvent("session:busy", { sessionId, reason: "already-running" });
      return;
    }
    void (async () => {
      try {
        // On the engine the mode is chosen per prompt, so toggling only records it and tells the UI.
        q.updateCodingSession(ctx.db, sessionId, { mode, updatedAt: ts() });
        broadcastEvent("session:mode-change", { sessionId, mode });
        broadcastEvent("session:projection", makeSessionProjection(sessionId, "mode-change", { mode }));
      } catch (e) {
        // Do not update or broadcast a requested mode when engine rejected it.
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
  // Resolve a pending approval. Grants come from the ask the engine recorded main-side,
  // never from renderer-supplied fields.
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
    if (!getEngineHost(ctx).respondTool(sessionId, callId, nonce, { approved, grant })) {
      console.warn(`[session] respond-tool rejected: bad nonce or no pending ask for ${sessionId}/${callId}`);
    }
  });

  // ── session:respond-questions ─────────────────────────────────────────────
  // Answers to a blocked ask_questions call. The formatted answer text is fed
  // back to the model as the tool result so it reasons over the answers in the
  // same turn. engine keys by requestId (which the renderer echoes as callId).
  registerIpcOn("session:respond-questions", (_event, { sessionId, callId, answers, nonce }: { sessionId: string; callId: string; answers: string; nonce?: string }) => {
    try {
      assertSafeId(sessionId, "sessionId");
      assertSafeId(callId, "callId");
    } catch {
      console.warn(`[session] respond-questions rejected: invalid id for ${String(sessionId)}/${String(callId)}`);
      return;
    }
    if (!answerQuestion(sessionId, callId, nonce, answers)) {
      // The tool is no longer waiting (timed out, aborted, settled) or the nonce is wrong.
      console.warn(`[session] respond-questions dropped: no matching pending question for ${sessionId}/${callId}`);
    }
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
    if (getEngineHost(ctx).isRunning(sessionId) || clearingSessions.has(sessionId)) {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — cannot clear while running.", code: "already-running" }));
      broadcastEvent("session:busy", { sessionId, reason: "already-running" });
      return;
    }
    clearingSessions.add(sessionId);
    try {
      // Grants + any stray pendings die with the conversation.
      forgetEngineSession(sessionId);
      cancelQuestions(sessionId);
      void getEngineHost(ctx).destroy(sessionId).catch(() => undefined);
      // Explicit session clearing wipes persisted todos too.
      q.saveSessionTodos(ctx.db, sessionId, []);
      // Drop any retired-harness copy too, or it would be re-imported on the next prompt.
      removeLegacySessions((name) => name === sessionId);
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
    sessions.delete(sessionId);
    getEngineHost(ctx).release(sessionId);
    forgetEngineSession(sessionId);
    cancelQuestions(sessionId);
  });

  // ── approval grants (workspace-persistent "Always allow") ─────────────────
  // Device-local, not synced: a trust decision on this machine must not
  // silently apply on another. One row per (workspace, tool, target) — target
  // is the exact command for "bash"/"pwsh", otherwise null (whole tool).
  registerContractHandle("approval-grants:list", (_event, { workspaceId }) =>
    handle(async () => {
      assertSafeId(workspaceId, "workspaceId");
      const { getWorkspaceApprovalGrants } = await import("../db/approval-grant-queries");
      return getWorkspaceApprovalGrants(ctx.db, workspaceId);
    }),
  );
  registerContractHandle("approval-grants:delete", (_event, { id }) =>
    handle(async () => {
      assertSafeId(id, "id");
      const { deleteWorkspaceApprovalGrant } = await import("../db/approval-grant-queries");
      return { deleted: deleteWorkspaceApprovalGrant(ctx.db, id) };
    }),
  );
  registerContractHandle("approval-grants:clear-workspace", (_event, { workspaceId }) =>
    handle(async () => {
      assertSafeId(workspaceId, "workspaceId");
      const { clearWorkspaceApprovalGrants } = await import("../db/approval-grant-queries");
      return { deleted: clearWorkspaceApprovalGrants(ctx.db, workspaceId) };
    }),
  );

  // ── session:restore-context ───────────────────────────────────────────────────────
  // Session context resumes from the engine's log; this handler just restores the persisted session persona so a re-prompt
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
