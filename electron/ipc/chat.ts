/**
 * Cairn — AI Chat IPC handler
 *
 * Runs the OpenAI-compatible completions loop in the Electron main process
 * so it works in the packaged app (no Next.js server needed).
 *
 * Registered as: ipcMain.on("chat:stream", ...)
 */

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import type Database from "better-sqlite3";
import { isLocalEndpoint, streamCompletion, normaliseBaseUrl, type OpenAIMessage } from "../lib/llm";
import { TOOLS, buildSystemPrompt, type ChatRequest } from "../lib/tools";
import { executeTool } from "./chat-executor";

// Track one AbortController per renderer webContents ID
const abortControllers = new Map<number, AbortController>();

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
  emitToolCall: (e: { tool: string; label: string; args: Record<string, unknown> }) => void,
  signal?: AbortSignal,
  getWin?: () => BrowserWindow | null,
  provider?: string,
  onUsage?: (pt: number, ct: number) => void,
  emitToolCallDone?: (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) => void,
): Promise<{ exhausted: true; content: string } | { exhausted: false }> {
  const maxSteps    = req.config?.maxSteps    ?? 20;
  const temperature = req.config?.temperature ?? 0.3;
  for (let round = 0; round < maxSteps; round++) {
    if (signal?.aborted) return { exhausted: true, content: "" };
    
    let assistantMsg: OpenAIMessage;
    
    if (provider === "localllm") {
      try {
        const { callLocalLLMChat } = await import("../lib/local-llm");
        const res = await callLocalLLMChat(messages, TOOLS);
        const choice = res.choices?.[0];
        if (!choice) return { exhausted: true, content: "No response from local Llama on-device model." };
        if (res.usage && onUsage) {
          onUsage(res.usage.prompt_tokens ?? 0, res.usage.completion_tokens ?? 0);
        }
        assistantMsg = choice.message as OpenAIMessage;

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
      } catch (err) {
        return { exhausted: true, content: `Local LLM Engine error: ${String(err)}` };
      }
    } else {
      let response: Response;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: "auto", max_tokens: 4096, temperature }),
        });
      } catch {
        return { exhausted: true, content: `Could not reach the AI endpoint at \`${baseUrl}\`. Check your endpoint URL and make sure the server is running.` };
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        return { exhausted: true, content: `AI endpoint error (${response.status}): ${errText.slice(0, 300)}` };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await response.json() as any;
      const choice = data.choices?.[0];
      if (!choice) return { exhausted: true, content: "No response from AI endpoint." };
      if (data.usage && onUsage) {
        onUsage(data.usage.prompt_tokens ?? 0, data.usage.completion_tokens ?? 0);
      }
      assistantMsg = choice.message as OpenAIMessage;
    }

    // No tool calls — model is ready to produce its final reply
    if (!assistantMsg.tool_calls?.length) {
      messages.push(assistantMsg);
      return { exhausted: false };
    }

    messages.push(assistantMsg);
    for (const call of assistantMsg.tool_calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments); } catch { args = {}; }
      let result: unknown;
      try {
        result = await executeTool(db, req, workspacePath, { baseUrl, model, apiKey, provider: provider as "openai" | "localllm" }, call.function.name, args, emitToolCall, getWin, emitToolCallDone);
      } catch (toolErr) {
        result = { error: `Tool "${call.function.name}" failed: ${String(toolErr)}` };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  return {
    exhausted: true,
    content: "I reached the maximum number of steps for this request. Any actions taken so far have been saved — check your board and notes. Try breaking the request into smaller steps.",
  };
}

