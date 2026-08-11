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
import { RefreshCw, Loader2, Check, Download, WifiOff, Search, ExternalLink } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import type { PersonalitiesFetchResult, RegistryPersonalityEntry } from "@/types";

const inputCls =
  "w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm pl-8 pr-3 py-2 focus:outline-none";

const emptyResult: PersonalitiesFetchResult = {
  manifest: { version: 1, updatedAt: "", personalities: [] },
  fromCache: false,
};

export function BrowsePersonalitiesModal({ onClose }: { onClose: () => void }) {
  const { installedPersonalities, installCommunityPersonality } = useCairnStore(
    useShallow((s) => ({
      installedPersonalities: s.aiConfig.installedPersonalities ?? [],
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
    <ModalShell
      onClose={onClose}
      size="lg"
      scrollable
      title={
        <span className="flex items-center gap-2">
          <Download size={16} /> Browse Community Personalities
        </span>
      }
      description="Install ready-made tone & style rules for chat. The full prompt is shown — it's appended to the system prompt verbatim."
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
              placeholder="Search personalities…"
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
            {personalities.length === 0 ? "No community personalities available." : "No matches."}
          </p>
        ) : (
          filtered.map((entry) => {
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
                        {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                        Add
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <p className="mt-4 text-[0.65rem] text-[var(--text-tertiary)]">
        Added personalities join your installed list. Select one in the personality
        picker next to the model selector in chat — "Default" means no personality.
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
