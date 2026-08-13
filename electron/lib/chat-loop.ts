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
import { AUTO_OUTPUT_TOKEN_CAP, failToolCallsFromTruncatedMessage, interruptedStreamToolCallError, truncationRetryNotice } from "./llm-stream";
import { resolveTransport, markCompletionsOnly, isEndpointNotFound, COMPLETIONS_TRANSPORT, type LlmTransport } from "./llm-transport";
import { TOOLS, type ChatRequest } from "./tools";
import { extractCacheTokens } from "./usage-recorder";
import { executeTool } from "../ipc/chat-executor";
import { executeExternalTool, isExternalToolName, externalToolLabel } from "./external-tools";
import { extractExternalRef } from "./external-ref";
import { externalOutputError } from "./tool-result";
import { traceTool } from "./tool-trace";
import { parseToolArgs } from "./parse-tool-args";

export type RunToolLoopResult =
  | { exhausted: true; content: string; reasoning: string; reasoningSummary?: string }
  | { exhausted: false; content: string; reasoning: string; reasoningSummary?: string };

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
  // Max output tokens. Undefined/0 → Auto: send a generous 32K cap (mirroring
  // opencode) so reasoning models can finish naturally. A positive value is the
  // user's deliberate cap. Two failure modes are avoided by never omitting the
  // field: omitting lets the endpoint apply a tiny server-side default (often
  // 4096) that truncates mid-tool-call, and the old hardcoded 4096 guillotined
  // "thinking" models mid-reasoning, yielding empty content that tripped a 400.
  const maxTokens   = req.config?.maxTokens && req.config.maxTokens > 0 ? req.config.maxTokens : AUTO_OUTPUT_TOKEN_CAP;
  // Built-in tools (or a caller-supplied override) + any external tools in scope.
  const baseTools = toolsOverride ?? TOOLS;
  const combinedTools = extraTools.length > 0 ? [...baseTools, ...extraTools] : baseTools;
  let accumulatedContent = "";
  let accumulatedReasoning = "";
  // Responses-only: condensed reasoning summary, when the provider emits one
  // (captured so the final message's collapsed Thinking panel can show it).
  let accumulatedReasoningSummary = "";

  // Resolve the wire protocol once per run (cached per base URL by the
  // transport). localllm never reaches here — it has its own branch below.
  let transport: LlmTransport | null = null;
  if (provider !== "localllm") {
    transport = await resolveTransport(baseUrl, apiKey);
  }

  // Reasoning round-trip (pi parity): the streamed chain-of-thought is captured
  // for the ThinkingPanel AND re-sent to the SAME model under its native field
  // on the next round (or folded into text when the model changes). Held in a
  // side map keyed by the assistant message object so the caller-owned `messages`
  // array is never mutated with internal metadata. NOTE: this matches
  // `prepareContextMessages` in llm-stream.ts (the agent loop's behaviour); chat
  // previously stripped reasoning entirely, which starved "thinking" models of
  // their own prior chain-of-thought on tool-call rounds.
  const currentModelKey = `${baseUrl}::${model}`;
  const reasoningByMsg = new Map<OpenAIMessage, { reasoning: string; field: string; modelKey: string }>();

  // Build the outgoing request messages: round-trip reasoning for the same
  // model under its native field, fold it into `content` for a different model,
  // and never send the internal metadata. Mirrors prepareContextMessages.
  const prepareForSend = (): OpenAIMessage[] => {
    return messages.map((m) => {
      const ri = reasoningByMsg.get(m);
      if (!ri || m.role !== "assistant") return m;
      if (ri.modelKey === currentModelKey) {
        return { ...m, [ri.field]: ri.reasoning } as unknown as OpenAIMessage;
      }
      const existing = typeof m.content === "string" && m.content.trim() ? m.content.trim() : "";
      return { ...m, content: [existing, ri.reasoning].filter(Boolean).join("\n\n") } as unknown as OpenAIMessage;
    });
  };

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
        // Strip reasoning before assigning — the ON-DEVICE path must not send a
        // reasoning field back (local Llama-family models reject it with a 400).
        // The STREAMED path round-trips reasoning instead (see reasoningByMsg).
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
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      // transport is resolved before the loop (cloud providers only). A 404/405
      // mid-flight downgrades it to completions for this and future rounds.
      let t = transport!;
      const buildBody = (reasoningEffort?: "none" | "low" | "high" | "max") =>
        t.buildBody({
          model,
          messages: prepareForSend(),
          tools: combinedTools,
          maxTokens,
          temperature,
          reasoningEffort,
        });
      const doFetch = (body: Record<string, unknown>) =>
        fetch(t.endpoint(baseUrl), {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify(body),
        });
      try {
        response = await doFetch(buildBody(req.config?.reasoningEffort));
        // reasoning_effort is ignored by non-reasoning models but a strict
        // endpoint may reject it (400/422) — retry once without it so the
        // loop never breaks for models that don't support the field.
        if (req.config?.reasoningEffort && (response.status === 400 || response.status === 422)) {
          response = await doFetch(buildBody(undefined));
        }
      } catch (_err) {
        if (signal?.aborted) return { exhausted: true, content: "", reasoning: accumulatedReasoning };
        return { exhausted: true, content: `Could not reach the AI endpoint at \`${baseUrl}\`. Check your endpoint URL and make sure the server is running.`, reasoning: "" };
      }

      if (!response.ok) {
        // A provider we thought spoke Responses returned 404/405 — downgrade it
        // to chat-completions and re-fetch this turn once.
        if (t.mode === "responses" && isEndpointNotFound(response.status)) {
          markCompletionsOnly(baseUrl);
          transport = COMPLETIONS_TRANSPORT;
          t = transport;
          try {
            response = await doFetch(buildBody(req.config?.reasoningEffort));
          } catch (_err) {
            if (signal?.aborted) return { exhausted: true, content: "", reasoning: accumulatedReasoning };
            return { exhausted: true, content: `Could not reach the AI endpoint at \`${baseUrl}\`. Check your endpoint URL and make sure the server is running.`, reasoning: "" };
          }
        }
        if (!response.ok) {
          const errText = await response.text().catch(() => response.statusText);
          return { exhausted: true, content: `AI endpoint error (${response.status}): ${errText.slice(0, 300)}`, reasoning: "" };
        }
      }

      const reader = response.body?.getReader();
      if (!reader) return { exhausted: true, content: "No response stream", reasoning: "" };

      // Shared SSE parse (same as the agent loop) so reasoning-field capture,
      // finish_reason tracking, and tool-call buffering can never diverge again.
      const turn = await t.consume(reader, {
        signal,
        onToken: (delta) => { if (onToken) onToken(delta); },
        onThought: (delta) => { if (onThought) onThought(delta); },
        onSummary: (delta) => { accumulatedReasoningSummary += delta; },
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
        tool_calls: toolCalls,
      };
      // Round-trip reasoning to the same model (pi parity) — never baked into
      // `content`. Only the STREAMED path round-trips; the on-device path below
      // still strips reasoning (local models reject a reasoning field).
      if (typeof turn.reasoning === "string" && turn.reasoning.length > 0 && typeof turn.reasoningField === "string") {
        reasoningByMsg.set(assistantMsg, {
          reasoning: turn.reasoning,
          field: turn.reasoningField,
          modelKey: currentModelKey,
        });
      }
    }

    // No tool calls — model is ready to produce its final reply
    if (!assistantMsg.tool_calls?.length) {
      messages.push(assistantMsg);
      return { exhausted: false, content: accumulatedContent, reasoning: accumulatedReasoning, reasoningSummary: accumulatedReasoningSummary };
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
      // Recover, don't refuse, when EVERY tool call in the turn is "tail-complete":
      // arguments valid except missing closing delimiters (the stream/gateway
      // dropped the final `"}` after otherwise-complete arguments). A cut landing
      // exactly at the tail means the emitted data IS the intended data. Anything
      // else (strict-valid = possible boundary cut with silently missing fields;
      // unparseable = mid-structure cut) is still refused.
      const calls = assistantMsg.tool_calls ?? [];
      const parsedCalls = calls.map((call) => ({ call, parsed: parseToolArgs(call.function.arguments) }));
      const tailComplete =
        parsedCalls.length > 0 &&
        parsedCalls.every(({ parsed }) => parsed.ok && parsed.tailRepaired === true);
      if (!tailComplete) {
        // Do NOT push the truncated assistant message or its synthesized tool
        // results into history — replaying that turn poisons the next request
        // with truncated tool-call JSON and duplicate/orphaned tool_call_ids
        // (→ provider 400). Emit the failed chips for the UI, then hand the model
        // a synthetic notice so it re-issues with complete arguments.
        failToolCallsFromTruncatedMessage(calls, {
          maxTokens,
          error: streamInterrupted ? interruptedStreamToolCallError() : undefined,
          labelFor: (name) => externalToolLabel(name, db),
          emitStart: (tool, label, callId, args) => emitToolCall({ tool, label, args, callId }),
          emitEnd: (tool, label, ok, output, callId, _args) => emitToolCallDone?.({ tool, callId, ok, error: output }),
        });
        messages.push({
          role: "user",
          content: truncationRetryNotice(calls.length, maxTokens),
        });
        continue;
      }
      // Tail-complete → fall through and execute. Rewrite each repaired call's
      // arguments to its canonical JSON (reusing the parse above) so history
      // holds what actually ran.
      for (const { call, parsed } of parsedCalls) {
        if (parsed.ok && parsed.tailRepaired) call.function.arguments = JSON.stringify(parsed.value);
      }
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
      if (parsed.ok && parsed.tailRepaired !== true) {
        args = parsed.value;
        // A repaired parse (e.g. a `<arg_value>` placeholder, dropped comma) is
        // canonicalised back into `arguments` so history holds valid JSON —
        // replaying the raw malformed string makes the next request 400.
        if (parsed.repaired) call.function.arguments = JSON.stringify(parsed.value);
        traceTool("parse", {
          toolName: call.function.name,
          title: typeof args.title === "string" ? args.title : "",
          content: typeof args.content === "string" ? args.content : "",
          rawArguments: call.function.arguments || "",
          repaired: parsed.repaired ? 1 : 0,
        });
      } else {
        // A tail-repaired parse (valid only after appending missing closing
        // delimiters) is refused on the NORMAL path — only the explicit
        // length/interrupted recovery gate above may execute those. On a natural
        // finish the model simply re-issues with complete JSON.
        parseError = parsed.ok
          ? "tool-call arguments missing closing delimiters — re-issue with complete JSON"
          : parsed.error;
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
    reasoningSummary: accumulatedReasoningSummary,
  };
}
