/**
 * Cairn — LLM usage log queries + types.
 *
 * Backs the Usage view (tokens / cost / requests per day, breakdowns by source
 * and model, recent per-call history). All rows are written by the main-process
 * recorder (`electron/lib/usage-recorder.ts`) at the LLM capture points; this
 * module only reads.
 */

import type Database from "better-sqlite3";
import { newId } from "./utils";

/** Where an LLM request originated — drives the "source" breakdown in the UI. */
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

/** Human label for a source, used by the renderer (kept here so it never drifts). */
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

export interface LlmUsageRecord {
  id: string;
  workspaceId?: string;
  projectId?: string;
  source: UsageSource;
  /** Chat threadId / pi-agent session id / automation run id this request belongs to. */
  sessionId?: string;
  provider?: string;
  model: string;
  baseUrl?: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  /** Prompt tokens served from the provider's cache (billed at the cache_read rate). */
  cacheReadTokens?: number;
  /** Prompt tokens written to the provider's cache (billed at the cache_write rate). */
  cacheCreationTokens?: number;
  costUsd?: number;
  /** True when cost_usd is a models.dev estimate (provider reported none). */
  costEstimated?: boolean;
  finishReason?: string;
  /** Epoch ms. Defaults to now when omitted. */
  createdAt?: number;
}

