/**
 * Rork AI toolkit provider — streaming /agent/chat with native tool-calling.
 *
 * Contract (see rorkopenai/EndpointMapping.md):
 *   POST {base}/agent/chat  ->  SSE stream (Vercel AI UI-message-stream v1)
 *   body: { id, messages, tools, stream: true, trigger: "submit-message" }
 * Messages use the AI SDK v5 UIMessage shape (parts[] + per-message id).
 *
 * SECURITY / CONFIG: the base URL is read ONLY from the EXPO_PUBLIC_TOOLKIT_URL
 * build-time env var — there is intentionally NO hardcoded default in source.
 * The Rork endpoint is unauthenticated, so committing it would let anyone point
 * an app at it and run up server-side bills. First-party builds inject it from a
 * git-ignored .env.local; if it's absent, this provider is unavailable and the
 * app falls back to the OpenAI-compatible provider (see providers/index.ts).
 */

import { fetch as expoFetch } from "expo/fetch";
import { newRunId, type AiTool, type ChatProvider, type StreamEvent, type UIMessage } from "./types";

/** The build-time-injected Rork base URL, or null if not configured. */
export function rorkBaseUrl(): string | null {
  const fromEnv = process.env.EXPO_PUBLIC_TOOLKIT_URL;
  const trimmed = fromEnv && fromEnv.trim();
  return trimmed ? trimmed : null;
}

/** Whether a Rork endpoint was injected at build time. */
export function isRorkAvailable(): boolean {
  return rorkBaseUrl() != null;
}

async function* streamRork(
  messages: UIMessage[],
  tools: Record<string, AiTool>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const base = rorkBaseUrl();
  if (!base) {
    throw new Error("Rork endpoint not configured (EXPO_PUBLIC_TOOLKIT_URL unset).");
  }

  const res = await expoFetch(new URL("/agent/chat", base).toString(), {
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

export const rorkProvider: ChatProvider = {
  name: "Rork",
  stream: streamRork,
};
