"use client";

// The Overview's lighter detail levels. "Full" is the panel stack in index.tsx;
// Glance and Brief restate the same numbers at a lower resolution rather than
// hiding sections: the KPI strip becomes a sentence, the per-column flow bars
// become one stacked bar.

import React from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Diamond, Hexagon, Kanban } from "lucide-react";
import { cn, plural } from "@/lib/utils";
import { COLUMN_COLORS, type OverviewDetail } from "@/lib/constants";
import { revealCard } from "@/lib/events";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionLabel } from "@/components/ui/labels";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SessionBrowser } from "@/components/agent/SessionBrowser";
import type { AppUIState, BoardColumn, TaskCard } from "@/types";
import type { AttentionItem, AttentionTone } from "../../../../shared/overview/attention";
import { SectionHeader } from "./primitives";
import { ShippedFeed } from "./sections";
import { RadarChart, type RadarAxis } from "./radar";

type SetView = (v: AppUIState["activeView"]) => void;
type Bottleneck = { name: string; count: number } | null;

const DETAIL_OPTIONS: { value: OverviewDetail; label: string }[] = [
  { value: "glance", label: "Glance" },
  { value: "brief", label: "Brief" },
  { value: "full", label: "Full" },
];
const DETAIL_HINT: Record<OverviewDetail, string> = {
  glance: "What needs you now",
  brief: "The week on one screen",
  full: "Every panel",
};

/** The Glance / Brief / Full switch, with a one-line hint of what the level shows. */
export function DetailSwitch({ value, onChange }: { value: OverviewDetail; onChange: (v: OverviewDetail) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <SectionLabel>{DETAIL_HINT[value]}</SectionLabel>
      <SegmentedControl ariaLabel="Overview detail" size="sm" options={DETAIL_OPTIONS} value={value} onChange={onChange} />
    </div>
  );
}

const PANEL = "rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-elev-1 p-4";

const TONE_COLOR: Record<AttentionTone, string> = {
  overdue: "var(--danger)",
  today: "var(--warning)",
  blocked: "var(--warning)",
  stale: "var(--text-tertiary)",
};

function TonePill({ tone, label }: { tone: AttentionTone; label: string }) {
  return (
    <span
      className="text-2xs font-medium px-1.5 py-0.5 rounded-md flex-shrink-0 whitespace-nowrap"
      style={{ color: TONE_COLOR[tone], background: `color-mix(in srgb, ${TONE_COLOR[tone]} 14%, transparent)` }}
    >
      {label}
    </span>
  );
}

/** Cards needing attention, one row each: main reason, title, other reasons, column. */
function AttentionList({ items, columns, setView }: { items: AttentionItem<TaskCard>[]; columns: BoardColumn[]; setView: SetView }) {
  return (
    <div className="space-y-0.5">
      {items.map(({ card, tags }) => (
        <button
          key={card.id}
          type="button"
          onClick={() => revealCard(setView, card.id)}
          className={cn("flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg hover:bg-[var(--surface-2)] transition-colors group text-left", FOCUS_RING)}
        >
          <TonePill {...tags[0]} />
          <span className="flex-1 min-w-0 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">{card.title}</span>
          {tags.slice(1).map((t) => <TonePill key={t.tone} {...t} />)}
          <span className="hidden @md:inline text-xs text-[var(--text-tertiary)] flex-shrink-0">
            {columns.find((c) => c.id === card.columnId)?.name}
          </span>
        </button>
      ))}
    </div>
  );
}

function ProgressHairline({ pct }: { pct: number }) {
  return (
    <div className="h-0.5 rounded-full bg-[var(--surface-3)] overflow-hidden" role="progressbar" aria-label="Completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%`, transition: "width .6s cubic-bezier(.4,0,.2,1)" }} />
    </div>
  );
}

// ── Glance ──────────────────────────────────────────────────────────────────

export interface OverviewGlanceProps {
  pct: number;
  totalCount: number;
  openCount: number;
  overdueCount: number;
  todayCount: number;
  bottleneck: Bottleneck;
  attention: AttentionItem<TaskCard>[];
  columns: BoardColumn[];
  shippedCount: number;
  notesCount: number;
  radarAxes: RadarAxis[];
  setView: SetView;
  onOpenSessions: () => void;
  onMore: () => void;
}

