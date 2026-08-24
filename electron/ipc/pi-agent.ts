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
import { handle } from "./result-helpers";

import type { PiAgentSession, AgentLLMConfig, AgentToolContext } from "../lib/pi-agent-types";
import { buildPiAgentSystemPrompt } from "../lib/pi-agent-prompt";
import { discoverSkills } from "../lib/skills";
import { normaliseBaseUrl } from "../lib/llm";
import type { DbContext } from "./handlers";
import * as q from "../db/queries";
import { ts } from "../db/utils";
import { getCachedConfig, cacheLlmConnection } from "../lib/config-cache";
import { resolveLlmApiKey } from "../lib/secure-store";
import { validateAttachmentDataUrl } from "../../shared/models/pdf-attach";
import { createDeltaBatcher } from "../lib/delta-batcher";
import { getSessionGrants, clearSessionGrants, canonicalBashCommand, createPendingAskRegistry, readPendingApprovalArgs, forgetSessionApprovalArgs } from "../cordis/approval-grants";
import { createInteractiveConfirmTransport, setConfirmTransport } from "../cordis/approval-transports";
import { assertSafeId, resolveWithinRoot } from "./path-safety";
import fs from "node:fs";
import path from "node:path";
import { webcrypto as nodeWebCrypto } from "node:crypto";
import { getSessionRoot, getContext } from "../cordis/run-cordis-loop";
import { foldPlanMode } from "@deepseek-ai/dsh-plan-mode";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

// ── Session registry ──────────────────────────────────────────────────────────

const sessions = new Map<string, PiAgentSession>();

/**
 * Session IDs with a runCordisCodingLoop currently in flight. The renderer
 * polls this via `pi-agent:is-running` when a pane (re)mounts so a session
 * that kept working while its UI was closed (e.g. the automation Develop
 * modal) comes
 * back already showing the busy state, instead of briefly looking idle.
 */
const runningLoops = new Set<string>();

// ── Cordis engine wiring ────────────────────────────────────────────────────
// Per-turn pending resolvers for the dsh loop's HITL seams, keyed by callId (or
// requestId for questions). The pi-agent:respond-* IPC handlers resolve these,
// exactly like the builtin loop's pendingApprovals/pendingDoomLoop maps. Kept
// module-level so the (single) respond handlers can reach any session's turn.
const cordisPendingApprovals = new Map<string, (d: { approved: boolean; grant?: "session" | "command" }) => void>();
const cordisPendingQuestions = new Map<string, (answersText: string) => void>();

/**
 * Pending maps are keyed `${sessionId}::${callId}` so a respond event can only
 * ever resolve its OWN session's ask — dsh callIds are provider-generated and
 * not guaranteed collision-free across concurrent coding/automation sessions.
 */
const pendingKey = (sessionId: string, callId: string): string => `${sessionId}::${callId}`;

/**
 * Outstanding tool-approval asks, so a reloading renderer can pull them back
 * via pi-agent:is-running instead of losing the card (and leaving the main
 * promise blocked with no visible way to answer it).
 */
const pendingAsks = createPendingAskRegistry();

/**
 * Outstanding QUESTION asks (ask_questions / exit_plan_mode's plan-review),
 * so a reloading renderer can pull the question payload back via
 * pi-agent:is-running. The tool-approval registry above (pendingAsks) only
 * records name/callId — questions need the full payload preserved so the
 * PlanReviewCard can re-render its plan-under-review after reload.
 */
