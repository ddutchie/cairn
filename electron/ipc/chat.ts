/**
 * Cairn — AI Chat IPC handler
 *
 * Runs the OpenAI-compatible completions loop in the Electron main process
 * so it works in the packaged app (no Next.js server needed).
 *
 * Registered as: registerIpcOn("chat:stream", ...)
 */

import { registerIpcHandle, registerIpcOn, broadcastEvent } from "./registry";
import { broadcastToChat } from "../chat-popout";
import type { DbContext } from "./result-helpers";
import { isLocalEndpoint, normaliseBaseUrl, type OpenAIMessage, calculatePromptBreakdown, scaleBreakdown, type TokenBreakdown, isSendableMessage } from "../lib/llm";
import { TOOLS, buildSystemPrompt, withPersonality, type ChatRequest } from "../lib/tools";
import { getExternalToolDefs } from "../lib/external-tools";
import { getCachedConfig, cacheLlmConnection } from "../lib/config-cache";
import { resolveSystemRole } from "../lib/llm-stream";
import { resolveLlmApiKey } from "../lib/secure-store";
import { buildAttachmentParts } from "../../shared/models/pdf-attach";
import { resolveCreditSpec, probeCredits } from "../lib/provider-credits";
import { fetchProvidersManifest } from "../lib/community-registry";
import { recordLlmUsage } from "../lib/usage-recorder";
import { applyRecoveredTurnCost } from "../db/usage-queries";
import { createDeltaBatcher } from "../lib/delta-batcher";

// Track one AbortController per renderer webContents ID
const abortControllers = new Map<number, AbortController>();

