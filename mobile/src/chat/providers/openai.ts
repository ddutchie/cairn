/**
 * OpenAI-compatible provider — streaming POST {base}/chat/completions.
 *
 * This is the "bring your own key" path for third-party builders and anyone not
 * using the first-party Rork endpoint. It targets the standard OpenAI Chat
 * Completions API (also implemented by Azure OpenAI, OpenRouter, Together,
 * LM Studio, Ollama's OpenAI shim, etc.) so users can point Cairn at any
 * compatible endpoint with a base URL + API key configured in-app (ai-config).
 *
 * It maps our internal `UIMessage`/`AiTool` shapes onto OpenAI's request body,
 * and translates the streamed `chat.completion.chunk` deltas back into the same
 * normalised `StreamEvent`s the Rork provider emits, so agent.ts is unchanged.
 *
 * Tool-calling: OpenAI streams tool calls incrementally (id/name on the first
 * chunk, arguments as string fragments across chunks). We accumulate per index
 * and emit a single `tool-input-available` with parsed JSON args at finish.
 */

import { fetch as expoFetch } from "expo/fetch";
import {
  parseCredits,
  resolveCreditSpec,
  type CreditInfo,
} from "@cairn/shared/chat/provider-credits";
import type { OpenAIConfig } from "../ai-config";
import { fetchProvidersManifest, getRegistryProviders } from "../providers-registry";
import { contextLimitForModel } from "../models-dev";
import { estimatePromptTokens } from "../token-breakdown";
import { countTextTokens } from "../tokens";
import { buildChatCompletionsBody } from "./openai-body";
import {
  type AiTool,
  type ChatProvider,
  type ChatUsage,
  type StreamEvent,
  type StreamOptions,
  type UIMessage,
} from "./types";

// ── stream translation ──────────────────────────────────────────────────────

interface ToolAccum {
  id: string;
  name: string;
  args: string;
}

