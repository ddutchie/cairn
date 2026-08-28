/**
 * Cairn — AI Chat IPC handler
 *
 * Runs the OpenAI-compatible completions loop in the Electron main process
 * so it works in the packaged app (no Next.js server needed).
 *
 * Registered through the canonical session:prompt IPC handler.
 */

import { registerIpcHandle, broadcastEvent } from "./registry";
import { handle } from "./result-helpers";
import { broadcastToChat } from "../chat-popout";
import { mintAskNonce, dropAskNonce, clearAskNoncesForSession } from "./ask-nonce";
import { cordisPendingApprovals, pendingKey, pendingAsks } from "./approval-state";
import { createInteractiveConfirmTransport, setConfirmTransport } from "../cordis/approval-transports";
import { forgetSessionApprovalArgs } from "../cordis/approval-grants";
import type { DbContext } from "./result-helpers";
import { isLocalEndpoint, normaliseBaseUrl } from "../lib/llm";
import type { ChatRequest } from "../lib/tools";
import { getCachedConfig, cacheLlmConnection } from "../lib/config-cache";
import { resolveLlmApiKey } from "../lib/secure-store";
import { registerPendingQuestion, recordPendingQuestion } from "../cordis/pending-question-broker";
import { makeSessionProjection } from "../../shared/agent/session-projection";

// One controller and concurrency slot per canonical session, regardless of
// which renderer issued the prompt.
const abortControllers = new Map<string, AbortController>();

/**
 * Threads that currently have an in-flight streaming turn. Prevents two
 * concurrent session:prompt requests on the SAME thread from writing to the
 * same session.jsonl.zstd in parallel — dsh's in-process persistence
 * serialises WRITES (so the file doesn't tear), but the two turns' events
 * still interleave into an incoherent transcript. Mirrors the coding session
 * runtime's
 * `runningLoops` guard on the coding side (review finding M13).
 */
const runningThreads = new Set<string>();

export function getRunningChatIds(): string[] {
  return Array.from(runningThreads).map((id) => `chat-${id}`);
}

export function isChatThreadRunning(sessionId: string): boolean {
  const raw = sessionId.startsWith("chat-") ? sessionId.slice(5) : sessionId;
  return runningThreads.has(raw);
}

export function abortChatSession(sessionId: string): void {
  abortControllers.get(sessionId)?.abort();
  abortControllers.delete(sessionId);
  const raw = sessionId.startsWith("chat-") ? sessionId.slice(5) : sessionId;
  runningThreads.delete(raw);
}

