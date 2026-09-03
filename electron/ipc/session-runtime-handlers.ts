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

import { registerIpcHandle, registerIpcOn, broadcastEvent } from "./registry";
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
import { getSessionGrants, clearSessionGrants, canonicalBashCommand, readPendingApprovalArgs, forgetPendingApprovalArgs, forgetSessionApprovalArgs } from "../cordis/approval-grants";
import { clearSecretGrants } from "../cordis/cairn-plugins";
import { addWorkspaceApprovalGrant } from "../db/approval-grant-queries";
import { createInteractiveConfirmTransport, setConfirmTransport } from "../cordis/approval-transports";
import { assertSafeId, isSafeId, resolveWithinRoot } from "./path-safety";
import fs from "node:fs";
import path from "node:path";
import { getSessionRoot, getContext } from "../cordis/run-cordis-loop";
import { mintAskNonce, verifyAskNonce, dropAskNonce, clearAskNoncesForSession, getAskNonce } from "./approval-state";
import { foldPlanModeActive } from "../cordis/plan-fold";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { registerPendingQuestion, resolvePendingQuestionAnswer, clearPendingQuestions, recordPendingQuestion, listPendingQuestions } from "../cordis/pending-question-broker";
import { type SessionProjection, makeSessionProjection } from "../../shared/agent/session-projection";
import { selectSessionProfile, type SessionProfileId } from "../../shared/agent/session-profile";
import { runChatPrompt, abortChatSession, getRunningChatIds, isChatThreadRunning } from "./chat";

// ── Session registry ──────────────────────────────────────────────────────────

const sessions = new Map<string, AgentSession>();

/**
 * Session IDs with a runCordisCodingLoop currently in flight. The renderer
 * polls this via `session:is-running` when a pane (re)mounts so a session
 * that kept working while its UI was closed (e.g. the automation Develop
 * modal) comes
 * back already showing the busy state, instead of briefly looking idle.
 */
const runningLoops = new Set<string>();
const clearingSessions = new Set<string>();

// ── Cordis engine wiring ────────────────────────────────────────────────────
// Per-turn pending resolvers for the dsh loop's HITL seams, keyed by callId (or
// requestId for questions). The session:respond-* IPC handlers resolve these,
// exactly like the builtin loop's pendingApprovals/pendingDoomLoop maps. Kept
// module-level so the (single) respond handlers can reach any session's turn.
// Extracted to approval-state.ts so the chat loop can share the same maps
// (previously coding-only — `session:respond-tool`'s global handler found an
// empty map for `chat-*` sessions).
import { cordisPendingApprovals, pendingKey, pendingAsks } from "./approval-state";

/**
 * Outstanding QUESTION asks (ask_questions / exit_plan_mode's plan-review),
 * so a reloading renderer can pull the question payload back via
 * session:is-running. The tool-approval registry above (pendingAsks) only
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
 * Store lives in ./ask-nonce.ts so chat.ts can mint/verify the same map
 * without a circular import (session-runtime-handlers ↔ chat).
 */

/** Drop every pending resolver + approval grant belonging to one session. */
function sweepSessionPendings(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const map of [cordisPendingApprovals]) {
    for (const key of Array.from(map.keys())) {
      if (key.startsWith(prefix)) map.delete(key);
    }
  }
  clearSessionGrants(sessionId);
  clearSecretGrants(sessionId);
  pendingAsks.clearSession(sessionId);
  clearPendingQuestions(sessionId);
  clearAskNoncesForSession(sessionId);
  forgetSessionApprovalArgs(sessionId);
  setConfirmTransport(sessionId, undefined);
}

import { isMode, modeFromAutoApprove, type Mode } from "../../shared/agent/approval-mode";

