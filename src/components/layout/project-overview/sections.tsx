"use client";

// Domain-specific sub-components for Project Overview sections.
// All are presentational (no local state, no effects, no store deps).

import React from "react";
import { FileText, Circle, Pin, LayoutDashboard } from "lucide-react";
import { cn, formatRelative, getDueDateStatus, parseIsoLocal } from "@/lib/utils";
import { COLUMN_COLORS, PRIORITY_CSS_COLORS } from "@/lib/constants";
import { revealColumn } from "@/lib/events";
import { Badge } from "@/components/ui/badge";
import { useCairnStore } from "@/store";
import type { TaskCard, Note, BoardColumn, AppUIState } from "@/types";
import type { ActivityGroup } from "./useProjectMetrics";
import { SectionHeader } from "./primitives";

// ── Column stats ────────────────────────────────────────────────────────────

export function ColumnBreakdownCard({
  columns, allCards, setView,
}: {
  columns: BoardColumn[];
  allCards: TaskCard[];
  setView: (v: AppUIState["activeView"]) => void;
}) {
  if (columns.length === 0) return null;
  return (
    <div>
      <div className="text-[0.714rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2.5">By column</div>
      <div className="space-y-1.5">
        {columns.map((col) => {
          const count = allCards.filter((c) => c.columnId === col.id).length;
          const pct   = allCards.length > 0 ? (count / allCards.length) * 100 : 0;
          const color = COLUMN_COLORS[col.type] ?? COLUMN_COLORS.custom;
          return (
            <button key={col.id}
              onClick={() => revealColumn(setView, col.id)}
              className="flex items-center gap-2.5 w-full group">
              <span className="text-[0.786rem] text-[var(--text-tertiary)] w-20 text-right flex-shrink-0 group-hover:text-[var(--text-secondary)] transition-colors truncate">{col.name}</span>
              <div className="flex-1 h-2 rounded-full bg-[var(--surface-2)] overflow-hidden">
                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
              </div>
              <span className="text-[0.786rem] tabular-nums text-[var(--text-tertiary)] w-5 text-right flex-shrink-0">{count}</span>
            </button>
          );
        })}
      </div>
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

// ── Column pill ──────────────────────────────────────────────────────────────

export function ColumnPill({ column, cards, onClick }: { column: BoardColumn; cards: TaskCard[]; onClick: () => void }) {
  const color = COLUMN_COLORS[column.type] ?? COLUMN_COLORS.custom;
  const isDone = column.type === "done";
  const isInProgress = column.type === "in_progress";
  return (
    <button onClick={onClick}
      className={cn("flex-1 min-w-[110px] max-w-[180px] rounded-xl border p-3 text-left transition-all hover:border-[var(--accent)]/40 hover:bg-[var(--surface-2)] flex-shrink-0",
        isInProgress ? "border-[var(--warning)]/30 bg-[var(--surface)]" : "border-[var(--border)] bg-[var(--surface)]")}>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
        <span className="text-[0.714rem] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider truncate">{column.name}</span>
      </div>
      <div className="text-xl font-bold mb-1.5 leading-none"
        style={{ color: isDone ? "var(--success)" : isInProgress ? "var(--warning)" : "var(--text-primary)" }}>
        {cards.length}
      </div>
      <div className="space-y-0.5">
        {cards.slice(0, 2).map((c) => (
          <div key={c.id} className="text-[0.75rem] text-[var(--text-tertiary)] truncate leading-snug">{c.title}</div>
        ))}
        {cards.length === 0 && <div className="text-[0.75rem] text-[var(--text-tertiary)]">—</div>}
      </div>
    </button>
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

// ── Pinned note card ────────────────────────────────────────────────────────

export function PinnedNoteCard({ note, onClick }: { note: Note; onClick: () => void }) {
  const getTagById = useCairnStore((s) => s.getTagById);
  const noteTags = note.tagIds.slice(0, 2).map((id) => getTagById(id)).filter(Boolean) as import("@/types").Tag[];
  return (
    <button onClick={onClick}
      className="p-4 rounded-xl border border-[var(--accent)]/20 bg-[var(--surface)] hover:bg-[var(--surface-2)] text-left transition-all w-full group">
      <div className="flex items-center gap-1 mb-2">
        <Pin size={9} className="text-[var(--accent)]" />
        <span className="text-[0.714rem] text-[var(--accent)] font-medium">Pinned</span>
      </div>
      <div className="text-sm font-semibold text-[var(--text-primary)] mb-1.5 truncate group-hover:text-[var(--accent)] transition-colors">{note.title}</div>
      <div className="text-[11.5px] text-[var(--text-tertiary)] line-clamp-2 leading-relaxed mb-3">
        {note.contentText.slice(0, 120) || (note.type === "dashboard" ? "Dashboard" : "Empty note")}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[0.714rem] text-[var(--text-tertiary)]">{formatRelative(note.updatedAt)}</span>
        <div className="flex gap-1">
          {noteTags.map((tag) => <Badge key={tag.id} color={tag.color}>{tag.name}</Badge>)}
        </div>
      </div>
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

export { SectionHeader };
