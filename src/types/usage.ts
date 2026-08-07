/**
 * Renderer-side types for the LLM/agent Usage view.
 * Mirrors the shapes returned by `electron/db/usage-queries.ts` over the
 * `usage:overview` / `usage:recent` IPC channels.
 */

export type UsageSource =
  | "chat"
  | "pi-agent"
  | "chat-subagent"
  | "pi-subagent"
  | "automation"
  | "prd"
  | "commit-message"
  | "pr-description"
  | "explain"
  | "flow-ai-summary"
  | "summary"
  | "tool-builder";

export const USAGE_SOURCE_LABELS: Record<UsageSource, string> = {
  chat: "Chat",
  "pi-agent": "Agent",
  "chat-subagent": "Chat subagent",
  "pi-subagent": "Agent subagent",
  automation: "Automation",
  prd: "PRD",
  "commit-message": "Commit message",
  "pr-description": "PR description",
  explain: "Explain code",
  "flow-ai-summary": "Idea Flow summary",
  summary: "Compaction",
  "tool-builder": "Tool builder",
};

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** Prompt tokens served from the provider's cache across the window. */
  cacheReadTokens: number;
  costUsd: number;
  requests: number;
}

export interface UsageDayBucket extends UsageTotals {
  /** Local YYYY-MM-DD. */
  day: string;
}

export interface UsageOverview {
  totals: UsageTotals;
  previous: UsageTotals | null;
  series: UsageDayBucket[];
  bySource: Array<{ source: UsageSource } & UsageTotals>;
  byModel: Array<{ model: string } & UsageTotals>;
}

export interface UsageRecentRow {
  id: string;
  workspaceId: string | null;
  projectId: string | null;
  source: UsageSource;
  sessionId: string | null;
  provider: string | null;
  model: string;
  baseUrl: string | null;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** Prompt tokens served from the provider's cache. */
  cacheReadTokens: number;
  /** Prompt tokens written to the provider's cache. */
  cacheCreationTokens: number;
  costUsd: number | null;
  costEstimated: boolean;
  finishReason: string | null;
  createdAt: number;
}
