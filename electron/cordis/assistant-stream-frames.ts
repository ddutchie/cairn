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
  /** Every frame (`start` | `chunk` | `end`), for stream timing. */
  onFrame?: (type: string, info: AssistantStreamInfo) => void;
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
      const frameType = payload?.frame?.type;
      if (typeof frameType === "string") handlers.onFrame?.(frameType, info);
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

export interface TurnStreamStats {
  ttftMs?: number;
  tokensPerSecond?: number;
  outputTokens?: number;
}

/**
 * Per-turn throughput/latency measured from the live stream frames. dsh ≥0.1.5
 * stopped logging `assistant/chunk` events, which the log fold needed to find
 * the first token, so the stats come from the frames instead: TTFT of the
 * turn's first stream, decode time from each stream's first token to its end,
 * and the provider-reported output tokens summed across streams (multi-step
 * tool turns have several). Feed it the `onFrame` / `onText` / `onReasoning` /
 * `onUsage` callbacks of {@link onAssistantStream}.
 */
export function createTurnStreamStats(now: () => number = Date.now) {
  let streamStart: number | null = null;
  let firstToken: number | null = null;
  let streamTokens = 0;
  let ttftMs: number | undefined;
  let decodeMs = 0;
  let outputTokens = 0;
  let sampled = false;

  const settle = (end: number) => {
    if (firstToken !== null && streamTokens > 0) {
      decodeMs += Math.max(0, end - firstToken);
      outputTokens += streamTokens;
      sampled = true;
    } else if (streamTokens > 0) {
      outputTokens += streamTokens;
    }
    streamStart = null;
    firstToken = null;
    streamTokens = 0;
  };

  return {
    onFrame(type: string): void {
      if (type === "start") {
        if (streamStart !== null) settle(now());
        streamStart = now();
      } else if (type === "end") {
        settle(now());
      }
    },
    /** A text or reasoning delta arrived. */
    onDelta(): void {
      if (firstToken !== null) return;
      firstToken = now();
      if (ttftMs === undefined && streamStart !== null) ttftMs = Math.max(0, firstToken - streamStart);
    },
    onUsage(usage: AssistantStreamDeltaUsage): void {
      // Providers may report usage more than once per stream; keep the latest.
      if (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0) {
        streamTokens = usage.outputTokens;
      }
    },
    /** The turn's stats so far, or undefined when nothing is derivable. Settles an open stream. */
    snapshot(): TurnStreamStats | undefined {
      if (streamStart !== null || firstToken !== null || streamTokens > 0) settle(now());
      const out: TurnStreamStats = {};
      if (ttftMs !== undefined) out.ttftMs = ttftMs;
      if (sampled && decodeMs > 0) out.tokensPerSecond = outputTokens / (decodeMs / 1000);
      if (outputTokens > 0) out.outputTokens = outputTokens;
      return Object.keys(out).length ? out : undefined;
    },
  };
}

/** Renderer-fold-compatible stats chunk (the renderer attaches it to the settled bubble). */
export function statsChunkEvent(stats: TurnStreamStats): { type: "assistant/chunk"; seq: -1; data: { chunk: { type: "stats"; stats: TurnStreamStats } } } {
  return { type: "assistant/chunk", seq: -1, data: { chunk: { type: "stats", stats } } };
}
