"use client";

import { useEffect, useState, useCallback } from "react";
import { useCairnStore } from "@/store";
import type { UsageOverview, UsageRecentRow, UsageSource } from "@/types/usage";

export interface UsageRange {
  /** Number of days back, or null for all time. */
  days: number | null;
  label: string;
}

export const USAGE_RANGES: UsageRange[] = [
  { days: 7, label: "7D" },
  { days: 30, label: "30D" },
  { days: 90, label: "90D" },
  { days: null, label: "All" },
];

export interface UseUsageResult {
  overview: UsageOverview | null;
  recent: UsageRecentRow[];
  loading: boolean;
  refresh: () => void;
  /** Wipe the recorded usage for the current workspace, then reload. */
  clear: () => Promise<void>;
}

/**
 * Fetches the usage overview + recent calls for the current workspace and range.
 * Re-fetches when the workspace, range, source filter, or estimate toggle
 * changes; `refresh` forces a reload (e.g. after the user sends a chat turn).
 * When `excludeEstimated` is true, aggregate cost sums count only provider-
 * reported costs — the rows themselves are never dropped, so token/request
 * stats stay complete.
 */
export function useUsage(days: number | null, source: UsageSource | "", excludeEstimated: boolean): UseUsageResult {
  const activeWorkspaceId = useCairnStore((s) => s.activeWorkspaceId);
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [recent, setRecent] = useState<UsageRecentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  /** Delete the recorded usage rows for the current workspace (see usage:clear). */
  const clear = useCallback(async () => {
    const api = window.electron?.usage;
    if (!api?.clear) return;
    await api.clear({ workspaceId: activeWorkspaceId ?? undefined });
    setNonce((n) => n + 1);
  }, [activeWorkspaceId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const api = window.electron?.usage;
      if (!api) {
        setOverview(null);
        setRecent([]);
        setLoading(false);
        return;
      }
      const from = days == null ? undefined : Date.now() - days * 86_400_000;
      const args = {
        workspaceId: activeWorkspaceId ?? undefined,
        source: source || undefined,
        from,
        to: Date.now(),
        excludeEstimated,
      };
      try {
        const [o, r] = await Promise.all([
          api.overview(args),
          api.recent({ ...args, limit: 100 }),
        ]);
        if (!cancelled) {
          setOverview(o);
          setRecent(r);
        }
      } catch {
        if (!cancelled) {
          setOverview(null);
          setRecent([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [days, source, activeWorkspaceId, nonce, excludeEstimated]);

  return { overview, recent, loading, refresh, clear };
}