// Pending ask_questions requests (Cordis engine): the cairn-questions provider
// blocks on ask() and stores its resolver here keyed by requestId; the renderer
// answers via chat:answer-questions, which resolves it (same-turn answer flow).
const pendingChatQuestions = new Map<string, (answersText: string) => void>();

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
export function registerChatHandler(ctx: DbContext): void {
  const getWin = ctx.getWin;

  registerIpcHandle("chat:compactThread", async (_event, req: {
    messages: Array<{ role: string; content: string }>;
    threadId?: string;
    config: { provider?: string; baseUrl?: string; model?: string; apiKey?: string };
  }) => {
    try {
      const { baseUrl, model, apiKey } = resolveAIConfig(req.config);
      const threadId = req.threadId;
      if (!threadId) return { error: "compact: threadId required" };

      // Session-as-truth compaction via the SHARED flow (also registered as the
      // dsh `compact` command — one implementation, two entry points).
      const { compactChatSession } = await import("../cordis/cairn-commands");
      const { getContext } = await import("../cordis/run-cordis-loop");
      const res = await compactChatSession(getContext, threadId, { baseUrl, model, apiKey });
      if (!res.ok) return { error: res.error ?? "compact failed" };
      console.log("[chat:compactThread] compactNow result", { threadId, compacted: res.compacted });
      return { data: { compacted: res.compacted } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[chat:compactThread] failed", msg, err);
      return { error: msg };
    }
  });

  // chat:abort — cancel the in-flight stream for this renderer
  registerIpcOn("chat:abort", (event) => {
    const ctrl = abortControllers.get(event.sender.id);
    if (ctrl) {
      ctrl.abort();
      abortControllers.delete(event.sender.id);
    }
  });

  // chat:answer-questions — the renderer's answer to a blocking ask_questions
  // (Cordis engine). Resolves the pending provider promise so the tool result
  // (the answers) is fed back to the model in the same turn. answers is the
  // JSON blob {answers:[{id,selected[],custom?}]} or plain text.
  registerIpcOn("chat:answer-questions", (_event, req: { requestId: string; answers: string }) => {
    const resolve = pendingChatQuestions.get(req.requestId);
    if (resolve) resolve(req.answers ?? "");
  });

  // chat:stream — fire-and-forget (registerIpcOn, not handle).
  // Emits:
  //   chat:token   { delta: string }   — one SSE content chunk
  //   chat:tool-call { tool, label, args } — tool being invoked
  //   chat:done    { content: string, contextRefs: [], error?: string }
  registerIpcOn("chat:stream", async (event, req: ChatRequest) => {
    // Cancel any previous in-flight request from this renderer
    abortControllers.get(event.sender.id)?.abort();
    const abortCtrl = new AbortController();
    abortControllers.set(event.sender.id, abortCtrl);
    
    const { provider, baseUrl, model, apiKey } = resolveAIConfig(req.config);
    const isLocalEndpointUrl = isLocalEndpoint(baseUrl);

    const send = (ch: string, payload: unknown) => {
      // Tag every streaming event with the originating threadId so renderer
      // consumers (chat panel vs. the note "Spawn tasks" one-shot) can filter
      // events that aren't theirs. Without this, a spawn stream's chat:done
      // would toggle the chat panel's loading state and disable its input.
      const tagged = (payload && typeof payload === "object")
        ? { ...(payload as Record<string, unknown>), threadId: req.threadId }
        : payload;
      if (!event.sender.isDestroyed()) event.sender.send(ch, tagged);
      broadcastToChat(ch, tagged, event.sender.id);
    };

    if (provider !== "localllm" && !apiKey && !isLocalEndpointUrl) {
      send("chat:done", {
        content: "AI chat is not configured. Set an API key in **Settings → AI & Chat**, or use a local endpoint (Ollama, LM Studio) with no key needed.",
        contextRefs: [],
      });
      return;
    }

    // Attachments are forwarded to the model: images as standard image_url
    // parts, PDFs as Anthropic-style `document` base64 parts (built by the
    // shared helper). We can't reliably guess vision/pdf support from a model
    // id — cloud APIs, custom OpenAI-compatible endpoints, and on-device models
    // all expose arbitrary names. The renderer gates what may attach (it knows
    // the catalog), so a part that arrives here is meant for this model / endpoint.

    const userMessage: OpenAIMessage = req.images?.length
      ? ({
          role: "user",
          content: buildAttachmentParts(req.message, req.images),
        } as unknown as OpenAIMessage)
      : { role: "user", content: req.message };

    // Compose the system prompt ONCE — buildSystemPrompt embeds the current
    // date, so recomputing it later (the token-usage breakdown) could measure a
    // different string if a turn crosses midnight.
    const systemContent = withPersonality(buildSystemPrompt(req), req.personality);

    const messages: OpenAIMessage[] = [
      {
        role: resolveSystemRole({ isReasoningModel: req.config?.isReasoningModel, baseUrl, provider, modelId: model }),
        content: systemContent,
      },
      ...(req.history ?? [])
        // Drop assistant turns that carry neither content nor tool_calls — a
        // thinking model that timed out or stopped mid-reasoning leaves such a
        // turn behind, and replaying it makes the provider reject the whole
        // request with "content or tool_calls must be set" (400).
        .filter(isSendableMessage)
        .map((m) => {
          const out: OpenAIMessage = { role: m.role, content: m.content };
          if (m.tool_calls) out.tool_calls = m.tool_calls;
          if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
          if (m.name) out.name = m.name;
          // Round-trip reasoning metadata persisted on the message so a resumed
          // thread keeps its chain-of-thought (chat-loop gates on model key).
          if (m.reasoning) out.reasoning = m.reasoning;
          if (m.reasoningField) out.reasoningField = m.reasoningField;
          if (m.reasoningModel) out.reasoningModel = m.reasoningModel;
          if (m.reasoningItems) out.reasoningItems = m.reasoningItems;
          return out;
        }),
      userMessage,
    ];

    const emitToolCall = (e: { tool: string; label: string; args: Record<string, unknown>; callId?: string }) => {
      send("chat:tool-call", e);
    };

    const emitToolCallDone = (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; externalRef?: { url: string; title?: string; snippet?: string }; output?: string; callId?: string; ok?: boolean; error?: string }) => {
      send("chat:tool-call-done", e);
    };

    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let costUsd: number | undefined = undefined;
    let lastBreakdown: TokenBreakdown | undefined = undefined;

    // Assemble external tool defs (MCP servers + custom services) in scope for
    // this workspace/project. Failures degrade to no external tools.
    let externalDefs: typeof TOOLS = [];
    try {
      externalDefs = (await getExternalToolDefs(ctx.db, req.workspaceId ?? "", req.projectId ?? "")) as typeof TOOLS;
    } catch (err) {
      console.error("[chat] failed to assemble external tools:", err);
    }
    const allTools = externalDefs.length > 0 ? [...TOOLS, ...externalDefs] : TOOLS;

    const addUsage = (pt: number, ct: number, rt?: number, cost?: number, cacheRead?: number, cacheCreate?: number) => {
      // Persist one usage row per tool-loop round (source = chat) for the Usage view.
      recordLlmUsage({
        source: "chat",
        sessionId: req.threadId,
        projectId: req.projectId,
        workspaceId: req.workspaceId,
        provider,
        model,
        baseUrl,
        promptTokens: pt,
        completionTokens: ct,
        reasoningTokens: typeof rt === "number" ? rt : 0,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreate,
        costUsd: cost,
      });
      promptTokens = pt;
      completionTokens += ct;
      if (typeof rt === "number") reasoningTokens += rt;
      // Cache tokens are last-round only, mirroring promptTokens (the context
      // window shown is the current round's, not a running sum).
      if (typeof cacheRead === "number") cacheReadTokens = cacheRead;
      if (typeof cacheCreate === "number") cacheCreationTokens = cacheCreate;
      // Provider-reported USD cost of this call (e.g. Neuralwatt usage.cost);
      // accumulated across tool-loop rounds like completion tokens. Only
      // non-negative finite values are accepted; an explicitly reported 0 is
      // preserved, and nothing is set when the provider reports no cost.
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        costUsd = (costUsd ?? 0) + cost;
      }
      try {
        const rawBreakdown = calculatePromptBreakdown(systemContent, messages, allTools);
        lastBreakdown = scaleBreakdown(rawBreakdown, promptTokens);
      } catch (err) {
        console.error("[chat] failed to calculate breakdown:", err);
      }
      const resolvedLimit = req.config?.contextLimit ?? req.config?.contextWindow;
      send("chat:usage", { promptTokens, completionTokens, reasoningTokens, breakdown: lastBreakdown, costUsd, cacheReadTokens, cacheCreationTokens, contextLimit: resolvedLimit, contextWindow: resolvedLimit });
    };

    // Final usage object attached to chat:done (or undefined when nothing ran —
    // a cost-only report is still retained, not dropped for having no tokens).
    const finalUsage = () => {
      const resolvedLimit = req.config?.contextLimit ?? req.config?.contextWindow;
      return promptTokens > 0 || costUsd != null
        ? {
            promptTokens,
            completionTokens,
            reasoningTokens,
            breakdown: lastBreakdown,
            costUsd: costUsd != null ? costUsd : undefined,
            cacheReadTokens,
            cacheCreationTokens,
            contextLimit: resolvedLimit,
            contextWindow: resolvedLimit,
          }
        : undefined;
    };

    // ── Subagent mode ─────────────────────────────────────────────────────────
    // The builtin dispatch → research/write subagent loop (chat-subagent-loop)
    // has been removed — Cordis handles subagents natively via cairn-subagent
    // (the dsh subagent tool, run-cordis-loop.ts:144) which emits chat:subagent*
    // events. So `req.useSubagents` is covered by the Cordis loop below.

    // ── Cordis engine (only path — local models via llama-server at 127.0.0.1:<port>/v1 are also OpenAI-compatible) ──
    if (true) {
      const { runCordisLoop } = await import("../cordis/run-cordis-loop");
      const tokens = createDeltaBatcher((delta) => send("chat:token", { delta }));
      const thoughts = createDeltaBatcher((delta) => send("chat:thought", { delta }));
      const flushStream = () => { tokens.flush(); thoughts.flush(); };
      try {
        const loopResult = await runCordisLoop({
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
          },
          signal: abortCtrl.signal,
          onToken: (d) => tokens.push(d),
          onThought: (d) => thoughts.push(d),
          onUsage: addUsage,
          emitToolCall,
          emitToolCallDone,
          getWin,
          sendSubagent: (channel, payload) => send(channel, payload),
          questions: {
            send: (channel, payload) => send(channel, payload),
            registerPending: (requestId, resolve) => {
              pendingChatQuestions.set(requestId, resolve);
              return () => pendingChatQuestions.delete(requestId);
            },
          },
        });
        flushStream();
        if (!abortCtrl.signal.aborted) broadcastEvent("db:changed", null);
        if (abortCtrl.signal.aborted) {
          send("chat:done", { content: "", reasoning: loopResult.reasoning, contextRefs: [], usage: finalUsage() });
        } else {
          send("chat:done", { content: loopResult.content, reasoning: loopResult.reasoning, reasoningSummary: loopResult.reasoningSummary, reasoningItems: loopResult.reasoningItems, reasoningField: loopResult.reasoningField, reasoningModel: loopResult.reasoningModel, contextRefs: [], usage: finalUsage() });
        }
      } catch (err) {
        flushStream();
        if (!abortCtrl.signal.aborted) {
          console.error("[chat] cordis loop failed:", err);
          send("chat:done", { content: `Chat loop failed: ${(err as Error)?.message ?? String(err)}`, contextRefs: [] });
        } else {
          send("chat:done", { content: "", contextRefs: [] });
        }
      } finally {
        abortControllers.delete(event.sender.id);
      }
      return;
    }
  });
}
