/**
 * Cairn — Local Llama & On-Device completions router
 *
 * Routes local LLM queries offline and on-demand to the local llama-server process.
 */

import { OpenAIMessage } from "./llm";
import { isLlamaServerInstalled, ensureLlamaServerRunning, listModels } from "./llama-server";

/**
 * On-device chat token budget. Reasoning-style local models (Qwen3.5-9B,
 * Bonsai-27B, partly Gemma-4) frequently emit their answer into
 * `message.reasoning_content` and exhaust a small default budget on
 * chain-of-thought before writing any `content` — leaving Cairn's
 * self-healing parser with nothing to repair. ≥4096 keeps the structured-
 * output path reliable for the models we benchmark (see "Local Model
 * Benchmark — Bonsai / Qwythos / Qwen vs Gemma", 2026-07-21).
 */
export const LOCAL_LLM_MAX_TOKENS = 4096;

/**
 * Check if the local Llama server and on-device model integration are available and configured.
 */
export async function isLocalLLMAvailable(): Promise<{ available: boolean; reason?: string }> {
  if (!isLlamaServerInstalled()) {
    return {
      available: false,
      reason: "llama-server is not installed. Please install llama.cpp via Homebrew: 'brew install llama.cpp' and restart."
    };
  }

  // Check if at least one model is downloaded/installed
  const models = listModels();
  const hasInstalled = models.some((m) => m.status === "installed");
  if (!hasInstalled) {
    return {
      available: false,
      reason: "No local on-device models downloaded. Please download a quantization variant in settings first."
    };
  }

  return { available: true };
}

/**
 * Call local on-device chat completions (non-streaming, supports tools).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callLocalLLMChat(messages: OpenAIMessage[], tools?: any[]): Promise<any> {
  const port = await ensureLlamaServerRunning();
  
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const body = {
    model: "gemma-4",
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
    })),
    ...(tools && tools.length > 0 ? { tools } : {}),
    temperature: 0.3,
    max_tokens: LOCAL_LLM_MAX_TOKENS,
    stream: false
  };

  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Local llama-server error ${response.status}: ${await response.text().catch(() => response.statusText)}`);
  }

  return await response.json();
}

/**
 * Continue a generation that ran out of tokens before producing final
 * `content`. Sends the conversation back with an explicit request to emit
 * only the final answer (no further reasoning), so a reasoning model that
 * exhausted its budget on chain-of-thought can still close out the reply.
 *
 * Returns the assistant message of the continuation, or null if the model
 * still produced no usable content.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function continueLocalLLMAfterReasoning(messages: OpenAIMessage[], tools?: any[]): Promise<any | null> {
  const port = await ensureLlamaServerRunning();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const body = {
    model: "gemma-4",
    messages: [
      ...messages,
      { role: "user" as const, content: "Continue. Provide the final, concise answer now without further reasoning." },
    ],
    ...(tools && tools.length > 0 ? { tools } : {}),
    temperature: 0.3,
    max_tokens: LOCAL_LLM_MAX_TOKENS,
    stream: false
  };

  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    return null;
  }

  const res = await response.json() as { choices?: Array<{ message?: { content?: string | null }; role?: string } & Record<string, unknown>> };
  const choice = res.choices?.[0];
  if (!choice) return null;
  return choice;
}

/**
 * Stream local on-device chat completions (yields chunks).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function* streamLocalLLMChat(messages: OpenAIMessage[], tools?: any[]): AsyncGenerator<any> {
  const port = await ensureLlamaServerRunning();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const body = {
    model: "gemma-4",
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
    })),
    ...(tools && tools.length > 0 ? { tools, tool_choice: "none" } : {}),
    temperature: 0.3,
    max_tokens: LOCAL_LLM_MAX_TOKENS,
    stream: true
  };

  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Local llama-server error ${response.status}: ${await response.text().catch(() => response.statusText)}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No readable stream from local server");

  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value, { stream: true }).split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === "[DONE]") return;
      try {
        const chunk = JSON.parse(jsonStr);
        yield chunk;
      } catch { /* skip malformed lines */ }
    }
  }
}