interface PendingQuestionMeta {
  sessionId: string;
  callId: string;
  questions: Array<{ id: string; [k: string]: unknown }>;
}
const pendingQuestionsRegistry = new Map<string, PendingQuestionMeta>();
function questionKey(sessionId: string, callId: string) {
  return `${sessionId}::${callId}`;
}
function recordPendingQuestion(meta: PendingQuestionMeta) {
  pendingQuestionsRegistry.set(questionKey(meta.sessionId, meta.callId), meta);
}
function resolvePendingQuestion(sessionId: string, callId: string) {
  pendingQuestionsRegistry.delete(questionKey(sessionId, callId));
}
function listPendingQuestionsForSession(sessionId: string): PendingQuestionMeta[] {
  const prefix = `${sessionId}::`;
  return Array.from(pendingQuestionsRegistry.entries())
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v);
}
function clearPendingQuestionsForSession(sessionId: string) {
  const prefix = `${sessionId}::`;
  for (const k of Array.from(pendingQuestionsRegistry.keys())) {
    if (k.startsWith(prefix)) pendingQuestionsRegistry.delete(k);
  }
}

/**
 * Per-ask random nonce so pi-agent:respond-tool must present proof it
 * received the original tool-confirm-required push. Without this, any
 * renderer-side script (a compromised web content, a UI plugin) could
 * call window.electron.piAgent.respondTool(sid, cid, true) for a
 * callId it saw broadcast — approving every pending ask silently and
 * defeating the entire approval gate. Nonces are minted in main-side
 * when the ask is emitted, sent to the renderer in the confirm-required
 * event, and required on the respond-tool payload.
 */
const pendingAskNonces = new Map<string, string>();
function nonceKey(sessionId: string, callId: string) {
  return `${sessionId}::${callId}`;
}
function mintAskNonce(sessionId: string, callId: string): string {
  // 128-bit cryptographic nonce — 32 hex chars, well past guessing range.
  const bytes = new Uint8Array(16);
  // globalThis.crypto is present in Node 24 + Electron main; node:crypto
  // webcrypto is the fallback for older runtimes or unusual bundling paths.
  (globalThis.crypto ?? nodeWebCrypto).getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  pendingAskNonces.set(nonceKey(sessionId, callId), nonce);
  return nonce;
}
function verifyAskNonce(sessionId: string, callId: string, presented: unknown): boolean {
  const expected = pendingAskNonces.get(nonceKey(sessionId, callId));
  return typeof presented === "string" && expected !== undefined && presented === expected;
}
function dropAskNonce(sessionId: string, callId: string) {
  pendingAskNonces.delete(nonceKey(sessionId, callId));
}
function clearAskNoncesForSession(sessionId: string) {
  const prefix = `${sessionId}::`;
  for (const k of Array.from(pendingAskNonces.keys())) {
    if (k.startsWith(prefix)) pendingAskNonces.delete(k);
  }
}

/** Drop every pending resolver + approval grant belonging to one session. */
function sweepSessionPendings(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const map of [cordisPendingApprovals, cordisPendingQuestions]) {
    for (const key of Array.from(map.keys())) {
      if (key.startsWith(prefix)) map.delete(key);
    }
  }
  clearSessionGrants(sessionId);
  pendingAsks.clearSession(sessionId);
  clearPendingQuestionsForSession(sessionId);
  clearAskNoncesForSession(sessionId);
  forgetSessionApprovalArgs(sessionId);
  setConfirmTransport(sessionId, undefined);
}

/** The raw turn inputs the Cordis coding loop needs (prompt + attachments + config). */
interface CordisTurnPayload {
  message: string;
  images?: Array<{ kind?: "image" | "pdf"; dataUrl: string; name?: string }>;
  projectId?: string;
  workspaceId?: string;
  personality?: string;
  autoApprove: boolean;
  /** automation-dev → read-only sandbox (file-only, no escape); else workspace-write. */
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  /** Session persona ("default" | "automation-dev"). automation-dev is a
   *  restricted coding session for authoring an automation's scripts — no
   *  bash, no Cairn data tools; the pre-Cordis loop enforced this via
   *  AUTOMATION_DEV_TOOLS. Restored here so the restriction can be applied
   *  to the Cordis tool registrations too. */
  role?: "default" | "automation-dev";
}

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
 * Cordis wrapper — builds all IPC-forwarding callbacks and calls
 * runCordisCodingSession (which drives the dsh agent loop). Extracted to
 * eliminate duplication between the pi-agent:prompt and pi-agent:approve-plan
 * handlers — both resolve their differences (system prompt, initial message)
 * before calling this. The compaction transformer + tool loop are owned by
 * dsh now; this thin wrapper only wires the send/emit adapters.
 */
