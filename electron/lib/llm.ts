/**
 * LLM utility helpers shared across the Electron main process.
 */

import { encode } from "gpt-tokenizer";

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
    /**
     * Gemini 3.x thought signature — opaque blob returned by the model on
     * tool-call parts when thinking is enabled. Must be round-tripped back
     * on subsequent requests so the model can resume its reasoning state.
     * Other providers ignore this field.
     */
    thought_signature?: string;
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
      // Must stream to prevent proxy connection drop timeouts (e.g. gateway/reverse proxy limits on blocking sync calls returning 504 Gateway Time-out)
      stream: true,
    }),
  });
  if (!response.ok) throw new Error(`LLM error ${response.status}: ${await response.text().catch(() => response.statusText)}`);

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No readable stream");

  const decoder = new TextDecoder();
  let content = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value, { stream: true }).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === "[DONE]") break;
      try {
        const obj = JSON.parse(jsonStr);
        const delta = obj.choices?.[0]?.delta?.content ?? "";
        if (delta) content += delta;
      } catch { /* skip malformed lines */ }
    }
  }
  return content;
}

/**
 * Stream a chat completion. Yields text delta chunks as they arrive.
 * Handles SSE parsing and authorization headers automatically.
 */
export async function* streamCompletion(
  config: LLMConfig,
  messages: OpenAIMessage[],
  tools?: object[],
  onUsage?: (pt: number, ct: number) => void,
): AsyncGenerator<string> {
  if (config.provider === "localllm") {
    const { streamLocalLLMChat } = await import("./local-llm");
    for await (const chunk of streamLocalLLMChat(messages)) {
      if (chunk.usage && onUsage) {
        onUsage(chunk.usage.prompt_tokens ?? 0, chunk.usage.completion_tokens ?? 0);
      }
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
  if (onUsage) {
    body.stream_options = { include_usage: true };
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
        const obj = JSON.parse(jsonStr);
        if (obj.usage && onUsage) {
          onUsage(obj.usage.prompt_tokens ?? 0, obj.usage.completion_tokens ?? 0);
        }
        const delta: string = obj.choices?.[0]?.delta?.content ?? "";
        if (delta) yield delta;
      } catch { /* skip malformed lines */ }
    }
  }
}

export interface TokenBreakdown {
  systemPrompt: number;
  skills: number;
  tools: number;
  conversation: number;
  toolOutputs: number;
  rules: number;
  mcp: number;
  subagentDefinitions: number;
}

function tok(s: string): number {
  return encode(s).length;
}

export function calculatePromptBreakdown(
  systemPrompt: string | undefined,
  messages: OpenAIMessage[],
  tools?: object[]
): TokenBreakdown {
  let systemTokens = 0;
  let skillsTokens = 0;
  let toolsTokens = 0;
  let conversationTokens = 0;
  let toolOutputsTokens = 0;
  const rulesTokens = 0;
  const mcpTokens = 0;
  const subagentTokens = 0;

  // 1. System Prompt & Skills
  if (systemPrompt) {
    let sysText = systemPrompt;
    // Extract available_skills XML if present
    const skillsMatch = sysText.match(/<available_skills>[\s\S]*?<\/available_skills>/);
    if (skillsMatch) {
      const skillsXml = skillsMatch[0];
      skillsTokens += tok(skillsXml);
      sysText = sysText.replace(skillsXml, "");
    }
    systemTokens = tok(sysText);
  }

  // 2. Tools (Definitions/Schemas)
  if (tools && tools.length > 0) {
    for (const tool of tools) {
      const t = tool as Record<string, unknown>;
      const func = (t.function ?? {}) as Record<string, unknown>;
      const toolStr = JSON.stringify({
        type: "function",
        function: {
          name: (func.name ?? t.name ?? "") as string,
          description: (func.description ?? t.description ?? "") as string,
          parameters: (func.parameters ?? t.parameters ?? {}) as object,
        },
      });
      toolsTokens += tok(toolStr);
    }
  }

  // 3. Messages / Conversation vs Tool Outputs
  const toolCallNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id && tc.function?.name) {
          toolCallNames.set(tc.id, tc.function.name);
        }
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === "system") {
      if (!systemPrompt) {
        let content = msg.content ?? "";
        const skillsMatch = content.match(/<available_skills>[\s\S]*?<\/available_skills>/);
        if (skillsMatch) {
          const skillsXml = skillsMatch[0];
          skillsTokens += tok(skillsXml);
          content = content.replace(skillsXml, "");
        }
        systemTokens += tok(content);
      }
      continue;
    }

    const textContent = msg.content ?? "";
    const textTokens = tok(textContent);
    const toolCallsTokens = msg.tool_calls ? tok(JSON.stringify(msg.tool_calls)) : 0;

    if (msg.role === "tool") {
      // If it's the "skill" tool, count under skills
      if (msg.tool_call_id && toolCallNames.get(msg.tool_call_id) === "skill") {
        skillsTokens += textTokens;
      } else {
        toolOutputsTokens += textTokens;
      }
    } else if (msg.role === "assistant") {
      conversationTokens += textTokens;
      toolOutputsTokens += toolCallsTokens;
    } else {
      // user role
      conversationTokens += textTokens;
    }
  }

  return {
    systemPrompt: systemTokens,
    skills: skillsTokens,
    tools: toolsTokens,
    conversation: conversationTokens,
    toolOutputs: toolOutputsTokens,
    rules: rulesTokens,
    mcp: mcpTokens,
    subagentDefinitions: subagentTokens,
  };
}

export function scaleBreakdown(
  breakdown: TokenBreakdown,
  targetTotal: number
): TokenBreakdown {
  const sum =
    breakdown.systemPrompt +
    breakdown.skills +
    breakdown.tools +
    breakdown.conversation +
    breakdown.toolOutputs +
    breakdown.rules +
    breakdown.mcp +
    breakdown.subagentDefinitions;

  if (sum <= 0 || targetTotal <= 0) return breakdown;

  const ratio = targetTotal / sum;
  return {
    systemPrompt: Math.round(breakdown.systemPrompt * ratio),
    skills: Math.round(breakdown.skills * ratio),
    tools: Math.round(breakdown.tools * ratio),
    conversation: Math.round(breakdown.conversation * ratio),
    toolOutputs: Math.round(breakdown.toolOutputs * ratio),
    rules: Math.round(breakdown.rules * ratio),
    mcp: Math.round(breakdown.mcp * ratio),
    subagentDefinitions: Math.round(breakdown.subagentDefinitions * ratio),
  };
}

