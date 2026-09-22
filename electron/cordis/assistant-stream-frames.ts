/**
 * assistant-stream-frames — live LLM deltas on dsh ≥0.1.5.
 *
 * dsh 0.1.5 removed the `assistant/chunk` SESSION event. Live deltas now
 * arrive as `agent/assistant-stream` DISPATCH frames
 * (`ctx.on("agent/assistant-stream", ...)` — same pattern as dsh's own
 * `agent/pre-step` listeners): `{ frame: { type: "start"|"chunk"|"end",
 * chunk? }, agent }`. The inner chunk keeps the old shape
 * (`{ type: "text-delta"|"reasoning-delta"|"usage", text?, usage? }`), so
 * existing consumers only need re-wiring, not re-parsing.
 *
 * Frames are transient (never persisted) and agent-scoped — every subscriber
 * passes a `match` predicate over the emitting agent's session id + header.
 */

import type { Context } from "@deepseek-ai/cordis";

export interface AssistantStreamDeltaUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  [key: string]: unknown;
}

export interface AssistantStreamChunk {
  type?: string;
  text?: string;
  usage?: AssistantStreamDeltaUsage;
  [key: string]: unknown;
}

export interface AssistantStreamFrame {
  type?: string;
  chunk?: AssistantStreamChunk;
  [key: string]: unknown;
}

export interface AssistantStreamAgent {
  session?: { id?: unknown; header?: { origin?: unknown; parentSession?: unknown } };
  [key: string]: unknown;
}

export interface AssistantStreamHandlers {
  onText?: (text: string, info: AssistantStreamInfo) => void;
  onReasoning?: (text: string, info: AssistantStreamInfo) => void;
  onUsage?: (usage: AssistantStreamDeltaUsage, info: AssistantStreamInfo) => void;
}

export interface AssistantStreamInfo {
  agentSessionId: unknown;
  header: { origin?: unknown; parentSession?: unknown } | undefined;
}

/**
 * Subscribe to live LLM deltas from one agent session. `match` receives the
 * emitting agent's session id + header (use it to select the parent attempt
 * or the children of one session, and to exclude `origin:"subagent"`).
 * Returns a disposer for the turn resources.
 */
export function onAssistantStream(
  ctx: Context,
  match: (
    agentSessionId: unknown,
    header: { origin?: unknown; parentSession?: unknown } | undefined,
  ) => boolean,
  handlers: AssistantStreamHandlers,
): () => void {
  const off = (ctx.on as unknown as (
    event: string,
    listener: (payload: { frame?: AssistantStreamFrame; agent?: AssistantStreamAgent }) => void,
  ) => () => void)("agent/assistant-stream", (payload) => {
    try {
      const agentSessionId = payload?.agent?.session?.id;
      const header = payload?.agent?.session?.header;
      if (!match(agentSessionId, header)) return;
      const info = { agentSessionId, header };
      const c = payload?.frame?.chunk;
      if (!c) return;
      if (c.type === "text-delta" && c.text) handlers.onText?.(c.text, info);
      else if (c.type === "reasoning-delta" && c.text) handlers.onReasoning?.(c.text, info);
      else if (c.type === "usage" && c.usage) handlers.onUsage?.(c.usage, info);
    } catch { /* decoration — never break the turn over a delta */ }
  });
  return () => {
    try { off(); } catch { /* noop */ }
  };
}

/** A renderer-fold-compatible synthetic chunk event (never appended to the log). */
export function syntheticChunkEvent(
  type: "text-delta" | "reasoning-delta",
  text: string,
): { type: "assistant/chunk"; seq: -1; data: { chunk: { type: string; text: string } } } {
  return { type: "assistant/chunk", seq: -1, data: { chunk: { type, text } } };
}
