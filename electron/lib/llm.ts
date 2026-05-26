/**
 * LLM utility helpers shared across the Electron main process.
 */

/**
 * Normalise a user-supplied base URL.
 * Strips trailing slashes and a trailing /v1 segment so that both
 * "http://localhost:3042" and "http://localhost:3042/v1" produce the same result.
 * The callers always append /v1/chat/completions themselves.
 */
export function normaliseBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Returns true if the given base URL points to a local server. */
export function isLocalEndpoint(baseUrl: string): boolean {
  return (
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("0.0.0.0")
  );
}

export interface LLMConfig {
  provider?: "openai" | "localllm";
  baseUrl: string;
  model: string;
  apiKey: string;
}

export type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export async function callLLM(config: LLMConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  if (config.provider === "localllm") {
    const { callLocalLLMChat } = await import("./local-llm");
    const messages: OpenAIMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const res = await callLocalLLMChat(messages);
    return res.choices?.[0]?.message?.content ?? "";
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4096,
      temperature: 0.4,
    }),
  });
  if (!response.ok) throw new Error(`LLM error ${response.status}: ${await response.text().catch(() => response.statusText)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await response.json() as any;
  return (data.choices?.[0]?.message?.content as string) ?? "";
}

/**
 * Stream a chat completion. Yields text delta chunks as they arrive.
 * Handles SSE parsing and authorization headers automatically.
 */
export async function* streamCompletion(
  config: LLMConfig,
  messages: OpenAIMessage[],
  tools?: object[],
): AsyncGenerator<string> {
  if (config.provider === "localllm") {
    const { streamLocalLLMChat } = await import("./local-llm");
    for await (const chunk of streamLocalLLMChat(messages)) {
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta) yield delta;
    }
    return;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: 4096,
    temperature: 0.3,
    stream: true,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "none";
  }

  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`LLM stream error ${response.status}: ${await response.text().catch(() => response.statusText)}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No readable stream");

  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value, { stream: true }).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === "[DONE]") return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const delta: string = (JSON.parse(jsonStr) as any).choices?.[0]?.delta?.content ?? "";
        if (delta) yield delta;
      } catch { /* skip malformed lines */ }
    }
  }
}
