/**
 * Responses API provider — the OpenAI Responses (`/v1/responses`) counterpart to
 * the `openai.ts` Chat Completions provider.
 *
 * Reuses the SAME request-shaping as desktop via the shared helpers
 * (`@cairn/shared/chat/responses`): `mapMessage` from `openai.ts` produces the
 * Chat Completions message shape, and `buildResponsesBody` converts it to
 * Responses input items (messages, `function_call` / `function_call_output`,
 * and `input_image` / `input_file` multimodal parts). The streamed Responses
 * SSE events are translated into the same normalised `StreamEvent`s the agent
 * loop already consumes, so `agent.ts` is unchanged.
 *
 * Selection: `index.ts` probes the endpoint once and returns this provider when
 * it serves `/responses`, otherwise the Chat Completions provider.
 */

import { fetch as expoFetch } from "expo/fetch";
import {
  buildResponsesBody,
  isEndpointNotFound,
  isResponsesEndpoint,
} from "@cairn/shared/chat/responses";
import type { OpenAIConfig } from "../ai-config";
import { contextLimitForModel } from "../models-dev";
import { estimatePromptTokens } from "../token-breakdown";
import { countTextTokens } from "../tokens";
import { mapMessage, mapTools } from "./openai";
import type { AiTool, ChatProvider, ChatUsage, StreamEvent, UIMessage } from "./types";

interface ToolAccum {
  id: string;
  name: string;
  args: string;
}