function makeStreamer(config: OpenAIConfig) {
  return async function* streamOpenAI(
    messages: UIMessage[],
    tools: Record<string, AiTool>,
    signal?: AbortSignal,
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent> {
    const body = buildChatCompletionsBody(config, messages, tools, options);

    const url = new URL("chat/completions", config.baseUrl.replace(/\/?$/, "/")).toString();
    const send = (payload: Record<string, unknown>) =>
      expoFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal,
      });

    let res = await send(body);
    // A 400 may mean the gateway rejected fields it doesn't support — the
    // `stream_options` usage request and/or an explicit `temperature` on a model
    // that rejects it. Retry once without both (we lose server-reported usage
    // and fall back to the client estimate; temperature falls back to the
    // model's own default for this one retry).
    if (res.status === 400 && ("stream_options" in body || "temperature" in body)) {
      const rest = { ...body };
      delete rest.stream_options;
      delete rest.temperature;
      res = await send(rest);
    }
    if (!res.ok || !res.body) {
      const detail = res.ok ? "no response body" : `HTTP ${res.status}`;
      throw new Error(`OpenAI provider error (${detail})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolAccum = new Map<number, ToolAccum>();
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let reasoningTokens: number | undefined;
    let costUsd: number | undefined;
    let cacheReadTokens: number | undefined;
    let cacheCreationTokens: number | undefined;
    // Client-side fallbacks when the endpoint reports no usage chunk: text and
    // reasoning streamed this turn are counted so the ring + Usage view always
    // have numbers (desktop estimates the same way when a provider reports none).
    let streamedText = "";
    let streamedReasoning = "";

    // Build the ring usage from the server's prompt_tokens + the model's context
    // window (models.dev, cached), falling back to the desktop-parity client
    // estimate when the endpoint reported no usage. Never undefined.
    const buildUsage = async (): Promise<ChatUsage> => {
      // Manual override wins; else look up the model in models.dev; else default.
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
        costUsd,
        cacheReadTokens,
        cacheCreationTokens,
        // Estimated when the prompt count (the ring's denominator) came from
        // our on-device count rather than the server.
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
      // Normalise CRLF streams so \r\n\r\n frames split exactly like \n\n.
      buffer = buffer.replace(/\r\n/g, "\n");

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            yield* flushTools();
            yield { type: "finish", finishReason: finishReason ?? "stop", usage: await buildUsage() };
            return;
          }
          let chunk: {
            choices?: {
              delta?: {
                content?: string;
                // Reasoning ("thinking") text streamed by some OpenAI-compatible
                // endpoints. DeepSeek uses `reasoning_content`; OpenRouter's
                // unified field is `reasoning`. First-party OpenAI o-series does
                // NOT stream reasoning, so this is simply absent there.
                reasoning_content?: string;
                reasoning?: string;
                tool_calls?: {
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }[];
              };
              finish_reason?: string;
            }[];
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              completion_tokens_details?: { reasoning_tokens?: number };
              // Some OpenAI-compatible providers (e.g. Neuralwatt) report the
              // USD cost of the call here.
              cost?: number;
              // Prompt-cache tokens: OpenAI-style (cached_tokens is a subset of
              // prompt_tokens), DeepSeek-style (prompt_cache_hit_tokens), or
              // Anthropic-style via a gateway (separate cache_read/creation counts).
              prompt_tokens_details?: { cached_tokens?: number };
              prompt_cache_hit_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          // Usage arrives in its own chunk (choices empty) when include_usage is on.
          if (typeof chunk.usage?.prompt_tokens === "number") {
            promptTokens = chunk.usage.prompt_tokens;
          }
          if (typeof chunk.usage?.completion_tokens === "number") {
            completionTokens = chunk.usage.completion_tokens;
          }
          if (typeof chunk.usage?.completion_tokens_details?.reasoning_tokens === "number") {
            reasoningTokens = chunk.usage.completion_tokens_details.reasoning_tokens;
          }
          if (typeof chunk.usage?.cost === "number") {
            costUsd = chunk.usage.cost;
          }
          // prompt_cache_hit_tokens and prompt_tokens_details.cached_tokens are
          // the SAME number reported under different names (DeepSeek vs
          // OpenAI-style) — take the max, not the sum, then add any separate
          // Anthropic-style cache_read_input_tokens on top.
          const cacheRead =
            (chunk.usage?.cache_read_input_tokens ?? 0) +
            Math.max(chunk.usage?.prompt_cache_hit_tokens ?? 0, chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0);
          if (cacheRead > 0) cacheReadTokens = cacheRead;
          if (typeof chunk.usage?.cache_creation_input_tokens === "number") {
            cacheCreationTokens = chunk.usage.cache_creation_input_tokens;
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          // Reasoning tail (if the endpoint streams it) — surface it before the
          // answer content so it renders as a "thinking" block. Skip redacted /
          // empty deltas (some providers send a literal "[REDACTED]"). Remember
          // which field it arrived in so the assistant turn can round-trip it.
          const reasoningField = delta?.reasoning_content
            ? "reasoning_content"
            : delta?.reasoning
              ? "reasoning"
              : undefined;
          const reasoning = reasoningField ? (delta as Record<string, unknown>)[reasoningField] as string : undefined;
          if (reasoning && reasoning.trim() && reasoning.trim().toUpperCase() !== "[REDACTED]") {
            streamedReasoning += reasoning;
            yield { type: "reasoning-delta", delta: reasoning, field: reasoningField };
          }
          if (delta?.content) {
            streamedText += delta.content;
            yield { type: "text-delta", delta: delta.content };
          }
          for (const tc of delta?.tool_calls ?? []) {
            const acc = toolAccum.get(tc.index) ?? { id: "", name: "", args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) {
              acc.name = tc.function.name;
              yield { type: "tool-input-start", toolCallId: acc.id, toolName: acc.name };
            }
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolAccum.set(tc.index, acc);
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
    }

    // Stream ended without an explicit [DONE].
    yield* flushTools();
    yield { type: "finish", finishReason: finishReason ?? "stop", usage: await buildUsage() };
  };
}

/** Build an OpenAI-compatible provider bound to a resolved config. */
export function makeOpenAIProvider(config: OpenAIConfig): ChatProvider {
  return { name: "OpenAI-compatible", stream: makeStreamer(config) };
}

/**
 * Query the endpoint's available models via `GET {base}/models` (the standard
 * OpenAI list-models call, supported by most compatible servers). Returns model
 * ids sorted alphabetically. Throws with a readable message on failure so the
 * settings UI can surface it (bad key, endpoint that doesn't implement /models,
 * offline, …).
 */
export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = new URL("models", baseUrl.replace(/\/?$/, "/")).toString();
  const res = await expoFetch(url, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? "Couldn't list models: the API key was rejected."
        : `Couldn't list models (HTTP ${res.status}).`,
    );
  }
  let json: { data?: { id?: string }[] } | { id?: string }[];
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new Error("Couldn't parse the models response.");
  }
  // OpenAI shape: { data: [{ id }] }. Some servers return a bare array.
  const list = Array.isArray(json) ? json : (json.data ?? []);
  const ids = list
    .map((m) => (typeof m === "string" ? m : m?.id))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

/**
 * Remaining-credits / balance for a provider key. All figures are USD credits.
 * `null` fields mean unlimited / not reported.
 */
export type ProviderKeyInfo = CreditInfo;

/**
 * Best-effort lookup of the key's remaining credits. Prefers the community
 * manifest's `credits` descriptor for the configured endpoint — DeepSeek's
 * /user/balance, Neuralwatt's /v1/quota, OpenRouter's /key — falling back to the
 * OpenRouter-style `GET {base}/key` probe. Returns null (never throws) when the
 * provider doesn't expose it — a non-2xx response, a parse failure, or a network
 * error all mean "no credits info", so the settings UI can simply hide the
 * display.
 */
export async function getKeyInfo(baseUrl: string, apiKey: string): Promise<ProviderKeyInfo | null> {
  if (!apiKey) return null;
  // Soft-refresh the manifest so descriptor lookups see the latest catalog; on
  // failure the cached copy is used (or no match → the default probe below).
  await fetchProvidersManifest();
  const spec = resolveCreditSpec(baseUrl, getRegistryProviders());
  const url = spec?.url ?? new URL("key", baseUrl.replace(/\/?$/, "/")).toString();
  let res: Awaited<ReturnType<typeof expoFetch>>;
  try {
    res = await expoFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return null; // offline / DNS / TLS — treat as "not supported"
  }
  if (!res.ok) return null;
  let json: unknown;
  try {
    json = (await res.json()) as unknown;
  } catch {
    return null;
  }
  return parseCredits(spec?.shape ?? "openrouter", json);
}
