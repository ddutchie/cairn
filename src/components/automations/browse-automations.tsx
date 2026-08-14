"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { RefreshCw, Loader2, WifiOff, Search, Sparkles, ArrowLeft, ChevronDown, ChevronUp, Plug, CheckCircle2, AlertTriangle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import type { AutomationsFetchResult, RegistryAutomationEntry, RegistryRequirement } from "@/types";

const inputCls =
  "w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm pl-8 pr-3 py-2 focus:outline-none";

const KIND_LABEL: Record<string, string> = {
  cron: "Cron",
  every: "Interval",
  once: "Once",
};

/** Installed/attached status for one required connector (from main). */
interface RequirementStatus {
  kind: "mcp" | "service";
  name: string;
  installed: boolean;
  attached: boolean;
}

function scheduleSummary(e: RegistryAutomationEntry): string {
  const s = e.definition.schedule;
  switch (s.kind) {
    case "every": return `Every ${s.expr.replace(/^every\s+/i, "")}`;
    case "cron": return `Cron ${s.expr}`;
    case "once": return `Once at ${s.expr}`;
  }
}

function reqKey(r: RegistryRequirement): string {
  return `${r.kind}:${r.name.toLowerCase()}`;
}

/**
 * Embedded "Browse Community Automations" step — rendered INSIDE the New
 * Automation dialog (a step of the same modal, not a nested dialog, so picking
 * can't dismiss the form). Selecting a recipe calls `onPick`; the caller
 * pre-fills the form fields and returns to it.
 */