export function registerChatHandler(db: Database.Database, workspacePath: string, getWin?: () => BrowserWindow | null): void {
  ipcMain.handle("chat:compactThread", async (_event, req: {
    messages: Array<{ role: string; content: string }>;
    config: { provider?: string; baseUrl?: string; model?: string; apiKey?: string };
  }) => {
    try {
      const baseUrl = normaliseBaseUrl(req.config?.baseUrl ?? "https://api.openai.com");
      const model = req.config?.model ?? "gpt-4o-mini";
      const apiKey = req.config?.apiKey ?? "";
      
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
  ipcMain.on("chat:abort", (event) => {
    const ctrl = abortControllers.get(event.sender.id);
    if (ctrl) {
      ctrl.abort();
      abortControllers.delete(event.sender.id);
    }
  });

  // chat:stream — fire-and-forget (ipcMain.on, not handle).
  // Emits:
  //   chat:token   { delta: string }   — one SSE content chunk
  //   chat:tool-call { tool, label, args } — tool being invoked
  //   chat:done    { content: string, contextRefs: [], error?: string }
  ipcMain.on("chat:stream", async (event, req: ChatRequest) => {
    // Cancel any previous in-flight request from this renderer
    abortControllers.get(event.sender.id)?.abort();
    const abortCtrl = new AbortController();
    abortControllers.set(event.sender.id, abortCtrl);
    
    const provider = req.config?.provider ?? "openai";
    const baseUrl = normaliseBaseUrl(req.config?.baseUrl ?? "https://api.openai.com");
    const model = req.config?.model ?? "gpt-4o-mini";
    const apiKey = req.config?.apiKey ?? "";
    const isLocal = isLocalEndpoint(baseUrl);

    const send = (ch: string, payload: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(ch, payload);
    };

    if (provider !== "localllm" && !apiKey && !isLocal) {
      send("chat:done", {
        content: "AI chat is not configured. Set an API key in **Settings → AI & Chat**, or use a local endpoint (Ollama, LM Studio) with no key needed.",
        contextRefs: [],
      });
      return;
    }

    const messages: OpenAIMessage[] = [
      { role: "system", content: buildSystemPrompt(req) },
      ...(req.history ?? []).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: req.message },
    ];

    const emitToolCall = (e: { tool: string; label: string; args: Record<string, unknown> }) => {
      send("chat:tool-call", e);
    };

    const emitToolCallDone = (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) => {
      send("chat:tool-call-done", e);
    };

    let promptTokens = 0;
    let completionTokens = 0;
    const addUsage = (pt: number, ct: number) => {
      promptTokens += pt;
      completionTokens += ct;
      send("chat:usage", { promptTokens, completionTokens });
    };

    const loopResult = await runToolLoop(db, req, workspacePath, baseUrl, model, apiKey, messages, emitToolCall, abortCtrl.signal, getWin, provider, addUsage, emitToolCallDone);

    abortControllers.delete(event.sender.id);

    if (abortCtrl.signal.aborted) {
      send("chat:done", { content: "", contextRefs: [], usage: promptTokens > 0 ? { promptTokens, completionTokens } : undefined });
      return;
    }

    if (loopResult.exhausted) {
      send("chat:done", { content: loopResult.content, contextRefs: [], usage: promptTokens > 0 ? { promptTokens, completionTokens } : undefined });
      return;
    }

    const lastMsg = messages[messages.length - 1] as OpenAIMessage;

    if (lastMsg.role === "assistant" && lastMsg.content && !lastMsg.tool_calls?.length) {
      messages.pop();

      // Re-request with stream: true for real SSE tokens
      let fullContent = "";
      try {
        for await (const delta of streamCompletion({ baseUrl, model, apiKey, provider: provider as "openai" | "localllm" }, messages, TOOLS, addUsage)) {
          if (abortCtrl.signal.aborted) break;
          fullContent += delta;
          send("chat:token", { delta });
        }
      } catch {
        // Fallback: just emit the already-received content verbatim
        if (!fullContent) {
          send("chat:token", { delta: lastMsg.content });
          send("chat:done", { content: lastMsg.content, contextRefs: [], usage: promptTokens > 0 ? { promptTokens, completionTokens } : undefined });
          return;
        }
      }

      send("chat:done", { content: fullContent || (lastMsg.content ?? ""), contextRefs: [], usage: promptTokens > 0 ? { promptTokens, completionTokens } : undefined });
      return;
    }

    // Unexpected state — shouldn't happen, but be safe
    send("chat:done", { content: "", contextRefs: [], usage: promptTokens > 0 ? { promptTokens, completionTokens } : undefined });
  });
}
