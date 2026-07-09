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
import type { OpenAIConfig } from "../ai-config";
import { contextLimitForModel } from "../models-dev";
import {
  type AiTool,
  type ChatProvider,
  type ChatUsage,
  type FilePart,
  type StreamEvent,
  type TextPart,
  type ToolPart,
  type UIMessage,
} from "./types";

// ── request mapping ─────────────────────────────────────────────────────────

interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** Map one internal UIMessage to one-or-more OpenAI messages. */
function mapMessage(m: UIMessage): OpenAIMessage[] {
  const textParts = m.parts.filter((p): p is TextPart => p.type === "text");
  const fileParts = m.parts.filter((p): p is FilePart => p.type === "file");
  const toolParts = m.parts.filter(
    (p): p is ToolPart => typeof p.type === "string" && p.type.startsWith("tool-"),
  );

  const out: OpenAIMessage[] = [];

  if (m.role === "assistant" && toolParts.length > 0) {
    // Assistant turn that called tools: one assistant msg with tool_calls, then
    // a `tool` msg per result.
    const text = textParts.map((p) => p.text).join("");
    out.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolParts.map((t) => ({
        id: t.toolCallId,
        type: "function",
        function: {
          name: t.toolName ?? t.type.replace(/^tool-/, ""),
          arguments: JSON.stringify(t.input ?? {}),
        },
      })),
    });
    for (const t of toolParts) {
      const value =
        t.output && typeof t.output === "object" && "value" in t.output
          ? (t.output as { value: string }).value
          : JSON.stringify(t.output ?? "");
      out.push({ role: "tool", tool_call_id: t.toolCallId, content: value });
    }
    return out;
  }

  // Plain text/image message. Images become image_url content parts (user only).
  if (fileParts.length > 0 && m.role === "user") {
    const content: OpenAIContentPart[] = [];
    for (const p of textParts) if (p.text) content.push({ type: "text", text: p.text });
    for (const f of fileParts) content.push({ type: "image_url", image_url: { url: f.url } });
    out.push({ role: "user", content });
    return out;
  }

  const text = textParts.map((p) => p.text).join("");
  out.push({ role: m.role, content: text });
  return out;
}

function mapTools(tools: Record<string, AiTool>) {
  return Object.entries(tools).map(([name, t]) => ({
    type: "function" as const,
    function: { name, description: t.description, parameters: t.jsonSchema },
  }));
}

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
  ): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: messages.flatMap(mapMessage),
      stream: true,
      // Ask for a final usage chunk (prompt/completion tokens) to drive the
      // context ring. Standard OpenAI honours it; some OpenAI-compatible
      // gateways reject unknown fields with a 400, so we retry without it below.
      stream_options: { include_usage: true },
    };
    const mapped = mapTools(tools);
    if (mapped.length > 0) body.tools = mapped;

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
    // A 400 may mean the gateway rejected `stream_options`; retry once without
    // it (we just lose server-reported usage, falling back to no ring).
    if (res.status === 400 && "stream_options" in body) {
      const rest = { ...body };
      delete rest.stream_options;
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

    // Build the ring usage from the server's prompt_tokens + the model's context
    // window (models.dev, cached). Undefined when the endpoint reported no usage.
    const buildUsage = async (): Promise<ChatUsage | undefined> => {
      if (promptTokens == null) return undefined;
      // Manual override wins; else look up the model in models.dev; else default.
      const contextLimit = config.contextLimit ?? (await contextLimitForModel(config.model));
      return { promptTokens, contextLimit };
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
            usage?: { prompt_tokens?: number };
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
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          // Reasoning tail (if the endpoint streams it) — surface it before the
          // answer content so it renders as a "thinking" block. Skip redacted /
          // empty deltas (some providers send a literal "[REDACTED]").
          const reasoning = delta?.reasoning_content ?? delta?.reasoning;
          if (reasoning && reasoning.trim() && reasoning.trim().toUpperCase() !== "[REDACTED]") {
            yield { type: "reasoning-delta", delta: reasoning };
          }
          if (delta?.content) {
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
