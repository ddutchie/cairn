"use client";

import { useState, useEffect, useMemo, useCallback, useSyncExternalStore } from "react";
import {
  RefreshCw,
  Loader2,
  Check,
  Download,
  ArrowUpCircle,
  KeyRound,
  WifiOff,
  Search,
} from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import type { ProvidersFetchResult, RegistryProviderEntry } from "@/types";
import { ConnectorLogo } from "./ConnectorLogo";
import { endpointLogoSlug } from "../../../../shared/models/model-catalog";
import { getOrFetchLogoSvg, subscribeModelCatalog, getModelCatalogVersion } from "@/lib/models-dev";

const inputCls =
  "w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm pl-8 pr-3 py-2 focus:outline-none";

const emptyResult: ProvidersFetchResult = {
  manifest: { version: 1, updatedAt: "", providers: [] },
  fromCache: false,
};

/**
 * Browse Community Providers — one-click presets for OpenAI-compatible AI
 * endpoints. Fetches the SEPARATE providers.json manifest (cache-first,
 * refreshable), lists each provider preset, and installs the chosen one into the
 * shared saved-providers list. Providers that need a key prompt for it inline;
 * the key is stored in the OS keychain. The provider is NOT auto-selected — the
 * user picks it in the provider switcher afterwards.
 */
