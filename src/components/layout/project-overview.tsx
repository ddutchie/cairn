"use client";

import React from "react";
import {
  FileText,
  Kanban,
  Calendar,
  Pin,
  ArrowRight,
  Clock,
  AlertCircle,
  Activity,
  Circle,
  BarChart2,
} from "lucide-react";
import { useCairnStore } from "@/store";
import { ProjectIcon } from "@/lib/workspace-icons";
import { cn, formatDate, formatRelative, STATUS_COLORS, getDueDateStatus } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TaskCard, Note, BoardColumn } from "@/types";

const COLUMN_TYPE_ORDER = ["backlog", "todo", "in_progress", "review", "done"];

const COLUMN_COLORS: Record<string, string> = {
  backlog:     "#666360",
  todo:        "#60a5fa",
  in_progress: "#f59e0b",
  review:      "#a78bfa",
  done:        "#3ecf8e",
  custom:      "#9ca3af",
};

const PRIORITY_STRIPE: Record<string, string> = {
  urgent: "var(--danger)",
  high:   "var(--danger)",
  medium: "var(--accent)",
  low:    "var(--text-tertiary)",
};

export function ProjectOverview() {
  const {
    activeProjectId,
    projects,
    getProjectNotes,
    getProjectColumns,
    getProjectCards,
    getColumnCards,
    getTagById,
    setView,
    tags,
  } = useCairnStore();

  const project = projects.find((p) => p.id === activeProjectId);
  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-[var(--text-tertiary)]">
          <Kanban size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">Select a project to get started</p>
        </div>
      </div>
    );
  }

  const notes      = getProjectNotes(project.id);
  const columns    = getProjectColumns(project.id).sort(
    (a, b) => COLUMN_TYPE_ORDER.indexOf(a.type) - COLUMN_TYPE_ORDER.indexOf(b.type)
  );
  const allCards   = getProjectCards(project.id);

  const doneCol    = columns.find((c) => c.type === "done");
  const doneCards  = doneCol ? getColumnCards(doneCol.id) : [];
  const openCards  = allCards.filter((c) => c.columnId !== doneCol?.id);

  const completionRate = allCards.length > 0
    ? Math.round((doneCards.length / allCards.length) * 100)
    : 0;

  // Due soon — overdue + due within 7 days, excluding done column
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in7Days = new Date(today);
  in7Days.setDate(today.getDate() + 7);

  const dueCards = openCards
    .filter((c) => c.dueDate)
    .filter((c) => new Date(c.dueDate!) <= in7Days)
    .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime());

  const overdueCount = dueCards.filter((c) => new Date(c.dueDate!) < today).length;

  // Priority breakdown across all open tasks
  const priorityCounts = {
    urgent: openCards.filter((c) => c.priority === "urgent").length,
    high:   openCards.filter((c) => c.priority === "high").length,
    medium: openCards.filter((c) => c.priority === "medium").length,
    low:    openCards.filter((c) => c.priority === "low").length,
  };
  const hasAnyCategorised = Object.values(priorityCounts).some((n) => n > 0);

  const pinnedNotes  = notes.filter((n) => n.isPinned);
  const recentNotes  = notes.filter((n) => !n.isPinned).slice(0, 5);

  const projectTags  = project.tagIds.map((tid) => getTagById(tid)).filter(Boolean);

  // Recent activity — notes + cards sorted by updatedAt, grouped by day
  type ActivityItem = {
    id: string;
    type: "note" | "card";
    title: string;
    subtitle: string | null;
    updatedAt: string;
    onClick: () => void;
  };
  const activityItems: ActivityItem[] = [
    ...notes.map((n) => ({
      id: n.id, type: "note" as const,
      title: n.title, subtitle: null,
      updatedAt: n.updatedAt,
      onClick: () => {
        setView("notes");
        window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: n.id } }));
      },
    })),
    ...allCards.map((c) => {
      const col = columns.find((col) => col.id === c.columnId);
      return {
        id: c.id, type: "card" as const,
        title: c.title, subtitle: col?.name ?? null,
        updatedAt: c.updatedAt,
        onClick: () => {
          setView("board");
          window.dispatchEvent(new CustomEvent("cairn:open-card", { detail: { cardId: c.id } }));
        },
      };
    }),
  ].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
   .slice(0, 20);

  // Group by day label
  function dayLabel(iso: string): string {
    const d = new Date(iso);
    d.setHours(0, 0, 0, 0);
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const diff = Math.round((now.getTime() - d.getTime()) / 86_400_000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  const activityByDay: { label: string; items: ActivityItem[] }[] = [];
  for (const item of activityItems) {
    const label = dayLabel(item.updatedAt);
    const group = activityByDay.find((g) => g.label === label);
    if (group) group.items.push(item);
    else activityByDay.push({ label, items: [item] });
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-8">

        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-6">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 mb-1.5">
              <ProjectIcon name={project.icon} size={26} className="text-[var(--text-secondary)]" />
              <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight truncate">
                {project.name}
              </h1>
            </div>
            {project.description && (
              <p className="text-sm text-[var(--text-secondary)] mb-3 max-w-lg">{project.description}</p>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full border border-[var(--border)]", STATUS_COLORS[project.status])}>
                {project.status.replace("_", " ")}
              </span>
              {project.dueDate && (
                <span className="flex items-center gap-1 text-xs text-[var(--text-tertiary)]">
                  <Calendar size={10} />
                  {formatDate(project.dueDate)}
                </span>
              )}
              {projectTags.map((tag) => tag && <Badge key={tag.id} color={tag.color}>{tag.name}</Badge>)}
            </div>
          </div>

          {/* Progress ring */}
          <div className="flex-shrink-0 flex flex-col items-center gap-1.5">
            <ProgressRing percent={completionRate} size={68} />
            <span className="text-[11px] text-[var(--text-tertiary)]">
              {doneCards.length}/{allCards.length} done
            </span>
          </div>
        </div>

        {/* ── Stats — 3 cards ────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-3">
          <StatCard
            icon={<FileText size={14} />}
            iconColor="var(--info)"
            iconBg="rgba(96,165,250,0.12)"
            value={notes.length}
            label="Notes"
            onClick={() => setView("notes")}
          />
          <StatCard
            icon={<Kanban size={14} />}
            iconColor="var(--accent)"
            iconBg="rgba(124,106,252,0.12)"
            value={openCards.length}
            label="Open tasks"
            onClick={() => setView("board")}
          />
          <StatCard
            icon={<AlertCircle size={14} />}
            iconColor={overdueCount > 0 ? "var(--danger)" : "var(--text-tertiary)"}
            iconBg={overdueCount > 0 ? "rgba(244,63,94,0.12)" : "var(--surface-2)"}
            value={overdueCount}
            label="Overdue"
            valueColor={overdueCount > 0 ? "var(--danger)" : undefined}
            danger={overdueCount > 0}
            onClick={() => setView("board")}
          />
        </div>

        {/* ── Health strip ───────────────────────────────────────── */}
        {(hasAnyCategorised || columns.length > 0) && (
          <section>
            <SectionHeader title="Health" icon={<BarChart2 size={12} />} />
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-4">

              {/* Column bar chart */}
              {columns.length > 0 && (
                <div>
                  <div className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2.5">
                    By column
                  </div>
                  <div className="space-y-1.5">
                    {columns.map((col) => {
                      const count = getColumnCards(col.id).length;
                      const pct   = allCards.length > 0 ? (count / allCards.length) * 100 : 0;
                      const color = COLUMN_COLORS[col.type] ?? COLUMN_COLORS.custom;
                      return (
                        <button
                          key={col.id}
                          onClick={() => { setView("board"); setTimeout(() => window.dispatchEvent(new CustomEvent("cairn:scroll-to-column", { detail: { columnId: col.id } })), 50); }}
                          className="flex items-center gap-2.5 w-full group"
                        >
                          <span className="text-[11px] text-[var(--text-tertiary)] w-20 text-right flex-shrink-0 group-hover:text-[var(--text-secondary)] transition-colors truncate">
                            {col.name}
                          </span>
                          <div className="flex-1 h-2 rounded-full bg-[var(--surface-2)] overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${pct}%`, backgroundColor: color }}
                            />
                          </div>
                          <span className="text-[11px] tabular-nums text-[var(--text-tertiary)] w-5 text-right flex-shrink-0">
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Priority breakdown */}
              {hasAnyCategorised && (
                <div>
                  <div className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2.5">
                    Open tasks by priority
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {([ 
                      { key: "urgent", label: "Urgent", color: "var(--danger)",        bg: "rgba(244,63,94,0.08)"     },
                      { key: "high",   label: "High",   color: "var(--warning)",       bg: "rgba(245,158,11,0.08)"   },
                      { key: "medium", label: "Medium", color: "var(--info)",          bg: "rgba(96,165,250,0.08)"   },
                      { key: "low",    label: "Low",    color: "var(--text-tertiary)", bg: "var(--surface-2)"        },
                    ] as const).map(({ key, label, color, bg }) => (
                      <button
                        key={key}
                        onClick={() => setView("board")}
                        className="rounded-lg p-2.5 text-center border border-[var(--border)] hover:border-[var(--accent)]/30 hover:bg-[var(--surface-2)] transition-all"
                        style={{ background: priorityCounts[key] > 0 ? bg : undefined }}
                      >
                        <div className="text-lg font-bold leading-none mb-1" style={{ color: priorityCounts[key] > 0 ? color : "var(--text-tertiary)" }}>
                          {priorityCounts[key]}
                        </div>
                        <div className="text-[10px] text-[var(--text-tertiary)]">{label}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Board snapshot ─────────────────────────────────────── */}
        {columns.length > 0 && (
          <section>
            <SectionHeader
              title="Board"
              icon={<Kanban size={12} />}
              action={{ label: "View board", onClick: () => setView("board") }}
            />
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {columns.map((col) => (
                <ColumnPill
                  key={col.id}
                  column={col}
                  cards={getColumnCards(col.id)}
                  onClick={() => {
                    setView("board");
                    // Small delay so the board has mounted before we dispatch
                    setTimeout(() => {
                      window.dispatchEvent(new CustomEvent("cairn:scroll-to-column", { detail: { columnId: col.id } }));
                    }, 50);
                  }}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── Due soon ───────────────────────────────────────────── */}
        {dueCards.length > 0 && (
          <section>
            <SectionHeader
              title="Due soon"
              icon={<Clock size={12} />}
            />
            <div className="space-y-2">
              {dueCards.map((card) => (
                <DueCard
                  key={card.id}
                  card={card}
                  columns={columns}
                  today={today}
                  onClick={() => {
                    setView("board");
                    window.dispatchEvent(new CustomEvent("cairn:open-card", { detail: { cardId: card.id } }));
                  }}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── Pinned notes ───────────────────────────────────────── */}
        {pinnedNotes.length > 0 && (
          <section>
            <SectionHeader
              title="Pinned"
              icon={<Pin size={12} />}
              action={{ label: "All notes", onClick: () => setView("notes") }}
            />
            <div className="grid grid-cols-2 gap-3">
              {pinnedNotes.map((note) => (
                <PinnedNoteCard
                  key={note.id}
                  note={note}
                  getTagById={getTagById}
                  onClick={() => {
                    setView("notes");
                    window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: note.id } }));
                  }}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── Recent notes ───────────────────────────────────────── */}
        {recentNotes.length > 0 && (
          <section>
            <SectionHeader
              title="Recent notes"
              icon={<FileText size={12} />}
              action={{ label: "All notes", onClick: () => setView("notes") }}
            />
            <div className="space-y-0.5">
              {recentNotes.map((note) => (
                <NoteRow
                  key={note.id}
                  note={note}
                  onClick={() => {
                    setView("notes");
                    window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: note.id } }));
                  }}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── Recent activity ────────────────────────────────────── */}
        {activityByDay.length > 0 && (
          <section>
            <SectionHeader
              title="Recent activity"
              icon={<Activity size={12} />}
            />
            <div className="space-y-4">
              {activityByDay.map(({ label, items }) => (
                <div key={label}>
                  <div className="text-[10px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider mb-1.5 px-2">
                    {label}
                  </div>
                  <div className="space-y-0.5">
                    {items.map((item) => (
                      <button
                        key={item.id}
                        onClick={item.onClick}
                        className="flex items-center gap-3 w-full px-2 py-1.5 rounded-lg hover:bg-[var(--surface-2)] transition-colors group text-left"
                      >
                        {item.type === "note" ? (
                          <FileText size={12} className="text-[var(--info)] flex-shrink-0" />
                        ) : (
                          <Circle size={12} className="text-[var(--accent)] flex-shrink-0" />
                        )}
                        <span className="flex-1 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">
                          {item.title}
                        </span>
                        {item.subtitle && (
                          <span className="text-[11px] text-[var(--text-tertiary)] flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                            {item.subtitle}
                          </span>
                        )}
                        <span className="text-[11px] text-[var(--text-tertiary)] flex-shrink-0 tabular-nums">
                          {formatRelative(item.updatedAt)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Empty state ────────────────────────────────────────── */}
        {notes.length === 0 && allCards.length === 0 && (
          <div className="py-16 text-center">
            <Kanban size={40} strokeWidth={1.5} className="mx-auto mb-3 text-[var(--text-tertiary)] opacity-30" />
            <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Start building</h3>
            <p className="text-sm text-[var(--text-tertiary)] max-w-sm mx-auto mb-6">
              Add notes to capture ideas and tasks to track progress.
            </p>
            <div className="flex justify-center gap-3">
              <Button variant="accent" size="sm" onClick={() => setView("notes")}>
                <FileText size={13} /> New Note
              </Button>
              <Button variant="default" size="sm" onClick={() => setView("board")}>
                <Kanban size={13} /> Open Board
              </Button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({
  title, icon, action,
}: {
  title: string;
  icon: React.ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
        {icon}{title}
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="text-[11px] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors flex items-center gap-1"
        >
          {action.label}<ArrowRight size={10} />
        </button>
      )}
    </div>
  );
}

function StatCard({
  icon, iconColor, iconBg, value, label, valueColor, danger, onClick,
}: {
  icon: React.ReactNode;
  iconColor: string;
  iconBg: string;
  value: number;
  label: string;
  valueColor?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "p-4 rounded-xl border bg-[var(--surface)] hover:bg-[var(--surface-2)] transition-colors text-left flex items-center gap-3 group",
        danger ? "border-[var(--danger)]/25" : "border-[var(--border)]"
      )}
    >
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: iconBg, color: iconColor }}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xl font-bold leading-none" style={{ color: valueColor ?? "var(--text-primary)" }}>
          {value}
        </div>
        <div className="text-[11px] text-[var(--text-tertiary)] mt-1">{label}</div>
      </div>
      <ArrowRight size={11} className="ml-auto text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
    </button>
  );
}

function ColumnPill({
  column, cards, onClick,
}: {
  column: BoardColumn;
  cards: TaskCard[];
  onClick: () => void;
}) {
  const color = COLUMN_COLORS[column.type] ?? COLUMN_COLORS.custom;
  const isDone = column.type === "done";
  const isInProgress = column.type === "in_progress";

  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 min-w-[110px] max-w-[180px] rounded-xl border p-3 text-left transition-all hover:border-[var(--accent)]/40 hover:bg-[var(--surface-2)] flex-shrink-0",
        isInProgress ? "border-[var(--warning)]/30 bg-[var(--surface)]" : "border-[var(--border)] bg-[var(--surface)]"
      )}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
        <span className="text-[10px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider truncate">
          {column.name}
        </span>
      </div>
      <div
        className="text-xl font-bold mb-1.5 leading-none"
        style={{ color: isDone ? "var(--success)" : isInProgress ? "var(--warning)" : "var(--text-primary)" }}
      >
        {cards.length}
      </div>
      <div className="space-y-0.5">
        {cards.slice(0, 2).map((c) => (
          <div key={c.id} className="text-[10.5px] text-[var(--text-tertiary)] truncate leading-snug">
            {c.title}
          </div>
        ))}
        {cards.length === 0 && (
          <div className="text-[10.5px] text-[var(--border)]">—</div>
        )}
      </div>
    </button>
  );
}

function DueCard({
  card, columns, today, onClick,
}: {
  card: TaskCard;
  columns: BoardColumn[];
  today: Date;
  onClick: () => void;
}) {
  const col = columns.find((c) => c.id === card.columnId);
  const due = new Date(card.dueDate!);
  const isOverdue = due < today;
  const isToday   = due.getTime() === today.getTime();

  const daysLeft  = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  const chipLabel = isOverdue
    ? `${Math.abs(daysLeft)}d overdue`
    : isToday
    ? "Today"
    : `in ${daysLeft}d`;

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all group",
        isOverdue
          ? "border-[var(--danger)]/25 bg-[var(--danger)]/[0.03] hover:bg-[var(--danger)]/[0.07]"
          : isToday
          ? "border-[var(--warning)]/30 bg-[var(--warning)]/[0.03] hover:bg-[var(--warning)]/[0.07]"
          : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/30 hover:bg-[var(--surface-2)]"
      )}
    >
      {/* Priority stripe */}
      <div
        className="w-0.5 h-7 rounded-full flex-shrink-0"
        style={{ background: PRIORITY_STRIPE[card.priority] ?? "var(--text-tertiary)" }}
      />
      <span className="flex-1 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">
        {card.title}
      </span>
      {col && (
        <span className="text-[11px] text-[var(--text-tertiary)] flex-shrink-0">{col.name}</span>
      )}
      <span
        className={cn(
          "text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0",
          isOverdue
            ? "bg-[var(--danger)]/15 text-[var(--danger)]"
            : isToday
            ? "bg-[var(--warning)]/15 text-[var(--warning)]"
            : "bg-[var(--accent-dim)] text-[var(--accent)]"
        )}
      >
        {chipLabel}
      </span>
    </button>
  );
}

function PinnedNoteCard({
  note, getTagById, onClick,
}: {
  note: Note;
  getTagById: (id: string) => import("@/types").Tag | undefined;
  onClick: () => void;
}) {
  const noteTags = note.tagIds.slice(0, 2).map((id) => getTagById(id)).filter(Boolean) as import("@/types").Tag[];

  return (
    <button
      onClick={onClick}
      className="p-4 rounded-xl border border-[var(--accent)]/20 bg-[var(--surface)] hover:bg-[var(--surface-2)] text-left transition-all w-full group"
    >
      <div className="flex items-center gap-1 mb-2">
        <Pin size={9} className="text-[var(--accent)]" />
        <span className="text-[10px] text-[var(--accent)] font-medium">Pinned</span>
      </div>
      <div className="text-sm font-semibold text-[var(--text-primary)] mb-1.5 truncate group-hover:text-white transition-colors">
        {note.title}
      </div>
      <div className="text-[11.5px] text-[var(--text-tertiary)] line-clamp-2 leading-relaxed mb-3">
        {note.contentText.slice(0, 120) || "Empty note"}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[var(--text-tertiary)]">{formatRelative(note.updatedAt)}</span>
        <div className="flex gap-1">
          {noteTags.map((tag) => (
            <Badge key={tag.id} color={tag.color}>{tag.name}</Badge>
          ))}
        </div>
      </div>
    </button>
  );
}

function NoteRow({ note, onClick }: { note: Note; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-[var(--surface-2)] transition-colors group text-left"
    >
      <FileText size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">
          {note.title}
        </div>
        <div className="text-[11px] text-[var(--text-tertiary)] truncate">
          {note.contentText.slice(0, 80) || "Empty note"}
        </div>
      </div>
      <span className="text-[11px] text-[var(--text-tertiary)] flex-shrink-0 tabular-nums">
        {formatRelative(note.updatedAt)}
      </span>
    </button>
  );
}

function ProgressRing({ percent, size }: { percent: number; size: number }) {
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDash = circumference - (percent / 100) * circumference;

  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} stroke="var(--border)" strokeWidth="4" fill="none" />
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        stroke="var(--accent)" strokeWidth="4" fill="none"
        strokeDasharray={circumference} strokeDashoffset={strokeDash}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.5s ease" }}
      />
      <text
        x="50%" y="50%" dominantBaseline="middle" textAnchor="middle"
        style={{ transform: "rotate(90deg)", transformOrigin: "50% 50%", fontSize: 11, fontWeight: 700, fill: "var(--text-primary)" }}
      >
        {percent}%
      </text>
    </svg>
  );
}
