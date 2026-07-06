/**
 * Rork agent client (mobile) — uses the streaming /agent/chat endpoint with
 * NATIVE tool-calling, matching the working reference in ../rorkopenai.
 *
 * Contract (see rorkopenai/EndpointMapping.md):
 *   POST {base}/agent/chat  ->  SSE stream (Vercel AI UI-message-stream v1)
 *   body: {
 *     id: "run-<hash>",
 *     messages: [{ id, role, parts: [{type:"text",text}, tool parts...] }],
 *     tools: { name: { description, jsonSchema } },
 *     stream: true,
 *     trigger: "submit-message",
 *   }
 *
 * Messages use the AI SDK v5 UIMessage shape (parts[] + per-message id) — a
 * plain {role,content} 500s. Tool results are merged back into the preceding
 * assistant message as a part with state:"output-available".
 */

import { fetch as expoFetch } from "expo/fetch";

export type RorkRole = "system" | "user" | "assistant";

export interface TextPart {
  type: "text";
  text: string;
}
/**
 * A binary attachment (image/pdf). For /agent/chat this is a native UIMessage
 * "file" part whose `url` is a data URI (see rorkopenai src/chat.ts image
 * handling). Rork forwards it to the model as multimodal input.
 */
export interface FilePart {
  type: "file";
  mediaType: string; // e.g. "image/jpeg"
  url: string; // data:image/jpeg;base64,… or a remote URL
  name?: string;
}
export interface ToolPart {
  type: string; // "tool-<name>"
  toolCallId: string;
  toolName?: string;
  state: "input-available" | "output-available";
  input?: unknown;
  output?: { type: "text"; value: string } | unknown;
}
export type UIPart = TextPart | FilePart | ToolPart;

export interface UIMessage {
  id: string;
  role: RorkRole;
  parts: UIPart[];
}

export interface RorkTool {
  description: string;
  jsonSchema: Record<string, unknown>;
}

/** SSE events we care about (subset of the Vercel UI-message stream). */
export type StreamEvent =
  | { type: "text-delta"; id?: string; delta: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown }
  | { type: "finish"; finishReason?: string }
  | { type: "reasoning-delta"; delta?: string }
  | { type: string; [k: string]: unknown };

const DEFAULT_BASE = "https://toolkit.rork.com";

function baseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_TOOLKIT_URL;
  return (fromEnv && fromEnv.trim()) || DEFAULT_BASE;
}

let _runSeq = 0;
export function newRunId(): string {
  _runSeq += 1;
  return `run-${Date.now().toString(36)}${_runSeq}${Math.random().toString(36).slice(2, 8)}`;
}

export function msgId(): string {
  return `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * POST to /agent/chat and yield parsed SSE events. RN's fetch returns a body
 * with a ReadableStream reader; we decode + split on the SSE `data:` frames.
 */
export async function* streamAgentChat(
  messages: UIMessage[],
  tools: Record<string, RorkTool>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const res = await expoFetch(new URL("/agent/chat", baseUrl()).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      id: newRunId(),
      messages,
      tools,
      stream: true,
      trigger: "submit-message",
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Rork agent error (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by double newlines; each line starts with "data:".
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload) as StreamEvent;
        } catch {
          // ignore keep-alives / partial frames
        }
      }
    }
  }
}