export function BrowseProvidersModal({ onClose }: { onClose: () => void }) {
  const { savedProviders, installCommunityProvider } = useCairnStore(
    useShallow((s) => ({
      savedProviders: s.aiConfig.savedProviders,
      installCommunityProvider: s.installCommunityProvider,
    }))
  );

  const [result, setResult] = useState<ProvidersFetchResult | null>(null);
  const [loading, setLoading] = useState(true);
  // Re-render when lazily-fetched models.dev provider SVGs land so entries
  // without an inline community icon pop in their brand mark on the chip.
  useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // Entry currently prompting for an API key.
  const [keyPrompt, setKeyPrompt] = useState<RegistryProviderEntry | null>(null);
  const [keyValue, setKeyValue] = useState("");

  const load = useCallback(async (force: boolean) => {
    const reg = window.electron?.registry;
    if (!reg?.fetchProviders) {
      setLoading(false);
      return;
    }
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const r = force ? await reg.refreshProviders() : await reg.fetchProviders();
      setResult(r);
    } catch (err) {
      setResult({ ...emptyResult, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false); // eslint-disable-line react-hooks/set-state-in-effect
  }, [load]);

  const providers = useMemo(() => result?.manifest.providers ?? [], [result]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of providers) if (p.category) set.add(p.category);
    return [...set].sort();
  }, [providers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers.filter((p) => {
      if (activeCategory && p.category !== activeCategory) return false;
      if (!q) return true;
      return (
        p.definition.name.toLowerCase().includes(q) ||
        p.blurb.toLowerCase().includes(q) ||
        (p.category ?? "").toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [providers, query, activeCategory]);

  // Installed state, keyed by communityId (== the entry id).
  const isInstalled = useCallback(
    (entry: RegistryProviderEntry): boolean =>
      (savedProviders ?? []).some((p) => p.communityId === entry.id),
    [savedProviders]
  );

  // A community provider is "outdated" when the installed row's connection no
  // longer matches the catalog (baseUrl / default model changed upstream).
  const isOutdated = useCallback(
    (entry: RegistryProviderEntry): boolean => {
      const row = (savedProviders ?? []).find((p) => p.communityId === entry.id);
      if (!row) return false;
      return row.baseUrl !== entry.definition.baseUrl || row.model !== (entry.definition.defaultModel ?? row.model);
    },
    [savedProviders]
  );

  const runInstall = useCallback(
    async (entry: RegistryProviderEntry, apiKey?: string) => {
      setInstalling(entry.id);
      setInstallError(null);
      try {
        await installCommunityProvider(entry, apiKey);
        setKeyPrompt(null);
        setKeyValue("");
      } catch (err) {
        setInstallError(err instanceof Error ? err.message : "Couldn't add the provider.");
      } finally {
        setInstalling(null);
      }
    },
    [installCommunityProvider]
  );

  const onInstallClick = useCallback(
    (entry: RegistryProviderEntry) => {
      if (entry.definition.needsApiKey) {
        setKeyValue("");
        setKeyPrompt(entry);
        return;
      }
      void runInstall(entry);
    },
    [runInstall]
  );

  return (
    <ModalShell
      onClose={onClose}
      size="lg"
      scrollable
      title={
        <span className="flex items-center gap-2">
          <Download size={16} /> Browse Community Providers
        </span>
      }
      description="Add a preset OpenAI-compatible AI provider — just enter your API key."
    >
      {/* Toolbar: search + refresh */}
      <div className="flex flex-col gap-3 pb-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
            />
            <input
              className={inputCls}
              placeholder="Search providers…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load(true)}
            disabled={refreshing}
            title="Refresh from the registry"
          >
            {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Refresh
          </Button>
        </div>

        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <TagChip label="All" active={activeCategory === null} onClick={() => setActiveCategory(null)} />
            {categories.map((cat) => (
              <TagChip key={cat} label={cat} active={activeCategory === cat} onClick={() => setActiveCategory(cat)} />
            ))}
          </div>
        )}
      </div>

      {/* Provenance / error banner */}
      {result?.error && (
        <div className="mt-3 flex items-center gap-2 text-[0.714rem] text-[var(--text-tertiary)]">
          <WifiOff size={12} />
          {result.fromCache
            ? "Showing the cached catalog — couldn't reach the registry."
            : `Couldn't load the registry: ${result.error}`}
        </div>
      )}
      {installError && (
        <div className="mt-3 text-[0.714rem] text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] rounded px-3 py-2">
          {installError}
        </div>
      )}

      {/* List */}
      <div className="mt-3 flex flex-col gap-2 min-h-[8rem]">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-[var(--text-tertiary)]">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-[var(--text-tertiary)] py-10 text-center border border-dashed border-[var(--border)] rounded-lg">
            {providers.length === 0 ? "No community providers available." : "No matches."}
          </p>
        ) : (
          filtered.map((entry) => {
            const def = entry.definition;
            const installed = isInstalled(entry);
            const updatable = installed && isOutdated(entry);
            const busy = installing === entry.id;
            const prompting = keyPrompt?.id === entry.id;
            return (
              <div
                key={entry.id}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)]"
              >
                <div className="flex items-start gap-3 p-3">
                  <div className="shrink-0">
                    {(() => {
                      // Community iconSvg when present; else fall back to the
                      // models.dev logo for a known direct-vendor hostname so
                      // entries without an inline icon still show their brand
                      // mark on the SAME fixed light chip as the others.
                      if (entry.iconSvg) {
                        return <ConnectorLogo iconSvg={entry.iconSvg} kind="service" color={entry.brandColor} size={36} />;
                      }
                      const slug = endpointLogoSlug(def.baseUrl);
                      const svg = slug ? getOrFetchLogoSvg(slug) : null;
                      if (svg) return <ConnectorLogo iconSvg={svg} kind="service" size={36} />;
                      return <ConnectorLogo kind="service" color={entry.brandColor} size={36} />;
                    })()}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-[var(--text-primary)]">{def.name}</span>
                      {def.needsApiKey && (
                        <span className="inline-flex items-center gap-1 text-[0.65rem] text-[var(--text-tertiary)]">
                          <KeyRound size={11} /> API key
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{entry.blurb}</p>
                    <p className="text-[0.65rem] text-[var(--text-tertiary)] mt-1 truncate font-mono">
                      {def.baseUrl}
                      {def.defaultModel ? ` · ${def.defaultModel}` : ""}
                    </p>
                  </div>

                  <div className="shrink-0">
                    {prompting ? (
                      // The inline key prompt below owns the install action — hide
                      // the redundant top-right button while it's open.
                      <span className="inline-flex items-center gap-1 text-[0.714rem] text-[var(--text-tertiary)]">
                        <KeyRound size={13} /> Enter key
                      </span>
                    ) : installed && !updatable ? (
                      <span className="inline-flex items-center gap-1 text-[0.714rem] text-[var(--success,var(--accent))]">
                        <Check size={13} /> Added
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant={updatable ? "outline" : "default"}
                        disabled={busy}
                        onClick={() => onInstallClick(entry)}
                      >
                        {busy ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : updatable ? (
                          <ArrowUpCircle size={12} />
                        ) : (
                          <Download size={12} />
                        )}
                        {updatable ? "Update" : "Add"}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Inline API-key prompt for THIS provider (below its row). */}
                {prompting && (
                  <div className="border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] px-3 py-3 rounded-b-lg">
                    <p className="text-[0.714rem] text-[var(--text-tertiary)] mb-2">
                      Stored securely in your OS keychain — never written to the app database or sent to the model.
                      {def.apiKeyUrl && (
                        <>
                          {" "}
                          <a
                            href={def.apiKeyUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[var(--accent)] underline"
                          >
                            Get a key
                          </a>
                        </>
                      )}
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        autoFocus
                        className="flex-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 focus:outline-none"
                        placeholder="sk-…"
                        value={keyValue}
                        onChange={(ev) => setKeyValue(ev.target.value)}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter" && keyValue.trim() && installing === null) void runInstall(entry, keyValue);
                          if (ev.key === "Escape") { setKeyPrompt(null); setKeyValue(""); }
                        }}
                        autoComplete="off"
                      />
                      <Button variant="ghost" size="sm" onClick={() => { setKeyPrompt(null); setKeyValue(""); }}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        disabled={installing !== null || !keyValue.trim()}
                        onClick={() => void runInstall(entry, keyValue)}
                      >
                        {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                        Confirm
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <p className="mt-4 text-[0.65rem] text-[var(--text-tertiary)]">
        Added providers join your shared provider list. Select one in the provider
        switcher above to use it in AI Chat or the coding agent.
      </p>
    </ModalShell>
  );
}

function TagChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "text-[0.65rem] rounded-full px-2 py-0.5 border transition-colors",
        active
          ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--text-primary)]"
          : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
      )}
    >
      {label}
    </button>
  );
}
