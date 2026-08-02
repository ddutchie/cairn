/**
 * Cairn — Chat tool-call loop (extracted from ipc/chat.ts)
 *
 * `runToolLoop` drives the OpenAI-compatible completions loop for the in-app
 * chat assistant: it sends messages + tools with tool_choice "auto", parses the
 * SSE stream, executes any tool calls, appends their results, and repeats until
 * the model returns a response with no tool calls (ready to stream) or the
 * step limit is reached.
 *
 * This was lifted out of `electron/ipc/chat.ts` verbatim (behaviour unchanged)
 * so it can be reused by (a) the IPC handler and (b) the subagent variant /
 * benchmark harness without duplicating the loop. `chat.ts` imports it.
 */

import type { BrowserWindow } from "electron";
import type Database from "better-sqlite3";
import type { OpenAIMessage } from "./llm";
import { buildApiUrl } from "./llm";
import { TOOLS, type ChatRequest } from "./tools";
import { executeTool } from "../ipc/chat-executor";
import { executeExternalTool, isExternalToolName, externalToolLabel } from "./external-tools";
import { extractExternalRef } from "./external-ref";
import { externalOutputError } from "./tool-result";
import { iterSseData } from "./sse";
import { traceTool } from "./tool-trace";
import { parseToolArgs } from "./parse-tool-args";

export type RunToolLoopResult =
  | { exhausted: true; content: string; reasoning: string }
  | { exhausted: false; content: string; reasoning: string };

/**
 * Run the tool-call loop. Returns when the model produces a response with no
 * tool calls (ready to stream) or when the round limit is hit.
 *
 * `toolsOverride` lets callers (e.g. the research/write subagents) restrict the
 * advertised tool set. When omitted, the full built-in TOOLS array is used.
 */
