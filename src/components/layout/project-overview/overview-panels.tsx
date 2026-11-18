"use client";

import { useCairnStore } from "@/store";
import { cn, formatRelative } from "@/lib/utils";
import { COLUMN_COLORS } from "@/lib/constants";
import { revealNote } from "@/lib/events";
import { EmptyState } from "@/components/ui/empty-state";
import type { BoardColumn, Note, TaskCard } from "@/types";
import { PanelHeading } from "./primitives";
import type { FocusFilter } from "./focus";

/** Task flow: open/done cards per column as bars, with the bottleneck ringed. */
export function TaskFlowPanel({ flowColumns, focus, filteredCards, allCards, openCards, doneColId, bottleneck }: {
  flowColumns: BoardColumn[];
  focus: FocusFilter;
  filteredCards: TaskCard[];
  allCards: TaskCard[];
  openCards: TaskCard[];
  doneColId: string | undefined;
  bottleneck: { name: string; count: number } | null;
}) {
  return (
    <section>
      <PanelHeading
        title="Task flow"
        note={bottleneck ? `${bottleneck.name} is the bottleneck, ${bottleneck.count} of ${openCards.length} open` : `${openCards.length} open`}
      />
      {flowColumns.length === 0 ? (
        <EmptyState title="No columns yet" className="py-6" />
      ) : (
        <div role="list" aria-label="Tasks by column">
          {flowColumns.map((col, idx) => {
            const sourceCards = focus === "overdue" || focus === "today" ? filteredCards : allCards;
            const sourceOpen = focus === "overdue" || focus === "today" ? filteredCards : openCards;
            const count = sourceCards.filter((c) => c.columnId === col.id).length;
            const isOpen = col.id !== doneColId;
            const denom = isOpen ? sourceOpen.length || 1 : sourceCards.length || 1;
            const pct = isOpen || focus === "overdue" || focus === "today" ? Math.round((count / denom) * 100) : Math.round((count / (allCards.length || 1)) * 100);
            const color = COLUMN_COLORS[col.type] ?? COLUMN_COLORS.custom;
            const isBottleneck = bottleneck?.name === col.name && focus === "all";
            const hasFiltered = focus !== "all" && count === 0 && focus !== "pinned";
            return (
              <div
                key={col.id}
                role="listitem"
                className={cn(
                  "w-full flex items-center gap-2.5 py-2",
                  idx !== 0 && "border-t border-[var(--border)]/60",
                  hasFiltered && "opacity-40",
                )}
              >
                <span className="w-24 text-right text-xs font-medium truncate flex-shrink-0 text-[var(--text-secondary)]">
                  {col.name}
                </span>
                <span
                  className={cn(
                    "flex-1 min-w-0 h-[26px] rounded-full bg-[var(--surface-2)] border overflow-hidden flex items-center p-[3px]",
                    isBottleneck ? "border-[var(--warning)]/60" : "border-[var(--border-subtle)]",
                  )}
                >
                  <span
                    className="h-full rounded-full flex items-center justify-end pr-1.5 text-2xs font-bold text-white min-w-[22px]"
                    style={{
                      width: `${Math.max(pct, count > 0 ? 8 : 0)}%`,
                      background: color,
                      transition: "width .7s cubic-bezier(.4,0,.2,1)",
                    }}
                  >
                    {pct > 16 ? count : ""}
                  </span>
                </span>
                <span className="w-7 text-right text-xs font-mono text-[var(--text-tertiary)] tabular-nums">{count}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap gap-3 mt-3 text-2xs text-[var(--text-tertiary)]">
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COLUMN_COLORS.backlog }} /> Backlog</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COLUMN_COLORS.todo }} /> Todo</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COLUMN_COLORS.in_progress }} /> In Progress</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COLUMN_COLORS.review }} /> Review</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COLUMN_COLORS.done }} /> Done</span>
      </div>
    </section>
  );
}

