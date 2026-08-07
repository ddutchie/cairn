/**
 * Cairn — Usage statistics IPC handlers (`usage:*` channels).
 *
 * Read-only queries over the `llm_usage` log backing the Usage view. All writes
 * happen in the capture sites via the recorder (`electron/lib/usage-recorder.ts`);
 * this module only aggregates.
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { queryUsageOverview, queryRecentUsage, clearLlmUsage, type UsageQueryFilter, type UsageSource } from "../db/usage-queries";
import { setModelPricing } from "../lib/model-pricing";

export interface UsageRangeArgs {
  workspaceId?: string;
  source?: UsageSource;
  /** Epoch ms, inclusive. Omit for all time. */
  from?: number;
  to?: number;
  /** Drop rows whose cost is a models.dev estimate (provider reported none). */
  excludeEstimated?: boolean;
}

export function registerUsageHandlers(ctx: DbContext): void {
  // models.dev per-1M pricing map pushed by the renderer once its catalog loads,
  // so the recorder can estimate cost for providers that don't report it.
  registerIpcHandle("app:modelPricing", (_e, map: Record<string, { input: number | null; output: number | null; cacheRead?: number | null; cacheWrite?: number | null }> | null) => {
    return handle(() => {
      setModelPricing(map);
      return { ok: true };
    });
  });

  const toFilter = (args: UsageRangeArgs): UsageQueryFilter => ({
    workspaceId: args?.workspaceId,
    source: args?.source,
    from: args?.from,
    to: args?.to,
    excludeEstimated: args?.excludeEstimated,
  });

  // Everything the view needs for a range: headline totals, previous window
  // (delta chips), per-day series, and source + model breakdowns.
  registerIpcHandle("usage:overview", async (_e, args: UsageRangeArgs) => {
    return handle(() => {
      return queryUsageOverview(ctx.db, toFilter(args));
    });
  });

  // Most recent per-call rows for the history table.
  registerIpcHandle("usage:recent", async (_e, args: UsageRangeArgs & { limit?: number }) => {
    return handle(() => {
      return queryRecentUsage(ctx.db, toFilter(args), args?.limit ?? 50);
    });
  });

  // Destructive: delete recorded usage rows (scoped to the workspace filter, so
  // it clears what the view shows — the workspace's rows plus global one-shots).
  registerIpcHandle("usage:clear", async (_e, args: UsageRangeArgs) => {
    return handle(() => {
      const deleted = clearLlmUsage(ctx.db, toFilter(args ?? {}));
      return { deleted, ok: true };
    });
  });
}
