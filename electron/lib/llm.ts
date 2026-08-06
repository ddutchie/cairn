/**
 * LLM utility helpers shared across the Electron main process.
 */

import { encode } from "gpt-tokenizer";
import { pdfTokenEstimate } from "../../shared/models/pdf-attach";

/**
 * Normalise a user-supplied base URL by stripping trailing slashes.
 *
 * We intentionally do NOT strip a trailing "/v1" here. Some gateways expose an
 * OpenAI-compatible surface *below* the version segment (e.g.
 * "https://api-gateway.merge.dev/v1/openai"), so blindly removing "/v1" would
 * corrupt the path. Version-segment handling is deferred to buildApiUrl, which
 * only appends "/v1" when the base doesn't already contain one.
 */
export function normaliseBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

/**
 * Build a full OpenAI-compatible endpoint URL from a (normalised) base URL and
 * an API path such as "chat/completions", "models", or "key".
 *
 * The "/v1" version segment is added automatically, but only when the base URL
 * does not already contain a "/v1" path segment. This supports both:
 *   - "https://api.openai.com"                → ".../v1/chat/completions"
 *   - "https://api.openai.com/v1"             → ".../v1/chat/completions"
 *   - "https://api-gateway.merge.dev/v1/openai" → ".../v1/openai/chat/completions"
 *
 * Any query string or fragment on the base URL is preserved and re-appended
 * AFTER the path (e.g. "https://host/v1?token=x" → ".../v1/chat/completions?token=x").
 */
export function buildApiUrl(baseUrl: string, path: string): string {
  // Peel off any ?query / #fragment so it doesn't land in the middle of the path.
  const suffixStart = baseUrl.search(/[?#]/);
  const suffix = suffixStart === -1 ? "" : baseUrl.slice(suffixStart);
  const base = (suffixStart === -1 ? baseUrl : baseUrl.slice(0, suffixStart)).replace(/\/+$/, "");
  const cleanPath = path.replace(/^\/+/, "");
  let pathname: string;
  try {
    pathname = new URL(/^https?:\/\//i.test(base) ? base : `http://${base}`).pathname;
  } catch {
    pathname = base;
  }
  const hasVersion = /(^|\/)v\d+(\/|$)/.test(pathname);
  const endpoint = hasVersion ? `${base}/${cleanPath}` : `${base}/v1/${cleanPath}`;
  return `${endpoint}${suffix}`;
}

/** Returns true if the given base URL points to a local server. */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    let urlString = baseUrl.trim();
    if (!/^https?:\/\//i.test(urlString)) {
      urlString = "http://" + urlString;
    }
    const parsed = new URL(urlString);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host === "::1"
    );
  } catch {
    return false;
  }
}

export interface LLMConfig {
  provider?: "openai" | "localllm";
  baseUrl: string;
  model: string;
  apiKey: string;
}

export type OpenAIMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
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

/**
 * An assistant turn is unusable to the provider when it carries neither
 * `content` nor `tool_calls` — OpenAI-compatible APIs reject the whole request
 * with `Invalid assistant message: content or tool_calls must be set` (400).
 *
 * This happens with "thinking"/reasoning models: if the model times out or
 * stops streaming mid-reasoning, the turn's only payload was reasoning (which
 * is deliberately stripped before re-send, since replaying reasoning also
 * 400s). Replaying that stripped, empty turn on the next message poisons the
 * request. Drop such turns before sending.
 */
export function isSendableMessage(m: {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
}): boolean {
  if (m.role !== "assistant") return true;
  return Boolean(m.content?.trim()) || Boolean(m.tool_calls?.length);
}

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
  const response = await fetch(buildApiUrl(config.baseUrl, "chat/completions"), {
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

  const response = await fetch(buildApiUrl(config.baseUrl, "chat/completions"), {
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

/**
 * Flat per-image token estimate. Vision models bill images by tiles, not by the
 * length of the base64 payload — so counting the data URL characters (which we
 * used to do implicitly when the multimodal `content` array got stringified)
 * over-counts by orders of magnitude. ~1.1k tokens is a reasonable single-image
 * approximation across OpenAI/Anthropic/Gemini for a typical attachment.
 */
const IMAGE_TOKEN_ESTIMATE = 1100;

/**
 * Count tokens for a message's `content`, which may be a plain string or an
 * OpenAI multimodal parts array (`[{type:"text"...}, {type:"image_url"...}]`).
 * Text parts are tokenised; image parts contribute a flat estimate instead of
 * the base64 data URL length; document (PDF) parts use the shared size-based
 * estimate so the context ring doesn't over-count raw base64.
 */
function tokContent(content: unknown): number {
  if (typeof content === "string") return tok(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      const p = part as Record<string, unknown>;
      if (p?.type === "image_url" || p?.image_url) {
        total += IMAGE_TOKEN_ESTIMATE;
      } else if (p?.type === "document") {
        const source = (p.source ?? {}) as { data?: string };
        total += pdfTokenEstimate(source.data ?? "");
      } else if (typeof p?.text === "string") {
        total += tok(p.text);
      }
    }
    return total;
  }
  return 0;
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
  let mcpTokens = 0;
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
      const name = (func.name ?? t.name ?? "") as string;
      const toolStr = JSON.stringify({
        type: "function",
        function: {
          name,
          description: (func.description ?? t.description ?? "") as string,
          parameters: (func.parameters ?? t.parameters ?? {}) as object,
        },
      });
      // External tools (MCP servers / custom services) are accounted separately
      // under `mcp` so the breakdown UI can distinguish built-in from external.
      if (name.startsWith("mcp__") || name.startsWith("svc__")) {
        mcpTokens += tok(toolStr);
      } else {
        toolsTokens += tok(toolStr);
      }
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
    if (msg.role === "system" || msg.role === "developer") {
      // The system prompt travels as `role: "system"` (or `"developer"` for
      // reasoning models). When it is also passed separately via `systemPrompt`,
      // the in-array copy is skipped so it is never double-counted — but if no
      // separate prompt was given, the in-array message IS the source of truth
      // and its tokens belong to the system bucket, not conversation.
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

    const textTokens = tokContent(msg.content);
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

