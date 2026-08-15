"use client";

// Domain-specific sub-components for Project Overview sections.
// All are presentational (no local state, no effects, no store deps).

import React from "react";
import { FileText, Circle, Pin, LayoutDashboard, Zap, Kanban } from "lucide-react";
import { cn, formatRelative, getDueDateStatus, parseIsoLocal } from "@/lib/utils";
import { COLUMN_COLORS, PRIORITY_CSS_COLORS } from "@/lib/constants";
import { revealColumn, revealNote, revealCard } from "@/lib/events";
import { Badge } from "@/components/ui/badge";
import { OverflowPill } from "@/components/ui/overflow-pill";
import { useCairnStore } from "@/store";
import type { TaskCard, Note, BoardColumn, AppUIState } from "@/types";
import type { ActivityGroup } from "./useProjectMetrics";
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

// ── Column stats ────────────────────────────────────────────────────────────

/**
 * Health's column-flow view — ONE representation of the board distribution
 * (replaces the old separate "By column" bars + Board pills, which duplicated
 * the same columns/counts). Each column row shows a proportional bar (same
 * COLUMN_COLORS as before), the count, and the top card titles so it doubles as
 * the board snapshot. Rows are clickable to jump to the column.
 */
export function TaskFlowCard({
  columns, allCards, setView,
}: {
  columns: BoardColumn[];
  allCards: TaskCard[];
  setView: (v: AppUIState["activeView"]) => void;
}) {
  if (columns.length === 0) return null;
  return (
    <div>
      <div className="text-[0.714rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2.5">Task flow</div>
      <div className="space-y-2">
        {columns.map((col) => {
          const cards = allCards.filter((c) => c.columnId === col.id);
          const pct   = allCards.length > 0 ? (cards.length / allCards.length) * 100 : 0;
          const color = COLUMN_COLORS[col.type] ?? COLUMN_COLORS.custom;
          return (
            <button key={col.id}
              onClick={() => revealColumn(setView, col.id)}
              className="flex items-start gap-2.5 w-full group text-left">
              <span className="text-[0.786rem] text-[var(--text-tertiary)] w-20 text-right flex-shrink-0 group-hover:text-[var(--text-secondary)] transition-colors truncate pt-px">{col.name}</span>
              <div className="flex-1 min-w-0">
                <div className="flex h-2 rounded-full bg-[var(--surface-2)] overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
                </div>
                <div className="flex gap-x-3 mt-1 items-center">
                  {cards.slice(0, 2).map((c) => (
                    <span key={c.id} className="text-[0.714rem] text-[var(--text-tertiary)] truncate">{c.title}</span>
                  ))}
                  {cards.length > 2 && (
                    <OverflowPill count={cards.length - 2} names={cards.slice(2).map((c) => c.title)} />
                  )}
                  {cards.length === 0 && <span className="text-[0.714rem] text-[var(--text-tertiary)]">—</span>}
                </div>
              </div>
              <span className="text-[0.786rem] tabular-nums text-[var(--text-tertiary)] w-5 text-right flex-shrink-0">{cards.length}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Collapsed mini-widgets (shown when a section is collapsed) ───────────────

/**
 * The Health section's collapsed representation: a thin stacked bar whose
 * segments are the per-column distribution (same COLUMN_COLORS as the expanded
 * breakdown), with a one-line done/open summary. Hovering a segment shows
 * "Column: N". The note/overdue stats render alongside in the section's
 * collapsed view.
 */
export function MiniHealthBar({
  columns, allCards, doneCount,
}: {
  columns: BoardColumn[];
  allCards: TaskCard[];
  doneCount: number;
}) {
  if (allCards.length === 0) return null;
  const segments = columns
    .map((col) => {
      const count = allCards.filter((c) => c.columnId === col.id).length;
      return { id: col.id, name: col.name, count, color: COLUMN_COLORS[col.type] ?? COLUMN_COLORS.custom };
    })
    .filter((s) => s.count > 0);
  const openCount = allCards.length - doneCount;
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 flex h-2 rounded-full overflow-hidden bg-[var(--surface-2)]">
        {segments.map((s) => (
          <div
            key={s.id}
            title={`${s.name}: ${s.count}`}
            style={{ width: `${(s.count / allCards.length) * 100}%`, backgroundColor: s.color }}
          />
        ))}
      </div>
      <span className="text-[0.714rem] tabular-nums text-[var(--text-secondary)] flex-shrink-0 whitespace-nowrap">
        Done {doneCount} · Open {openCount}
      </span>
    </div>
  );
}

// ── Priority stats ──────────────────────────────────────────────────────────

export function PriorityBreakdownCard({
  priorityCounts, hasAnyCategorised, setView,
}: {
  priorityCounts: { urgent: number; high: number; medium: number; low: number };
  hasAnyCategorised: boolean;
  setView: (v: AppUIState["activeView"]) => void;
}) {
  if (!hasAnyCategorised) return null;
  return (
    <div>
      <div className="text-[0.714rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2.5">Open tasks by priority</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {([
          { key: "urgent", label: "Urgent", color: "var(--danger)",        bg: "color-mix(in srgb, var(--danger) 8%, transparent)" },
          { key: "high",   label: "High",   color: "var(--warning)",       bg: "color-mix(in srgb, var(--warning) 8%, transparent)" },
          { key: "medium", label: "Medium", color: "var(--info)",          bg: "color-mix(in srgb, var(--info) 8%, transparent)" },
          { key: "low",    label: "Low",    color: "var(--text-tertiary)", bg: "var(--surface-2)" },
        ] as const).map(({ key, label, color, bg }) => (
          <button key={key} onClick={() => setView("board")}
            className="rounded-lg p-2.5 text-center border border-[var(--border)] hover:border-[var(--accent)]/30 hover:bg-[var(--surface-2)] transition-all"
            style={{ background: priorityCounts[key] > 0 ? bg : undefined }}>
            <div className="text-lg font-bold leading-none mb-1" style={{ color: priorityCounts[key] > 0 ? color : "var(--text-tertiary)" }}>
              {priorityCounts[key]}
            </div>
            <div className="text-[0.714rem] text-[var(--text-tertiary)]">{label}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Due card ────────────────────────────────────────────────────────────────

export function DueCard({ card, columns, today, onClick }: { card: TaskCard; columns: BoardColumn[]; today: Date; onClick: () => void }) {
  const col = columns.find((c) => c.id === card.columnId);
  // Use the shared, timezone-safe status so a task due today reads "Today"
  // instead of "0d overdue" (a bare yyyy-MM-dd parses to UTC midnight, which
  // can land on the previous local day and skew a raw timestamp comparison).
  const status = getDueDateStatus(card.dueDate);
  const isOverdue = status === "overdue";
  const isToday   = status === "today";
  // Whole-calendar-day difference (local), so the count matches the status.
  // parseIsoLocal keeps a bare yyyy-MM-dd on its local calendar day — using
  // new Date() here would parse it as UTC midnight and shift the count a day
  // earlier in negative-offset timezones (e.g. "2d overdue" for a 1-day gap).
  const due = parseIsoLocal(card.dueDate!);
  due.setHours(0, 0, 0, 0);
  const daysLeft = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  const chipLabel = isOverdue ? `${Math.abs(daysLeft)}d overdue` : isToday ? "Today" : `in ${daysLeft}d`;
  return (
    <button onClick={onClick}
      className={cn("w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all group",
        isOverdue ? "border-[var(--danger)]/25 bg-[var(--surface)] hover:bg-[var(--surface-2)]"
        : isToday  ? "border-[var(--warning)]/30 bg-[var(--surface)] hover:bg-[var(--surface-2)]"
        : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/30 hover:bg-[var(--surface-2)]")}>
      <div className="w-0.5 h-7 rounded-full flex-shrink-0" style={{ background: PRIORITY_CSS_COLORS[card.priority] ?? "var(--text-tertiary)" }} />
      <span className="flex-1 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">{card.title}</span>
      {col && <span className="text-[0.786rem] text-[var(--text-tertiary)] flex-shrink-0">{col.name}</span>}
      <span className={cn("text-[0.714rem] font-semibold px-2 py-0.5 rounded-full flex-shrink-0",
        isOverdue ? "bg-[var(--danger)]/15 text-[var(--danger)]"
        : isToday  ? "bg-[var(--warning)]/15 text-[var(--warning)]"
        : "bg-[var(--accent-dim)] text-[var(--accent)]")}>
        {chipLabel}
      </span>
    </button>
  );
}

// ── Pinned note row ─────────────────────────────────────────────────────────

/**
 * Pinned notes render as compact line items (matching Recent notes) but keep a
 * pin accent so "pinned = important" reads at a glance: an accent bar on the
 * left edge, a pin glyph, title + one-line snippet, tags, and relative time.
 */
export function PinnedNoteCard({ note, onClick }: { note: Note; onClick: () => void }) {
  const getTagById = useCairnStore((s) => s.getTagById);
  const allNoteTags = note.tagIds.map((id) => getTagById(id)).filter(Boolean) as import("@/types").Tag[];
  const noteTags = allNoteTags.slice(0, 2);
  const hiddenNoteTags = allNoteTags.slice(2);
  return (
    <button onClick={onClick}
      className="flex items-center gap-3 w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/40 hover:bg-[var(--surface-2)] transition-colors group text-left">
      <div className="w-0.5 h-7 rounded-full bg-[var(--accent)] flex-shrink-0" />
      <Pin size={11} className="text-[var(--accent)] flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors truncate">{note.title}</div>
        <div className="text-[0.786rem] text-[var(--text-tertiary)] truncate">
          {note.contentText.slice(0, 80) || (note.type === "dashboard" ? "Dashboard" : "Empty note")}
        </div>
      </div>
      {noteTags.length > 0 && (
        <div className="flex gap-1 items-center flex-shrink-0">
          {noteTags.map((tag) => <Badge key={tag.id} color={tag.color} size="xs">{tag.name}</Badge>)}
          {hiddenNoteTags.length > 0 && (
            <OverflowPill count={hiddenNoteTags.length} names={hiddenNoteTags.map((t) => t.name)} />
          )}
        </div>
      )}
      <span className="text-[0.786rem] text-[var(--text-tertiary)] flex-shrink-0 tabular-nums">{formatRelative(note.updatedAt)}</span>
    </button>
  );
}

// ── Note row ────────────────────────────────────────────────────────────────

export function NoteRow({ note, onClick }: { note: Note; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-[var(--surface-2)] transition-colors group text-left">
      {note.type === "dashboard"
        ? <LayoutDashboard size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
        : <FileText size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">{note.title}</div>
        <div className="text-[0.786rem] text-[var(--text-tertiary)] truncate">{note.contentText.slice(0, 80) || (note.type === "dashboard" ? "Dashboard" : "Empty note")}</div>
      </div>
      <span className="text-[0.786rem] text-[var(--text-tertiary)] flex-shrink-0 tabular-nums">{formatRelative(note.updatedAt)}</span>
    </button>
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
