"use client";

import { AlertTriangle, FileText, LayoutDashboard, Pin } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn, formatRelative } from "@/lib/utils";
import { COLUMN_COLORS } from "@/lib/constants";
import { revealNote } from "@/lib/events";
import { EmptyState } from "@/components/ui/empty-state";
import type { BoardColumn, Note, TaskCard } from "@/types";
import { TiltCard } from "./tilt-card";
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
    <TiltCard
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 md:p-[18px]"
      restShadow="0 8px 24px color-mix(in srgb, black 14%, transparent)"
      activeShadow="0 14px 32px color-mix(in srgb, black 24%, transparent), inset 0 1px 0 color-mix(in srgb, white 4%, transparent)"
    >
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-[0.813rem] font-semibold tracking-tight flex items-center gap-2">
          <span className="w-5 h-5 rounded-md grid place-items-center bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-tertiary)] text-[0.625rem] leading-none">
            ▦
          </span>
          Task flow{" "}
          <span className="font-normal text-[var(--text-tertiary)] text-xs">
            — {bottleneck ? `${bottleneck.name} is the bottleneck (${bottleneck.count} of ${openCards.length} open)` : `${openCards.length} open`}
          </span>
        </h2>
      </div>
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
                    isBottleneck ? "border-[var(--warning)]/50 ring-1 ring-[var(--warning)]/25" : "border-[var(--border)]",
                  )}
                >
                  <span
                    className="h-full rounded-full flex items-center justify-end pr-1.5 text-[0.643rem] font-bold text-white min-w-[22px]"
                    style={{
                      width: `${Math.max(pct, count > 0 ? 8 : 0)}%`,
                      background: color,
                      transition: "width .7s cubic-bezier(.4,0,.2,1)",
                      boxShadow: isBottleneck ? "0 0 10px color-mix(in srgb, var(--warning) 35%, transparent)" : undefined,
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
      <div className="flex flex-wrap gap-3 mt-3 text-[0.643rem] text-[var(--text-tertiary)]">
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COLUMN_COLORS.backlog }} /> Backlog</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COLUMN_COLORS.todo }} /> Todo</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COLUMN_COLORS.in_progress }} /> In Progress</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COLUMN_COLORS.review }} /> Review</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COLUMN_COLORS.done }} /> Done</span>
      </div>
    </TiltCard>
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
    <TiltCard
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 md:p-[18px]"
      restShadow="0 8px 24px color-mix(in srgb, black 14%, transparent)"
      activeShadow="0 14px 32px color-mix(in srgb, black 24%, transparent), inset 0 1px 0 color-mix(in srgb, white 4%, transparent)"
    >
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-[0.813rem] font-semibold tracking-tight flex items-center gap-2">
          <span className="w-5 h-5 rounded-md grid place-items-center bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-tertiary)]">
            <AlertTriangle size={10} />
          </span>
          Open by priority
        </h2>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {(
          [
            { key: "urgent", label: "Urgent", color: "var(--danger)", bg: "color-mix(in srgb,var(--danger) 12%, transparent)" },
            { key: "high", label: "High", color: "var(--warning)", bg: "color-mix(in srgb,var(--warning) 12%, transparent)" },
            { key: "medium", label: "Medium", color: "var(--info)", bg: "color-mix(in srgb,var(--info) 12%, transparent)" },
            { key: "low", label: "Low", color: "var(--text-tertiary)", bg: "var(--surface-2)" },
          ] as const
        ).map(({ key, label, color, bg }) => {
          
          const n = counts[key as keyof typeof counts] ?? 0;
          const active = n > 0;
          return (
            <div
              key={key}
              className="rounded-xl border p-3.5 text-center"
              style={{
                background: bg,
                borderColor: active ? (color === "var(--text-tertiary)" ? "var(--border)" : color) : "var(--border)",
                boxShadow: active && color !== "var(--text-tertiary)" ? `inset 0 1px 0 color-mix(in srgb, white 6%, transparent)` : undefined,
              }}
            >
              <div className="text-[1.35rem] font-bold leading-none tracking-tight" style={{ color: active ? color : "var(--text-tertiary)" }}>
                {n}
              </div>
              <div className="text-[0.625rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)] mt-1">{label}</div>
              <div className="text-[0.688rem] text-[var(--text-tertiary)] mt-0.5">{n ? `${n} open` : "—"}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs text-[var(--text-tertiary)]">
        <span>WIP — {inProgressCount} in progress</span>
        <span className="font-semibold text-[var(--text-primary)]">
          {wipLimit ? (
            <>
              Limit {wipLimit} ·{" "}
              <span className={wipStatus === "over" ? "text-[var(--danger)]" : wipStatus === "at limit" ? "text-[var(--warning)]" : "text-[var(--success)]"}>
                {wipStatus}
              </span>
            </>
          ) : (
            <span className="text-[var(--text-tertiary)]">No limit</span>
          )}
        </span>
      </div>
    </TiltCard>
  );
}

/** Pinned and recent notes, with a link to the Notes view. */
export function NotesSummaryPanel({ notesCount, pinnedNotes, recentNotes }: {
  notesCount: number;
  pinnedNotes: Note[];
  recentNotes: Note[];
}) {
  const setView = useCairnStore((s) => s.setView);
  return (
    <TiltCard
      className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-4 md:p-[16px]"
      restShadow="0 4px 14px color-mix(in srgb, black 12%, transparent)"
      activeShadow="0 12px 28px color-mix(in srgb, black 18%, transparent)"
    >
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-[0.813rem] font-semibold flex items-center gap-2">
          <span className="w-5 h-5 rounded-md grid place-items-center bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-tertiary)]">
            <FileText size={10} />
          </span>
          Notes
          <span className="font-normal text-[var(--text-tertiary)] text-xs">
            · {notesCount} total{pinnedNotes.length > 0 ? ` · ${pinnedNotes.length} pinned` : ""} · {recentNotes.length} recent
          </span>
        </h2>
        <button type="button" onClick={() => setView("notes")} className="text-xs font-semibold text-[var(--accent)] hover:text-[var(--accent-hover)]">
          Open notes →
        </button>
      </div>
      {notesCount === 0 ? (
        <EmptyState title="No notes yet — capture ideas to see them here" className="py-6" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <div className="text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)] mb-2 flex items-center gap-1.5">
              <Pin size={10} /> Pinned · keeps focus
            </div>
            {pinnedNotes.length === 0 ? (
              <p className="text-xs text-[var(--text-tertiary)] py-3">No pinned notes</p>
            ) : (
              <ul className="list-none m-0 p-0">
                {pinnedNotes.slice(0, 3).map((note) => (
                  <li key={note.id} className="flex gap-2.5 items-center py-2 border-b border-[var(--border)]/60 last:border-0">
                    <span className="w-6 h-6 rounded-md grid place-items-center bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-tertiary)] flex-shrink-0">
                      <Pin size={10} />
                    </span>
                    <button type="button" onClick={() => revealNote(setView, note.id)} className="flex-1 min-w-0 text-left group">
                      <span className="block text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] truncate">{note.title}</span>
                      <span className="block text-xs text-[var(--text-tertiary)] truncate">{note.contentText.slice(0, 64) || "Empty note"}</span>
                    </button>
                    <span className="text-xs font-mono text-[var(--text-tertiary)] flex-shrink-0 hidden sm:inline">{formatRelative(note.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)] mb-2 flex items-center gap-1.5">
              <FileText size={10} /> Recent
            </div>
            {recentNotes.length === 0 ? (
              <p className="text-xs text-[var(--text-tertiary)] py-3">No recent notes</p>
            ) : (
              <ul className="list-none m-0 p-0">
                {recentNotes.slice(0, 4).map((note) => (
                  <li key={note.id} className="flex gap-2.5 items-center py-2 border-b border-[var(--border)]/60 last:border-0">
                    <span className="w-6 h-6 rounded-md grid place-items-center bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-tertiary)] flex-shrink-0">
                      {note.type === "dashboard" ? <LayoutDashboard size={10} /> : <FileText size={10} />}
                    </span>
                    <button type="button" onClick={() => revealNote(setView, note.id)} className="flex-1 min-w-0 text-left group">
                      <span className="block text-sm font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] truncate">{note.title}</span>
                      <span className="block text-xs text-[var(--text-tertiary)] truncate">{note.contentText.slice(0, 64) || (note.type === "dashboard" ? "Dashboard" : "Empty note")}</span>
                    </button>
                    <span className="text-xs font-mono text-[var(--text-tertiary)] flex-shrink-0 hidden sm:inline">{formatRelative(note.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </TiltCard>
  );
}