/** The raw turn inputs the Cordis coding loop needs (prompt + attachments + config). */
interface CordisTurnPayload {
  message: string;
  images?: Array<{ kind?: "image" | "pdf"; dataUrl: string; name?: string }>;
  projectId?: string;
  workspaceId?: string;
  personality?: string;
  autoApprove?: boolean;
  mode?: Mode;
  /** automation-dev → read-only sandbox (file-only, no escape); else workspace-write. */
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  /** Session persona ("default" | "automation-dev"). automation-dev is a
   *  restricted coding session for authoring an automation's scripts — no
   *  bash, no Cairn data tools; the pre-Cordis loop enforced this via
   *  AUTOMATION_DEV_TOOLS. Restored here so the restriction can be applied
   *  to the Cordis tool registrations too. */
  role?: "default" | "automation-dev";
  onSessionEvent?: (event: SessionEvent) => void;
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

// ── Shared session runner ──────────────────────────────────────────────────────

/**
 * Cordis wrapper — builds all IPC-forwarding callbacks and calls
 * runCordisCodingSession (which drives the dsh agent loop). Extracted to
 * eliminate duplication between the session:prompt and session:approve-plan
 * handlers — both resolve their differences (system prompt, initial message)
 * before calling this. The compaction transformer + tool loop are owned by
 * dsh now; this thin wrapper only wires the send/emit adapters.
 */
async function runSession(
  session: AgentSession,
  systemPrompt: string,
  llmConfig: AgentLLMConfig,
  mode: "plan" | "execute",
  toolCtx: AgentToolContext,
  ctx: DbContext,
  send: (channel: string, payload: unknown) => void,
  cordis: CordisTurnPayload,
): Promise<void> {
  // ── Cordis engine (only path — local models via llama-server are also OpenAI-compatible) ──
  return runCordisCodingSession(session, systemPrompt, llmConfig, mode, toolCtx, ctx, send, cordis);
}

// ── Cordis coding-session runner ────────────────────────────────────────────
// Drives runCordisCodingLoop for one turn and bridges its adapters to the same
// session:* IPC + runningLoops lifecycle the builtin path uses. The dsh loop
// owns the model↔tool iteration, session persistence (jsonl), plan mode,
// approvals, doom-loop, skills, sandbox, attachments, compaction, and retries;
// nothing here re-implements them.
async function runCordisCodingSession(
  session: AgentSession,
  systemPrompt: string,
  llmConfig: AgentLLMConfig,
  mode: "plan" | "execute",
  toolCtx: AgentToolContext,
  ctx: DbContext,
  send: (channel: string, payload: unknown) => void,
  payload: CordisTurnPayload,
): Promise<void> {
  const { sessionId } = toolCtx;
  runningLoops.add(sessionId);

  const { runCordisCodingLoop } = await import("../cordis/run-cordis-coding");

  // Forward only Cairn-derived projections. Parent lifecycle is folded from raw
  // session:event in the renderers.
  const loopSend = (channel: string, evtPayload: Record<string, unknown>) => {
    if (channel !== "session:projection") return;
    const projection = evtPayload as unknown as SessionProjection;
    if (projection.kind === "approval") {
      const data = projection.data as unknown as { status?: string; callId?: string; name?: string; label?: string; nonce?: string };
      if (data.status === "required" && typeof data.callId === "string" && !data.nonce) {
        const nonce = mintAskNonce(sessionId, data.callId);
        data.nonce = nonce;
        pendingAsks.record({
          sessionId,
          name: data.name ?? "tool",
          label: data.label ?? data.name ?? "tool",
          callId: data.callId,
          nonce,
        } as never);
      } else if (data.status === "expired" && typeof data.callId === "string") {
        pendingAsks.resolve(sessionId, data.callId);
        dropAskNonce(sessionId, data.callId);
        forgetPendingApprovalArgs(sessionId, data.callId);
      }
    }
    if (projection.kind === "plan-note" && typeof (projection.data as unknown as { noteId?: unknown }).noteId === "string") {
      try { q.updateCodingSession(ctx.db, sessionId, { planNoteId: (projection.data as unknown as { noteId: string }).noteId, updatedAt: ts() }); } catch { /* non-critical */ }
    }
    send(channel, projection);
  };

  const req = {
    message: payload.message,
    threadId: sessionId,
    projectId: payload.projectId,
    workspaceId: payload.workspaceId,
    history: [],
    personality: payload.personality ?? "helpful",
    images: payload.images,
    config: { provider: llmConfig.provider === "localllm" ? "localllm" : "openai", baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey },
  };

  // Bind the plugin confirmation seam for this session's turn: ctx.cairn.confirm
  // routes through the same interactive pairing (chip + ApprovalCard + respond
  // IPC) the native approval bridge uses. Cleared when the turn ends.
  setConfirmTransport(sessionId, createInteractiveConfirmTransport({
    sessionId,
    send: loopSend,
    registerPending: (callId: string, resolve: (d: { approved: boolean; grant?: "session" | "command" | "workspace" }) => void) => {
      const key = pendingKey(sessionId, callId);
      cordisPendingApprovals.set(key, resolve);
      return () => cordisPendingApprovals.delete(key);
    },
  }));

  try {
    await runCordisCodingLoop({
      db: ctx.db,
      req: req as never,
      workspacePath: ctx.workspacePath,
      sessionId,
      cwd: toolCtx.cwd,
      systemPrompt,
      llmConfig: { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey, provider: llmConfig.provider === "localllm" ? "localllm" : "openai", contextWindow: llmConfig.contextWindow, maxTokens: llmConfig.maxTokens, isReasoningModel: llmConfig.isReasoningModel, reasoningEffort: llmConfig.reasoningEffort, apiMode: llmConfig.apiMode, mode: payload.mode, autoApprove: payload.autoApprove },
      mode,
      autoApprove: payload.autoApprove,
      approvalMode: payload.mode,
      sandboxMode: payload.sandboxMode,
      role: payload.role,
      onSessionEvent: payload.onSessionEvent,
      send: (channel, payload) => {
        // Record outstanding approval asks so a reloaded renderer can pull
        // them back via is-running (the original push died with the old page).
        // Handle both legacy top-level callId shape (session:tool-confirm-*) and
        // the current Cairn approval plugin shape (session:projection kind:"approval").
        if (channel === "session:projection" && payload && typeof payload === "object" && (payload as { kind?: unknown }).kind === "approval") {
          const proj = payload as { sessionId?: string; data?: { status?: string; callId?: string; name?: string; label?: string; nonce?: string } };
          const data = proj.data;
          const sessId = proj.sessionId ?? sessionId;
          if (data && data.status === "required" && typeof data.callId === "string" && !data.nonce) {
            const nonce = mintAskNonce(sessId, data.callId);
            data.nonce = nonce;
            pendingAsks.record({
              sessionId: sessId,
              name: data.name ?? "tool",
              label: data.label ?? data.name ?? "tool",
              callId: data.callId,
              nonce,
            } as never);
          } else if (data && data.status === "expired" && typeof data.callId === "string") {
            pendingAsks.resolve(sessId, data.callId);
            dropAskNonce(sessId, data.callId);
            forgetPendingApprovalArgs(sessId, data.callId);
          }
        } else if (payload && typeof payload === "object" && typeof (payload as { callId?: unknown }).callId === "string") {
          const p = payload as { sessionId?: string; name?: string; label?: string; callId?: string };
          if (p.sessionId) {
            if (channel === "session:tool-confirm-required") {
              // Mint a per-ask nonce so session:respond-tool must present
              // it — a renderer-side script can't approve an ask it never
              // received the original push for. The nonce is attached to
              // the outgoing event (see the payload mutation below) and
              // consumed / cleared by respond-tool on settle.
              const nonce = mintAskNonce(p.sessionId, p.callId ?? "");
              (payload as { nonce?: string }).nonce = nonce;
              pendingAsks.record({
                sessionId: p.sessionId,
                name: p.name ?? "tool",
                label: p.label ?? p.name ?? "tool",
                callId: p.callId ?? "",
                nonce,
              } as never);
            } else if (channel === "session:tool-confirm-expired") {
              pendingAsks.resolve(p.sessionId, p.callId ?? "");
              dropAskNonce(p.sessionId, p.callId ?? "");
              forgetPendingApprovalArgs(p.sessionId, p.callId ?? "");
            }

          }
        }
        loopSend(channel, payload);
      },
      getWin: toolCtx.getWin,
      signal: session.abortCtrl.signal,
      questions: {
        send: (channel, p) => {
          // Record the outstanding question payload so a reloading renderer
          // can pull the full question (including plan-review detail +
          // options) back via session:is-running — the original push dies
          // with the old page, and losing it would strand the review with
          // no UI to answer it.
          //
          // Security note (H4): this send is the coding path's broadcastEvent
          // (all windows + mobile). The HITL nonce minted here authenticates
          // session:respond-questions — it must reach the desktop renderer
          // but MUST NOT be exposed to mobile clients. broadcastEvent's
          // registry layer now strips `nonce` (and `data.nonce`) before
          // forwarding to mobileBroadcastCallback, so desktop receives the
          // nonce via BrowserWindow.send while mobile gets a sanitized
          // payload. is-running remains the recovery path for reloads.
          if (channel === "session:ask-questions") {
            const requestId = typeof p.callId === "string" ? p.callId : undefined;
            const qs = Array.isArray(p.questions) ? p.questions : undefined;
            if (requestId && qs) {
              const nonce = mintAskNonce(sessionId, requestId);
              (p as { nonce?: string }).nonce = nonce;
              recordPendingQuestion({
                sessionId,
                callId: requestId,
                questions: qs as Array<{ id: string; [k: string]: unknown }>,
              });
            }
          }
          send(channel, { sessionId, ...p });
        },
        registerPending: (requestId, resolve) => {
           const dispose = registerPendingQuestion(sessionId, requestId, resolve);
           return () => {
             dispose();
           };
        },
      },
      approvals: {
        registerPending: (callId: string, resolve: (d: { approved: boolean; grant?: "session" | "command" | "workspace" }) => void) => {
          const key = pendingKey(sessionId, callId);
          cordisPendingApprovals.set(key, resolve);
          return () => cordisPendingApprovals.delete(key);
        },
      },
    });
  } catch (err) {
    if (!session.abortCtrl.signal.aborted) {
      console.error("[session] coding loop failed:", err);
    }
  } finally {
    runningLoops.delete(sessionId);
    // The turn is over — every ask in it was settled (answered, aborted, or
    // timed out). Drop any registry residue so the next turn starts clean.
    pendingAsks.clearSession(sessionId);
    clearAskNoncesForSession(sessionId);
    setConfirmTransport(sessionId, undefined);
  }
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
  registerIpcHandle("session:is-running", (_event, { sessionId }: { sessionId: string }) => handle(async () => {
    const running = runningLoops.has(sessionId) || isChatThreadRunning(sessionId);
    return {
      running,
      pendingAsks: pendingAsks.listForSession(sessionId),
      // Outstanding question asks (ask_questions / plan-review). The renderer
      // uses this to re-open a PlanReviewCard after a reload that swallowed
      // the original session:ask-questions push.
      pendingQuestions: listPendingQuestions(sessionId).map((q) => ({
        callId: q.callId,
        questions: q.questions,
        nonce: getAskNonce(sessionId, q.callId),
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
  registerIpcHandle("session:running-ids", () => handle(async () => {
    return { ids: [...Array.from(runningLoops), ...getRunningChatIds()] };
  }));

  // ── session:context-ring ─────────────────────────────────────────────────
  // Reasoning-provenance snapshot ("whose thinking is in context") for the
  // agent panel's ring badge. Unavailable → renderer hides the pill.
  registerIpcHandle("session:context-ring", (_event, { sessionId }: { sessionId: string }) => handle(async () => {
    const { readContextRing } = await import("../cordis/run-cordis-loop");
    return readContextRing(sessionId);
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
  registerIpcHandle("subagent:list", (_event, { parentSessionId }: { parentSessionId: string }) => handle(async () => {
    const { listSubagentChildren } = await import("../cordis/subagent-control");
    return subagentResult(() => listSubagentChildren(parentSessionId));
  }));
  registerIpcHandle("subagent:interrupt", (_event, { parentSessionId, childId }: { parentSessionId: string; childId: string }) => handle(async () => {
    const { interruptSubagentChild } = await import("../cordis/subagent-control");
    return subagentResult(() => interruptSubagentChild(parentSessionId, childId));
  }));
  registerIpcHandle("subagent:message", (_event, { parentSessionId, childId, text }: { parentSessionId: string; childId: string; text: string }) => handle(async () => {
    const { messageSubagentChild } = await import("../cordis/subagent-control");
    return subagentResult(() => messageSubagentChild(parentSessionId, childId, text));
  }));

  // ── session:abort ────────────────────────────────────────────────────────
  registerIpcOn("session:abort", (_event, { sessionId }: { sessionId: string }) => {
    const profile = q.getSessionProfile(ctx.db, sessionId)?.profile;
    if (profile === "chat") {
      abortChatSession(sessionId);
      return;
    }
    const session = sessions.get(sessionId);
    if (session) {
      session.abortCtrl.abort();
    }
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
    if (runningLoops.has(sessionId)) {
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
      // No isLocalEndpoint→"localllm" coercion: a custom local endpoint
      // (Ollama, LM Studio, user-run llama.cpp) must keep its own baseUrl —
      // tagging it "localllm" would reroute requests into the app-managed
      // on-device llama-server in run-cordis-coding.ts. "localllm" only ever
      // arrives explicitly from the chat surface.
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
       onSessionEvent: (sessionEvent: SessionEvent) => broadcastEvent("session:event", { sessionId, event: sessionEvent }),
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
    if (runningLoops.has(sessionId)) {
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
    if (runningLoops.has(sessionId)) {
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
      const { getContext } = await import("../cordis/run-cordis-loop");
      const { openCordisAgent } = await import("../cordis/run-cordis-coding");
      const ctxC = await getContext();
      // Pin the summariser protocol to the saved provider's apiMode (never
      // auto-probe): mounting a different `api` than the session was written
      // under corrupts replay, and a probe can never yield anthropic-messages.
      const compactApi = llmConfig.apiMode === "responses" ? "openai-responses"
        : llmConfig.apiMode === "anthropic-messages" ? "anthropic-messages"
        : "openai-completions";
      await (await import("../cordis/run-cordis-loop")).ensureAgentAiAdapter(ctxC, {
        baseUrl: llmConfig.baseUrl,
        model: llmConfig.model,
        apiKey: llmConfig.apiKey,
        api: compactApi,
      });
      const handle = await openCordisAgent(ctxC, { sessionId, cwd, llmConfig: { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey, provider: "openai" as const, apiMode: llmConfig.apiMode }, signal: new AbortController().signal });
      try {
        // Ensure idle before compactNow (P1-5 busy race): session:compact-now
        // bypasses runningLoops for races outside its own map; check whenIdle.
        const maybeIdle = (handle.agent as { whenIdle?: () => Promise<void> })?.whenIdle;
        if (typeof maybeIdle === "function") {
          try { await maybeIdle.call(handle.agent); } catch { /* compaction will throw busy */ }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const compaction = (ctxC as any).compaction;
        if (!compaction?.compactNow) throw new Error("compaction service not mounted");
        const result = await compaction.compactNow(handle.agent, new AbortController().signal);
        if (result) {
          send("session:compact-result", {
            sessionId,
            messageCount: (result as { replacedCount?: number; replacedSeqs?: unknown[] })?.replacedCount
              ?? (result as { replacedSeqs?: unknown[] })?.replacedSeqs?.length
              ?? 0,
            summary: (result as { summary?: string })?.summary ?? "",
          });
        } else {
          send("session:compact-result", { sessionId, messageCount: 0, summary: "Nothing to compact." });
        }
      } finally {
        await handle.dispose?.();
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
    if (runningLoops.has(sessionId)) {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — cannot toggle plan mode while running.", code: "already-running" }));
      broadcastEvent("session:busy", { sessionId, reason: "already-running" });
      return;
    }
    void (async () => {
      try {
        const agentConfig = getCachedConfig().agentConfig;
        const { openCordisAgent } = await import("../cordis/run-cordis-coding");
        const { getContext } = await import("../cordis/run-cordis-loop");
        const cordisCtx = await getContext();
        const handle = await openCordisAgent(cordisCtx, {
          sessionId, cwd: ctx.workspacePath || process.cwd(),
          llmConfig: { baseUrl: agentConfig?.baseUrl ?? "", model: agentConfig?.model ?? "", apiKey: agentConfig?.apiKey ?? "", provider: "openai" },
          signal: undefined,
        });
        try {
          const commands = (cordisCtx as unknown as { commands?: { execute: (a: unknown, line: string, images: unknown[], signal?: AbortSignal) => Promise<unknown> } }).commands;
          if (!commands) throw new Error("commands runtime unavailable");
          const result = await commands.execute((handle as { agent: unknown }).agent, mode === "plan" ? "/plan" : "/plan off", [], new AbortController().signal);
          const commandResult = (result as { result?: { kind?: string; text?: string } } | undefined)?.result;
          if (commandResult?.kind !== "success") {
            throw new Error(commandResult?.text ?? "plan mode command was not accepted");
          }
          const session = (handle as { agent: { session?: unknown } }).agent.session;
          const committedMode = foldPlanModeActive(session as never) ? "plan" : "execute";
          if (committedMode !== mode) {
            throw new Error(`plan mode command did not commit ${mode}`);
          }
          try {
            q.updateCodingSession(ctx.db, sessionId, { mode: committedMode, updatedAt: ts() });
          } catch (e) {
            console.warn("[session] failed to update session mode index:", e);
          }
          broadcastEvent("session:mode-change", { sessionId, mode: committedMode });
          broadcastEvent("session:projection", makeSessionProjection(sessionId, "mode-change", { mode: committedMode }));
        } finally {
          try { await (handle as { dispose?: () => Promise<void> }).dispose?.(); } catch { /* noop */ }
        }
      } catch (e) {
        // Do not update or broadcast a requested mode when dsh rejected it.
        // The durable session log remains authoritative and the UI can retry.
        const msg = e instanceof Error ? e.message : String(e);
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
    if (!verifyAskNonce(sessionId, callId, nonce)) {
      console.warn(`[session] respond-tool rejected: bad or missing nonce for ${sessionId}/${callId}`);
      return;
    }
    const key = pendingKey(sessionId, callId);
    const cordisPending = cordisPendingApprovals.get(key);
    if (!cordisPending) return;
    // Capture the ask's tool name BEFORE the pending-ask registry is cleared,
    // so a workspace grant can be bound to the exact tool that was asked.
    const pendingMetaForGrant = pendingAsks.listForSession(sessionId).find((m) => m.callId === callId);
    cordisPending({ approved, grant: approved ? grant : undefined });
    cordisPendingApprovals.delete(key);
    pendingAsks.resolve(sessionId, callId);
    dropAskNonce(sessionId, callId);
    if (approved && grant === "command") {
      // Read the trusted command from the pre-execute stash — the renderer's
      // command field is ignored (parameter kept in the type signature only
      // so old renderers don't get a payload-validation error at the IPC
      // boundary; it's intentionally unused).
      const trusted = readPendingApprovalArgs(sessionId, callId);
      const trustedCommand = trusted && typeof trusted.command === "string" ? trusted.command : undefined;
      const cmd = canonicalBashCommand(trustedCommand);
      if (cmd) getSessionGrants(sessionId).bashCommands.add(cmd);
    }
    if (approved && grant === "workspace") {
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
            const trusted = readPendingApprovalArgs(sessionId, callId);
            const target = toolName === "bash" && trusted ? canonicalBashCommand(trusted.command) : null;
            const grantRec = addWorkspaceApprovalGrant(ctx.db, workspaceId, toolName, target);
            // Also grant this session immediately so the current turn proceeds
            // without needing to re-read the DB before the next ask.
            if (grantRec) {
              if (toolName === "bash" && target) getSessionGrants(sessionId).bashCommands.add(target);
              else getSessionGrants(sessionId).tools.add(toolName);
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
    if (!verifyAskNonce(sessionId, callId, nonce)) {
      console.warn(`[session] respond-questions rejected: bad or missing nonce for ${sessionId}/${callId}`);
      return;
    }
    resolvePendingQuestionAnswer(sessionId, callId, answers);
    dropAskNonce(sessionId, callId);
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
    if (runningLoops.has(sessionId) || clearingSessions.has(sessionId)) {
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — cannot clear while running.", code: "already-running" }));
      broadcastEvent("session:busy", { sessionId, reason: "already-running" });
      return;
    }
    clearingSessions.add(sessionId);
    try {
      // TOCTOU re-check: re-validate runningLoops after assertSafeId and immediately
      // before the destructive sweep/file deletion. A concurrent prompt could have
      // started between the first guard and now; clear is rejected if still running.
      if (runningLoops.has(sessionId)) {
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
        const primaryRoot = getSessionRoot();
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
                if (runningLoops.has(sessionId)) {
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
            if (runningLoops.has(sessionId)) {
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
        // Also drop any in-memory dsh agent that still holds the old session.
        getContext().then((c: unknown) => {
          const maybeAgents = (c as { agents?: { get?: (id: unknown) => unknown; delete?: (id: unknown) => void; remove?: (id: unknown) => void; dispose?: (id: unknown) => void } })?.agents;
          const sid = { toString: () => sessionId } as unknown as string;
          // Try every plausible delete/remove/dispose shape — dsh-agent's API has shifted across rc's.
          const removed = false;
          for (const k of ["delete", "remove", "dispose", "destroy"] as const) {
            try {
              const fn = (maybeAgents as Record<string, unknown>)?.[k] as ((id: unknown) => unknown) | undefined;
              if (typeof fn === "function") { fn.call(maybeAgents, sid); break; }
            } catch { /* ignore */ }
          }
          if (!removed) {
            try {
              const ag = maybeAgents?.get?.(sid) as { dispose?: () => void } | undefined;
              ag?.dispose?.();
            } catch { /* ignore */ }
          }
        }).catch(() => {});
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
      session.abortCtrl.abort();
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
  // is the exact bash command for "bash", otherwise null (whole tool).
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
