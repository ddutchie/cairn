/** Chat threads and messages. */

import type { ID } from "./domain";

// ── Chat ──────────────────────────────────────
export type ChatThreadScope = "workspace" | "project";

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

export interface ChatThread {
  id: ID;
  scope: ChatThreadScope;
  workspaceId: ID;
  projectId?: ID;
  title?: string;
  /** Let the chat agent spawn subagents (stored on the thread row). */
  useSubagents?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsage?: {
    promptTokens: number;
    completionTokens: number;
    /** Subset of completion_tokens produced by the model's reasoning/thinking step. 0 if the model didn't split. */
    reasoningTokens?: number;
    /** Prompt tokens served from the provider's cache this turn (0 when the provider doesn't cache/report). */
    cacheReadTokens?: number;
    /** Prompt tokens written to the provider's cache this turn (0 when not split out). */
    cacheCreationTokens?: number;
    breakdown?: TokenBreakdown;
    /** Provider-reported USD cost of the turn (e.g. Neuralwatt usage.cost), when present. */
    costUsd?: number;
    /** Model capacity / context limit. */
    contextLimit?: number;
    contextWindow?: number;
  };
}

export type ChatRole = "user" | "assistant" | "system";

/**
 * Streaming token-usage shape mirrored from the OpenAI chat/completions spec.
 * `reasoningTokens` is the subset of `completionTokens` spent on chain-of-thought
 * reasoning; absent when the model doesn't split reasoning from content.
 */
export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  reasoningTokens?: number;
  /** Prompt tokens served from the provider's cache (billed at the cache_read rate). */
  cacheReadTokens?: number;
  /** Prompt tokens written to the provider's cache (billed at the cache_write rate). */
  cacheCreationTokens?: number;
  breakdown?: TokenBreakdown;
  /** Provider-reported USD cost of the call (e.g. Neuralwatt usage.cost), when present. */
  costUsd?: number;
}

export interface LinkedContextReference {
  type: "note" | "task" | "project" | "search_result";
  id: ID;
  title: string;
  snippet?: string;
}

export interface ChatToolCallRecord {
  tool: string;
  label: string;
  /** Tool-authored title from dsh `presentCall` (main-attached on tool/call); renderer prefers it. */
  viewTitle?: string;
  /** Tool-authored result view from dsh `presentResult` (main-attached on tool/result). */
  resultView?: { card?: string; title?: string; output?: string; exitCode?: number; signal?: string; content?: unknown };
  cairnRef?: { type: "note" | "task"; id: ID; title: string };
  /**
   * A linkable external artefact extracted from an MCP-server / custom-service
   * tool result (a Confluence page, web-search hit, GitHub PR, …). Rendered as a
   * browser-opening chip. Absent for native tools (which use `cairnRef`) and for
   * results with no usable http(s) URL.
   */
  externalRef?: { url: string; title?: string; snippet?: string };
  callId?: string;
  args?: string;      // JSON arguments string
  output?: string;    // JSON output string
  /**
   * Tool execution status. `ok: false` means the tool returned an error result
   * or threw — the chip renders a failure state and `error` carries the reason.
   * Absent (undefined) on older persisted records → treated as success.
   */
  ok?: boolean;
  error?: string;
  /**
   * Presentation metadata recomputed from the registered tool definition's
   * output.presentationMeta(args, value) (NOT persisted in the session log —
   * dsh recomputes it at render time like its web shell). Rich toolviews keyed
   * to this tool read it off the block; absent → generic text rendering.
   */
  meta?: Record<string, unknown>;
}

/**
 * A single subagent run inside a subagent-mode chat turn (dispatch → research/
 * write). Captures the subagent's role, the dispatcher's instruction, its own
 * streamed content + tool calls, and the brief it returned. Rendered as an
 * expandable inline block so the user can step into what each subagent did.
 */
