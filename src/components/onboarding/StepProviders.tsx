"use client";

import { useState, useEffect, useMemo, useCallback, useSyncExternalStore } from "react";
import { Check, Download, Loader2, WifiOff } from "lucide-react";
import { Shell, NavRow } from "./shared";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { ProvidersFetchResult, RegistryProviderEntry } from "@/types";
import { ConnectorLogo } from "@/components/settings/tools/ConnectorLogo";
import { endpointLogoSlug } from "../../../shared/models/model-catalog";
import { getOrFetchLogoSvg, subscribeModelCatalog, getModelCatalogVersion } from "@/lib/models-dev";

const emptyResult: ProvidersFetchResult = {
  manifest: { version: 1, updatedAt: "", providers: [] },
  fromCache: false,
};

interface Props {
  onBack: () => void;
  onNext: () => void;
}

/**
 * Onboarding provider gallery — the OpenWorker-style step 1: a FIXED-HEIGHT
 * two-per-row grid of community AI providers, each card wearing its own
 * connect/add state. Reuses the existing registry provider model
 * (cache-first manifest fetch, per-provider API-key install, OS keychain) — this
 * is presentation only, it does not rebuild the provider connector.
 *
 * The fixed-height frame is the point: the step never grows/shrinks as
 * providers load, install, or fail, so the wizard chrome doesn't jump.
 */
export function StepProviders({ onBack, onNext }: Props) {
  const { savedProviders, installCommunityProvider } = useCairnStore(
    useShallow((s) => ({
      savedProviders: s.aiConfig.savedProviders,
      installCommunityProvider: s.installCommunityProvider,
    }))
  );

  const [result, setResult] = useState<ProvidersFetchResult | null>(null);
  const [loading, setLoading] = useState(true);
  useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // Entry currently prompting for an API key.
  const [keyPrompt, setKeyPrompt] = useState<RegistryProviderEntry | null>(null);
  const [keyValue, setKeyValue] = useState("");

  const load = useCallback(async () => {
    const reg = window.electron?.registry;
    if (!reg?.fetchProviders) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const r = await reg.fetchProviders();
      setResult(r);
    } catch (err) {
      setResult({ ...emptyResult, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(); // eslint-disable-line react-hooks/set-state-in-effect
  }, [load]);

  const providers = useMemo(() => result?.manifest.providers ?? [], [result]);

  const isInstalled = useCallback(
    (entry: RegistryProviderEntry): boolean =>
      (savedProviders ?? []).some((p) => p.communityId === entry.id || p.name === entry.definition.name),
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
    <Shell step="providers">
      <div className="w-full max-w-md flex flex-col gap-4">

        {/* Error banner */}
        {result?.error && (
          <div className="flex items-center gap-2 text-[0.714rem] text-[var(--text-tertiary)]">
            <WifiOff size={12} />
            {result.fromCache
              ? "Showing the cached catalog — couldn't reach the registry."
              : `Couldn't load the registry: ${result.error}`}
          </div>
        )}
        {installError && (
          <div className="text-[0.714rem] text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] rounded px-3 py-2">
            {installError}
          </div>
        )}

        {/* Fixed-height gallery — two per row, frame never jumps */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
          <p className="text-sm font-semibold text-[var(--text-primary)] mb-0.5">Add an AI provider</p>
          <p className="text-xs text-[var(--text-tertiary)] leading-relaxed mb-4">
            One-click presets for OpenAI-compatible endpoints. Keys are stored in your OS keychain.
            You can add these later from Settings → AI.
          </p>

          <div className="h-[21rem]">
            {loading ? (
              <div className="flex items-center justify-center h-full text-[var(--text-tertiary)]">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : providers.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs text-[var(--text-tertiary)] text-center border border-dashed border-[var(--border)] rounded-lg px-4">
                {result?.error ? "No providers available offline." : "No community providers available."}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 h-full content-start">
                {providers.map((entry) => {
                  const def = entry.definition;
                  const installed = isInstalled(entry);
                  const busy = installing === entry.id;
                  const prompting = keyPrompt?.id === entry.id;
                  return (
                    <div key={entry.id} className="flex flex-col rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 min-h-[7rem]">
                      <div className="flex items-start gap-2 mb-1.5">
                        <div className="shrink-0">
                          {(() => {
                            if (entry.iconSvg) {
                              return <ConnectorLogo iconSvg={entry.iconSvg} kind="service" color={entry.brandColor} size={28} />;
                            }
                            const slug = endpointLogoSlug(def.baseUrl);
                            const svg = slug ? getOrFetchLogoSvg(slug) : null;
                            if (svg) return <ConnectorLogo iconSvg={svg} kind="service" size={28} />;
                            return <ConnectorLogo kind="service" color={entry.brandColor} size={28} />;
                          })()}
                        </div>
                        <span className="text-xs font-semibold text-[var(--text-primary)] leading-tight">{def.name}</span>
                      </div>
                      <p className="text-[0.65rem] text-[var(--text-tertiary)] leading-snug line-clamp-2 flex-1">{entry.blurb}</p>
                      {prompting ? (
                        <div className="mt-2 flex items-center gap-1.5">
                          <input
                            type="password"
                            autoFocus
                            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-[0.65rem] px-2 py-1 focus:outline-none"
                            placeholder="sk-…"
                            value={keyValue}
                            onChange={(ev) => setKeyValue(ev.target.value)}
                            onKeyDown={(ev) => {
                              if (ev.key === "Enter" && keyValue.trim() && installing === null) void runInstall(entry, keyValue);
                              if (ev.key === "Escape") { setKeyPrompt(null); setKeyValue(""); }
                            }}
                            autoComplete="off"
                          />
                          <button
                            type="button"
                            disabled={installing !== null || !keyValue.trim()}
                            onClick={() => void runInstall(entry, keyValue)}
                            className="shrink-0 px-2 py-1 text-[0.65rem] rounded bg-[var(--accent)] text-white disabled:opacity-40"
                          >
                            {busy ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />}
                          </button>
                        </div>
                      ) : installed ? (
                        <div className="mt-2 flex items-center gap-1 text-[0.65rem] text-[var(--success,var(--accent))]">
                          <Check size={11} /> Added
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onInstallClick(entry)}
                          className="mt-2 inline-flex items-center gap-1 px-2 py-1 text-[0.65rem] rounded bg-[var(--surface-3)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
                        >
                          {busy ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                          {def.needsApiKey ? "Add · key" : "Add"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <NavRow onBack={onBack} onNext={onNext} nextLabel="Continue" />
      </div>
    </Shell>
  );
}
