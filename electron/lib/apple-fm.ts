/**
 * Cairn — Local Llama & Gemma 4 completions router
 *
 * Repurposes the original Apple Foundation Models integration to route requests
 * offline and on-demand to the local llama-server process.
 */

import { OpenAIMessage } from "./llm";
import { isLlamaServerInstalled, ensureLlamaServerRunning, listModels } from "./llama-server";

/**
 * Check if the local Llama server and Gemma 4 integration are available and configured.
 */
export async function isAppleFMAvailable(): Promise<{ available: boolean; reason?: string }> {
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
      reason: "No local Gemma 4 models downloaded. Please download a quantization variant in settings first."
    };
  }

  return { available: true };
}

/**
 * Call local Gemma 4 chat completions (non-streaming, supports tools).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callAppleFMChat(messages: OpenAIMessage[], tools?: any[]): Promise<any> {
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
 * Stream local Gemma 4 chat completions (yields chunks).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function* streamAppleFMChat(messages: OpenAIMessage[], tools?: any[]): AsyncGenerator<any> {
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
