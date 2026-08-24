import type { SessionEventEnvelope } from "./session-event";

export type RendererSessionEvent = SessionEventEnvelope["event"];

export interface FoldedToolCall {
  callId?: string;
  name: string;
  args?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface FoldedToolResult extends FoldedToolCall {
  output?: string;
  error?: string;
  ok: boolean;
}

export interface FoldedUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  breakdown?: unknown;
  costUsd?: number;
}

export interface SessionEventFoldHandlers {
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onUsage?: (usage: FoldedUsage) => void;
  onToolCall?: (call: FoldedToolCall) => void;
  onToolResult?: (result: FoldedToolResult) => void;
  onAssistantMessage?: (message: {
    text: string;
    reasoning: string;
    reasoningItems?: Array<Record<string, unknown>>;
    usage?: FoldedUsage;
    contextRefs?: unknown[];
  }) => void;
  onTurnStart?: () => void;
  onTurnEnd?: (reason?: string) => void;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" ? value as RecordValue : {};
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((part) => record(part).type === "text" && typeof record(part).text === "string")
    .map((part) => String(record(part).text))
    .join("");
}

function usage(value: unknown): FoldedUsage | undefined {
  const u = record(value);
  if (!Object.keys(u).length) return undefined;
  return {
    promptTokens: Number(u.inputTokens ?? u.promptTokens ?? 0),
    completionTokens: Number(u.outputTokens ?? u.completionTokens ?? 0),
    reasoningTokens: Number(u.reasoningTokens ?? 0),
    cacheReadTokens: typeof u.cacheReadTokens === "number" ? u.cacheReadTokens : undefined,
    cacheCreationTokens: typeof u.cacheCreationTokens === "number" ? u.cacheCreationTokens : undefined,
    breakdown: u.breakdown,
    costUsd: typeof u.costUsd === "number" ? u.costUsd : undefined,
  };
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Fold canonical DSH parent events into the renderer's existing UI actions. */
export function createSessionEventFold(handlers: SessionEventFoldHandlers) {
  let streamedText = false;
  let streamedReasoning = false;
  const toolNames = new Map<string, string>();
  const toolArgs = new Map<string, Record<string, unknown> | undefined>();

  return (event: RendererSessionEvent): void => {
    const data = record(event.data);

    if (event.type === "turn/start") {
      streamedText = false;
      streamedReasoning = false;
      handlers.onTurnStart?.();
      return;
    }

    if (event.type === "assistant/chunk") {
      const chunk = record(data.chunk);
      if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text) {
        streamedText = true;
        handlers.onText?.(chunk.text);
      } else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string" && chunk.text) {
        streamedReasoning = true;
        handlers.onReasoning?.(chunk.text);
      } else if (chunk.type === "usage") {
        const normalized = usage(chunk.usage);
        if (normalized) handlers.onUsage?.(normalized);
      }
      return;
    }

    if (event.type === "tool/call") {
      const callId = typeof data.callId === "string" ? data.callId : undefined;
      const name = String(data.name ?? "tool");
      const args = parseArgs(data.args ?? data.arguments);
      if (callId) {
        toolNames.set(callId, name);
        toolArgs.set(callId, args);
      }
      handlers.onToolCall?.({
        callId,
        name,
        args,
        meta: record(data.meta),
      });
      return;
    }

    if (event.type === "tool/result") {
      const message = record(data.message);
      const source = record(message.source);
      const block = Array.isArray(message.content) ? record(message.content[0]) : {};
      const output = typeof data.output === "string"
        ? data.output
        : contentText(block.content);
      const error = typeof data.error === "string"
        ? data.error
        : block.isError === true ? (output || "tool error") : undefined;
      const callId = typeof data.callId === "string" ? data.callId : typeof source.callId === "string" ? source.callId : undefined;
      handlers.onToolResult?.({
        callId,
        name: String(data.name ?? (callId ? toolNames.get(callId) : undefined) ?? "tool"),
        args: parseArgs(data.args ?? data.arguments) ?? (callId ? toolArgs.get(callId) : undefined),
        output: error ? undefined : output,
        error,
        ok: data.ok === false || block.isError === true || Boolean(error) ? false : true,
        meta: data.meta && typeof data.meta === "object" ? data.meta as Record<string, unknown> : undefined,
      });
      return;
    }

    if (event.type === "assistant/message") {
      const message = record(data.message);
      const parts = Array.isArray(message.content) ? message.content : data.content;
      const text = contentText(parts);
      const reasoningItems = Array.isArray(parts)
        ? parts.filter((part) => record(part).reasoning && typeof record(part).reasoning === "string") as Array<Record<string, unknown>>
        : undefined;
      const reasoning = Array.isArray(parts)
        ? parts.filter((part) => record(part).type === "reasoning").map((part) => String(record(part).text ?? "")).join("")
        : "";
      const finalUsage = usage(data.usage);
      if (!streamedText && text) handlers.onText?.(text);
      if (!streamedReasoning && reasoning) handlers.onReasoning?.(reasoning);
      if (finalUsage) handlers.onUsage?.(finalUsage);
      handlers.onAssistantMessage?.({ text, reasoning, reasoningItems: reasoningItems?.length ? reasoningItems : undefined, usage: finalUsage, contextRefs: Array.isArray(data.contextRefs) ? data.contextRefs : undefined });
      return;
    }

    if (event.type === "turn/end") {
      handlers.onTurnEnd?.(typeof record(data.reason).kind === "string" ? String(record(data.reason).kind) : undefined);
    }
  };
}
