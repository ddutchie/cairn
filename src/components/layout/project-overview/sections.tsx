"use client";

// Domain-specific sub-components for Project Overview sections.
// All are presentational (no local state, no effects, no store deps).

import React from "react";
import { FileText, Circle, Zap, Kanban, CheckCircle2 } from "lucide-react";
import { cn, formatRelative, parseIsoLocal } from "@/lib/utils";
import { revealNote, revealCard } from "@/lib/events";
import { OverflowPill } from "@/components/ui/overflow-pill";
import type { AppUIState } from "@/types";
import type { ActivityGroup } from "./useProjectMetrics";
import type { TaskCard } from "@/types";
import type { AtRiskCard, RiskReason } from "../../../../shared/overview/delivery";
import type { AutomationRunWithAutomation } from "@/store/slices/automations";
import { SectionHeader } from "./primitives";

// Status → text colour, mirroring STATUS_COLOR in the Automations view detail
// dialog so run rows read consistently across surfaces.
const RUN_STATUS_COLOR: Record<AutomationRunWithAutomation["status"], string> = {
  done: "text-[var(--ok)]",
  running: "text-[var(--accent)]",
  pending: "text-[var(--text-secondary)]",
  skipped: "text-[var(--text-tertiary)]",
  exhausted: "text-[var(--warning)]",
  error: "text-[var(--danger)]",
  denied: "text-[var(--danger)]",
};

interface RunArtifactRef { type: "note" | "task"; id: string; title: string }

/** Notes/tasks a run created, parsed from its scratch JSON (set by the runner). */
function runArtifacts(run: AutomationRunWithAutomation): RunArtifactRef[] {
  if (!run.scratch) return [];
  try {
    const scratch = JSON.parse(run.scratch) as { artifacts?: RunArtifactRef[] };
    return Array.isArray(scratch.artifacts) ? scratch.artifacts : [];
  } catch {
    return [];
  }
}

// ── Delivery: shipped / at-risk ─────────────────────────────────────────────

/** Cards completed recently — one row each, newest first. */
export function ShippedFeed({ cards, columnName, setView }: {
  cards: TaskCard[];
  columnName: (id: string) => string | undefined;
  setView: (v: AppUIState["activeView"]) => void;
}) {
  return (
    <div className="space-y-0.5">
      {cards.map((c) => (
        <button key={c.id} onClick={() => revealCard(setView, c.id)}
          className="flex items-center gap-3 w-full px-2 py-1.5 rounded-lg hover:bg-[var(--surface-2)] transition-colors group text-left">
          <CheckCircle2 size={12} className="text-[var(--success)] flex-shrink-0" />
          <span className="flex-1 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">{c.title}</span>
          {c.archivedAt
            ? <span className="text-[0.714rem] text-[var(--text-tertiary)] flex-shrink-0">archived</span>
            : <span className="text-[0.714rem] text-[var(--text-tertiary)] flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">{columnName(c.columnId)}</span>}
          <span className="text-[0.786rem] text-[var(--text-tertiary)] flex-shrink-0 tabular-nums">{formatRelative(c.completedAt)}</span>
        </button>
      ))}
    </div>
  );
}

const RISK_LABEL: Record<RiskReason, string> = { overdue: "Overdue", blocked: "Blocked", stale: "Stale" };
const RISK_COLOR: Record<RiskReason, string> = {
  overdue: "var(--danger)",
  blocked: "var(--warning)",
  stale: "var(--text-tertiary)",
};

