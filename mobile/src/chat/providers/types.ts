/**
 * AI provider abstraction — the seam between the agent loop and whichever
 * backend actually talks to a model.
 *
 * Two providers implement this:
 *   - rork.ts   — the Rork AI toolkit (/agent/chat, native tool-calling).
 *                 Zero-config for first-party builds; endpoint injected at build
 *                 time via a git-ignored env var (never hardcoded in source).
 *   - openai.ts — any OpenAI-compatible /v1/chat/completions endpoint, using a
 *                 base URL + API key the user supplies in-app. This is the path
 *                 for third-party builders (BYO key), so the app never depends on
 *                 our unauthenticated Rork endpoint.
 *
 * Both normalise their wire format down to the same `StreamEvent` stream so the
 * agent loop (agent.ts) is provider-agnostic.
 */

import type { TokenBreakdown } from "../token-breakdown";

export type RorkRole = "system" | "user" | "assistant";

export interface TextPart {
  type: "text";
  text: string;
}

/**
 * A binary attachment (image/pdf). For Rork /agent/chat this is a native
 * UIMessage "file" part whose `url` is a data URI; the OpenAI provider maps it
 * to an `image_url` content part.
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
  /** Reasoning text round-tripped to a completions provider (same model). */
  reasoning?: string;
  /** The provider field the reasoning arrived in (e.g. "reasoning_content"). */
  reasoningField?: string;
  /** Raw Responses reasoning items round-tripped to a Responses provider. */
  reasoningItems?: Array<Record<string, unknown>>;
}

/**
 * True when an assistant turn has something the provider will accept — real
 * text or at least one tool call. A "thinking" model that stops mid-reasoning
 * leaves a turn with neither (reasoning isn't a text part); replaying it trips
 * the OpenAI-compatible "content or tool_calls must be set" 400 on the next
 * message. Non-assistant roles are always sendable (the provider only rejects
 * assistant turns for the missing-payload reason).
 */
export function assistantTurnIsSendable(role: RorkRole, parts: UIPart[]): boolean {
  if (role !== "assistant") return true;
  const hasText = parts.some((p) => p.type === "text" && (p as TextPart).text.trim().length > 0);
  const hasTool = parts.some((p) => p.type !== "text" && p.type !== "file");
  return hasText || hasTool;
}

/** A tool the model may call. `jsonSchema` is a JSON Schema object for the args. */
export interface AiTool {
  description: string;
  jsonSchema: Record<string, unknown>;
}

/**
 * Normalised stream events every provider emits. This is the Rork
 * UI-message-stream subset; the OpenAI provider translates its
 * chat.completion.chunk deltas into these same shapes.
 */
export type StreamEvent =
  | { type: "text-delta"; id?: string; delta: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown }
  | {
      // A tool the provider already executed itself (e.g. Apple's native tools).
      // The agent loop must NOT re-run it — just surface it for display.
      type: "tool-executed";
      toolCallId: string;
      toolName: string;
      input: unknown;
      output: unknown;
    }
  | { type: "finish"; finishReason?: string; usage?: ChatUsage }
  | { type: "reasoning-delta"; delta?: string; field?: string }
  | { type: "reasoning-summary-delta"; delta?: string }
  | { type: "reasoning-items"; items: Array<Record<string, unknown>> }
  | { type: string; [k: string]: unknown };

/** Context-window usage for the chat ring (prompt tokens over the model limit). */
export interface ChatUsage {
  promptTokens: number;
  contextLimit: number;
  /** True when promptTokens is a client-side estimate (no server usage / wrong
   *  tokenizer family, e.g. Rork/Gemini counted with o200k_base). The ring shows
   *  a "~" and an "estimated" hint. */
  estimated?: boolean;
  /** Per-category prompt-token split (system prompt, tools, MCP, conversation,
   *  tool outputs, …). Computed on-device by the agent loop; drives the detailed
   *  breakdown in the context ring. Absent for a turn where it couldn't be built. */
  breakdown?: TokenBreakdown;
  /** Completion tokens the model produced this turn (answer + reasoning), if the
   *  provider reported them. */
  completionTokens?: number;
  /** Subset of completionTokens spent on reasoning/thinking (0/undefined if the
   *  provider didn't split it out). */
  reasoningTokens?: number;
  /** Provider-reported USD cost of the turn (e.g. Neuralwatt usage.cost),
   *  when present. Shown in the context ring breakdown. */
  costUsd?: number;
  /** Prompt tokens served from the provider's cache this turn (0 when the
   *  provider doesn't cache/report). */
  cacheReadTokens?: number;
  /** Prompt tokens written to the provider's cache this turn (0 when not split out). */
  cacheCreationTokens?: number;
}

/** A provider streams normalised events for a turn. */
export interface ChatProvider {
  /** Human label for diagnostics / the settings UI. */
  readonly name: string;
  /** Stream one model turn as normalised events. */
  stream(
    messages: UIMessage[],
    tools: Record<string, AiTool>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent>;
}

let _runSeq = 0;
export function newRunId(): string {
  _runSeq += 1;
  return `run-${Date.now().toString(36)}${_runSeq}${Math.random().toString(36).slice(2, 8)}`;
}

export function msgId(): string {
  return `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
