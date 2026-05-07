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
import { isLocalEndpoint, streamCompletion, type OpenAIMessage } from "../lib/llm";
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
): Promise<{ exhausted: true; content: string } | { exhausted: false }> {
  const maxSteps = req.config?.maxSteps ?? 20;
  for (let round = 0; round < maxSteps; round++) {
    if (signal?.aborted) return { exhausted: true, content: "" };
    let response: Response;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: "auto", max_tokens: 4096, temperature: 0.3 }),
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

    const assistantMsg = choice.message as OpenAIMessage;

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
        result = await executeTool(db, req, workspacePath, { baseUrl, model, apiKey }, call.function.name, args, emitToolCall, getWin);
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
    const baseUrl = (req.config?.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    const model = req.config?.model ?? "gpt-4o-mini";
    const apiKey = req.config?.apiKey ?? "";
    const isLocal = isLocalEndpoint(baseUrl);

    const send = (ch: string, payload: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(ch, payload);
    };

    if (!apiKey && !isLocal) {
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

    const loopResult = await runToolLoop(db, req, workspacePath, baseUrl, model, apiKey, messages, emitToolCall, abortCtrl.signal, getWin);

    abortControllers.delete(event.sender.id);

    if (abortCtrl.signal.aborted) {
      send("chat:done", { content: "", contextRefs: [] });
      return;
    }

    if (loopResult.exhausted) {
      send("chat:done", { content: loopResult.content, contextRefs: [] });
      return;
    }

    const lastMsg = messages[messages.length - 1] as OpenAIMessage;

    if (lastMsg.role === "assistant" && lastMsg.content && !lastMsg.tool_calls?.length) {
      messages.pop();

      // Re-request with stream: true for real SSE tokens
      let fullContent = "";
      try {
        for await (const delta of streamCompletion({ baseUrl, model, apiKey }, messages, TOOLS)) {
          if (abortCtrl.signal.aborted) break;
          fullContent += delta;
          send("chat:token", { delta });
        }
      } catch {
        // Fallback: just emit the already-received content verbatim
        if (!fullContent) {
          send("chat:token", { delta: lastMsg.content });
          send("chat:done", { content: lastMsg.content, contextRefs: [] });
          return;
        }
      }

      send("chat:done", { content: fullContent || (lastMsg.content ?? ""), contextRefs: [] });
      return;
    }

    // Unexpected state — shouldn't happen, but be safe
    send("chat:done", { content: "", contextRefs: [] });
  });
}
