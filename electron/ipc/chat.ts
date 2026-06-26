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
import { executeTool } from "./chat-executor";
import { saveCachedConfig, getCachedConfig } from "../lib/config-cache";
import { iterSseData } from "../lib/sse";
import { traceTool } from "../lib/tool-trace";

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

/**
 * Run the tool-call loop. Returns when the model produces a response with no
 * tool calls (ready to stream) or when the round limit is hit.
 */
async function runToolLoop(
  db: Database.Database,
  req: ChatRequest,
  workspacePath: string,
  baseUrl: string,
  model: string,
  apiKey: string,
  messages: OpenAIMessage[],
  emitToolCall: (e: { tool: string; label: string; args: Record<string, unknown>; callId?: string }) => void,
  signal?: AbortSignal,
  getWin?: () => BrowserWindow | null,
  provider?: string,
  onUsage?: (pt: number, ct: number, rt?: number) => void,
  emitToolCallDone?: (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; output?: string; callId?: string }) => void,
  onToken?: (delta: string) => void,
  onThought?: (delta: string) => void,
): Promise<{ exhausted: true; content: string; reasoning: string } | { exhausted: false; content: string; reasoning: string }> {
  const maxSteps    = req.config?.maxSteps    ?? 30;
  const temperature = req.config?.temperature ?? 0.3;
  let accumulatedContent = "";
  let accumulatedReasoning = "";

  for (let round = 0; round < maxSteps; round++) {
    if (signal?.aborted) return { exhausted: true, content: "", reasoning: accumulatedReasoning };

    let assistantMsg: OpenAIMessage & { reasoning?: string };
    
    if (provider === "localllm") {
      try {
        const { callLocalLLMChat } = await import("../lib/local-llm");
        const res = await callLocalLLMChat(messages, TOOLS);
        const choice = res.choices?.[0];
        if (!choice) return { exhausted: true, content: "No response from local Llama on-device model.", reasoning: "" };
        if (res.usage && onUsage) {
          onUsage(
            res.usage.prompt_tokens ?? 0,
            res.usage.completion_tokens ?? 0,
            res.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          );
        }
        const rawMsg = choice.message as OpenAIMessage & { reasoning?: string };
        if (rawMsg.reasoning) {
          accumulatedReasoning += rawMsg.reasoning;
          if (onThought) onThought(rawMsg.reasoning);
        }
        // Strip reasoning before assigning — it must not enter the messages
        // array that gets re-sent to the API on subsequent rounds.
        const { reasoning: _r, ...msgWithoutReasoning } = rawMsg;
        assistantMsg = msgWithoutReasoning;

        // Self-Healing Parser for On-Device XML-style tool calls and tokenizers
        if (assistantMsg.content && assistantMsg.content.includes("<|tool_call>call:")) {
          const matches = [...assistantMsg.content.matchAll(/<\|tool_call>call:\s*([a-zA-Z0-9_-]+)(.*?)<tool_call\|>/gs)];
          if (matches.length > 0) {
            assistantMsg.tool_calls = assistantMsg.tool_calls || [];
            for (const match of matches) {
              const fullMatch = match[0];
              const toolName = match[1];
              let argsStr = match[2];
              // Replace tokenized quotes: <|"|> -> "
              argsStr = argsStr.replace(/<\|"\|>/g, '"');
              // Wrap unquoted keys in double quotes to ensure strict JSON compliance
              argsStr = argsStr.replace(/([{,]\s*)([a-zA-Z0-9_-]+)\s*:/g, '$1"$2":');
              assistantMsg.tool_calls.push({
                id: `call_${Math.random().toString(36).substring(2, 11)}`,
                type: "function",
                function: { name: toolName, arguments: argsStr }
              });
              assistantMsg.content = assistantMsg.content.replace(fullMatch, "");
            }
            assistantMsg.content = assistantMsg.content.trim();
            if (!assistantMsg.content) {
              assistantMsg.content = null;
            }
          }
        }
        if (assistantMsg.content) {
          accumulatedContent += assistantMsg.content;
          if (onToken) onToken(assistantMsg.content);
        }
      } catch (err) {
        return { exhausted: true, content: `Local LLM Engine error: ${String(err)}`, reasoning: accumulatedReasoning };
      }
    } else {
      let response: Response;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({
            model,
            messages,
            tools: TOOLS,
            tool_choice: "auto",
            max_tokens: 4096,
            temperature,
            stream: true,
            stream_options: { include_usage: true },
          }),
        });
      } catch (_err) {
        if (signal?.aborted) return { exhausted: true, content: "", reasoning: accumulatedReasoning };
        return { exhausted: true, content: `Could not reach the AI endpoint at \`${baseUrl}\`. Check your endpoint URL and make sure the server is running.`, reasoning: "" };
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        return { exhausted: true, content: `AI endpoint error (${response.status}): ${errText.slice(0, 300)}`, reasoning: "" };
      }

      const reader = response.body?.getReader();
      if (!reader) return { exhausted: true, content: "No response stream", reasoning: "" };

      let contentBuffer = "";
      const toolCallBuffers: Map<number, { id: string; name: string; args: string; thought_signature?: string }> = new Map();

      for await (const jsonStr of iterSseData(reader, signal ?? undefined)) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chunk = JSON.parse(jsonStr) as any;
          if (chunk.usage && onUsage) {
            onUsage(
              chunk.usage.prompt_tokens ?? 0,
              chunk.usage.completion_tokens ?? 0,
              chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            );
          }
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            contentBuffer += delta.content;
            accumulatedContent += delta.content;
            if (onToken) onToken(delta.content);
          }

          // Reasoning / thinking stream (Claude thinking_delta, OpenAI delta.reasoning).
          // Models that don't expose reasoning text simply never emit this field —
          // the panel stays hidden. Reasoning is NOT merged into content/tool JSON.
          if (delta.reasoning) {
            accumulatedReasoning += delta.reasoning;
            if (onThought) onThought(delta.reasoning);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0;
              if (!toolCallBuffers.has(idx)) {
                toolCallBuffers.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
              }
              const buf = toolCallBuffers.get(idx)!;
              if (tc.id) buf.id = tc.id;
              if (tc.function?.name) buf.name = tc.function.name;
              if (tc.function?.arguments) buf.args += tc.function.arguments;
              // Gemini 3.x thought signature — opaque blob to round-trip back.
              if (tc.thought_signature) buf.thought_signature = tc.thought_signature;
            }
          }
        } catch { /* skip malformed SSE JSON line */ }
      }

      // Dev trace: per-tool assembled arguments.
      for (const [idx, buf] of toolCallBuffers.entries()) {
        traceTool("sse-args", {
          toolIndex: idx,
          toolName: buf.name,
          arguments: buf.args,
        });
      }

      if (signal?.aborted) return { exhausted: true, content: "", reasoning: accumulatedReasoning };

      const toolCalls = toolCallBuffers.size > 0
        ? Array.from(toolCallBuffers.entries())
            .sort(([a], [b]) => a - b)
            .map(([, buf]) => ({
              id: buf.id,
              type: "function" as const,
              function: { name: buf.name, arguments: buf.args },
              ...(buf.thought_signature ? { thought_signature: buf.thought_signature } : {}),
            }))
        : undefined;

      assistantMsg = {
        role: "assistant" as const,
        content: contentBuffer || null,
        // Note: reasoning is intentionally NOT included here. It is
        // accumulated separately in `accumulatedReasoning` and returned
        // to the caller for UI/persistence. Sending it back to the API
        // would violate both OpenAI and Anthropic message schemas.
        tool_calls: toolCalls,
      };
    }

    // No tool calls — model is ready to produce its final reply
    if (!assistantMsg.tool_calls?.length) {
      messages.push(assistantMsg);
      return { exhausted: false, content: accumulatedContent, reasoning: accumulatedReasoning };
    }

    messages.push(assistantMsg);
    for (const call of assistantMsg.tool_calls) {
      let args: Record<string, unknown>;
      let parseError: string | null = null;
      try {
        const rawArgs = call.function.arguments?.trim() || "{}";
        args = JSON.parse(rawArgs) as Record<string, unknown>;
        traceTool("parse", {
          toolName: call.function.name,
          title: typeof args.title === "string" ? args.title : "",
          content: typeof args.content === "string" ? args.content : "",
          rawArguments: call.function.arguments || "",
        });
      } catch (err) {
        parseError = `Malformed tool-call arguments JSON from model: ${(err as Error).message}`;
        args = {};
      }

      // Surface the chip so the UI shows the tool happening, then fail
      // with a descriptive error so the model can re-issue — never run
      // a tool with destructured args.
      if (parseError) {
        emitToolCall({ tool: call.function.name, label: call.function.name, args: {}, callId: call.id });
        emitToolCallDone?.({ tool: call.function.name, callId: call.id });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: parseError }),
        });
        continue;
      }

      let result: unknown;
      try {
        result = await executeTool(db, req, workspacePath, { baseUrl, model, apiKey, provider: provider as "openai" | "localllm" }, call.function.name, args, emitToolCall, getWin, emitToolCallDone, call.id);
      } catch (toolErr) {
        result = { error: `Tool "${call.function.name}" failed: ${String(toolErr)}` };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  return {
    exhausted: true,
    content: "I reached the maximum number of steps for this request. Any actions taken so far have been saved — check your board and notes. Try breaking the request into smaller steps.",
    reasoning: accumulatedReasoning,
  };
}

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
      if (!event.sender.isDestroyed()) event.sender.send(ch, payload);
      broadcastToChat(ch, payload, event.sender.id);
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
        const out: any = { role: m.role, content: m.content };
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

    const emitToolCallDone = (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; output?: string; callId?: string }) => {
      send("chat:tool-call-done", e);
    };

    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let lastBreakdown: TokenBreakdown | undefined = undefined;
    const addUsage = (pt: number, ct: number, rt?: number) => {
      promptTokens = pt;
      completionTokens += ct;
      if (typeof rt === "number") reasoningTokens += rt;
      try {
        const rawBreakdown = calculatePromptBreakdown(buildSystemPrompt(req), messages, TOOLS);
        lastBreakdown = scaleBreakdown(rawBreakdown, promptTokens);
      } catch (err) {
        console.error("[chat] failed to calculate breakdown:", err);
      }
      send("chat:usage", { promptTokens, completionTokens, reasoningTokens, breakdown: lastBreakdown });
    };

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
