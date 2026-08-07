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
import { buildChatCompletionsBody, consumeAssistantStream, failToolCallsFromTruncatedMessage, interruptedStreamToolCallError } from "./llm-stream";
import { TOOLS, type ChatRequest } from "./tools";
import { extractCacheTokens } from "./usage-recorder";
import { executeTool } from "../ipc/chat-executor";
import { executeExternalTool, isExternalToolName, externalToolLabel } from "./external-tools";
import { extractExternalRef } from "./external-ref";
import { externalOutputError } from "./tool-result";
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
  onUsage?: (pt: number, ct: number, rt?: number, costUsd?: number, cacheReadTokens?: number, cacheCreationTokens?: number) => void,
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
  /**
   * Optional human-in-the-loop gate (used by the heartbeat runner). Called after
   * parse + argMutator, before any tool executes. May block while waiting for a
   * user decision. When it returns `{ allow: false }` the tool is NOT executed —
   * a "Blocked: …" result is fed back to the model so it can adjust/stop.
   */
  approvalGate?: (name: string, args: Record<string, unknown>) => Promise<{ allow: boolean; reason?: string }>,
): Promise<RunToolLoopResult> {
  const maxSteps    = req.config?.maxSteps    ?? 30;
  const temperature = req.config?.temperature ?? 0.3;
  // Max output tokens. Undefined/0 → OMIT max_tokens so the model finishes
  // naturally (full reasoning + answer, bounded by the provider's own limit).
  // A positive value is the user's deliberate cap. The old hardcoded 4096 was
  // the bug: it guillotined "thinking" models mid-reasoning, yielding empty
  // content that then tripped a 400 on the next message.
  const maxTokens   = req.config?.maxTokens && req.config.maxTokens > 0 ? req.config.maxTokens : undefined;
  // Built-in tools (or a caller-supplied override) + any external tools in scope.
  const baseTools = toolsOverride ?? TOOLS;
  const combinedTools = extraTools.length > 0 ? [...baseTools, ...extraTools] : baseTools;
  let accumulatedContent = "";
  let accumulatedReasoning = "";

  for (let round = 0; round < maxSteps; round++) {
    if (signal?.aborted) return { exhausted: true, content: "", reasoning: accumulatedReasoning };

    let assistantMsg: OpenAIMessage & { reasoning?: string };
    // Captured finish_reason for THIS round. "length" means the model hit its
    // output-token limit mid-turn — any tool calls in that message may carry
    // truncated arguments (see the truncation guard below).
    let turnFinishReason: string | null = null;
    // True only for the SSE streaming (cloud) branch. The interrupted-stream
    // guard below must NOT apply to the localllm non-streaming path, where a
    // null finish_reason is a normal, complete response.
    let streamingTurn = false;

    if (provider === "localllm") {
      try {
        const { callLocalLLMChat, continueLocalLLMAfterReasoning } = await import("./local-llm");
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
          const cache = extractCacheTokens(res.usage);
          onUsage(
            res.usage.prompt_tokens ?? 0,
            res.usage.completion_tokens ?? 0,
            res.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            costVal,
            cache.cacheReadTokens,
            cache.cacheCreationTokens,
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

        // Reasoning-budget recovery. Reasoning models (Qwen3.5-9B, Bonsai-27B,
        // partly Gemma-4) can spend the entire `max_tokens` budget on
        // chain-of-thought and return an empty `content` with
        // `finish_reason: "length"`. Cairn's self-healing parser can only
        // repair *present* content — an empty reply leaves the chat with
        // nothing to show. When that happens we make one continuation call
        // asking the model to emit only the final answer (no further
        // reasoning). If the continuation still yields nothing, we fall back
        // to surfacing the captured reasoning so the user sees something
        // useful instead of a blank message. Skipped when the model already
        // emitted tool calls (we want those executed, not retried).
        const finishReason = choice.finish_reason;
        turnFinishReason = finishReason ?? null;
        const hasNoContent = !assistantMsg.content || !assistantMsg.content.trim();
        const hasNoToolCalls = !assistantMsg.tool_calls?.length;
        if (hasNoContent && hasNoToolCalls && finishReason === "length" && accumulatedReasoning) {
          if (signal?.aborted) return { exhausted: true, content: "", reasoning: accumulatedReasoning };
          try {
            const contChoice = await continueLocalLLMAfterReasoning(messages, combinedTools, signal);
            if (signal?.aborted) return { exhausted: true, content: "", reasoning: accumulatedReasoning };
            const contContent = contChoice?.message?.content;
            if (contContent && contContent.trim()) {
              assistantMsg.content = contContent;
            }
          } catch {
            // Cancellation aborts the continuation — surface the aborted result
            // instead of running the reasoning fallback for a request nobody is
            // waiting on. Other failures fall through to the reasoning fallback.
            if (signal?.aborted) return { exhausted: true, content: "", reasoning: accumulatedReasoning };
          }
          if ((!assistantMsg.content || !assistantMsg.content.trim()) && accumulatedReasoning) {
            assistantMsg.content = `*[This reasoning model exhausted its token budget before emitting a final answer. The captured reasoning is shown below.]*\n\n${accumulatedReasoning.trim()}`;
          }
        }

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
      streamingTurn = true;
      let response: Response;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        response = await fetch(buildApiUrl(baseUrl, "chat/completions"), {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify(buildChatCompletionsBody({
            model,
            messages,
            tools: combinedTools,
            maxTokens,
            temperature,
          })),
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

      // Shared SSE parse (same as the agent loop) so reasoning-field capture,
      // finish_reason tracking, and tool-call buffering can never diverge again.
      const turn = await consumeAssistantStream(reader, {
        signal,
        onToken: (delta) => { if (onToken) onToken(delta); },
        onThought: (delta) => { if (onThought) onThought(delta); },
        onUsage: (usage) => {
          if (!onUsage) return;
          const topCost = usage.chunkCost as { request_cost_usd?: unknown } | undefined;
          const raw = usage.raw as { cost?: unknown };
          onUsage(
            usage.promptTokens,
            usage.completionTokens,
            usage.reasoningTokens,
            typeof raw.cost === "number"
              ? raw.cost
              : typeof topCost?.request_cost_usd === "number"
                ? topCost.request_cost_usd
                : undefined,
            usage.cacheReadTokens,
            usage.cacheCreationTokens,
          );
        },
      });
      // Reasoning and content are accumulated here (onToken/onThought only stream).
      accumulatedContent += turn.content;
      accumulatedReasoning += turn.reasoning;
      turnFinishReason = turn.finishReason;

      // Dev trace: per-tool assembled arguments.
      for (let i = 0; i < turn.toolCalls.length; i++) {
        const tc = turn.toolCalls[i];
        traceTool("sse-args", {
          toolIndex: turn.toolCallIndexes[i],
          toolName: tc.function.name,
          arguments: tc.function.arguments,
        });
      }

      if (signal?.aborted) return { exhausted: true, content: "", reasoning: accumulatedReasoning };

      const toolCalls = turn.toolCalls.length > 0 ? turn.toolCalls : undefined;

      assistantMsg = {
        role: "assistant" as const,
        content: turn.content || null,
        // Note: reasoning is intentionally NOT included here. It is
        // accumulated separately in `accumulatedReasoning` and returned
        // to the caller for UI/persistence (the ThinkingPanel renders it).
        // Reasoning is never baked into `content` — matching pi.
        tool_calls: toolCalls,
      };
    }

    // No tool calls — model is ready to produce its final reply
    if (!assistantMsg.tool_calls?.length) {
      messages.push(assistantMsg);
      return { exhausted: false, content: accumulatedContent, reasoning: accumulatedReasoning };
    }

    // Output-token-limit / interrupted-stream truncation guard. A "length"
    // finish (or a stream that ended without ANY finish_reason — connection cut
    // mid-call) means the tool calls in this message may carry truncated
    // arguments. The worst case is a cut that lands on a well-formed boundary:
    // the partial JSON parses cleanly and would be executed with silently
    // missing fields — something no JSON parser can detect. Mirroring pi's
    // `failToolCallsFromTruncatedMessage`, refuse to execute ANY of them: emit
    // the chip + a structured error so the model re-issues with complete
    // arguments (or the user raises the output-token cap).
    const streamInterrupted = streamingTurn && turnFinishReason === null && (assistantMsg.tool_calls?.length ?? 0) > 0;
    if (turnFinishReason === "length" || streamInterrupted) {
      messages.push(assistantMsg);
      const toolResults = failToolCallsFromTruncatedMessage(assistantMsg.tool_calls, {
        maxTokens,
        error: streamInterrupted ? interruptedStreamToolCallError() : undefined,
        labelFor: (name) => externalToolLabel(name, db),
        emitStart: (tool, label, callId, args) => emitToolCall({ tool, label, args, callId }),
        emitEnd: (tool, label, ok, output, callId, _args) => emitToolCallDone?.({ tool, callId, ok, error: output }),
      });
      for (const tr of toolResults) messages.push(tr);
      continue;
    }

    messages.push(assistantMsg);

    // ── Execute tool calls ───────────────────────────────────────────────
    // Run parallel tool calls like the agent loop does. The per-tool
    // concurrency guards (file mutex, note locks, atomic writes) live in the
    // shared tool implementations, so parallel execution is equally safe here.
    // Results are appended back in source order so the model sees a stable
    // sequence. When an approval gate is present (heartbeat runner), execution
    // stays sequential so human prompts never stack and the abort-while-waiting
    // break is preserved.
    type ToolCallMsg = { id: string; function: { name: string; arguments: string } };
    const runOne = async (call: ToolCallMsg): Promise<{ call: ToolCallMsg; content: string; abort?: boolean }> => {
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
        return { call, content: JSON.stringify({ error: parseError }) };
      }

      try {
        if (argMutator) args = argMutator(call.function.name, args);
        if (approvalGate) {
          const gate = await approvalGate(call.function.name, args);
          if (!gate.allow) {
            const reason = gate.reason ?? "Blocked by user";
            emitToolCall({ tool: call.function.name, label: externalToolLabel(call.function.name, db), args, callId: call.id });
            emitToolCallDone?.({ tool: call.function.name, callId: call.id, ok: false, error: reason });
            return { call, content: JSON.stringify({ error: reason }) };
          }
          // The gate can block for a long time (human decision) — if the run was
          // aborted while waiting, don't execute this or any remaining tool call.
          if (signal?.aborted) {
            const reason = "Aborted while waiting for approval";
            emitToolCall({ tool: call.function.name, label: externalToolLabel(call.function.name, db), args, callId: call.id });
            emitToolCallDone?.({ tool: call.function.name, callId: call.id, ok: false, error: reason });
            return { call, content: JSON.stringify({ error: reason }), abort: true };
          }
        }
        if (isExternalToolName(call.function.name)) {
          // MCP server / custom service tool — route to the external executor.
          emitToolCall({ tool: call.function.name, label: externalToolLabel(call.function.name, db), args, callId: call.id });
          const output = await executeExternalTool(db, req.workspaceId ?? "", req.projectId ?? "", call.function.name, args);
          // Surface a linkable artefact (Confluence page, web-search hit, …) from
          // the vendor-specific output so the UI can render a browser-opening chip.
          const externalRef = extractExternalRef(output);
          const externalError = externalOutputError(output);
          emitToolCallDone?.({ tool: call.function.name, externalRef, output, callId: call.id, ok: externalError === undefined, error: externalError });
          return { call, content: typeof output === "string" ? output : JSON.stringify(output) };
        }
        const result = await executeTool(db, req, workspacePath, { baseUrl, model, apiKey, provider: provider as "openai" | "localllm" }, call.function.name, args, emitToolCall, getWin, emitToolCallDone, call.id);
        return { call, content: typeof result === "string" ? result : JSON.stringify(result) };
      } catch (toolErr) {
        const message = `Tool "${call.function.name}" failed: ${String(toolErr)}`;
        // executeTool fires its own emitDone only on the success return path; a
        // thrown exception skips it, so emit a failure done here (keyed by callId
        // so the renderer updates the same chip) — otherwise the chip would hang
        // in its running state with no failure signal.
        emitToolCallDone?.({ tool: call.function.name, callId: call.id, ok: false, error: message });
        return { call, content: JSON.stringify({ error: message }) };
      }
    };

    const appendResult = (r: { call: ToolCallMsg; content: string }) => {
      messages.push({ role: "tool", tool_call_id: r.call.id, content: r.content });
    };

    if (approvalGate) {
      // Sequential: approval gates prompt a human — never stack them.
      for (const call of assistantMsg.tool_calls) {
        const r = await runOne(call);
        appendResult(r);
        if (r.abort) break;
      }
    } else {
      // Parallel (agent parity), reordered back into source order.
      const results = await Promise.all(assistantMsg.tool_calls.map((call) => runOne(call)));
      for (const r of results) appendResult(r);
    }
  }

  return {
    exhausted: true,
    content: "I reached the maximum number of steps for this request. Any actions taken so far have been saved — check your board and notes. Try breaking the request into smaller steps.",
    reasoning: accumulatedReasoning,
  };
}
