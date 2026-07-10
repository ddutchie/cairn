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
import { countTextTokens } from "../tokens";
import { newRunId, type AiTool, type ChatProvider, type ChatUsage, type StreamEvent, type UIMessage } from "./types";

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

// Rork's underlying model is not guaranteed, so we assume a conservative context
// window for the ring (many modern models are >=200K; this errs toward showing
// "full" sooner rather than underestimating and overflowing silently).
const RORK_CONTEXT_LIMIT = 200_000;

/** Plain text of all message parts, for a client-side token estimate. */
function conversationText(messages: UIMessage[]): string {
  const chunks: string[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text" && typeof (p as { text?: string }).text === "string") {
        chunks.push((p as { text: string }).text);
      }
    }
  }
  return chunks.join("\n");
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

  // Preserve any path in the configured base URL (e.g. .../api). A leading-slash
  // path in `new URL` would reset to the host root and break `{base}/agent/chat`
  // — mirror openai.ts's relative-segment + trailing-slash approach.
  const url = new URL("agent/chat", base.replace(/\/?$/, "/")).toString();
  const res = await expoFetch(url, {
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
  // Prefer a server-reported prompt-token count if the stream carries one;
  // otherwise fall back to a client estimate (marked estimated) at finish.
  let serverPromptTokens: number | undefined;
  let sawFinish = false;

  const usageEvent = (): ChatUsage => {
    if (serverPromptTokens != null) {
      return { promptTokens: serverPromptTokens, contextLimit: RORK_CONTEXT_LIMIT };
    }
    // Estimate from the outgoing conversation (o200k_base — approximate for
    // whatever model Rork serves, which is all a fill gauge needs).
    return {
      promptTokens: countTextTokens(conversationText(messages)),
      contextLimit: RORK_CONTEXT_LIMIT,
      estimated: true,
    };
  };

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
        if (payload === "[DONE]") {
          // Ensure a usage-carrying finish even if the server never sent one.
          if (!sawFinish) yield { type: "finish", finishReason: "stop", usage: usageEvent() };
          return;
        }
        let ev: StreamEvent;
        try {
          ev = JSON.parse(payload) as StreamEvent;
        } catch {
          continue; // ignore keep-alives / partial frames
        }
        // Capture any usage the server includes (AI SDK totalUsage/usage shapes).
        const raw = ev as { usage?: { promptTokens?: number; inputTokens?: number }; totalUsage?: { promptTokens?: number; inputTokens?: number } };
        const u = raw.totalUsage ?? raw.usage;
        const pt = u?.promptTokens ?? u?.inputTokens;
        if (typeof pt === "number") serverPromptTokens = pt;

        if (ev.type === "finish") {
          sawFinish = true;
          yield { type: "finish", finishReason: (ev as { finishReason?: string }).finishReason ?? "stop", usage: usageEvent() };
        } else if (ev.type === "reasoning-delta") {
          // Some models (e.g. Gemini on tool-calling turns) emit a reasoning part
          // whose content is redacted — the delta is the literal "[REDACTED]" (or
          // empty). Don't surface that as a "thinking" block; only forward
          // reasoning that carries real text.
          const delta = (ev as { delta?: string }).delta;
          if (typeof delta === "string" && delta.trim() && delta.trim().toUpperCase() !== "[REDACTED]") {
            yield ev;
          }
        } else {
          yield ev;
        }
      }
    }
  }

  // Stream ended without [DONE] or a finish part.
  if (!sawFinish) yield { type: "finish", finishReason: "stop", usage: usageEvent() };
}

export const rorkProvider: ChatProvider = {
  name: "Rork",
  stream: streamRork,
};
