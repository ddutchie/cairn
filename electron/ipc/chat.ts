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
import { runToolLoop } from "../lib/chat-loop";
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
      
      const llmConfig = {
        baseUrl,
        model,
        apiKey,
        maxSteps: 20,
        temperature: 0.1,
      };

      const { generateSummary } = await import("../lib/compaction");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agentMsgs = req.messages as any[];
      const summary = await generateSummary(agentMsgs, llmConfig, new AbortController().signal, { sessionId: req.threadId });
      return { data: { summary } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
      send("chat:usage", { promptTokens, completionTokens, reasoningTokens, breakdown: lastBreakdown, costUsd, cacheReadTokens, cacheCreationTokens });
    };

    // Final usage object attached to chat:done (or undefined when nothing ran —
    // a cost-only report is still retained, not dropped for having no tokens).
    const finalUsage = () =>
      promptTokens > 0 || costUsd != null
        ? {
            promptTokens,
            completionTokens,
            reasoningTokens,
            breakdown: lastBreakdown,
            costUsd: costUsd != null ? costUsd : undefined,
            cacheReadTokens,
            cacheCreationTokens,
          }
        : undefined;

    // ── Subagent mode ─────────────────────────────────────────────────────────
    // Per-thread toggle routes the turn through the dispatch → research/write
    // loop. It streams a live, expandable subagent trace to the renderer via
    // chat:subagent* events, then streams the dispatcher's final reply as tokens.
    if (req.useSubagents && provider !== "localllm") {
      const { runDispatchLoop } = await import("../lib/chat-subagent-loop");
      try {
        const dispatchResult = await runDispatchLoop(
          ctx.db, req, ctx.workspacePath, { baseUrl, model, apiKey, provider },
          getWin,
          {
            signal: abortCtrl.signal,
            events: {
              onSubagentStart: (e) => send("chat:subagent", { ...e, status: "start" }),
              onSubagentDone: (e) => send("chat:subagent", { ...e, status: "done" }),
              onSubagentToken: (e) => send("chat:subagent-token", e),
              onSubagentThought: (e) => send("chat:subagent-thought", e),
              onSubagentToolCall: (e) => send("chat:subagent-tool-call", e),
              onSubagentToolCallDone: (e) => send("chat:subagent-tool-call-done", e),
              onSubagentUsage: (e) => send("chat:subagent-usage", e),
            },
          },
        );

        // The main/total ContextRing must reflect the DISPATCHER's context window —
        // the system prompt + the subagent briefs fed back — NOT the summed cost of
        // every subagent turn. Each subagent reports its own usage via
        // chat:subagent-usage for its own ring. (metrics.promptTokens is the total
        // cost figure; metrics.dispatcherPromptTokens is the context figure.)
        const m = dispatchResult.metrics;
        promptTokens = m.dispatcherPromptTokens;
        completionTokens = m.dispatcherCompletionTokens;
        reasoningTokens = m.dispatcherReasoningTokens;
        cacheReadTokens = m.dispatcherCacheReadTokens;
        cacheCreationTokens = m.dispatcherCacheCreationTokens;
        if (typeof m.costUsd === "number") costUsd = m.costUsd;
        send("chat:usage", { promptTokens, completionTokens, reasoningTokens, breakdown: lastBreakdown, costUsd, cacheReadTokens, cacheCreationTokens });

        // Stream the dispatcher's final reply as content tokens so it renders like
        // a normal assistant message.
        if (!abortCtrl.signal.aborted && dispatchResult.content) send("chat:token", { delta: dispatchResult.content });

        if (!abortCtrl.signal.aborted) broadcastEvent("db:changed", null);
        send("chat:done", {
          content: abortCtrl.signal.aborted ? "" : dispatchResult.content,
          reasoning: dispatchResult.reasoning,
          reasoningItems: dispatchResult.reasoningItems,
          reasoningField: dispatchResult.reasoningField,
          reasoningModel: dispatchResult.reasoningModel,
          contextRefs: [],
          usage: finalUsage(),
        });
      } catch (err) {
        // Cancellation or an unexpected failure must never leave the input
        // disabled — always emit chat:done so the renderer resolves the turn.
        if (!abortCtrl.signal.aborted) {
          console.error("[chat] subagent dispatch failed:", err);
          send("chat:done", { content: `Subagent run failed: ${String(err)}`, contextRefs: [] });
        } else {
          send("chat:done", { content: "", contextRefs: [] });
        }
      } finally {
        abortControllers.delete(event.sender.id);
      }
      return;
    }

    // ── Cordis engine (only path for non-local models) ─────────────────────
    // The on-device local LLM (localllm) still uses the builtin loop — the
    // cordis adapter doesn't cover it yet. Everything else is Cordis.
    if (provider !== "localllm") {
      const { runCordisLoop } = await import("../cordis/run-cordis-loop");
      const tokens = createDeltaBatcher((delta) => send("chat:token", { delta }));
      const thoughts = createDeltaBatcher((delta) => send("chat:thought", { delta }));
      const flushStream = () => { tokens.flush(); thoughts.flush(); };
      try {
        const loopResult = await runCordisLoop({
          db: ctx.db,
          req,
          workspacePath: ctx.workspacePath,
          llmConfig: { baseUrl, model, apiKey, provider: (provider === "openai" || provider === "localllm" ? provider : "openai") },
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

    // Pre-stream snapshot of provider credits (for providers like NeuralWatt
    // that don't include cost in streaming responses). We diff after the stream
    // to recover per-request cost — only used when the stream didn't report it.
    // `turnStart` scopes the recovery write-back to exactly this turn's rows.
    const turnStart = Date.now();
    let creditsBefore: number | null = null;
    if (apiKey && !isLocalEndpointUrl) {
      try {
        const { manifest } = await fetchProvidersManifest();
        const spec = resolveCreditSpec(baseUrl, manifest.providers);
        if (spec) {
          const probe = await probeCredits(spec.url, apiKey, spec.shape);
          if (probe.info?.usage != null) creditsBefore = probe.info.usage;
          else if (probe.info?.remaining != null && probe.info?.limit != null) {
            creditsBefore = probe.info.limit - probe.info.remaining;
          }
        }
      } catch { /* best-effort — no snapshot */ }
    }

    // Batch streamed deltas — one IPC event per flush instead of per token, so a
    // dense stream can't flood the renderer. Flushed before every chat:done below.
    const tokens = createDeltaBatcher((delta) => send("chat:token", { delta }));
    const thoughts = createDeltaBatcher((delta) => send("chat:thought", { delta }));
    const flushStream = () => { tokens.flush(); thoughts.flush(); };

    let loopResult: Awaited<ReturnType<typeof runToolLoop>>;
    try {
      loopResult = await runToolLoop(
        ctx.db, req, ctx.workspacePath, baseUrl, model, apiKey, messages,
        emitToolCall, abortCtrl.signal, getWin, provider, addUsage,
        emitToolCallDone,
        (delta) => {
          tokens.push(delta);
        },
        (delta) => {
          thoughts.push(delta);
        },
        externalDefs,
      );
    } catch (err) {
      // A crashed loop must still resolve the turn: flush any buffered tokens,
      // release the abort controller, and send a terminal error chat:done so
      // the renderer never stays stuck in its loading state.
      flushStream();
      abortControllers.delete(event.sender.id);
      if (!abortCtrl.signal.aborted) {
        console.error("[chat] tool loop failed:", err);
        send("chat:done", { content: `Chat loop failed: ${(err as Error)?.message ?? String(err)}`, contextRefs: [] });
      } else {
        send("chat:done", { content: "", contextRefs: [] });
      }
      return;
    }

    abortControllers.delete(event.sender.id);

    // If the provider didn't report cost inline (streaming responses from
    // NeuralWatt etc. lack a cost field), recover it by diffing /quota usage.
    if (costUsd === undefined && creditsBefore !== null && apiKey && !abortCtrl.signal.aborted) {
      try {
        const { manifest } = await fetchProvidersManifest();
        const spec = resolveCreditSpec(baseUrl, manifest.providers);
        if (spec) {
          const probe = await probeCredits(spec.url, apiKey, spec.shape);
          if (probe.info) {
            const after = probe.info.usage != null
              ? probe.info.usage
              : probe.info.remaining != null && probe.info.limit != null
                ? probe.info.limit - probe.info.remaining
                : null;
            if (after !== null) {
              const diff = after - creditsBefore;
              if (Number.isFinite(diff) && diff >= 0) {
                costUsd = diff;
                if (promptTokens > 0) {
                  send("chat:usage", { promptTokens, completionTokens, reasoningTokens, breakdown: lastBreakdown, costUsd, cacheReadTokens, cacheCreationTokens });
                }
                // Write the recovered provider-reported cost back onto this
                // turn's recorded usage rows (they were persisted during the
                // loop, when the provider's inline cost wasn't known yet).
                applyRecoveredTurnCost(ctx.db, req.threadId, turnStart, diff);
              }
            }
          }
        }
      } catch { /* best-effort — no cost recovered */ }
    }

    // Broadcast db:changed so mobile SSE clients (and other Electron windows)
    // re-hydrate the store after any tool calls that wrote to the DB.
    // The chat stream runs tool calls internally — we broadcast once after all
    // tools have finished so the board, notes, and other views stay in sync.
    if (!abortCtrl.signal.aborted) {
      broadcastEvent("db:changed", null);
    }

    if (abortCtrl.signal.aborted) {
      flushStream();
      send("chat:done", { content: "", reasoning: loopResult.reasoning, reasoningSummary: loopResult.reasoningSummary, reasoningItems: loopResult.reasoningItems, reasoningField: loopResult.reasoningField, reasoningModel: loopResult.reasoningModel, contextRefs: [], usage: finalUsage() });
      return;
    }

    flushStream();
    send("chat:done", { content: loopResult.content, reasoning: loopResult.reasoning, reasoningSummary: loopResult.reasoningSummary, reasoningItems: loopResult.reasoningItems, reasoningField: loopResult.reasoningField, reasoningModel: loopResult.reasoningModel, contextRefs: [], usage: finalUsage() });
  });
}