async function runSession(
  session: PiAgentSession,
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
// pi-agent:* IPC + runningLoops lifecycle the builtin path uses. The dsh loop
// owns the model↔tool iteration, session persistence (jsonl), plan mode,
// approvals, doom-loop, skills, sandbox, attachments, compaction, and retries;
// nothing here re-implements them.
async function runCordisCodingSession(
  session: PiAgentSession,
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

  // Coalesce streamed deltas into ~20 IPC events/sec (same as the builtin path).
  const tokens = createDeltaBatcher((delta) => send("session:token", { sessionId, delta }));
  const thoughts = createDeltaBatcher((delta) => send("session:thought", { sessionId, delta }));

  // Route the loop's raw pi-agent:* events through the delta batchers, then out.
  const loopSend = (channel: string, evtPayload: Record<string, unknown>) => {
    if (channel === "session:token" && typeof evtPayload.delta === "string") { tokens.push(evtPayload.delta); return; }
    if (channel === "session:thought" && typeof evtPayload.delta === "string") { thoughts.push(evtPayload.delta); return; }
    if (channel === "session:done" || channel === "session:error") { tokens.flush(); thoughts.flush(); }
    if (channel === "session:plan-note" && typeof evtPayload.noteId === "string") {
      try { q.updatePiSession(ctx.db, sessionId, { planNoteId: evtPayload.noteId, updatedAt: ts() }); } catch { /* non-critical */ }
    }
    send(channel, { sessionId, ...evtPayload });
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
    registerPending: (callId, resolve) => {
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
      llmConfig: { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey, provider: llmConfig.provider === "localllm" ? "localllm" : "openai" },
      mode,
      autoApprove: payload.autoApprove,
      sandboxMode: payload.sandboxMode,
      role: payload.role,
      send: (channel, payload) => {
        // Record outstanding approval asks so a reloaded renderer can pull
        // them back via is-running (the original push died with the old page).
        if (payload && typeof payload === "object" && typeof (payload as { callId?: unknown }).callId === "string") {
          const p = payload as { sessionId?: string; name?: string; label?: string; callId?: string };
          if (p.sessionId) {
            if (channel === "session:tool-confirm-required") {
              // Mint a per-ask nonce so pi-agent:respond-tool must present
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
          // options) back via pi-agent:is-running — the original push dies
          // with the old page, and losing it would strand the review with
          // no UI to answer it.
          if (channel === "session:ask-questions") {
            const requestId = typeof p.callId === "string" ? p.callId : undefined;
            const qs = Array.isArray(p.questions) ? p.questions : undefined;
            if (requestId && qs) {
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
          const key = pendingKey(sessionId, requestId);
          cordisPendingQuestions.set(key, resolve);
          return () => {
            cordisPendingQuestions.delete(key);
            resolvePendingQuestion(sessionId, requestId);
          };
        },
      },
      approvals: {
        registerPending: (callId, resolve) => {
          const key = pendingKey(sessionId, callId);
          cordisPendingApprovals.set(key, resolve);
          return () => cordisPendingApprovals.delete(key);
        },
      },
    });
  } catch (err) {
    tokens.flush();
    thoughts.flush();
    if (!session.abortCtrl.signal.aborted) {
      send("session:error", { sessionId, error: (err as Error)?.message ?? String(err) });
    }
  } finally {
    runningLoops.delete(sessionId);
    // The turn is over — every ask in it was settled (answered, aborted, or
    // timed out). Drop any registry residue so the next turn starts clean.
    pendingAsks.clearSession(sessionId);
    setConfirmTransport(sessionId, undefined);
    tokens.flush();
    thoughts.flush();
  }
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
  // renderer's local state. Also returns the session's outstanding approval
  // asks so a reload that swallowed the original push can re-render the cards.
  registerIpcHandle("session:is-running", (_event, { sessionId }: { sessionId: string }) => {
    return {
      running: runningLoops.has(sessionId),
      pendingAsks: pendingAsks.listForSession(sessionId),
      // Outstanding question asks (ask_questions / plan-review). The renderer
      // uses this to re-open a PlanReviewCard after a reload that swallowed
      // the original pi-agent:ask-questions push.
      pendingQuestions: listPendingQuestionsForSession(sessionId).map((q) => ({
        callId: q.callId,
        questions: q.questions,
      })),
    };
  });

  // ── pi-agent:context-ring ─────────────────────────────────────────────────
  // Reasoning-provenance snapshot ("whose thinking is in context") for the
  // agent panel's ring badge. Unavailable → renderer hides the pill.
  registerIpcHandle("session:context-ring", (_event, { sessionId }: { sessionId: string }) => handle(async () => {
    const { readContextRing } = await import("../cordis/run-cordis-loop");
    return readContextRing(sessionId);
  }));

  // ── pi-agent:abort ────────────────────────────────────────────────────────
  registerIpcOn("session:abort", (_event, { sessionId }: { sessionId: string }) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.abortCtrl.abort();
    }
  });

  // ── pi-agent:prompt ───────────────────────────────────────────────────────
  registerIpcOn("session:prompt", async (event, req: PiAgentPromptRequest) => {
    const { sessionId, prompt, projectId, workspaceId, cwd, taskTitle, mode = "execute" } = req;

    const send = (channel: string, payload: unknown) => {
      broadcastEvent(channel, payload);
    };

    // Reject a second prompt for a session whose loop is already running —
    // starting a new loop would replace session.abortCtrl mid-flight and leave
    // the is-running state inconsistent. The renderer queues prompts while busy,
    // so this is a defensive guard, not the normal path.
    if (runningLoops.has(sessionId)) {
      send("session:error", { sessionId, error: "This agent session is already running — wait for the current turn to finish before sending another prompt." });
      return;
    }

    // Runtime-validate staged attachments BEFORE they are persisted into the
    // session or turned into content parts — a malformed/oversized data URL must
    // never reach the provider (or the transcript).
    if (req.attachments?.length) {
      for (const a of req.attachments) {
        const problem = validateAttachmentDataUrl(a?.dataUrl);
        if (problem) {
          send("session:error", {
            sessionId,
            error: `Invalid attachment${a?.name ? ` "${a.name}"` : ""}: ${problem}`,
          });
          return;
        }
      }
    }

    if (req.config?.provider === "localllm") {
      send("session:error", {
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
        // Temperature is renderer-authoritative (it resolves the capability gate
        // and the plan-mode override). Never fall back to a cached 0.3: an
        // explicit 0 must survive, and unset/unsupported must stay omitted.
        temperature: reqConfig?.temperature,
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
      // The renderer resolved the effective temperature (capability-gated;
      // undefined = omit → vendor default).
      temperature: reqConfig?.temperature,
      maxTokens:   reqConfig?.maxTokens,
      autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : false,
      isReasoningModel: reqConfig?.isReasoningModel,
      // No isLocalEndpoint→"localllm" coercion: a custom local endpoint
      // (Ollama, LM Studio, user-run llama.cpp) must keep its own baseUrl —
      // tagging it "localllm" would reroute requests into the app-managed
      // on-device llama-server in run-cordis-coding.ts. "localllm" only ever
      // arrives explicitly from the chat surface.
      provider: reqConfig?.provider,
      contextWindow: reqConfig?.contextWindow,
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

    const sessionRow = q.getPiSessionById(ctx.db, sessionId);
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
    const systemPrompt = buildPiAgentSystemPrompt({
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
      autoApprove: llmConfig.autoApprove !== false,
      // Confine fs mutations to cwd for every coding session. automation-dev
      // has its own persona-scoped tool filter (see role below) that removes
      // bash + Cairn data tools, restoring the pre-Cordis AUTOMATION_DEV_TOOLS
      // restriction — the fs sandbox stays workspace-write so the persona can
      // still edit its scripts.
      sandboxMode: "workspace-write",
      role,
    });
  });

  // ── pi-agent:approve-plan ─────────────────────────────────────────────────
  // Renderer fires this when the user clicks "Approve Plan". Fetches the PRD
  // note, injects the approval message, then continues in execute mode.
  registerIpcOn("session:approve-plan", async (_event, req: PiAgentApprovePlanRequest) => {
    const { sessionId, planNoteId, projectId, workspaceId, cwd, taskTitle } = req;

    const send = (channel: string, payload: unknown) => {
      broadcastEvent(channel, payload);
    };

    // Same concurrency guard as pi-agent:prompt — a plan approval is also a
    // loop run and must never stack on an in-flight loop for this session.
    if (runningLoops.has(sessionId)) {
      send("session:error", { sessionId, error: "This agent session is already running — wait for the current turn to finish before approving the plan." });
      return;
    }

    if (req.config?.provider === "localllm") {
      send("session:error", {
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
        // Temperature is renderer-authoritative (it resolves the capability gate
        // and the plan-mode override). Never fall back to a cached 0.3: an
        // explicit 0 must survive, and unset/unsupported must stay omitted.
        temperature: reqConfig?.temperature,
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
      // The renderer resolved the effective temperature (capability-gated;
      // undefined = omit → vendor default).
      temperature: reqConfig?.temperature,
      maxTokens:   reqConfig?.maxTokens,
      autoApprove: reqConfig?.autoApprove !== undefined ? reqConfig.autoApprove : false,
      isReasoningModel: reqConfig?.isReasoningModel,
      // Same no-coercion rule as pi-agent:prompt (see above).
      provider: reqConfig?.provider,
      contextWindow: reqConfig?.contextWindow,
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
    const sessionRow = q.getPiSessionById(ctx.db, sessionId);
    const role = q.normalizeSessionRole(sessionRow?.role);
    session.role = role;

    const skills = discoverSkills(cwd);
    const systemPrompt = buildPiAgentSystemPrompt({ projectName, cwd, taskTitle, workspaceId, projectId, mode: "execute", planContent, role });

    const toolCtx: AgentToolContext = {
      cwd, db: ctx.db, workspacePath: ctx.workspacePath, sessionId, send, getWin, skills,
      req: { message: "", threadId: sessionId, projectId, workspaceId,
             config: { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey } },
    };

    await runSession(session, systemPrompt, llmConfig, "execute", toolCtx, ctx, send, {
      message: `The plan has been approved. Begin implementation now, following the approved PRD exactly. The PRD note ID is ${planNoteId} — you can re-read it via get_note if needed.`,
      projectId,
      workspaceId,
      autoApprove: llmConfig.autoApprove !== false,
      sandboxMode: "workspace-write",
      role,
    });
  });

  // ── pi-agent:compact-now ─────────────────────────────────────────────────
  // Triggered by the /compact slash command. Auto-compaction (BasicCompactionEngine,
  // thresholdRatio 0.8) runs between steps automatically; this is the explicit
  // user-triggered variant. It opens the session's agent from its persisted jsonl
  // (idle), runs ctx.compaction.compactNow(agent), then disposes it.
  registerIpcOn("session:compact-now", async (_event, req: { sessionId: string; config?: { baseUrl?: string; model?: string; apiKey?: string; contextWindow?: number } }) => {
    const { sessionId } = req;
    const send = (channel: string, payload: unknown) => {
      broadcastEvent(channel, payload);
    };
    if (runningLoops.has(sessionId)) {
      send("session:compact-result", { sessionId, messageCount: 0, summary: "Can't compact while the agent is working — try again when it finishes." });
      return;
    }
    const sessionRow = q.getPiSessionById(ctx.db, sessionId) as { cwd?: string } | undefined;
    const cwd = sessionRow?.cwd ?? "/";
    const llmConfig: AgentLLMConfig = {
      baseUrl: normaliseBaseUrl(req.config?.baseUrl || "https://api.openai.com"),
      model: req.config?.model || "gpt-5.6-luna",
      apiKey: resolveLlmApiKey(req.config?.apiKey),
      maxSteps: 20,
      temperature: 0.1,
      contextWindow: req.config?.contextWindow,
    };
    send("session:compact", { sessionId, status: "start" });
    try {
      const { getContext } = await import("../cordis/run-cordis-loop");
      const { openCordisAgent } = await import("../cordis/run-cordis-coding");
      const ctxC = await getContext();
      await (await import("../cordis/run-cordis-loop")).ensurePiAiAdapter(ctxC, {
        baseUrl: llmConfig.baseUrl,
        model: llmConfig.model,
        apiKey: llmConfig.apiKey,
        api: (await (await import("../lib/llm-transport")).resolveTransport(llmConfig.baseUrl, llmConfig.apiKey)).mode === "responses" ? "openai-responses" : "openai-completions",
      });
      const handle = await openCordisAgent(ctxC, { sessionId, cwd, llmConfig: { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey, provider: "openai" as const }, signal: new AbortController().signal });
      try {
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

  // ── pi-agent:set-mode ─────────────────────────────────────────────────────
  // Plan mode is dsh-owned. The toggle executes dsh's /plan command through
  // ctx.commands on a short-lived resumed agent. The session log is the source
  // of truth; SQLite is updated only after a successful command and a committed
  // plan/mode event have been observed.
  registerIpcOn("session:set-mode", (_event, { sessionId, mode }: { sessionId: string; mode: "plan" | "execute" }) => {
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
          const events = ((handle as { agent: { session?: { events?: readonly SessionEvent[] } } }).agent.session?.events ?? []);
          const committedMode = foldPlanMode(events) ? "plan" : "execute";
          if (committedMode !== mode) {
            throw new Error(`plan mode command did not commit ${mode}`);
          }
          try {
            q.updatePiSession(ctx.db, sessionId, { mode: committedMode, updatedAt: ts() });
          } catch (e) {
            console.warn("[pi-agent] failed to update session mode index:", e);
          }
          broadcastEvent("session:mode-change", { sessionId, mode: committedMode });
        } finally {
          try { await (handle as { dispose?: () => Promise<void> }).dispose?.(); } catch { /* noop */ }
        }
      } catch (e) {
        // Do not update or broadcast a requested mode when dsh rejected it.
        // The durable session log remains authoritative and the UI can retry.
        console.warn("[pi-agent] /plan execution failed:", e instanceof Error ? e.message : e);
      }
    })();
  });

  // ── pi-agent:respond-tool ──────────────────────────────────────────────────
  // Resolve the Cordis loop's approval adapter (keyed `${sessionId}::${callId}`).
  // grant:"command" records the exact canonicalized bash command in the
  // session's durable grants — using the TRUSTED args recorded at
  // tools/pre-execute time (main-side), NOT the renderer's echo. A compromised
  // renderer / UI plugin can send anything in `command`; the actual command
  // dsh will execute is what we stashed via recordPendingApprovalArgs. If the
  // two disagree (or the renderer's command is absent), the grant is a no-op:
  // fail-closed on the record path.
  registerIpcOn("session:respond-tool", (_event, { sessionId, callId, approved, grant, nonce }: { sessionId: string; callId: string; approved: boolean; grant?: "session" | "command"; command?: string; nonce?: string }) => {
    // Require the per-ask nonce — a compromised renderer (XSS from a
    // rendered note, an installed UI plugin) that only saw the callId
    // broadcast on pi-agent:tool-confirm-required must NOT be able to
    // auto-approve every ask. The nonce is minted main-side and returned
    // in the confirm-required event; only a legitimate consumer of that
    // event has it. Fail-closed on absence / mismatch.
    if (!verifyAskNonce(sessionId, callId, nonce)) {
      console.warn(`[pi-agent] respond-tool rejected: bad or missing nonce for ${sessionId}/${callId}`);
      return;
    }
    const key = pendingKey(sessionId, callId);
    const cordisPending = cordisPendingApprovals.get(key);
    if (!cordisPending) return;
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
  });

  // ── pi-agent:respond-questions ─────────────────────────────────────────────
  // Answers to a blocked ask_questions call. The formatted answer text is fed
  // back to the model as the tool result so it reasons over the answers in the
  // same turn. Cordis keys by requestId (which the renderer echoes as callId).
  registerIpcOn("session:respond-questions", (_event, { sessionId, callId, answers }: { sessionId: string; callId: string; answers: string }) => {
    const key = pendingKey(sessionId, callId);
    const cordisPending = cordisPendingQuestions.get(key);
    if (cordisPending) {
      cordisPending(answers);
      cordisPendingQuestions.delete(key);
    }
    // Drop the recovery registry entry: whether the user answered normally
    // or dismissed via { __dismissed__: true }, the ask has settled and a
    // subsequent is-running poll must NOT re-surface it.
    resolvePendingQuestion(sessionId, callId);
  });

  // ── pi-agent:clear ────────────────────────────────────────────────────────
  // Clears a session's message history (new conversation within same session).
  // Also resets the compaction transformer so the new conversation starts
  // with a fresh cachedSummary.
  registerIpcOn("session:clear", (_event, { sessionId }: { sessionId: string }) => {
    // Reject renderer-supplied ids that could path-traverse before they reach
    // fs.rmSync() below. Any legitimate session id (pi-<nanoid>, subagent uuid)
    // passes; `..`, `/`, `\`, empty, over-length, control chars all fail here.
    try {
      assertSafeId(sessionId, "sessionId");
    } catch (err) {
      broadcastEvent("session:error", { sessionId, error: (err as Error).message });
      return;
    }
    // Clearing the persisted log while a loop is running would desync its
    // in-flight context. The renderer stops the run before clearing, so this is
    // defensive.
    if (runningLoops.has(sessionId)) {
      broadcastEvent("session:error", { sessionId, error: "Can't clear while the agent is working — stop the run first." });
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
            const base = resolveWithinRoot(root, proj, sessionId);
            if (!base) continue;
            for (const p of [path.join(base, "session.jsonl.zstd"), path.join(base, "session.jsonl"), base + ".jsonl", path.join(base, "session.jsonl"), base]) {
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
  });

  // ── pi-agent:destroy ──────────────────────────────────────────────────────
  // Called when a pi session tab is closed — frees memory
  registerIpcOn("session:destroy", (_event, { sessionId }: { sessionId: string }) => {
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

  // ── pi-agent:restore-context ───────────────────────────────────────────────────────
  // On the Cordis engine, session context resumes automatically via the dsh
  // jsonl log (ctx.sessionPersistence.inspect → ctx.agents.resume in
  // run-cordis-coding.ts) — there is no pi_agent_llm_history on this path.
  // This handler just restores the persisted session persona so a re-prompt
  // keeps the session's tool restrictions (validated, failing closed).
  registerIpcOn("session:restore-context", (_event, { sessionId }: { sessionId: string }) => {
    if (sessions.has(sessionId)) return; // already in memory
    try {
      const sessionRow = q.getPiSessionById(ctx.db, sessionId);
      sessions.set(sessionId, {
        abortCtrl: new AbortController(),
        role: q.normalizeSessionRole(sessionRow?.role),
      });
    } catch (e) {
      console.warn("[pi-agent] restore-context failed for", sessionId, e);
    }
  });
}
