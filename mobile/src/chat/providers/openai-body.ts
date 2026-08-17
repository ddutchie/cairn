/**
 * Pure OpenAI-compatible chat/completions body building — framework-free so the
 * temperature semantics are unit-testable in plain Node (the mobile test
 * project rejects modules that import expo/react-native at load time).
 *
 * `openai.ts` imports these and wraps the body in the streaming fetch; nothing
 * here touches the network or Expo APIs.
 */

import { pdfDocumentPart } from "@cairn/shared/models/pdf-attach";
import {
  assistantTurnIsSendable,
  type AiTool,
  type FilePart,
  type StreamOptions,
  type TextPart,
  type ToolPart,
  type UIMessage,
} from "./types";
import type { OpenAIConfig } from "../ai-config";

interface OpenAIContentPart {
  type: "text" | "image_url" | "document";
  text?: string;
  image_url?: { url: string };
  document?: { source: { type: "base64"; media_type: string; data: string } };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** Reasoning text to round-trip (completions) — sent under `reasoningField`. */
  reasoning?: string;
  reasoningField?: string;
  /** Raw Responses reasoning items to round-trip (Responses). */
  reasoningItems?: Record<string, unknown>[];
}

/** The reasoning round-trip metadata to attach to an assistant message, if any. */
function reasoningMeta(m: UIMessage): Partial<OpenAIMessage> {
  const out: Partial<OpenAIMessage> = {};
  if (m.reasoning && m.reasoningField) {
    out.reasoning = m.reasoning;
    out.reasoningField = m.reasoningField;
  }
  if (m.reasoningItems && m.reasoningItems.length > 0) out.reasoningItems = m.reasoningItems;
  return out;
}

/** Map one internal UIMessage to one-or-more OpenAI messages. */
export function mapMessage(m: UIMessage): OpenAIMessage[] {
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
      ...reasoningMeta(m),
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

  // Plain text/attachment message. Images become image_url content parts;
  // PDFs become Anthropic-style `document` base64 parts (user only).
  if (fileParts.length > 0 && m.role === "user") {
    const content: OpenAIContentPart[] = [];
    for (const p of textParts) if (p.text) content.push({ type: "text", text: p.text });
    for (const f of fileParts) {
      if (f.mediaType === "application/pdf") {
        content.push(pdfDocumentPart(f.url) as OpenAIContentPart);
      } else {
        content.push({ type: "image_url", image_url: { url: f.url } });
      }
    }
    out.push({ role: "user", content });
    return out;
  }

  const text = textParts.map((p) => p.text).join("");
  // Skip an assistant turn with no sendable payload — a thinking model that
  // stopped mid-reasoning leaves one behind, and replaying it trips the
  // provider's "content or tool_calls must be set" 400 on the next message.
  if (!assistantTurnIsSendable(m.role, m.parts)) return out;
  out.push({ role: m.role, content: text, ...(m.role === "assistant" ? reasoningMeta(m) : {}) });
  return out;
}

/** Map the agent's tool map to OpenAI `tools` array entries. */
export function mapTools(tools: Record<string, AiTool>) {
  return Object.entries(tools).map(([name, t]) => ({
    type: "function" as const,
    function: { name, description: t.description, parameters: t.jsonSchema },
  }));
}

/**
 * Build the chat/completions request body. Pure (no network) so the temperature
 * semantics are unit-testable: the field is only added when the user set a
 * value — Auto (undefined) omits it so the model's own default applies.
 */
export function buildChatCompletionsBody(
  config: OpenAIConfig,
  messages: UIMessage[],
  tools: Record<string, AiTool>,
  options?: StreamOptions,
): Record<string, unknown> {
  // Materialise the reasoning round-trip metadata onto the wire: reasoning text
  // goes under its native field, and the Responses-only `reasoningItems` (which
  // a chat-completions endpoint would reject) is stripped.
  const wireMessages = messages.flatMap(mapMessage).map((m) => {
    const { reasoning, reasoningField, reasoningItems: _ri, ...rest } = m;
    const out = rest as Record<string, unknown>;
    if (reasoning && reasoningField) out[reasoningField] = reasoning;
    return out;
  });
  const body: Record<string, unknown> = {
    model: config.model,
    messages: wireMessages,
    stream: true,
    // Deliberately no max_tokens: omitting it lets the model finish naturally
    // (full reasoning + answer). A cap only ever truncates the tail case and
    // can leave "thinking" models with empty content — see mapMessage.
    // Ask for a final usage chunk (prompt/completion tokens) to drive the
    // context ring. Standard OpenAI honours it; some OpenAI-compatible
    // gateways reject unknown fields with a 400, so we retry without it below.
    stream_options: { include_usage: true },
  };
  // Temperature: only when the user set one — omit = the model's own default
  // (desktop parity; some endpoints reject a non-null temperature on models
  // that don't support it, so an explicit "Auto" must send nothing).
  if (options?.temperature != null) body.temperature = options.temperature;
  const mapped = mapTools(tools);
  if (mapped.length > 0) body.tools = mapped;
  return body;
}
