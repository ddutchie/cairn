"use client";

/**
 * Browse Community Personalities — install ready-made chat personalities from
 * the cairn-community catalog. Fetches the separate personalities.json manifest
 * (cache-first, refreshable), lists each entry with its full prompt text, and
 * installs the chosen one into the shared installed list. Installed entries are
 * NOT auto-selected — the user picks one in the personality picker afterwards.
 *
 * The full prompt is shown on every card because it is appended verbatim to the
 * chat system prompt — transparency matters for untrusted community text.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { Check, Download, ExternalLink } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { CatalogBrowserShell } from "@/components/ui/catalog-browser-shell";
import { Button } from "@/components/ui/button";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { PersonalitiesFetchResult, RegistryPersonalityEntry } from "@/types";

const emptyResult: PersonalitiesFetchResult = {
  manifest: { version: 1, updatedAt: "", personalities: [] },
  fromCache: false,
};

export function BrowsePersonalitiesModal({ onClose }: { onClose: () => void }) {
  const { installedPersonalities, installCommunityPersonality } = useCairnStore(
    useShallow((s) => ({
      // NOTE: no `?? []` inside the selector — a fresh array reference would
      // break useShallow's snapshot caching (React infinite-loop guard).
      installedPersonalities: s.aiConfig.installedPersonalities,
      installCommunityPersonality: s.installCommunityPersonality,
    })),
  );

  const [result, setResult] = useState<PersonalitiesFetchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    const reg = window.electron?.registry;
    if (!reg?.fetchPersonalities) {
      setLoading(false);
      return;
    }
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const r = force ? await reg.refreshPersonalities() : await reg.fetchPersonalities();
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

  const personalities = useMemo(() => result?.manifest.personalities ?? [], [result]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of personalities) if (p.category) set.add(p.category);
    return [...set].sort();
  }, [personalities]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return personalities.filter((p) => {
      if (activeCategory && p.category !== activeCategory) return false;
      if (!q) return true;
      return (
        p.definition.name.toLowerCase().includes(q) ||
        p.blurb.toLowerCase().includes(q) ||
        (p.category ?? "").toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [personalities, query, activeCategory]);

  // Installed state, keyed by communityId (== the entry id).
  const isInstalled = useCallback(
    (entry: RegistryPersonalityEntry): boolean =>
      (installedPersonalities ?? []).some((p) => p.communityId === entry.id),
    [installedPersonalities],
  );

  const runInstall = useCallback(
    async (entry: RegistryPersonalityEntry) => {
      setInstalling(entry.id);
      setInstallError(null);
      try {
        await installCommunityPersonality(entry);
      } catch (err) {
        setInstallError(err instanceof Error ? err.message : "Couldn't install the personality.");
      } finally {
        setInstalling(null);
      }
    },
    [installCommunityPersonality],
  );

  return (
    <CatalogBrowserShell
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Download size={16} /> Browse Community Personalities
        </span>
      }
      description="Install ready-made tone & style rules for chat. The full prompt is shown — it's appended to the system prompt verbatim."
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search personalities…"
      refreshing={refreshing}
      onRefresh={() => void load(true)}
      categories={categories}
      activeCategory={activeCategory}
      onCategoryChange={setActiveCategory}
      registryError={result?.error}
      fromCache={result?.fromCache}
      installError={installError}
      loading={loading}
      hasEntries={personalities.length > 0}
      hasResults={filtered.length > 0}
      emptyText="No community personalities available."
      belowList={
        <p className="mt-4 text-[0.65rem] text-[var(--text-tertiary)]">
          Added personalities join your installed list. Select one in the personality
          picker next to the model selector in chat — &quot;None&quot; means no personality.
        </p>
      }
    >
      {filtered.map((entry) => {
            const def = entry.definition;
            const installed = isInstalled(entry);
            const busy = installing === entry.id;
            return (
              <div
                key={entry.id}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)]"
              >
                <div className="flex items-start gap-3 p-3">
                  <div className="shrink-0">
                    <span
                      className="w-2 h-2 rounded-full mt-1.5 block"
                      style={{ background: entry.brandColor ?? "var(--text-tertiary)" }}
                    />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-[var(--text-primary)]">{def.name}</span>
                      {entry.category && (
                        <span className="text-[0.6rem] text-[var(--text-tertiary)] border border-[var(--border)] rounded px-1 py-px">
                          {entry.category}
                        </span>
                      )}
                      <span className="text-[0.65rem] text-[var(--text-tertiary)]">by {entry.author}</span>
                      {entry.homepage && (
                        <a
                          href={entry.homepage}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 text-[0.6rem] text-[var(--accent)] underline"
                        >
                          source <ExternalLink size={9} />
                        </a>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{entry.blurb}</p>
                    {def.description && (
                      <p className="text-[0.65rem] text-[var(--text-tertiary)] mt-0.5">{def.description}</p>
                    )}
                    {/* Full prompt — transparency: this text is appended verbatim
                        to the chat system prompt. */}
                    <div className="mt-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-2">
                      <p className="text-[0.6rem] font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">
                        System prompt layer
                      </p>
                      <p className="text-[0.65rem] text-[var(--text-secondary)] whitespace-pre-wrap font-mono leading-relaxed max-h-32 overflow-y-auto">
                        {def.prompt}
                      </p>
                    </div>
                  </div>

                  <div className="shrink-0">
                    {installed ? (
                      <span className="inline-flex items-center gap-1 text-[0.714rem] text-[var(--success,var(--accent))]">
                        <Check size={13} /> Added
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void runInstall(entry)}
                      >
                        {busy ? <Spinner size={12} /> : <Download size={12} />}
                        Add
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
    </CatalogBrowserShell>
  );
}