export interface ChatSubagent {
  /** Unique child id: `${threadId}:sub:<n>` */
  childId: string;
  /** "research" | "write" */
  role: string;
  /** The dispatcher's instruction to this subagent */
  instruction: string;
  /** Content streamed by the subagent (its findings brief / confirmation) */
  content: string;
  /** Reasoning/thinking streamed by the subagent */
  reasoning?: string;
  /** Tool calls the subagent made */
  toolCalls?: ChatToolCallRecord[];
  /** Whether the subagent is still running */
  running: boolean;
  /** Final result returned to the dispatcher (usually == content) */
  result?: string;
  /** This subagent's OWN latest context-window usage — drives its dedicated ring. */
  lastUsage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: TokenBreakdown; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
}

export type SuggestedAction =
  | { type: "add_wikilink";   sourceNoteId: string; sourceTitle: string; targetTitle: string; reason: string }
  | { type: "link_note_note"; sourceNoteId: string; sourceTitle: string; targetNoteId: string; targetTitle: string; reason: string }
  | { type: "link_note_card"; noteId: string; noteTitle: string; cardId: string; cardTitle: string; reason: string }
  | { type: "add_tag";        nodeId: string; nodeTitle: string; nodeType: "note" | "card"; tagName: string; reason: string };

export interface ChatHistoryEntry {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
  reasoning?: string;
  reasoningField?: string;
  reasoningModel?: string;
  reasoningItems?: Array<Record<string, unknown>>;
}

export interface ChatMessage {
  id: ID;
  threadId: ID;
  role: ChatRole;
  content: string;
  /**
   * Reasoning / thinking text emitted by the model during generation (Claude's
   * thinking_delta, OpenAI-style delta.reasoning). Persisted so past messages
   * retain an expandable Thinking panel in the bubble; intentionally stripped
   * from compaction summaries. Empty for models that don't expose reasoning.
   */
  reasoning?: string;
  /**
   * Condensed reasoning summary (Responses `reasoning.summary`), when the
   * provider emits one. Shown in the collapsed Thinking panel in place of the
   * raw reasoning preview; absent for providers that don't support it.
   */
  reasoningSummary?: string;
  /**
   * Raw Responses reasoning items produced with this message, persisted so a
   * resumed thread can round-trip the chain-of-thought to the same model.
   */
  reasoningItems?: Array<Record<string, unknown>>;
  /** The provider field the reasoning text arrived in (round-trip target). */
  reasoningField?: string;
  /** Model key (`baseUrl::model`) that produced this message's reasoning. */
  reasoningModel?: string;
  /** Entities cited in or used to produce this message */
  contextRefs?: LinkedContextReference[];
  /** Tool calls made during this assistant turn — persisted so they remain visible after streaming ends */
  toolCalls?: ChatToolCallRecord[];
  /** Suggested connection actions for graph assistant */
  actions?: SuggestedAction[];
  /** Attachments on this message — inline base64 data URLs, ephemeral (not persisted to disk) */
  images?: Array<{ url: string; name: string; kind?: "image" | "pdf" }>;
  /** Subagent runs during this turn (subagent mode) — expandable inline traces. */
  subagents?: ChatSubagent[];
  /** Per-turn throughput/latency stats (TTFT, tok/s, output tokens) folded from
   *  the session log; shown in a compact stats line under the assistant bubble.
   *  Absent when timing/usage is unavailable (UI shows no stats line). */
  stats?: MessageStats;
  createdAt: string;
}

/** Per-message throughput/latency reading (mirrors the session-stats TurnStats). */
export interface MessageStats {
  /** First-token latency in ms. */
  ttftMs?: number;
  /** Decode throughput (provider output tokens / decode seconds). */
  tokensPerSecond?: number;
  /** Provider-reported output tokens for the turn. */
  outputTokens?: number;
}

// ── IPC inputs ────────────────────────────────
export interface ChatThreadUpsertInput {
  id: ID;
  scope: ChatThreadScope;
  workspaceId: ID;
  projectId?: ID;
  title?: string;
  useSubagents?: boolean;
}
