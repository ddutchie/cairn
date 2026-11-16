"use client";

import { useCallback, useState } from "react";
import type {
  AutomationsFetchResult,
  ChatThemesFetchResult,
  PersonalitiesFetchResult,
  ProvidersFetchResult,
  RegistryFetchResult,
} from "@/types";
import { registryClient } from "@/lib/ipc/registry";
import { hasElectron } from "@/lib/ipc/client";

export type RegistryKind = "tools" | "providers" | "automations" | "personalities" | "chatThemes";

export interface RegistryResultMap {
  tools: RegistryFetchResult;
  providers: ProvidersFetchResult;
  automations: AutomationsFetchResult;
  personalities: PersonalitiesFetchResult;
  chatThemes: ChatThemesFetchResult;
}

const EMPTY_MANIFEST: Record<RegistryKind, RegistryResultMap[RegistryKind]["manifest"]> = {
  tools: { version: 1, updatedAt: "", mcpServers: [], services: [], commands: [] },
  providers: { version: 1, updatedAt: "", providers: [] },
  automations: { version: 1, updatedAt: "", automations: [] },
  personalities: { version: 1, updatedAt: "", personalities: [] },
  chatThemes: { version: 1, updatedAt: "", themes: [] },
};

const OPS: Record<
  RegistryKind,
  { fetch: () => Promise<unknown>; refresh: () => Promise<unknown> }
> = {
  tools: { fetch: registryClient.fetch, refresh: registryClient.refresh },
  providers: { fetch: registryClient.fetchProviders, refresh: registryClient.refreshProviders },
  automations: { fetch: registryClient.fetchAutomations, refresh: registryClient.refreshAutomations },
  personalities: { fetch: registryClient.fetchPersonalities, refresh: registryClient.refreshPersonalities },
  chatThemes: { fetch: registryClient.fetchChatThemes, refresh: registryClient.refreshChatThemes },
};

/**
 * Load a community-registry manifest (tools/commands, providers, automations,
 * personalities, chat themes). Owns result/loading/refreshing + the
 * force-refresh path; filtering, categories and install flows stay local.
 */
export function useRegistryManifest<K extends RegistryKind = "tools">(kind: K = "tools" as K) {
  const [result, setResult] = useState<RegistryResultMap[K] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (force: boolean) => {
      // Off-Electron the registry bridge is absent: stay empty, not errored.
      if (!hasElectron("registry")) {
        setLoading(false);
        return;
      }
      else setLoading(true);
      try {
        const r = force ? await OPS[kind].refresh() : await OPS[kind].fetch();
        setResult(r as RegistryResultMap[K]);
      } catch (err) {
        setResult({
          manifest: EMPTY_MANIFEST[kind],
          fromCache: false,
          error: err instanceof Error ? err.message : String(err),
        } as RegistryResultMap[K]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [kind],
  );

  return { result, loading, refreshing, load };
}
