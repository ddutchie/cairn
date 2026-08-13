/**
 * Responses API adapter — desktop streaming parser + re-exports of the shared
 * request/conversion helpers (`shared/chat/responses.ts`).
 *
 * The pure pieces — endpoint gating, tool flattening, message → input mapping,
 * multimodal content-part conversion, request-body building, and non-streaming
 * output parsing — live in the shared module so the mobile app reuses them
 * verbatim. This file keeps only the desktop-specific streaming parser, which
 * turns a Responses SSE stream into the same `StreamedTurn` shape the chat and
 * agent loops consume from `consumeAssistantStream`.
 *
 * See the migration guide:
 *   https://developers.openai.com/api/docs/guides/migrate-to-responses
 */

import { iterSseData } from "./sse";
import { randomUUID } from "node:crypto";
import type { StreamOptions, StreamedTurn } from "./llm-stream";

// Re-export the pure shared helpers so existing desktop importers (llm.ts,
// llm-transport.ts, compaction.ts, chat-subagent-loop.ts) are unchanged.
export {
  isResponsesEndpoint,
  isEndpointNotFound,
  mapToolToResponses,
  mapContentPartsToResponses,
  mapMessagesToInput,
  roundTripReasoningItem,
  buildResponsesBody,
  parseResponsesOutput,
  responsesToCompletionsShape,
  type ResponsesInputItem,
  type ResponsesSourceMessage,
  type ResponsesFunctionTool,
  type ParsedResponsesUsage,
} from "../../shared/chat/responses";

// ── Streaming conversion ─────────────────────────────────────────────────────

interface ResponsesToolBuffer {
  id: string;
  name: string;
  args: string;
}

/**
 * Consume a Responses SSE stream and assemble the SAME `StreamedTurn` shape the
 * loops already consume from `consumeAssistantStream`. Branches on each event's
 * `type`:
 *
 *   - `response.output_text.delta`            → content (+ onToken)
 *   - `response.reasoning_text.delta`         → reasoning (+ onThought)
 *   - `response.reasoning_summary_text.delta` → reasoning summary (+ onSummary)
 *   - `response.output_item.added`            → a `function_call` item's name +
 *                                                call_id (fires onToolPending)
 *   - `response.function_call_arguments.delta` → append to the call's arguments
 *   - `response.function_call_arguments.done`  → authoritative full arguments
 *   - `response.completed` / `incomplete` / `failed` → finish_reason + usage
 *   - `error`                                  → throw
 */