export function insertLlmUsage(db: Database.Database, record: LlmUsageRecord): void {
  db.prepare(
    `INSERT INTO llm_usage (
       id, workspace_id, project_id, source, session_id, provider, model, base_url,
       prompt_tokens, completion_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd, cost_estimated, finish_reason, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id || newId(),
    record.workspaceId ?? null,
    record.projectId ?? null,
    record.source,
    record.sessionId ?? null,
    record.provider ?? null,
    record.model,
    record.baseUrl ?? null,
    Math.max(0, Math.round(record.promptTokens ?? 0)),
    Math.max(0, Math.round(record.completionTokens ?? 0)),
    Math.max(0, Math.round(record.reasoningTokens ?? 0)),
    Math.max(0, Math.round(record.cacheReadTokens ?? 0)),
    Math.max(0, Math.round(record.cacheCreationTokens ?? 0)),
    typeof record.costUsd === "number" && Number.isFinite(record.costUsd) ? record.costUsd : null,
    record.costEstimated ? 1 : 0,
    record.finishReason ?? null,
    record.createdAt ?? Date.now(),
  );
}

export interface UsageQueryFilter {
  workspaceId?: string;
  source?: UsageSource;
  /** Epoch ms, inclusive. */
  from?: number;
  /** Epoch ms, inclusive. */
  to?: number;
  /** Drop rows whose cost is a models.dev estimate (provider reported none). */
  excludeEstimated?: boolean;
}

/**
 * Build the WHERE clause + params for a usage filter.
 * `workspaceId` scopes to rows of that workspace PLUS rows with no workspace
 * (global one-shot features) so nothing is hidden; a NULL workspaceId filters nothing.
 */
function whereClause(f: UsageQueryFilter): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.workspaceId) {
    conds.push("(workspace_id = ? OR workspace_id IS NULL)");
    params.push(f.workspaceId);
  }
  if (f.source) {
    conds.push("source = ?");
    params.push(f.source);
  }
  if (f.from != null) {
    conds.push("created_at >= ?");
    params.push(f.from);
  }
  if (f.to != null) {
    conds.push("created_at <= ?");
    params.push(f.to);
  }
  if (f.excludeEstimated) {
    // Only calls with a provider-reported cost survive: a row is never an
    // estimate when cost_estimated is 0, but it may still carry no cost at all
    // (provider reported none and pricing is unknown) — those have no real cost
    // either and are dropped so the view reflects actual billed spend.
    conds.push("cost_estimated = 0 AND cost_usd IS NOT NULL");
  }
  return { sql: conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "", params };
}

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

const TOTAL_COLS = `COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cost_usd), 0) AS cost_usd,
  COUNT(*) AS requests`;

function toTotals(row: Record<string, number>): UsageTotals {
  return {
    promptTokens: Number(row.prompt_tokens) || 0,
    completionTokens: Number(row.completion_tokens) || 0,
    reasoningTokens: Number(row.reasoning_tokens) || 0,
    cacheReadTokens: Number(row.cache_read_tokens) || 0,
    costUsd: Number(row.cost_usd) || 0,
    requests: Number(row.requests) || 0,
  };
}

/**
 * Everything the Usage view needs for one range: headline totals, the previous
 * window for deltas, the per-day series, and source + model breakdowns.
 */
export function queryUsageOverview(db: Database.Database, filter: UsageQueryFilter): UsageOverview {
  const where = whereClause(filter);

  const totalsRow = db.prepare(`SELECT ${TOTAL_COLS} FROM llm_usage${where.sql}`).get(...where.params) as Record<string, number>;
  const totals = toTotals(totalsRow);

  let previous: UsageTotals | null = null;
  if (filter.from != null && filter.to != null) {
    const windowMs = filter.to - filter.from;
    if (windowMs > 0) {
      const prevWhere = whereClause({
        ...filter,
        from: filter.from - windowMs,
        to: filter.from - 1,
      });
      const prevRow = db.prepare(`SELECT ${TOTAL_COLS} FROM llm_usage${prevWhere.sql}`).get(...prevWhere.params) as Record<string, number>;
      previous = toTotals(prevRow);
    }
  }

  const series = (
    db
      .prepare(
        `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day,
           ${TOTAL_COLS}
         FROM llm_usage${where.sql}
         GROUP BY day ORDER BY day ASC`
      )
      .all(...where.params) as Array<Record<string, number> & { day: string }>
  ).map((row) => ({ day: row.day, ...toTotals(row) }));

  const bySource = (
    db
      .prepare(
        `SELECT source, ${TOTAL_COLS}
         FROM llm_usage${where.sql}
         GROUP BY source
         ORDER BY SUM(prompt_tokens) + SUM(completion_tokens) DESC`
      )
      .all(...where.params) as Array<Record<string, number> & { source: UsageSource }>
  ).map((row) => ({ source: row.source, ...toTotals(row) }));

  const byModel = (
    db
      .prepare(
        `SELECT model, ${TOTAL_COLS}
         FROM llm_usage${where.sql}
         GROUP BY model
         ORDER BY SUM(prompt_tokens) + SUM(completion_tokens) DESC`
      )
      .all(...where.params) as Array<Record<string, number> & { model: string }>
  ).map((row) => ({ model: row.model, ...toTotals(row) }));

  return { totals, previous, series, bySource, byModel };
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

/**
 * Write a recovered turn-level cost (provider credit-diff) back onto the usage
 * rows recorded for that chat turn. Only rows without a provider-reported cost
 * (estimated or null) are touched, and the total is distributed proportionally
 * to each round's completion tokens so per-day totals stay accurate.
 */
export function applyRecoveredTurnCost(
  db: Database.Database,
  sessionId: string | undefined,
  fromMs: number,
  totalCost: number,
): void {
  if (!sessionId || !Number.isFinite(totalCost) || totalCost < 0) return;
  const rows = db.prepare(
    `SELECT id, completion_tokens FROM llm_usage
     WHERE source = 'chat' AND session_id = ? AND created_at >= ? AND (cost_usd IS NULL OR cost_estimated = 1)`
  ).all(sessionId, fromMs) as Array<{ id: string; completion_tokens: number }>;
  if (rows.length === 0) return;
  const totalOut = rows.reduce((a, r) => a + r.completion_tokens, 0);
  const update = db.prepare("UPDATE llm_usage SET cost_usd = ?, cost_estimated = 0 WHERE id = ?");
  const apply = db.transaction(() => {
    for (const r of rows) {
      const share = totalOut > 0
        ? (r.completion_tokens / totalOut) * totalCost
        : totalCost / rows.length;
      update.run(share, r.id);
    }
  });
  apply();
}

/** Most recent per-call rows for the history table. */
export function queryRecentUsage(db: Database.Database, filter: UsageQueryFilter, limit = 50): UsageRecentRow[] {  const where = whereClause(filter);
  const rows = db
    .prepare(
      `SELECT id, workspace_id, project_id, source, session_id, provider, model, base_url,
         prompt_tokens, completion_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens,
         cost_usd, cost_estimated, finish_reason, created_at
       FROM llm_usage${where.sql}
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(...where.params, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    workspaceId: (r.workspace_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    source: r.source as UsageSource,
    sessionId: (r.session_id as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    model: String(r.model),
    baseUrl: (r.base_url as string | null) ?? null,
    promptTokens: Number(r.prompt_tokens) || 0,
    completionTokens: Number(r.completion_tokens) || 0,
    reasoningTokens: Number(r.reasoning_tokens) || 0,
    cacheReadTokens: Number(r.cache_read_tokens) || 0,
    cacheCreationTokens: Number(r.cache_creation_tokens) || 0,
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    costEstimated: Number(r.cost_estimated) === 1,
    finishReason: (r.finish_reason as string | null) ?? null,
    createdAt: Number(r.created_at) || 0,
  }));
}