function resolveAIConfig(config?: {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
} {
  // Persist the connection (provider/baseUrl/model + a keychain-ref apiKey only;
  // cacheLlmConnection scrubs any raw key). The renderer sends a ref, not a key.
  cacheLlmConnection("ai", config);

  let reqConfig = config;
  const isLocal = config?.baseUrl ? isLocalEndpoint(normaliseBaseUrl(config.baseUrl)) : false;
  if (!reqConfig?.apiKey && reqConfig?.provider !== "localllm" && !isLocal) {
    const cached = getCachedConfig().aiConfig;
    if (cached?.apiKey) {
      reqConfig = {
        ...reqConfig,
        provider: reqConfig?.provider || cached.provider,
        baseUrl: reqConfig?.baseUrl || cached.baseUrl,
        model: reqConfig?.model || cached.model,
        apiKey: cached.apiKey,
      };
    }
  }

  return {
    provider: reqConfig?.provider ?? "openai",
    baseUrl: normaliseBaseUrl(reqConfig?.baseUrl ?? "https://api.openai.com"),
    model: reqConfig?.model ?? "gpt-5.6-luna",
    // Resolve the keychain ref (or pass a literal through) to the real key used
    // for this request only. Never stored anywhere from here on.
    apiKey: resolveLlmApiKey(reqConfig?.apiKey),
  };
}

// Re-export for backward compatibility (prd.ts and others import LLMConfig from here)
export type { LLMConfig } from "../lib/llm";
export { callLLM } from "../lib/llm";

/**
 * Registers the chat streaming channels.
 *
 * Reads `db` / `workspacePath` from `ctx` at CALL time, never at registration
 * time, so `reinitialise()` swapping the workspace is transparent. Capturing
 * them by value here is what previously left a freshly-onboarded workspace's
 * chat bound to the throwaway boot DB until the app was restarted.
 */
export function registerChatHandler(_ctx: DbContext): void {
  registerIpcHandle("chat:compactThread", (_event, req: {
    messages: Array<{ role: string; content: string }>;
    threadId?: string;
    config: { provider?: string; baseUrl?: string; model?: string; apiKey?: string; apiMode?: "responses" | "completions" | "anthropic-messages" };
  }) => handle(async () => {
      const { baseUrl, model, apiKey } = resolveAIConfig(req.config);
      const threadId = req.threadId;
      if (!threadId) throw new Error("compact: threadId required");

      // Session-as-truth compaction via the SHARED flow (also registered as the
      // dsh `compact` command — one implementation, two entry points).
      const { compactChatSession } = await import("../cordis/cairn-commands");
      const { getContext } = await import("../cordis/run-cordis-loop");
      const res = await compactChatSession(getContext, threadId, { baseUrl, model, apiKey, apiMode: req.config.apiMode });
      if (!res.ok) throw new Error(res.error ?? "compact failed");
      console.log("[chat:compactThread] compactNow result", { threadId, compacted: res.compacted });
      return { compacted: res.compacted };
  }));

}

/** Shared Chat profile runner used by the canonical session:prompt handler. */
export async function runChatPrompt(ctx: DbContext, event: Electron.IpcMainEvent, req: ChatRequest): Promise<void> {
    const getWin = ctx.getWin;
    const sessionId = `chat-${req.threadId}`;
    // Concurrent-stream guard on the same thread: if another window (pop-out,
    // second Cairn instance) is already streaming this thread, refuse the
    // second stream instead of racing on the same session.jsonl.zstd. dsh's
    // persistence serialises writes, but the two turns would still interleave
    // into a semantically incoherent transcript. Check BEFORE aborting so a
    // concurrent turn is not killed and the new turn does not also start.
    if (req.threadId && runningThreads.has(req.threadId)) {
       broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — please wait for the current turn to finish.", code: "already-running" }));
       broadcastEvent("session:busy", { sessionId, reason: "already-running" });
       return;
    }
    // A new turn supersedes a previous turn from the same session.
    abortChatSession(sessionId);
    if (req.threadId) runningThreads.add(req.threadId);
    const abortCtrl = new AbortController();
     abortControllers.set(sessionId, abortCtrl);
    
    const { provider, baseUrl, model, apiKey } = resolveAIConfig(req.config);
    const isLocalEndpointUrl = isLocalEndpoint(baseUrl);

    const send = (ch: string, payload: unknown) => {
      // Tag every streaming event with the originating threadId so renderer
      // consumers (chat panel vs. the note "Spawn tasks" one-shot) can filter
      // events that aren't theirs. Without this, a spawn stream's completion
      // would toggle the chat panel's loading state and disable its input.
      const tagged = (payload && typeof payload === "object")
        ? { sessionId, ...(payload as Record<string, unknown>), threadId: req.threadId }
        : payload;
        const outChannel = ch;
        const outPayload = tagged;
       if (!event.sender.isDestroyed()) event.sender.send(outChannel, outPayload);
       // Intentionally scoped to chat participants (main + pop-out) — not
       // broadcastEvent (all windows + mobile). Coding sessions use
       // broadcastEvent because they are not participant-gated (see
       // session-runtime-handlers.ts). This split is deliberate; don't unify
       // without auditing the pop-out participant set.
       broadcastToChat(outChannel, outPayload, event.sender.id);
    };

    // Chat HITL: interactive approval transport so EXTERNAL/EXEC tools (and
    // deletions) gate through the same approval cards as coding. Mirrors the
    // coding loop's setConfirmTransport pattern; the pending-ask state is
    // shared via approval-state.ts so session:respond-tool's global handler
    // can resolve it regardless of which profile created the ask.
    const chatLoopSend = (channel: string, payload: Record<string, unknown>) => {
      if (channel === "session:projection" && payload && typeof payload === "object" && (payload as { kind?: unknown }).kind === "approval") {
        const data = (payload as { data?: { status?: string; callId?: string; name?: string; label?: string; nonce?: string } }).data;
        if (data?.status === "required" && data.callId && !data.nonce) {
          const nonce = mintAskNonce(sessionId, data.callId);
          (data as { nonce?: string }).nonce = nonce;
          pendingAsks.record({ sessionId, name: data.name ?? "tool", label: data.label ?? data.name ?? "tool", callId: data.callId, nonce });
        } else if (data?.status === "expired" && data.callId) {
          pendingAsks.resolve(sessionId, data.callId);
          dropAskNonce(sessionId, data.callId);
          forgetSessionApprovalArgs(sessionId);
        }
      }
      send(channel, payload);
    };
    const chatConfirmTransport = createInteractiveConfirmTransport({
      sessionId,
      send: chatLoopSend,
      registerPending: (callId: string, resolve: (d: { approved: boolean; grant?: "session" | "command" | "workspace" }) => void) => {
        const key = pendingKey(sessionId, callId);
        cordisPendingApprovals.set(key, resolve);
        return () => cordisPendingApprovals.delete(key);
      },
    });
    setConfirmTransport(sessionId, chatConfirmTransport);

    if (provider !== "localllm" && !apiKey && !isLocalEndpointUrl) {
       abortControllers.delete(sessionId);
      if (req.threadId) runningThreads.delete(req.threadId);
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Missing API key — configure provider in Settings.", code: "missing-api-key" }));
      broadcastEvent("session:busy", { sessionId, reason: "missing-api-key" });
      return;
    }

    // Attachments are forwarded to the model: images as standard image_url
    // parts, PDFs as Anthropic-style `document` base64 parts (built by the
    // shared helper). We can't reliably guess vision/pdf support from a model
    // id — cloud APIs, custom OpenAI-compatible endpoints, and on-device models
    // all expose arbitrary names. The renderer gates what may attach (it knows
    // the catalog), so a part that arrives here is meant for this model / endpoint.

    // NOTE: usage is recorded exclusively by `cairnUsagePlugin` (mounted for
    // every Cordis session in mountCordisSessionPlugins). A per-turn
    // recordLlmUsage used to live here as well, which double-counted every chat
    // turn's tokens and cost in the Usage view.

    // ── Subagent mode ─────────────────────────────────────────────────────────
    // The builtin dispatch → research/write subagent loop (chat-subagent-loop)
    // has been removed — Cordis handles subagents natively via cairn-subagent
    // (the dsh subagent tool, run-cordis-loop.ts:144) which emits chat:subagent*
    // events. So `req.useSubagents` is covered by the Cordis loop below.

    // ── Cordis engine (only path — local models via llama-server at 127.0.0.1:<port>/v1 are also OpenAI-compatible) ──
    if (true) {
      const { runCordisLoop } = await import("../cordis/run-cordis-loop");
      try {
         await runCordisLoop({
          db: ctx.db,
          req,
          workspacePath: ctx.workspacePath,
          llmConfig: {
            baseUrl,
            model,
            apiKey,
            provider: (provider === "openai" || provider === "localllm" ? provider : "openai"),
            contextWindow: req.config?.contextLimit ?? req.config?.contextWindow,
            maxTokens: req.config?.maxTokens,
            reasoningEffort: req.config?.reasoningEffort,
            isReasoningModel: req.config?.isReasoningModel,
            apiMode: req.config?.apiMode,
          },
          signal: abortCtrl.signal,
          getWin,
             sendSubagent: (channel, payload) => send(channel.replace(/^chat:/, "session:"), payload),
           approvals: {
             send: chatLoopSend,
             registerPending: (callId: string, resolve: (d: { approved: boolean; grant?: "session" | "command" | "workspace" }) => void) => {
               const key = pendingKey(sessionId, callId);
               cordisPendingApprovals.set(key, resolve);
               return () => cordisPendingApprovals.delete(key);
             },
           },
           questions: {
              send: (channel, payload) => chatLoopSend(channel, payload),
               emitQuestions: (requestId, questions) => {
                 const nonce = mintAskNonce(sessionId, requestId);
                 recordPendingQuestion({ sessionId, callId: requestId, questions: questions as Array<{ id: string; [key: string]: unknown }> });
                  chatLoopSend("session:projection", makeSessionProjection(sessionId, "question", { callId: requestId, questions, nonce } as never));
               },
             registerPending: (requestId, resolve) => {
               return registerPendingQuestion(sessionId, requestId, resolve);
              },
           },
           onSessionEvent: (sessionEvent) => broadcastEvent("session:event", { sessionId, event: sessionEvent }),
         });
         if (!abortCtrl.signal.aborted) broadcastEvent("db:changed", null);
       } catch (err) {
         if (!abortCtrl.signal.aborted) {
           console.error("[chat] cordis loop failed:", err);
         }
      } finally {
         abortControllers.delete(sessionId);
        if (req.threadId) runningThreads.delete(req.threadId);
        setConfirmTransport(sessionId, undefined);
        pendingAsks.clearSession(sessionId);
        clearAskNoncesForSession(sessionId);
        forgetSessionApprovalArgs(sessionId);
        for (const k of Array.from(cordisPendingApprovals.keys())) if (k.startsWith(`${sessionId}::`)) cordisPendingApprovals.delete(k);
      }
      return;
    }
}