/** One sentence of status, the three cards that need you, and quiet links out. */
export function OverviewGlance({
  pct, totalCount, openCount, overdueCount, todayCount, bottleneck, attention, columns,
  shippedCount, notesCount, radarAxes, setView, onOpenSessions, onMore,
}: OverviewGlanceProps) {
  const strong = "font-semibold text-[var(--text-primary)]";
  const quiet = cn("rounded text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors", FOCUS_RING);
  const next = attention.slice(0, 3);
  return (
    // The page keeps one width at every level so the switch stays put; Glance
    // caps its text to a readable measure and the health radar takes the rest
    // (below the text when the pane is narrow).
    <div className="flex flex-col @4xl:flex-row gap-8 @4xl:gap-12 items-start">
    <div className="w-full max-w-[720px] min-w-0">
      <ProgressHairline pct={pct} />
      <p className="text-xl leading-relaxed text-[var(--text-secondary)] mt-5 mb-5 text-pretty" style={{ fontFamily: "var(--font-display)" }}>
        {totalCount === 0 ? (
          "No tasks yet. Add cards to the board to see where this project stands."
        ) : openCount === 0 ? (
          <><span className={strong}>Everything is done</span>, all {plural(totalCount, "card")}.</>
        ) : (
          <>
            <span className={strong}>{pct}%</span> done with <span className={strong}>{plural(openCount, "card")}</span> open.{" "}
            {overdueCount > 0 && (
              <span className="font-semibold text-[var(--danger)]">{overdueCount} {overdueCount === 1 ? "is" : "are"} overdue</span>
            )}
            {overdueCount > 0 && todayCount > 0 && " and "}
            {todayCount > 0 && (
              <span className="font-semibold text-[var(--warning)]">{todayCount} {todayCount === 1 ? "is" : "are"} due today</span>
            )}
            {overdueCount > 0 || todayCount > 0 ? ". " : "Nothing is overdue. "}
            {bottleneck && (
              <>{bottleneck.name} is backing up with <span className={strong}>{bottleneck.count}</span> waiting.</>
            )}
          </>
        )}
      </p>

      {next.length > 0 && (
        <>
          <SectionLabel className="block px-2 mb-1.5">Next up</SectionLabel>
          <AttentionList items={next} columns={columns} setView={setView} />
        </>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-4 px-2 text-xs">
        <button type="button" className={quiet} onClick={() => setView("board")}>{shippedCount} shipped this week</button>
        <button type="button" className={quiet} onClick={() => setView("notes")}>{plural(notesCount, "note")}</button>
        <button type="button" className={quiet} onClick={onOpenSessions}>Recent sessions</button>
      </div>

      <Button variant="outline" size="sm" className="mt-6 rounded-full" onClick={onMore}>
        See the week <ArrowRight size={11} />
      </Button>
    </div>
    {totalCount > 0 && (
      <div className="w-full max-w-[340px] aspect-square mx-auto @4xl:mx-0 @4xl:ml-auto flex-shrink-0 px-8">
        <RadarChart axes={radarAxes} />
      </div>
    )}
    </div>
  );
}

// ── Brief ───────────────────────────────────────────────────────────────────

function Stat({ label, value, unit, first }: { label: string; value: React.ReactNode; unit: string; first?: boolean }) {
  return (
    <div className={cn("flex-1 basis-1/2 @2xl:basis-0 min-w-0 px-3.5 py-2.5", !first && "@2xl:border-l border-[var(--border)]")}>
      <SectionLabel>{label}</SectionLabel>
      <div className="text-lg font-bold tracking-tight leading-tight mt-0.5 flex items-baseline gap-1.5 tabular-nums whitespace-nowrap">
        {value}
        <span className="text-xs font-medium text-[var(--text-tertiary)] truncate">{unit}</span>
      </div>
    </div>
  );
}

/** Every column as one stacked bar, sized by card count. */
function FlowBar({ columns, cards }: { columns: BoardColumn[]; cards: TaskCard[] }) {
  const rows = columns.map((col) => ({
    col,
    count: cards.filter((c) => c.columnId === col.id).length,
    color: COLUMN_COLORS[col.type] ?? COLUMN_COLORS.custom,
  }));
  const summary = rows.map((r) => `${r.col.name} ${r.count}`).join(", ");
  return (
    <>
      <div className="flex h-2.5 gap-0.5 rounded-full overflow-hidden bg-[var(--surface-3)]" role="img" aria-label={`Cards by column: ${summary}`}>
        {rows.filter((r) => r.count > 0).map((r) => (
          <span key={r.col.id} style={{ flexGrow: r.count, flexBasis: 0, background: r.color }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 text-xs text-[var(--text-secondary)]">
        {rows.map((r) => (
          <span key={r.col.id} className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.color }} aria-hidden="true" />
            {r.col.name}
            <span className="font-mono font-semibold text-[var(--text-primary)] tabular-nums">{r.count}</span>
          </span>
        ))}
      </div>
    </>
  );
}

export interface OverviewBriefProps {
  pct: number;
  doneCount: number;
  totalCount: number;
  openCount: number;
  needsAttention: number;
  notesCount: number;
  bottleneck: Bottleneck;
  attention: AttentionItem<TaskCard>[];
  /** Columns in flow order (done last). */
  columns: BoardColumn[];
  cards: TaskCard[];
  shippedCards: TaskCard[];
  inProgressCount: number;
  wipLimit: number | undefined;
  radarAxes: RadarAxis[];
  activeSessionId: string | null;
  setView: SetView;
  onOpenSessions: () => void;
  onMore: () => void;
}

const ATTENTION_LIMIT = 6;

/** Four numbers, what needs attention next to what shipped, one flow bar, recent sessions. */
export function OverviewBrief({
  pct, doneCount, totalCount, openCount, needsAttention, notesCount, bottleneck, attention, columns, cards,
  shippedCards, inProgressCount, wipLimit, radarAxes, activeSessionId, setView, onOpenSessions, onMore,
}: OverviewBriefProps) {
  const hiddenAttention = attention.length - ATTENTION_LIMIT;
  return (
    <div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-elev-1 flex flex-wrap mb-3.5">
        <Stat first label="Needs attention" value={needsAttention} unit={`/ ${openCount}`} />
        <Stat label="Completion" value={`${pct}%`} unit={`${doneCount}/${totalCount}`} />
        <Stat label="Knowledge" value={notesCount} unit={notesCount === 1 ? "note" : "notes"} />
        <Stat label="Bottleneck" value={bottleneck ? bottleneck.count : "—"} unit={bottleneck ? `in ${bottleneck.name}` : "none"} />
      </div>

      <div className="grid grid-cols-1 @4xl:grid-cols-2 gap-3.5 mb-3.5 [&>*]:min-w-0">
        <section className={PANEL}>
          <SectionHeader title="Needs attention" icon={<AlertTriangle size={12} />} action={{ label: "Open board", onClick: () => setView("board") }} />
          {attention.length === 0 ? (
            <EmptyState title="Nothing overdue, due today, blocked or stale" className="py-4" />
          ) : (
            <>
              <AttentionList items={attention.slice(0, ATTENTION_LIMIT)} columns={columns} setView={setView} />
              {hiddenAttention > 0 && (
                <p className="text-xs text-[var(--text-tertiary)] mt-2 px-2">and {hiddenAttention} more on the board</p>
              )}
            </>
          )}
        </section>
        <section className={PANEL}>
          <SectionHeader title="Shipped this week" icon={<CheckCircle2 size={12} />} />
          {shippedCards.length === 0 ? (
            <EmptyState title="Nothing finished in the last 7 days" className="py-4" />
          ) : (
            <div className="max-h-[240px] overflow-y-auto pr-1 -mr-1">
              <ShippedFeed cards={shippedCards} columnName={(id) => columns.find((c) => c.id === id)?.name} setView={setView} />
            </div>
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 @4xl:grid-cols-[1.55fr_0.95fr] gap-3.5 [&>*]:min-w-0">
      <div>
      <section className={cn(PANEL, "mb-3.5")}>
        <SectionHeader title="Task flow" icon={<Kanban size={12} />} />
        {columns.length === 0 ? (
          <EmptyState title="No columns yet" className="py-4" />
        ) : (
          <FlowBar columns={columns} cards={cards} />
        )}
        {wipLimit !== undefined && wipLimit > 0 && inProgressCount >= wipLimit && (
          <p className="text-xs text-[var(--text-tertiary)] mt-2.5">
            In progress is at <span className="font-semibold text-[var(--warning)]">{inProgressCount} of {wipLimit}</span>
            {inProgressCount > wipLimit ? ", over the WIP limit." : ", at the WIP limit."}
          </p>
        )}
      </section>

      <section className={PANEL}>
        <SectionHeader title="Recent sessions" icon={<Diamond size={12} />} action={{ label: "Open sessions", onClick: onOpenSessions }} />
        <SessionBrowser variant="preview" limit={2} activeSessionId={activeSessionId} />
      </section>
      </div>
      <section className={cn(PANEL, "flex flex-col")}>
        <SectionHeader title="Project health" icon={<Hexagon size={12} />} />
        <div className="flex-1 grid place-items-center">
          <div className="w-full max-w-[320px] aspect-square px-8">
            <RadarChart axes={radarAxes} />
          </div>
        </div>
      </section>
      </div>

      <Button variant="outline" size="sm" className="mt-5 rounded-full" onClick={onMore}>
        Every panel <ArrowRight size={11} />
      </Button>
    </div>
  );
}
