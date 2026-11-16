"use client";

import { useCallback, useState } from "react";
import type { RegistryFetchResult } from "@/types";

/**
 * Load the community-registry manifest (BrowseCommunityModal,
 * BrowseCommandsModal). Owns result/loading/refreshing + the
 * force-refresh path; filtering, categories and install flows stay local.
 */
export function useRegistryManifest() {
  const [result, setResult] = useState<RegistryFetchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force: boolean) => {
    const reg = window.electron?.registry;
    if (!reg) {
      setLoading(false);
      return;
    }
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const r = force ? await reg.refresh() : await reg.fetch();
      setResult(r as RegistryFetchResult);
    } catch (err) {
      setResult({
        manifest: { version: 1, updatedAt: "", mcpServers: [], services: [], commands: [] },
        fromCache: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  return { result, loading, refreshing, load };
}