export async function consumeResponsesStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: StreamOptions,
): Promise<StreamedTurn> {
  const { signal } = opts;
  let content = "";
  let reasoning = "";
  let reasoningSummary = "";
  let reasoningField: string | null = null;
  let finishReason: string | null = null;
  // Raw reasoning items captured for round-trip (encrypted_content / summary).
  const reasoningItems: Array<Record<string, unknown>> = [];
  // Keyed by output_index (stable across added + delta + done events), matching
  // the chat-completions `index` convention the loops already understand.
  const toolBuffers = new Map<number, ResponsesToolBuffer>();
  const streamCallIds = new Map<number, string>();

  for await (const jsonStr of iterSseData(reader, signal)) {
    let evt: unknown;
    try {
      evt = JSON.parse(jsonStr);
    } catch {
      continue; // skip malformed SSE JSON line
    }
    const e = evt as Record<string, unknown>;
    const type = String(e.type ?? "");

    switch (type) {
      case "response.output_text.delta": {
        const delta = String(e.delta ?? "");
        if (delta) {
          content += delta;
          opts.onToken?.(delta);
        }
        break;
      }
      case "response.reasoning_text.delta": {
        reasoningField ??= "reasoning";
        const delta = String(e.delta ?? "");
        reasoning += delta;
        if (delta) opts.onThought?.(delta);
        break;
      }
      case "response.reasoning_summary_text.delta": {
        const delta = String(e.delta ?? "");
        reasoningSummary += delta;
        if (delta) opts.onSummary?.(delta);
        break;
      }
      case "response.output_item.added": {
        const item = (e.item ?? {}) as Record<string, unknown>;
        if (item.type === "function_call") {
          const idx = typeof e.output_index === "number" ? e.output_index : toolBuffers.size;
          const name = String(item.name ?? "");
          toolBuffers.set(idx, { id: String(item.call_id ?? ""), name, args: "" });
          if (name && !streamCallIds.has(idx)) {
            const callId = opts.makeCallId?.(idx, name) ?? `${name}:${Date.now()}:${idx}`;
            streamCallIds.set(idx, callId);
            opts.onToolPending?.(name, callId);
          }
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const idx = typeof e.output_index === "number" ? e.output_index : toolBuffers.size - 1;
        const buf = toolBuffers.get(idx);
        const delta = String(e.delta ?? "");
        if (buf) buf.args += delta;
        else if (delta) toolBuffers.set(idx, { id: "", name: "", args: delta });
        break;
      }
      case "response.function_call_arguments.done": {
        const idx = typeof e.output_index === "number" ? e.output_index : toolBuffers.size - 1;
        const buf = toolBuffers.get(idx);
        const args = String(e.arguments ?? "");
        if (buf) buf.args = args;
        else if (args) toolBuffers.set(idx, { id: "", name: "", args });
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const resp = (e.response ?? {}) as Record<string, unknown>;
        const status = typeof resp.status === "string" ? resp.status : type.slice("response.".length);
        if (status === "completed") {
          finishReason = "stop";
        } else if (status === "incomplete") {
          const details = (resp.incomplete_details ?? {}) as Record<string, unknown>;
          // The Responses analogue of Chat Completions' finish_reason: "length".
          finishReason = details.reason === "max_output_tokens" ? "length" : null;
        } else {
          finishReason = null;
        }
        // Capture the completed `reasoning` items for round-trip, and fall back
        // to the `summary` array when the summary never streamed as deltas.
        const output = resp.output as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(output)) {
          for (const item of output) {
            if (item.type !== "reasoning") continue;
            reasoningItems.push(item);
            if (!reasoningSummary && Array.isArray(item.summary)) {
              const text = item.summary
                .map((p) => String((p as Record<string, unknown>).text ?? ""))
                .filter(Boolean)
                .join("\n");
              if (text) {
                reasoningSummary = text;
                opts.onSummary?.(text);
              }
            }
          }
        }
        const usage = resp.usage as Record<string, unknown> | undefined;
        if (usage) {
          const outDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
          const inDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
          opts.onUsage?.({
            promptTokens: Number(usage.input_tokens ?? 0),
            completionTokens: Number(usage.output_tokens ?? 0),
            reasoningTokens: Number(outDetails.reasoning_tokens ?? 0),
            cacheReadTokens: Number(inDetails.cached_tokens ?? 0),
            cacheCreationTokens: 0,
            raw: usage,
            chunkCost: undefined,
            finishReason,
          });
        }
        break;
      }
      case "error": {
        const message = String(e.message ?? e.error ?? "Unknown Responses API error");
        throw new Error(`Responses API stream error: ${message}`);
      }
      default:
        break;
    }
  }

  // Assemble tool calls in output_index order, mirroring consumeAssistantStream
  // (including the unique-id fallback for an interrupted stream that cut before
  // the call_id arrived).
  const entries = Array.from(toolBuffers.entries()).sort(([a], [b]) => a - b);
  const toolCalls = entries.map(([, buf]) => ({
    id: buf.id || `${buf.name || "tool"}:${randomUUID().slice(0, 8)}`,
    type: "function" as const,
    function: { name: buf.name, arguments: buf.args },
  }));
  const toolCallIndexes = entries.map(([idx]) => idx);

  return { content, reasoning, reasoningField, reasoningSummary, reasoningItems, finishReason, toolCalls, toolCallIndexes, streamCallIds };
}