/** Open cards by priority, plus the In Progress WIP limit. */
export function PriorityPanel({ counts, inProgressCount, wipLimit, wipStatus }: {
  counts: { urgent: number; high: number; medium: number; low: number };
  inProgressCount: number;
  wipLimit: number | undefined;
  wipStatus: string | null;
}) {
  return (
    <section>
      <PanelHeading title="Open by priority" />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(5.5rem,1fr))] gap-x-4 gap-y-4">
        {(
          [
            { key: "urgent", label: "Urgent", color: "var(--danger)" },
            { key: "high", label: "High", color: "var(--warning)" },
            { key: "medium", label: "Medium", color: "var(--info)" },
            { key: "low", label: "Low", color: "var(--text-tertiary)" },
          ] as const
        ).map(({ key, label, color }) => {
          const n = counts[key as keyof typeof counts] ?? 0;
          return (
            <div key={key} className="min-w-0">
              <div className="font-display text-3xl leading-none tabular-nums" style={{ color: n > 0 ? "var(--text-primary)" : "var(--text-tertiary)" }}>
                {n}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] mt-1.5">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} aria-hidden="true" />
                {label}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-5 pt-2.5 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-[var(--text-tertiary)]">
        <span>{inProgressCount} in progress</span>
        <span className="text-[var(--text-secondary)]">
          {wipLimit ? (
            <>
              Limit {wipLimit},{" "}
              <span className={wipStatus === "over" ? "text-[var(--danger)]" : wipStatus === "at limit" ? "text-[var(--warning)]" : "text-[var(--success)]"}>
                {wipStatus}
              </span>
            </>
          ) : (
            "No WIP limit set"
          )}
        </span>
      </div>
    </section>
  );
}

/** Pinned and recent notes, with a link to the Notes view. */
export function NotesSummaryPanel({ notesCount, pinnedNotes, recentNotes }: {
  notesCount: number;
  pinnedNotes: Note[];
  recentNotes: Note[];
}) {
  const setView = useCairnStore((s) => s.setView);
  const row = (note: Note, tone: "primary" | "secondary") => (
    <li key={note.id} className="border-b border-[var(--border-subtle)] last:border-0">
      <button type="button" onClick={() => revealNote(setView, note.id)} className="flex w-full items-center gap-3 py-2 text-left group">
        <span className="flex-1 min-w-0">
          <span className={cn("block text-sm font-medium truncate group-hover:text-[var(--accent)]", tone === "primary" ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]")}>{note.title}</span>
          <span className="block text-xs text-[var(--text-tertiary)] truncate">{note.contentText.slice(0, 64) || "Empty note"}</span>
        </span>
        <span className="text-xs tabular-nums text-[var(--text-tertiary)] flex-shrink-0 hidden sm:inline">{formatRelative(note.updatedAt)}</span>
      </button>
    </li>
  );
  return (
    <section>
      <PanelHeading
        title="Notes"
        note={`${notesCount} total${pinnedNotes.length > 0 ? `, ${pinnedNotes.length} pinned` : ""}`}
        action={<button type="button" onClick={() => setView("notes")} className="text-xs text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors">Open notes</button>}
      />
      {notesCount === 0 ? (
        <EmptyState title="No notes yet — capture ideas to see them here" className="py-6" />
      ) : (
        <div className="grid grid-cols-1 @2xl:grid-cols-2 gap-x-8 gap-y-4">
          <div>
            <div className="text-xs font-medium text-[var(--text-secondary)] mb-1">Pinned</div>
            {pinnedNotes.length === 0 ? (
              <p className="text-xs text-[var(--text-tertiary)] py-3">No pinned notes</p>
            ) : (
              <ul className="list-none m-0 p-0">{pinnedNotes.slice(0, 3).map((n) => row(n, "primary"))}</ul>
            )}
          </div>
          <div>
            <div className="text-xs font-medium text-[var(--text-secondary)] mb-1">Recent</div>
            {recentNotes.length === 0 ? (
              <p className="text-xs text-[var(--text-tertiary)] py-3">No recent notes</p>
            ) : (
              <ul className="list-none m-0 p-0">{recentNotes.slice(0, 4).map((n) => row(n, "secondary"))}</ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
