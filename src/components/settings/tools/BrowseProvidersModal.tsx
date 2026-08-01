"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
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
        p.tags.some((t) => t.includes(q))
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
        setInstallError(err instanceof Error ? err.message : "Install failed.");
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
      description="Install a preset OpenAI-compatible AI provider — just add your API key."
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
            return (
              <div
                key={entry.id}
                className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
              >
                <div
                  className="shrink-0 rounded-md p-1.5"
                  style={{
                    background: entry.brandColor
                      ? `color-mix(in srgb, ${entry.brandColor} 14%, transparent)`
                      : "var(--surface-2, transparent)",
                  }}
                >
                  <ConnectorLogo iconSvg={entry.iconSvg} kind="service" color={entry.brandColor} size={22} />
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
                  {installed && !updatable ? (
                    <span className="inline-flex items-center gap-1 text-[0.714rem] text-[var(--success,var(--accent))]">
                      <Check size={13} /> Installed
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
                      {updatable ? "Update" : "Install"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* API-key prompt */}
      {keyPrompt && (
        <div className="mt-4 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_5%,var(--surface))] p-3">
          <div className="flex items-center gap-2 mb-2">
            <KeyRound size={13} className="text-[var(--accent)]" />
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              {keyPrompt.definition.name} needs an API key
            </span>
          </div>
          <p className="text-[0.714rem] text-[var(--text-tertiary)] mb-3">
            Stored securely in your OS keychain — never written to the app database or sent to the model.
            {keyPrompt.definition.apiKeyUrl && (
              <>
                {" "}
                <a
                  href={keyPrompt.definition.apiKeyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--accent)] underline"
                >
                  Get a key
                </a>
              </>
            )}
          </p>
          <input
            type="password"
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 focus:outline-none mb-2"
            placeholder="sk-…"
            value={keyValue}
            onChange={(ev) => setKeyValue(ev.target.value)}
            autoComplete="off"
          />
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="ghost" size="sm" onClick={() => { setKeyPrompt(null); setKeyValue(""); }}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={installing !== null || !keyValue.trim()}
              onClick={() => void runInstall(keyPrompt, keyValue)}
            >
              {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              Install
            </Button>
          </div>
        </div>
      )}

      <p className="mt-4 text-[0.65rem] text-[var(--text-tertiary)]">
        Installed providers are added to your shared provider list. Select one in the provider
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
