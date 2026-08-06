/**
 * Cairn — Usage statistics IPC handlers (`usage:*` channels).
 *
 * Read-only queries over the `llm_usage` log backing the Usage view. All writes
 * happen in the capture sites via the recorder (`electron/lib/usage-recorder.ts`);
 * this module only aggregates.
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { queryUsageOverview, queryRecentUsage, type UsageQueryFilter, type UsageSource } from "../db/usage-queries";
import { setModelPricing } from "../lib/model-pricing";

export interface UsageRangeArgs {
  workspaceId?: string;
  source?: UsageSource;
  /** Epoch ms, inclusive. Omit for all time. */
  from?: number;
  to?: number;
}

export function registerUsageHandlers(ctx: DbContext): void {
  // models.dev per-1M pricing map pushed by the renderer once its catalog loads,
  // so the recorder can estimate cost for providers that don't report it.
  registerIpcHandle("app:modelPricing", (_e, map: Record<string, { input: number | null; output: number | null }> | null) => {
    return handle(() => {
      setModelPricing(map);
      return { ok: true };
    });
  });

  // Everything the view needs for a range: headline totals, previous window
  // (delta chips), per-day series, and source + model breakdowns.
  registerIpcHandle("usage:overview", async (_e, args: UsageRangeArgs) => {
    return handle(() => {
      const filter: UsageQueryFilter = {
        workspaceId: args?.workspaceId,
        source: args?.source,
        from: args?.from,
        to: args?.to,
      };
      return queryUsageOverview(ctx.db, filter);
    });
  });

  // Most recent per-call rows for the history table.
  registerIpcHandle("usage:recent", async (_e, args: UsageRangeArgs & { limit?: number }) => {
    return handle(() => {
      const filter: UsageQueryFilter = {
        workspaceId: args?.workspaceId,
        source: args?.source,
        from: args?.from,
        to: args?.to,
      };
      return queryRecentUsage(ctx.db, filter, args?.limit ?? 50);
    });
  });
}
