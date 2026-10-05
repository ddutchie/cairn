/**
 * LLM usage log views (Usage view, cost estimates) shared by the main-process
 * usage queries, the typed IPC contract and the renderer.
 */

export type UsageSource =
  | "chat"
  | "coding-agent"
  | "chat-subagent"
  | "coding-subagent"
  | "automation"
  | "prd"
  | "commit-message"
  | "pr-description"
  | "explain"
  | "flow-ai-summary"
  | "summary"
  | "tool-builder"
  | "writing-style";

/** Human label for a source, used by the renderer (kept here so it never drifts). */
export const USAGE_SOURCE_LABELS: Record<UsageSource, string> = {
  chat: "Chat",
  "coding-agent": "Agent",
  "chat-subagent": "Chat subagent",
  "coding-subagent": "Agent subagent",
  automation: "Automation",
  prd: "PRD",
  "commit-message": "Commit message",
  "pr-description": "PR description",
  explain: "Explain code",
  "flow-ai-summary": "Idea Flow summary",
  summary: "Compaction",
  "tool-builder": "Tool builder",
  "writing-style": "Writing style",
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
  /** Local YYYY-MM-DD (bucketed via SQLite localtime). */
  day: string;
}

export interface UsageModelBucket extends UsageTotals {
  model: string;
}

export interface UsageSourceBucket extends UsageTotals {
  source: UsageSource;
}

export interface UsageOverview {
  totals: UsageTotals;
  /** Same window immediately before the requested range (for delta chips). */
  previous: UsageTotals | null;
  series: UsageDayBucket[];
  bySource: UsageSourceBucket[];
  byModel: UsageModelBucket[];
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

/** One chat thread / agent session / automation run, rolled up across its requests. */
export interface UsageThreadGroup extends UsageTotals {
  sessionId: string;
  /** Source of the group's first request. */
  source: UsageSource;
  /** Thread / session title when it still exists; null for deleted threads and automation runs. */
  title: string | null;
  /** Distinct models used (unordered). */
  models: string[];
  firstAt: number;
  lastAt: number;
  /** Any request in the group has an estimated (models.dev) cost. */
  hasEstimated: boolean;
}

/** Range + scope filter for the `usage:*` channels. */
export interface UsageRangeArgs {
  workspaceId?: string;
  source?: UsageSource;
  /** Epoch ms, inclusive. Omit for all time. */
  from?: number;
  to?: number;
  /** Restrict to one thread/session (expanding a thread group). */
  sessionId?: string;
  /** Only rows with no session id (flat rows shown beside thread groups). */
  noSession?: boolean;
  /** Drop rows whose cost is a models.dev estimate (provider reported none). */
  excludeEstimated?: boolean;
}