/** Open cards that need attention, with labelled reason pills (not colour alone). */
export function AtRiskFeed({ items, setView }: { items: AtRiskCard<TaskCard>[]; setView: (v: AppUIState["activeView"]) => void }) {
  return (
    <div className="space-y-0.5">
      {items.map(({ card, reasons, idleDays }) => (
        <button key={card.id} onClick={() => revealCard(setView, card.id)}
          className="flex items-center gap-3 w-full px-2 py-1.5 rounded-lg hover:bg-[var(--surface-2)] transition-colors group text-left">
          <span className="flex-1 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">{card.title}</span>
          {card.dueDate && (
            <span className="text-[0.786rem] text-[var(--text-tertiary)] flex-shrink-0 tabular-nums">
              {parseIsoLocal(card.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          )}
          {reasons.map((r) => (
            <span key={r}
              title={r === "stale" ? `No updates for ${idleDays} days` : r === "blocked" ? "Due soon with an open blocker" : `Due ${card.dueDate}`}
              className="text-[0.643rem] font-medium px-1.5 py-0.5 rounded-md flex-shrink-0"
              style={{ color: RISK_COLOR[r], background: `color-mix(in srgb, ${RISK_COLOR[r]} 14%, transparent)` }}>
              {RISK_LABEL[r]}{r === "stale" ? ` · ${idleDays}d` : ""}
            </span>
          ))}
        </button>
      ))}
    </div>
  );
}

// ── Recent activity feed ────────────────────────────────────────────────────

export function RecentActivityFeed({ activityByDay }: { activityByDay: ActivityGroup[] }) {
  return (
    <div className="space-y-4">
      {activityByDay.map(({ label, items }) => (
        <div key={label}>
          <div className="text-[0.714rem] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider mb-1.5 px-2">{label}</div>
          <div className="space-y-0.5">
            {items.map((item) => (
              <button key={item.id} onClick={item.onClick}
                className="flex items-center gap-3 w-full px-2 py-1.5 rounded-lg hover:bg-[var(--surface-2)] transition-colors group text-left">
                {item.type === "note"
                  ? <FileText size={12} className="text-[var(--info)] flex-shrink-0" />
                  : <Circle size={12} className="text-[var(--accent)] flex-shrink-0" />
                }
                <span className="flex-1 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">{item.title}</span>
                {item.subtitle && (
                  <span className="text-[0.786rem] text-[var(--text-tertiary)] flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">{item.subtitle}</span>
                )}
                <span className="text-[0.786rem] text-[var(--text-tertiary)] flex-shrink-0 tabular-nums">{formatRelative(item.updatedAt)}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Recent automation runs feed ─────────────────────────────────────────────

/**
 * Compact "recent run results" feed for the project Overview. Mirrors the
 * `RecentActivityFeed` row pattern (icon + title + relative time) but adds:
 *  - status-coloured status pill (matching the Automations view detail dialog)
 *  - artifact chips (notes/tasks the run created) when present, clickable to
 *    reveal the artifact — same `revealNote`/`revealCard` dispatch the rest of
 *    the Overview uses.
 *
 * Data shape: `AutomationRunWithAutomation[]` (run row joined with its
 * automation name + project). One row per run.
 */
export function RecentAutomationRunsFeed({
  runs,
  setView,
}: {
  runs: AutomationRunWithAutomation[];
  setView: (v: AppUIState["activeView"]) => void;
}) {
  return (
    <div className="space-y-0.5">
      {runs.map((r) => {
        const artifacts = runArtifacts(r);
        const ts = r.finishedAt ?? r.startedAt;
        return (
          <div
            key={r.id}
            className="flex items-center gap-3 w-full px-2 py-1.5 rounded-lg hover:bg-[var(--surface-2)] transition-colors group text-left"
          >
            <Zap size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
            <span className="flex-1 min-w-0 truncate text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors">
              {r.automationName}
            </span>
            {artifacts.length > 0 && (
              <div className="flex gap-1 flex-shrink-0">
                {artifacts.slice(0, 2).map((art) => (
                  <button
                    key={art.id}
                    onClick={() => (art.type === "note" ? revealNote(setView, art.id) : revealCard(setView, art.id))}
                    title={`Open ${art.type === "note" ? "note" : "task"}`}
                    className="inline-flex items-center gap-1 text-[0.714rem] px-1.5 py-0.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors max-w-32"
                  >
                    {art.type === "note"
                      ? <FileText size={10} className="shrink-0" />
                      : <Kanban size={10} className="shrink-0" />}
                    <span className="truncate">{art.title}</span>
                  </button>
                ))}
                {artifacts.length > 2 && (
                  <OverflowPill count={artifacts.length - 2} names={artifacts.slice(2).map((a) => a.title)} />
                )}
              </div>
            )}
            {r.error && (
              <span className="text-[0.714rem] text-[var(--danger)] flex-shrink-0 truncate max-w-40" title={r.error}>{r.error}</span>
            )}
            <span className={cn("text-[0.714rem] font-medium flex-shrink-0 capitalize", RUN_STATUS_COLOR[r.status])}>
              {r.status}
            </span>
            <span className="text-[0.786rem] text-[var(--text-tertiary)] flex-shrink-0 tabular-nums">{formatRelative(ts)}</span>
          </div>
        );
      })}
    </div>
  );
}

export { SectionHeader };
