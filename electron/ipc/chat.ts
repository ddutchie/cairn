/**
 * Cairn — AI Chat IPC handler
 *
 * Runs the OpenAI-compatible completions loop in the Electron main process
 * so it works in the packaged app (no Next.js server needed).
 *
 * Registered as: registerIpcOn("chat:stream", ...)
 */

import type { BrowserWindow } from "electron";
import { registerIpcHandle, registerIpcOn, broadcastEvent } from "./registry";
import { broadcastToChat } from "../chat-popout";
import type Database from "better-sqlite3";
import { isLocalEndpoint, normaliseBaseUrl, type OpenAIMessage, calculatePromptBreakdown, scaleBreakdown, type TokenBreakdown } from "../lib/llm";
import { TOOLS, buildSystemPrompt, type ChatRequest } from "../lib/tools";
import { getExternalToolDefs } from "../lib/external-tools";
import { saveCachedConfig, getCachedConfig } from "../lib/config-cache";
import { runToolLoop } from "../lib/chat-loop";

// Track one AbortController per renderer webContents ID
const abortControllers = new Map<number, AbortController>();

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
  if (config?.apiKey) {
    saveCachedConfig("ai", {
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
    });
  }

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
    model: reqConfig?.model ?? "gpt-4o-mini",
    apiKey: reqConfig?.apiKey ?? "",
  };
}

// Re-export for backward compatibility (prd.ts and others import LLMConfig from here)
export type { LLMConfig } from "../lib/llm";
export { callLLM } from "../lib/llm";

export function registerChatHandler(db: Database.Database, workspacePath: string, getWin?: () => BrowserWindow | null): void {
  registerIpcHandle("chat:compactThread", async (_event, req: {
    messages: Array<{ role: string; content: string }>;
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
      const summary = await generateSummary(agentMsgs, llmConfig, new AbortController().signal);
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

    // Check if the model supports vision before including images
    const modelLc = (model ?? "").toLowerCase();
    const supportsVision = provider !== "localllm" && (
      modelLc.includes("vision") ||
      modelLc.includes("gpt-4o") ||
      modelLc.startsWith("claude-3") ||
      modelLc.startsWith("claude-sonnet-4") ||
      modelLc.includes("gemini")
    );

    if (req.images?.length && !supportsVision) {
      req.message = "[Images omitted — model does not support vision]\n\n" + req.message;
      req.images = undefined;
    }

    const userMessage: OpenAIMessage = req.images?.length
      ? ({
          role: "user",
          content: [
            { type: "text", text: req.message },
            ...req.images.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } })),
          ],
        } as unknown as OpenAIMessage)
      : { role: "user", content: req.message };

    const messages: OpenAIMessage[] = [
      { role: "system", content: buildSystemPrompt(req) },
      ...(req.history ?? []).map((m) => {
        const out: OpenAIMessage = { role: m.role, content: m.content };
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.name) out.name = m.name;
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
    let lastBreakdown: TokenBreakdown | undefined = undefined;

    // Assemble external tool defs (MCP servers + custom services) in scope for
    // this workspace/project. Failures degrade to no external tools.
    let externalDefs: typeof TOOLS = [];
    try {
      externalDefs = (await getExternalToolDefs(db, req.workspaceId ?? "", req.projectId ?? "")) as typeof TOOLS;
    } catch (err) {
      console.error("[chat] failed to assemble external tools:", err);
    }
    const allTools = externalDefs.length > 0 ? [...TOOLS, ...externalDefs] : TOOLS;

    const addUsage = (pt: number, ct: number, rt?: number) => {
      promptTokens = pt;
      completionTokens += ct;
      if (typeof rt === "number") reasoningTokens += rt;
      try {
        const rawBreakdown = calculatePromptBreakdown(buildSystemPrompt(req), messages, allTools);
        lastBreakdown = scaleBreakdown(rawBreakdown, promptTokens);
      } catch (err) {
        console.error("[chat] failed to calculate breakdown:", err);
      }
      send("chat:usage", { promptTokens, completionTokens, reasoningTokens, breakdown: lastBreakdown });
    };

    // ── Subagent mode ─────────────────────────────────────────────────────────
    // Per-thread toggle routes the turn through the dispatch → research/write
    // loop. It streams a live, expandable subagent trace to the renderer via
    // chat:subagent* events, then streams the dispatcher's final reply as tokens.
    if (req.useSubagents && provider !== "localllm") {
      const { runDispatchLoop } = await import("../lib/chat-subagent-loop");
      try {
        const dispatchResult = await runDispatchLoop(
          db, req, workspacePath, { baseUrl, model, apiKey, provider },
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
        send("chat:usage", { promptTokens, completionTokens, reasoningTokens, breakdown: lastBreakdown });

        // Stream the dispatcher's final reply as content tokens so it renders like
        // a normal assistant message.
        if (!abortCtrl.signal.aborted && dispatchResult.content) send("chat:token", { delta: dispatchResult.content });

        if (!abortCtrl.signal.aborted) broadcastEvent("db:changed", null);
        send("chat:done", {
          content: abortCtrl.signal.aborted ? "" : dispatchResult.content,
          reasoning: dispatchResult.reasoning,
          contextRefs: [],
          usage: promptTokens > 0 ? { promptTokens, completionTokens, reasoningTokens, breakdown: lastBreakdown } : undefined,
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

    const loopResult = await runToolLoop(
      db, req, workspacePath, baseUrl, model, apiKey, messages,
      emitToolCall, abortCtrl.signal, getWin, provider, addUsage,
      emitToolCallDone,
      (delta) => {
        send("chat:token", { delta });
      },
      (delta) => {
        send("chat:thought", { delta });
      },
      externalDefs,
    );

    abortControllers.delete(event.sender.id);

    // Broadcast db:changed so mobile SSE clients (and other Electron windows)
    // re-hydrate the store after any tool calls that wrote to the DB.
    // The chat stream runs tool calls internally — we broadcast once after all
    // tools have finished so the board, notes, and other views stay in sync.
    if (!abortCtrl.signal.aborted) {
      broadcastEvent("db:changed", null);
    }

    if (abortCtrl.signal.aborted) {
      send("chat:done", { content: "", reasoning: loopResult.reasoning, contextRefs: [], usage: promptTokens > 0 ? { promptTokens, completionTokens, reasoningTokens, breakdown: lastBreakdown } : undefined });
      return;
    }

    send("chat:done", { content: loopResult.content, reasoning: loopResult.reasoning, contextRefs: [], usage: promptTokens > 0 ? { promptTokens, completionTokens, reasoningTokens, breakdown: lastBreakdown } : undefined });
  });
}