export async function runToolLoop(
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
  onUsage?: (pt: number, ct: number, rt?: number, costUsd?: number) => void,
  emitToolCallDone?: (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; externalRef?: { url: string; title?: string; snippet?: string }; output?: string; callId?: string; ok?: boolean; error?: string }) => void,
  onToken?: (delta: string) => void,
  onThought?: (delta: string) => void,
  extraTools: typeof TOOLS = [],
  toolsOverride?: typeof TOOLS,
  /**
   * Optional pre-execution hook to transform tool-call args (test/benchmark
   * seam — e.g. fault injection). Production never passes this; default is the
   * identity transform. Runs after JSON parse, before executeTool.
   */
  argMutator?: (name: string, args: Record<string, unknown>) => Record<string, unknown>,
): Promise<RunToolLoopResult> {
  const maxSteps    = req.config?.maxSteps    ?? 30;
  const temperature = req.config?.temperature ?? 0.3;
  // Built-in tools (or a caller-supplied override) + any external tools in scope.
  const baseTools = toolsOverride ?? TOOLS;
  const combinedTools = extraTools.length > 0 ? [...baseTools, ...extraTools] : baseTools;
  let accumulatedContent = "";
  let accumulatedReasoning = "";

  for (let round = 0; round < maxSteps; round++) {
    if (signal?.aborted) return { exhausted: true, content: "", reasoning: accumulatedReasoning };

    let assistantMsg: OpenAIMessage & { reasoning?: string };

    if (provider === "localllm") {
      try {
        const { callLocalLLMChat } = await import("./local-llm");
        const res = await callLocalLLMChat(messages, combinedTools);
        const choice = res.choices?.[0];
        if (!choice) return { exhausted: true, content: "No response from local Llama on-device model.", reasoning: "" };
        if (res.usage && onUsage) {
          const usageCost = (res.usage as { cost?: unknown }).cost;
          const topCost = (res as { cost?: { request_cost_usd?: unknown } }).cost;
          const costVal = typeof usageCost === "number"
            ? usageCost
            : typeof topCost?.request_cost_usd === "number"
              ? topCost.request_cost_usd
              : undefined;
          onUsage(
            res.usage.prompt_tokens ?? 0,
            res.usage.completion_tokens ?? 0,
            res.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            costVal,
          );
        }
        const rawMsg = choice.message as OpenAIMessage & { reasoning?: string; reasoning_content?: string };
        const rawThought = rawMsg.reasoning_content ?? rawMsg.reasoning;
        if (rawThought) {
          accumulatedReasoning += rawThought;
          if (onThought) onThought(rawThought);
        }
        // Strip reasoning before assigning — it must not enter the messages
        // array that gets re-sent to the API on subsequent rounds. Both
        // `reasoning` and `reasoning_content` must be stripped (DeepSeek docs:
        // re-sending reasoning_content on assistant messages causes 400s).
        const { reasoning: _r, reasoning_content: _rc, ...msgWithoutReasoning } = rawMsg;
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
        response = await fetch(buildApiUrl(baseUrl, "chat/completions"), {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({
            model,
            messages,
            tools: combinedTools,
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
            const topCost = chunk.cost as { request_cost_usd?: unknown } | undefined;
            onUsage(
              chunk.usage.prompt_tokens ?? 0,
              chunk.usage.completion_tokens ?? 0,
              chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
              typeof chunk.usage.cost === "number"
                ? chunk.usage.cost
                : typeof topCost?.request_cost_usd === "number"
                  ? topCost.request_cost_usd
                  : undefined,
            );
          }
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            contentBuffer += delta.content;
            accumulatedContent += delta.content;
            if (onToken) onToken(delta.content);
          }

          // Reasoning / thinking stream (Claude thinking_delta, OpenAI delta.reasoning,
          // DeepSeek/Qwen-style delta.reasoning_content).
          // Models that don't expose reasoning text simply never emit this field —
          // the panel stays hidden. Reasoning is NOT merged into content/tool JSON.
          const thought = delta.reasoning_content ?? delta.reasoning;
          if (thought) {
            accumulatedReasoning += thought;
            if (onThought) onThought(thought);
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
      const parsed = parseToolArgs(call.function.arguments);
      if (parsed.ok) {
        args = parsed.value;
        traceTool("parse", {
          toolName: call.function.name,
          title: typeof args.title === "string" ? args.title : "",
          content: typeof args.content === "string" ? args.content : "",
          rawArguments: call.function.arguments || "",
          repaired: parsed.repaired ? 1 : 0,
        });
      } else {
        parseError = parsed.error;
        args = {};
      }

      // Surface the chip so the UI shows the tool happening, then fail
      // with a descriptive error so the model can re-issue — never run
      // a tool with destructured args.
      if (parseError) {
        emitToolCall({ tool: call.function.name, label: externalToolLabel(call.function.name, db), args: {}, callId: call.id });
        emitToolCallDone?.({ tool: call.function.name, callId: call.id, ok: false, error: parseError });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: parseError }),
        });
        continue;
      }

      let result: unknown;
      try {
        if (argMutator) args = argMutator(call.function.name, args);
        if (isExternalToolName(call.function.name)) {
          // MCP server / custom service tool — route to the external executor.
          emitToolCall({ tool: call.function.name, label: externalToolLabel(call.function.name, db), args, callId: call.id });
          const output = await executeExternalTool(db, req.workspaceId ?? "", req.projectId ?? "", call.function.name, args);
          // Surface a linkable artefact (Confluence page, web-search hit, …) from
          // the vendor-specific output so the UI can render a browser-opening chip.
          const externalRef = extractExternalRef(output);
          const externalError = externalOutputError(output);
          emitToolCallDone?.({ tool: call.function.name, externalRef, output, callId: call.id, ok: externalError === undefined, error: externalError });
          result = output;
        } else {
          result = await executeTool(db, req, workspacePath, { baseUrl, model, apiKey, provider: provider as "openai" | "localllm" }, call.function.name, args, emitToolCall, getWin, emitToolCallDone, call.id);
        }
      } catch (toolErr) {
        const message = `Tool "${call.function.name}" failed: ${String(toolErr)}`;
        result = { error: message };
        // executeTool fires its own emitDone only on the success return path; a
        // thrown exception skips it, so emit a failure done here (keyed by callId
        // so the renderer updates the same chip) — otherwise the chip would hang
        // in its running state with no failure signal.
        emitToolCallDone?.({ tool: call.function.name, callId: call.id, ok: false, error: message });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: typeof result === "string" ? result : JSON.stringify(result) });
    }
  }

  return {
    exhausted: true,
    content: "I reached the maximum number of steps for this request. Any actions taken so far have been saved — check your board and notes. Try breaking the request into smaller steps.",
    reasoning: accumulatedReasoning,
  };
}