export function BrowseAutomationsContent({ onPick, onBack, workspaceId, projectId }: {
  onPick: (entry: RegistryAutomationEntry) => void;
  onBack: () => void;
  /** Workspace the automation will run in (for connector status checks). */
  workspaceId: string;
  /** Currently selected project in the form ("" = workspace scope). */
  projectId: string;
}) {
  const setView = useCairnStore((s) => s.setView);
  const setSettingsSection = useCairnStore((s) => s.setSettingsSection);
  const [result, setResult] = useState<AutomationsFetchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Installed/attached status per required connector, keyed by `${kind}:${name}`. */
  const [reqStatus, setReqStatus] = useState<Record<string, RequirementStatus>>({});

  const openConnectorBrowser = useCallback(() => {
    setSettingsSection("tools");
    setView("settings");
  }, [setSettingsSection, setView]);

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

  // Resolve the installed/attached status of every connector any recipe
  // requires, against the currently selected project scope. Empty requires →
  // checkRequirements([]) resolves to {} (no synchronous setState in the body).
  useEffect(() => {
    if (!workspaceId) return;
    const unique = new Map<string, RegistryRequirement>();
    for (const a of automations) {
      for (const r of a.definition.requires ?? []) unique.set(reqKey(r), r);
    }
    const reqs = [...unique.values()];
    const check = window.electron?.automation?.checkRequirements;
    let cancelled = false;
    void Promise.resolve()
      .then(() =>
        check
          ? check(workspaceId, projectId, reqs)
          : ([] as RequirementStatus[])
      )
      .then((rows) => {
        if (cancelled) return;
        const map: Record<string, RequirementStatus> = {};
        for (const r of rows) map[reqKey(r)] = r;
        setReqStatus(map);
      })
      .catch(() => { if (!cancelled) setReqStatus({}); });
    return () => { cancelled = true; };
  }, [workspaceId, projectId, automations]);

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
        a.tags.some((t) => t.toLowerCase().includes(q)) ||
        (a.definition.requires ?? []).some((r) => r.name.toLowerCase().includes(q))
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
        <Tooltip content="Refresh from the registry">
          <Button variant="ghost" size="sm" onClick={() => void load(true)} disabled={refreshing}>
            {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Refresh
          </Button>
        </Tooltip>
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
                  {entry.definition.requires && entry.definition.requires.length > 0 && (
                    <>
                      <RequirementBadges
                        requires={entry.definition.requires}
                        statuses={reqStatus}
                      />
                      {!requirementsReady(entry.definition.requires, reqStatus) && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-2 py-1.5 text-[0.65rem] text-[var(--text-secondary)]">
                          <span className="inline-flex items-center gap-1">
                            <AlertTriangle size={11} className="text-[var(--warning)]" />
                            {missingSummary(entry.definition.requires, reqStatus)}
                          </span>
                          <button
                            type="button"
                            onClick={openConnectorBrowser}
                            className="inline-flex items-center gap-1 text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors cursor-pointer underline underline-offset-2"
                          >
                            Open connector browser <ExternalLink size={10} />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                  <div className="mt-1">
                    <p
                      className={cn(
                        "text-[0.65rem] text-[var(--text-tertiary)] font-mono whitespace-pre-wrap",
                        expandedId !== entry.id && "line-clamp-2",
                      )}
                    >
                      {def.instructions}
                    </p>
                    <button
                      type="button"
                      onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                      className="mt-1 inline-flex items-center gap-1 text-[0.65rem] text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors cursor-pointer"
                    >
                      {expandedId === entry.id ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                      {expandedId === entry.id ? "Collapse prompt" : "Show full prompt"}
                    </button>
                  </div>
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
        Picking a recipe pre-fills the form — you can change the schedule, approval mode, and instructions before saving. Data-only recipes use notes, tasks, tags and boards; connector recipes also use the attached MCP/service tools, which stay gated behind the approval inbox (never auto-approved).
      </p>

      <p className="flex items-center gap-1.5 text-[0.65rem] text-[var(--text-tertiary)]">
        <RefreshCw size={10} />
        {result
          ? result.fromCache
            ? `Showing the cached catalog${result.cachedAt ? ` from ${new Date(result.cachedAt).toLocaleString()}` : ""} — refreshed in the background on open, or tap Refresh for the latest.`
            : "Catalog refreshed from the community registry."
          : "Fetched from the community registry (cache-first; stale content is refreshed in the background on open)."}
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

/** Required connectors a recipe needs, with their installed/attached status. */
function RequirementBadges({ requires, statuses }: {
  requires: RegistryRequirement[];
  statuses: Record<string, RequirementStatus>;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      <span className="inline-flex items-center gap-1 text-[0.65rem] text-[var(--text-tertiary)]">
        <Plug size={10} /> Needs:
      </span>
      {requires.map((r) => {
        const st = statuses[reqKey(r)];
        const attached = Boolean(st?.attached);
        const installed = Boolean(st?.installed);
        const cls = attached
          ? "border-[color-mix(in_srgb,var(--ok)_45%,transparent)] text-[var(--ok)]"
          : installed
            ? "border-[color-mix(in_srgb,var(--warning)_45%,transparent)] text-[var(--warning)]"
            : "border-[color-mix(in_srgb,var(--danger)_45%,transparent)] text-[var(--danger)]";
        const label = attached
          ? r.name
          : installed
            ? `${r.name} · not attached`
            : `${r.name} · not installed`;
        return (
          <Tooltip key={reqKey(r)} content={attached ? "Connected and attached to this project" : "This connector isn't ready for this project yet"}>
            <span
              className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-px text-[0.65rem]", cls)}
            >
            {attached ? <CheckCircle2 size={9} /> : <AlertTriangle size={9} />}
            {label}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** True when every required connector is installed AND attached to the project. */
function requirementsReady(requires: RegistryRequirement[], statuses: Record<string, RequirementStatus>): boolean {
  return requires.every((r) => statuses[reqKey(r)]?.attached);
}

/** Human-readable summary of what's missing for a recipe. */
function missingSummary(requires: RegistryRequirement[], statuses: Record<string, RequirementStatus>): string {
  const notInstalled = requires.filter((r) => !statuses[reqKey(r)]?.installed).map((r) => r.name);
  const notAttached = requires
    .filter((r) => statuses[reqKey(r)]?.installed && !statuses[reqKey(r)]?.attached)
    .map((r) => r.name);
  const parts: string[] = [];
  if (notInstalled.length > 0) parts.push(`Not installed: ${notInstalled.join(", ")}`);
  if (notAttached.length > 0) parts.push(`Installed but not attached to this project: ${notAttached.join(", ")}`);
  return parts.join(" · ") || "Connector status unknown — check your project's attached tools.";
}