function makeResponsesStreamer(config: OpenAIConfig) {
  return async function* streamResponses(
    messages: UIMessage[],
    tools: Record<string, AiTool>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    // Reuse the shared request builder: it maps messages → input items and
    // flattens the `{ type:"function", function:{…} }` tool defs.
    const body = buildResponsesBody({
      model: config.model,
      messages: messages.flatMap(mapMessage),
      tools: mapTools(tools),
      stream: true,
    });

    const url = new URL("responses", config.baseUrl.replace(/\/?$/, "/")).toString();
    const res = await expoFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = res.ok ? "no response body" : `HTTP ${res.status}`;
      throw new Error(`Responses provider error (${detail})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolAccum = new Map<number, ToolAccum>();
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let reasoningTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    // Client-side fallbacks when the endpoint reports no usage (mirrors the
    // Chat Completions provider + desktop).
    let streamedText = "";
    let streamedReasoning = "";

    const buildUsage = async (): Promise<ChatUsage> => {
      const contextLimit = config.contextLimit ?? (await contextLimitForModel(config.model));
      const estimate = estimatePromptTokens(messages, tools);
      const prompt = promptTokens != null && promptTokens > 0 ? promptTokens : estimate;
      const completion = completionTokens ?? (streamedText ? countTextTokens(streamedText) : 0);
      const reasoning = reasoningTokens != null && reasoningTokens > 0
        ? reasoningTokens
        : streamedReasoning
          ? countTextTokens(streamedReasoning)
          : 0;
      return {
        promptTokens: prompt,
        contextLimit,
        completionTokens: completion,
        reasoningTokens: reasoning,
        cacheReadTokens,
        estimated: promptTokens == null || promptTokens <= 0,
      };
    };

    const flushTools = function* (): Generator<StreamEvent> {
      for (const acc of toolAccum.values()) {
        let input: unknown = {};
        try {
          input = acc.args ? JSON.parse(acc.args) : {};
        } catch {
          input = { _raw: acc.args };
        }
        yield { type: "tool-input-available", toolCallId: acc.id, toolName: acc.name, input };
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let evt: any;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          const type: string | undefined = evt?.type;

          switch (type) {
            case "response.output_text.delta": {
              const d = String(evt.delta ?? "");
              if (d) {
                streamedText += d;
                yield { type: "text-delta", delta: d };
              }
              break;
            }
            case "response.reasoning_text.delta": {
              const d = String(evt.delta ?? "");
              if (d) {
                streamedReasoning += d;
                yield { type: "reasoning-delta", delta: d };
              }
              break;
            }
            case "response.reasoning_summary_text.delta": {
              const d = String(evt.delta ?? "");
              if (d) yield { type: "reasoning-summary-delta", delta: d };
              break;
            }
            case "response.output_item.added": {
              const item = evt.item ?? {};
              if (item.type === "function_call") {
                const outIdx = typeof evt.output_index === "number" ? evt.output_index : toolAccum.size;
                const name = String(item.name ?? "");
                const callId = String(item.call_id ?? "");
                toolAccum.set(outIdx, { id: callId, name, args: "" });
                if (name) yield { type: "tool-input-start", toolCallId: callId, toolName: name };
              }
              break;
            }
            case "response.function_call_arguments.delta": {
              const outIdx = typeof evt.output_index === "number" ? evt.output_index : toolAccum.size - 1;
              const acc = toolAccum.get(outIdx);
              const d = String(evt.delta ?? "");
              if (acc) acc.args += d;
              else toolAccum.set(outIdx, { id: "", name: "", args: d });
              break;
            }
            case "response.function_call_arguments.done": {
              const outIdx = typeof evt.output_index === "number" ? evt.output_index : toolAccum.size - 1;
              const acc = toolAccum.get(outIdx);
              const args = String(evt.arguments ?? "");
              if (acc) acc.args = args;
              else toolAccum.set(outIdx, { id: "", name: "", args });
              break;
            }
            case "response.completed":
            case "response.incomplete":
            case "response.failed": {
              const resp = evt.response ?? {};
              const status = typeof resp.status === "string" ? resp.status : type.slice("response.".length);
              // The agent loop branches on finishReason to decide whether to keep
              // looping after a tool call — mirror the completions convention of
              // "tool_calls" so a tool-call turn isn't mistaken for a final stop.
              finishReason =
                status === "completed"
                  ? toolAccum.size > 0
                    ? "tool_calls"
                    : "stop"
                  : status === "incomplete" && resp.incomplete_details?.reason === "max_output_tokens"
                    ? "length"
                    : undefined;
              const usage = resp.usage ?? {};
              if (typeof usage.input_tokens === "number") promptTokens = usage.input_tokens;
              if (typeof usage.output_tokens === "number") completionTokens = usage.output_tokens;
              if (typeof usage.output_tokens_details?.reasoning_tokens === "number") {
                reasoningTokens = usage.output_tokens_details.reasoning_tokens;
              }
              if (typeof usage.input_tokens_details?.cached_tokens === "number") {
                cacheReadTokens = usage.input_tokens_details.cached_tokens;
              }
              // Capture reasoning items for round-trip before finishing.
              const reasoningItems: Array<Record<string, unknown>> = [];
              const output = resp.output;
              if (Array.isArray(output)) {
                for (const item of output) {
                  if (item.type === "reasoning") reasoningItems.push(item);
                }
              }
              if (reasoningItems.length > 0) yield { type: "reasoning-items", items: reasoningItems };
              yield* flushTools();
              yield { type: "finish", finishReason: finishReason ?? "stop", usage: await buildUsage() };
              return;
            }
            case "error": {
              throw new Error(`Responses stream error: ${String(evt.message ?? evt.error ?? "unknown")}`);
            }
            default:
              break;
          }
        }
      }
    }

    // Stream ended without a response.completed / response.failed event.
    yield* flushTools();
    yield { type: "finish", finishReason: finishReason ?? "stop", usage: await buildUsage() };
  };
}

/** Build a Responses-based provider bound to a resolved config. */
export function makeResponsesProvider(config: OpenAIConfig): ChatProvider {
  return { name: "Responses", stream: makeResponsesStreamer(config) };
}

/**
 * Whether the configured endpoint serves `/responses`. OpenAI-native / Azure
 * endpoints answer true without I/O; anything else is probed once with a tiny
 * request (404/405 = chat-completions only). Never throws.
 */
export async function supportsResponses(baseUrl: string, apiKey: string): Promise<boolean> {
  if (isResponsesEndpoint(baseUrl)) return true;
  const url = new URL("responses", baseUrl.replace(/\/?$/, "/")).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await expoFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "__cairn_probe__", input: "ping", max_output_tokens: 1, stream: false }),
      signal: controller.signal,
    });
    return !isEndpointNotFound(res.status);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
