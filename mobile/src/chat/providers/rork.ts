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
  // Prefer a server-reported token count if the stream carries one; otherwise
  // fall back to a client estimate (marked estimated) at finish. Completion
  // tokens are likewise taken from the server when reported, else estimated
  // from the text deltas actually streamed.
  let serverPromptTokens: number | undefined;
  let serverCompletionTokens: number | undefined;
  let streamedText = "";
  let streamedReasoning = "";
  let sawFinish = false;

  const usageEvent = (): ChatUsage => {
    // The server's /agent/chat sometimes reports a prompt-token count far below
    // the real request (it appears to omit system / tools / history — observed
    // ~270 reported for a ~6k request). The context ring and its breakdown are
    // rescaled to this number, so an under-count makes every segment tiny.
    // Trust the server value only when it's plausibly close to the client
    // estimate (conversation text + tool definitions); otherwise use the
    // estimate so the ring reflects the actual request.
    const estimatedPrompt =
      countTextTokens(conversationText(messages)) + countTextTokens(JSON.stringify(tools ?? {}));
    const promptTokens =
      serverPromptTokens != null && serverPromptTokens >= estimatedPrompt * 0.8
        ? serverPromptTokens
        : estimatedPrompt;
    return {
      promptTokens,
      contextLimit: RORK_CONTEXT_LIMIT,
      // Server-reported output when available; otherwise count what we
      // streamed so the Usage view shows input AND output, not input alone.
      completionTokens: serverCompletionTokens ?? (streamedText ? countTextTokens(streamedText) : 0),
      // Reasoning is streamed as reasoning-delta parts — count it so the
      // Usage view's "thinking" column reflects Rork's chain-of-thought too.
      reasoningTokens: streamedReasoning ? countTextTokens(streamedReasoning) : 0,
      // Marked estimated when we fell back to the client-side prompt count.
      estimated: promptTokens !== serverPromptTokens,
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
        const raw = ev as { usage?: { promptTokens?: number; inputTokens?: number; completionTokens?: number; outputTokens?: number }; totalUsage?: { promptTokens?: number; inputTokens?: number; completionTokens?: number; outputTokens?: number } };
        const u = raw.totalUsage ?? raw.usage;
        const pt = u?.promptTokens ?? u?.inputTokens;
        const ct = u?.completionTokens ?? u?.outputTokens;
        if (typeof pt === "number") serverPromptTokens = pt;
        if (typeof ct === "number") serverCompletionTokens = ct;
        // Track streamed text so output tokens can be estimated when the server
        // doesn't report them (keeps input vs output counting honest on Rork).
        if (ev.type === "text-delta") {
          const d = (ev as { delta?: string }).delta;
          if (typeof d === "string") streamedText += d;
        }
        // Reasoning (chain-of-thought) is also streamed — count it as reasoning
        // tokens so the Usage view's "thinking" column is populated.
        if (ev.type === "reasoning-delta") {
          const d = (ev as { delta?: string }).delta;
          if (typeof d === "string" && d.trim() && d.trim().toUpperCase() !== "[REDACTED]") {
            streamedReasoning += d;
          }
        }

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
