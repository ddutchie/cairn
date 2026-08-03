"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { RefreshCw, Loader2, WifiOff, Search, Sparkles, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AutomationsFetchResult, RegistryAutomationEntry } from "@/types";

const inputCls =
  "w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm pl-8 pr-3 py-2 focus:outline-none";

const KIND_LABEL: Record<string, string> = {
  cron: "Cron",
  every: "Interval",
  once: "Once",
};

function scheduleSummary(e: RegistryAutomationEntry): string {
  const s = e.definition.schedule;
  switch (s.kind) {
    case "every": return `Every ${s.expr.replace(/^every\s+/i, "")}`;
    case "cron": return `Cron ${s.expr}`;
    case "once": return `Once at ${s.expr}`;
  }
}

/**
 * Embedded "Browse Community Automations" step — rendered INSIDE the New
 * Automation dialog (a step of the same modal, not a nested dialog, so picking
 * can't dismiss the form). Selecting a recipe calls `onPick`; the caller
 * pre-fills the form fields and returns to it.
 */
export function BrowseAutomationsContent({ onPick, onBack }: {
  onPick: (entry: RegistryAutomationEntry) => void;
  onBack: () => void;
}) {
  const [result, setResult] = useState<AutomationsFetchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    const reg = window.electron?.registry;
    if (!reg) {
      setLoading(false);
      return;
    }
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const r = force ? await reg.refreshAutomations() : await reg.fetchAutomations();
      setResult(r as AutomationsFetchResult);
    } catch (err) {
      setResult({
        manifest: { version: 1, updatedAt: "", automations: [] },
        fromCache: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false); // eslint-disable-line react-hooks/set-state-in-effect
  }, [load]);

  const automations = useMemo(() => result?.manifest.automations ?? [], [result]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const a of automations) if (a.category) set.add(a.category);
    return [...set].sort();
  }, [automations]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return automations.filter((a) => {
      if (activeCategory && a.category !== activeCategory) return false;
      if (!q) return true;
      return (
        a.definition.name.toLowerCase().includes(q) ||
        a.blurb.toLowerCase().includes(q) ||
        (a.definition.description ?? "").toLowerCase().includes(q) ||
        (a.category ?? "").toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [automations, query, activeCategory]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
          <ArrowLeft size={13} /> Back
        </Button>
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] flex items-center gap-1.5">
          <Sparkles size={12} className="text-[var(--accent)]" /> Community automations
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
          <input
            className={inputCls}
            placeholder="Search automations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load(true)} disabled={refreshing} title="Refresh from the registry">
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

      {result?.error && (
        <div className="flex items-center gap-2 text-[0.714rem] text-[var(--text-tertiary)]">
          <WifiOff size={12} />
          {result.fromCache ? "Showing the cached catalog — couldn't reach the registry." : `Couldn't load the registry: ${result.error}`}
        </div>
      )}

      <div className="flex flex-col gap-2 min-h-[8rem]">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-[var(--text-tertiary)]">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-[var(--text-tertiary)] py-10 text-center border border-dashed border-[var(--border)] rounded-lg">
            {automations.length === 0 ? "No community automations available." : "No matches."}
          </p>
        ) : (
          filtered.map((entry) => {
            const def = entry.definition;
            return (
              <div key={entry.id} className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
                <div
                  className="shrink-0 rounded-md p-1.5"
                  style={{
                    background: entry.brandColor ? `color-mix(in srgb, ${entry.brandColor} 14%, transparent)` : "var(--surface-2, transparent)",
                    color: entry.brandColor || "var(--text-secondary)",
                  }}
                >
                  <Sparkles size={22} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{def.name}</span>
                    {def.schedule && (
                      <span className="text-[0.65rem] uppercase tracking-wide text-[var(--text-tertiary)] border border-[var(--border)] rounded px-1 py-px">
                        {KIND_LABEL[def.schedule.kind] ?? def.schedule.kind}
                      </span>
                    )}
                    {def.approvalMode === "ask" && (
                      <span className="text-[0.65rem] uppercase tracking-wide text-[var(--text-tertiary)] border border-[var(--border)] rounded px-1 py-px">
                        Ask
                      </span>
                    )}
                    {entry.category && <span className="text-[0.65rem] text-[var(--text-tertiary)]">{entry.category}</span>}
                  </div>
                  <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{entry.blurb}</p>
                  <p className="text-[0.65rem] text-[var(--text-tertiary)] mt-1">{scheduleSummary(entry)}</p>
                  <p className="text-[0.65rem] text-[var(--text-tertiary)] mt-1 font-mono line-clamp-2">{def.instructions}</p>
                </div>

                <div className="shrink-0">
                  <Button size="sm" variant="accent" onClick={() => onPick(entry)}>
                    Use this
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <p className="text-[0.65rem] text-[var(--text-tertiary)]">
        Picking a recipe pre-fills the form — you can change the schedule, approval mode, and instructions before saving. Recipes only use data tools (notes, tasks, tags, boards) — no shell.
      </p>
    </div>
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

