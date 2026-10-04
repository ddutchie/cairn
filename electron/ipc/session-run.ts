/**
 * One coding-session turn: drives the Cordis/dsh loop for an AgentSession and
 * bridges its callbacks to the session:* IPC events. Called by the
 * session:prompt and session:approve-plan handlers.
 */

import type { AgentSession, AgentLLMConfig, AgentToolContext } from "../lib/session-runtime-types";
import type { DbContext } from "./handlers";
import * as q from "../db/queries";
import { ts } from "../db/utils";
import { getAgentHost } from "../cordis/agent-host";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { type SessionProjection, makeSessionProjection } from "../../shared/agent/session-projection";
import { errMsg } from "../host-shared/errors";
import type { Mode } from "../../shared/agent/approval-mode";
import { notifyAgentAttention } from "../lib/agent-attention";

/** The raw turn inputs the Cordis coding loop needs (prompt + attachments + config). */
export interface CordisTurnPayload {
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

// ── Shared session runner ──────────────────────────────────────────────────────

/**
 * Cordis wrapper — builds all IPC-forwarding callbacks and calls
 * runCordisCodingSession (which drives the dsh agent loop). Extracted to
 * eliminate duplication between the session:prompt and session:approve-plan
 * handlers — both resolve their differences (system prompt, initial message)
 * before calling this. The compaction transformer + tool loop are owned by
 * dsh now; this thin wrapper only wires the send/emit adapters.
 */
export async function runSession(
  session: AgentSession,
  systemPrompt: string,
  llmConfig: AgentLLMConfig,
  mode: "plan" | "execute",
  toolCtx: AgentToolContext,
  ctx: DbContext,
  send: (channel: string, payload: unknown) => void,
  cordis: CordisTurnPayload,
): Promise<void> {
  // ── Cordis engine (only path — user-run local servers are plain OpenAI-compatible endpoints) ──
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
  const turnController = getAgentHost().startTurn(sessionId);
  session.abortCtrl = turnController;

  const { runCordisCodingLoop } = await import("../cordis/run-cordis-coding");

  // Forward only Cairn-derived projections. Parent lifecycle is folded from raw
  // session:event in the renderers.
  const loopSend = (channel: string, evtPayload: Record<string, unknown>) => {
    if (channel !== "session:projection") return;
    const projection = evtPayload as unknown as SessionProjection;
    if (projection.kind === "approval") {
      const data = projection.data as unknown as { status?: string; callId?: string; name?: string; label?: string; nonce?: string; reason?: string };
      if (data.status === "required") notifyAgentAttention(ctx.db, { sessionId, kind: "approval", detail: data.label ?? data.name });
      if (data.status === "required" && typeof data.callId === "string" && !data.nonce) {
        const nonce = getAgentHost().mintApprovalNonce(sessionId, data.callId);
        data.nonce = nonce;
        getAgentHost().recordPendingApprovalAsk({
          sessionId,
          name: data.name ?? "tool",
          label: data.label ?? data.name ?? "tool",
          callId: data.callId,
          nonce,
          ...(data.reason ? { reason: data.reason } : {}),
          escalation: data.reason?.startsWith("escalate sandbox to ") === true,
        } as never);
      } else if (data.status === "expired" && typeof data.callId === "string") {
        getAgentHost().resolvePendingApprovalAsk(sessionId, data.callId);
        getAgentHost().dropApprovalNonce(sessionId, data.callId);
        getAgentHost().forgetPendingApprovalArgs(sessionId, data.callId);
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
    config: { provider: "openai", baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey },
  };

  // Bind the plugin confirmation seam for this session's turn: ctx.cairn.confirm
  // routes through the same interactive pairing (chip + ApprovalCard + respond
  // IPC) the native approval bridge uses. Cleared when the turn ends.
  getAgentHost().bindInteractiveConfirmTransport(sessionId, {
    send: loopSend,
    registerPending: (callId: string, resolve: (d: { approved: boolean; grant?: "session" | "command" | "workspace" }) => void) => {
      return getAgentHost().registerPendingApproval(sessionId, callId, resolve);
    },
  });

  try {
    await runCordisCodingLoop({
      db: ctx.db,
      req: req as never,
      workspacePath: ctx.workspacePath,
      sessionId,
      cwd: toolCtx.cwd,
      systemPrompt,
      llmConfig: { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey, provider: "openai", contextWindow: llmConfig.contextWindow, maxTokens: llmConfig.maxTokens, isReasoningModel: llmConfig.isReasoningModel, reasoningEffort: llmConfig.reasoningEffort, apiMode: llmConfig.apiMode, mode: payload.mode, autoApprove: payload.autoApprove },
      mode,
      autoApprove: payload.autoApprove,
      approvalMode: payload.mode,
      // Interactive coding sessions follow dsh: the permission preset is the
      // guard and Cairn tools never ask (automations keep the Mode gate).
      approvalGate: "sandbox",
      sandboxMode: payload.sandboxMode,
      role: payload.role,
      onSessionEvent: payload.onSessionEvent,
      send: (channel, payload) => {
        // Record outstanding approval asks so a reloaded renderer can pull
        // them back via is-running (the original push died with the old page).
        // Handle both legacy top-level callId shape (session:tool-confirm-*) and
        // the current Cairn approval plugin shape (session:projection kind:"approval").
        if (channel === "session:projection" && payload && typeof payload === "object" && (payload as { kind?: unknown }).kind === "approval") {
          const proj = payload as { sessionId?: string; data?: { status?: string; callId?: string; name?: string; label?: string; nonce?: string; reason?: string } };
          const data = proj.data;
          const sessId = proj.sessionId ?? sessionId;
          if (data && data.status === "required" && typeof data.callId === "string" && !data.nonce) {
            const nonce = getAgentHost().mintApprovalNonce(sessId, data.callId);
            data.nonce = nonce;
            getAgentHost().recordPendingApprovalAsk({
              sessionId: sessId,
              name: data.name ?? "tool",
              label: data.label ?? data.name ?? "tool",
              callId: data.callId,
              nonce,
              ...(data.reason ? { reason: data.reason } : {}),
              escalation: data.reason?.startsWith("escalate sandbox to ") === true,
            } as never);
          } else if (data && data.status === "expired" && typeof data.callId === "string") {
            getAgentHost().resolvePendingApprovalAsk(sessId, data.callId);
            getAgentHost().dropApprovalNonce(sessId, data.callId);
            getAgentHost().forgetPendingApprovalArgs(sessId, data.callId);
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
              const nonce = getAgentHost().mintApprovalNonce(p.sessionId, p.callId ?? "");
              (payload as { nonce?: string }).nonce = nonce;
              getAgentHost().recordPendingApprovalAsk({
                sessionId: p.sessionId,
                name: p.name ?? "tool",
                label: p.label ?? p.name ?? "tool",
                callId: p.callId ?? "",
                nonce,
              } as never);
            } else if (channel === "session:tool-confirm-expired") {
              getAgentHost().resolvePendingApprovalAsk(p.sessionId, p.callId ?? "");
              getAgentHost().dropApprovalNonce(p.sessionId, p.callId ?? "");
              getAgentHost().forgetPendingApprovalArgs(p.sessionId, p.callId ?? "");
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
            notifyAgentAttention(ctx.db, { sessionId, kind: "question" });
            const requestId = typeof p.callId === "string" ? p.callId : undefined;
            const qs = Array.isArray(p.questions) ? p.questions : undefined;
            if (requestId && qs) {
              const nonce = getAgentHost().mintApprovalNonce(sessionId, requestId);
              (p as { nonce?: string }).nonce = nonce;
              getAgentHost().recordPendingQuestion({
                sessionId,
                callId: requestId,
                questions: qs as Array<{ id: string; [k: string]: unknown }>,
              });
              // Live path: the renderer has no listener for the raw
              // session:ask-questions push — it renders from the folded
              // tool-call event (questions + callId, but no nonce), so without
              // this projection the answer is rejected on nonce and silently
              // dropped. Mirror the chat path (chat.ts emitQuestions): emit a
              // question projection carrying callId + nonce, which
              // useSessionConversation already handles.
              send("session:projection", makeSessionProjection(sessionId, "question", {
                callId: requestId,
                questions: qs,
                nonce,
              } as never));
            }
          }
          send(channel, { sessionId, ...p });
        },
        registerPending: (requestId, resolve) => {
           return getAgentHost().registerPendingQuestion(sessionId, requestId, resolve);
        },
      },
      approvals: {
        registerPending: (callId: string, resolve: (d: { approved: boolean; grant?: "session" | "command" | "workspace" }) => void) => {
          return getAgentHost().registerPendingApproval(sessionId, callId, resolve);
        },
      },
    });
    if (!session.abortCtrl.signal.aborted) notifyAgentAttention(ctx.db, { sessionId, kind: "finished" });
  } catch (err) {
    if (!session.abortCtrl.signal.aborted) {
      console.error("[session] coding loop failed:", err);
      notifyAgentAttention(ctx.db, { sessionId, kind: "failed", detail: errMsg(err) });
    }
  } finally {
     getAgentHost().endTurn(sessionId, turnController);
    // The turn is over — every ask in it was settled (answered, aborted, or
    // timed out). Drop any registry residue so the next turn starts clean.
     getAgentHost().clearApprovalState(sessionId);
    getAgentHost().unbindConfirmTransport(sessionId);
  }
}
