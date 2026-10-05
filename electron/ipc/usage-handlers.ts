/**
 * Cairn — Usage statistics IPC handlers (`usage:*` channels).
 *
 * Read-only queries over the `llm_usage` log backing the Usage view. All writes
 * happen in the capture sites via the recorder (`electron/lib/usage-recorder.ts`);
 * this module only aggregates.
 */

import { registerContractHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { queryUsageOverview, queryRecentUsage, queryUsageThreads, clearLlmUsage, type UsageQueryFilter } from "../db/usage-queries";
import { getAgentHost } from "../cordis/agent-host";
import { setModelPricing, setNoTemperatureModels } from "../lib/model-pricing";

export type { UsageRangeArgs } from "../../shared/types/usage";
import type { UsageRangeArgs } from "../../shared/types/usage";

export function registerUsageHandlers(ctx: DbContext): void {
  // models.dev per-1M pricing map pushed by the renderer once its catalog loads,
  // so the recorder can estimate cost for providers that don't report it.
  registerContractHandle("app:modelPricing", (_e, map) => {
    return handle(() => {
      setModelPricing(map);
      return { ok: true };
    });
  });

  // Model ids models.dev marks `temperature: false` — the request builders must
  // never send a temperature to these (the vendor manages sampling internally).
  registerContractHandle("app:noTemperatureModels", (_e, ids) => {
    return handle(() => {
      setNoTemperatureModels(ids);
      return { ok: true };
    });
  });

  const toFilter = (args: UsageRangeArgs): UsageQueryFilter => ({
    workspaceId: args?.workspaceId,
    source: args?.source,
    from: args?.from,
    to: args?.to,
    sessionId: args?.sessionId,
    noSession: args?.noSession,
    excludeEstimated: args?.excludeEstimated,
  });

  // Everything the view needs for a range: headline totals, previous window
  // (delta chips), per-day series, and source + model breakdowns.
  registerContractHandle("usage:overview", async (_e, args) => {
    return handle(() => {
      return queryUsageOverview(ctx.db, toFilter(args));
    });
  });

  // Most recent per-call rows for the history table.
  registerContractHandle("usage:recent", async (_e, args) => {
    return handle(() => {
      return queryRecentUsage(ctx.db, toFilter(args), args?.limit ?? 50);
    });
  });

  // Per-thread rollups (chat threads, agent sessions, automation runs) for the
  // grouped history table; expand a group with usage:recent + sessionId.
  registerContractHandle("usage:threads", async (_e, args) => {
    return handle(async () => {
      const groups = queryUsageThreads(ctx.db, toFilter(args), args?.limit ?? 50);
      // Chat titles live in the session log (chat_threads.title is mostly empty),
      // so resolve the untitled chat groups from there.
      const host = getAgentHost();
      await Promise.all(groups.map(async (g) => {
        if (g.title || !g.sessionId.startsWith("chat-")) return;
        try { g.title = (await host.readSessionTitle(g.sessionId)) || null; } catch { /* keep the id fallback */ }
      }));
      return groups;
    });
  });

  // Destructive: delete recorded usage rows (scoped to the workspace filter, so
  // it clears what the view shows — the workspace's rows plus global one-shots).
  registerContractHandle("usage:clear", async (_e, args) => {
    return handle(() => {
      const deleted = clearLlmUsage(ctx.db, toFilter(args ?? {}));
      return { deleted, ok: true as const };
    });
  });
}
