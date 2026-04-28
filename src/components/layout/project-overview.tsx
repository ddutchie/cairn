"use client";

import React from "react";
import {
  FileText,
  Kanban,
  Calendar,
  Pin,
  ArrowRight,
  CheckCircle,
  Circle,
  Clock,
  TrendingUp,
  Activity,
} from "lucide-react";
import { useCairnStore } from "@/store";
import { cn, formatDate, formatRelative, STATUS_COLORS, PRIORITY_COLORS } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TaskCard, Note } from "@/types";

const COLUMN_TYPE_ORDER = ["in_progress", "review", "todo", "backlog", "done"];

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

  const notes = getProjectNotes(project.id);
  const columns = getProjectColumns(project.id);
  const allCards = getProjectCards(project.id);

  const doneCol = columns.find((c) => c.type === "done");
  const doneCards = doneCol ? getColumnCards(doneCol.id) : [];
  const completionRate = allCards.length > 0
    ? Math.round((doneCards.length / allCards.length) * 100)
    : 0;

  const inProgressCards = columns
    .filter((c) => c.type === "in_progress")
    .flatMap((c) => getColumnCards(c.id));

  const pinnedNotes = notes.filter((n) => n.isPinned);
  const recentNotes = notes.slice(0, 4);

  // Unified activity feed — notes + tasks sorted by updatedAt
  const recentActivity = [
    ...notes.map((n) => ({
      id: n.id, type: "note" as const, title: n.title,
      subtitle: null as string | null,
      updatedAt: n.updatedAt, onClick: () => setView("notes"),
    })),
    ...allCards.map((c) => {
      const col = columns.find((col) => col.id === c.columnId);
      return {
        id: c.id, type: "task" as const, title: c.title,
        subtitle: col?.name ?? null,
        updatedAt: c.updatedAt, onClick: () => setView("board"),
      };
    }),
  ]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 12);

  const projectTags = project.tagIds.map((tid) => getTagById(tid)).filter(Boolean);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-8 space-y-8">
        {/* Header */}
        <div className="animate-fade-in">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-3xl">{project.icon ?? "📁"}</span>
                <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight">
                  {project.name}
                </h1>
              </div>
              {project.description && (
                <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-lg">
                  {project.description}
                </p>
              )}
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <span
                  className={cn(
                    "text-xs font-medium px-2 py-0.5 rounded-full border",
                    STATUS_COLORS[project.status]
                  )}
                  style={{ borderColor: "var(--border)" }}
                >
                  {project.status.replace("_", " ")}
                </span>
                <span
                  className={cn(
                    "text-xs font-medium px-2 py-0.5 rounded-full border",
                    PRIORITY_COLORS[project.priority]
                  )}
                  style={{ borderColor: "var(--border)" }}
                >
                  {project.priority} priority
                </span>
                {project.dueDate && (
                  <span className="flex items-center gap-1 text-xs text-[var(--text-tertiary)]">
                    <Calendar size={10} />
                    {formatDate(project.dueDate)}
                  </span>
                )}
                {projectTags.map(
                  (tag) =>
                    tag && (
                      <Badge key={tag.id} color={tag.color}>
                        {tag.name}
                      </Badge>
                    )
                )}
              </div>
            </div>

            {/* Progress ring */}
            <div className="flex-shrink-0 flex flex-col items-center gap-1">
              <ProgressRing percent={completionRate} size={64} />
              <span className="text-[11px] text-[var(--text-tertiary)]">
                {doneCards.length}/{allCards.length} done
              </span>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3">
          {[
            {
              label: "Notes",
              value: notes.length,
              icon: <FileText size={14} />,
              action: () => setView("notes"),
              color: "var(--info)",
            },
            {
              label: "Total tasks",
              value: allCards.length,
              icon: <Kanban size={14} />,
              action: () => setView("board"),
              color: "var(--accent)",
            },
            {
              label: "In progress",
              value: inProgressCards.length,
              icon: <TrendingUp size={14} />,
              action: () => setView("board"),
              color: "var(--warning)",
            },
            {
              label: "Completed",
              value: doneCards.length,
              icon: <CheckCircle size={14} />,
              action: () => setView("board"),
              color: "var(--success)",
            },
          ].map((stat) => (
            <button
              key={stat.label}
              onClick={stat.action}
              className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] transition-colors text-left group"
            >
              <div className="flex items-center justify-between mb-2">
                <span style={{ color: stat.color }}>{stat.icon}</span>
                <ArrowRight
                  size={12}
                  className="text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity"
                />
              </div>
              <div className="text-2xl font-bold text-[var(--text-primary)]">{stat.value}</div>
              <div className="text-xs text-[var(--text-tertiary)] mt-0.5">{stat.label}</div>
            </button>
          ))}
        </div>

        {/* In-progress cards */}
        {inProgressCards.length > 0 && (
          <section>
            <SectionHeader
              title="In Progress"
              icon={<Clock size={13} />}
              action={{ label: "View board", onClick: () => setView("board") }}
            />
            <div className="space-y-2">
              {inProgressCards.map((card) => (
                <MiniCard key={card.id} card={card} />
              ))}
            </div>
          </section>
        )}

        {/* Pinned Notes */}
        {pinnedNotes.length > 0 && (
          <section>
            <SectionHeader
              title="Pinned Notes"
              icon={<Pin size={13} />}
              action={{ label: "All notes", onClick: () => setView("notes") }}
            />
            <div className="grid grid-cols-2 gap-3">
              {pinnedNotes.map((note) => (
                <MiniNote key={note.id} note={note} onClick={() => setView("notes")} />
              ))}
            </div>
          </section>
        )}

        {/* Recent notes */}
        {recentNotes.filter((n) => !n.isPinned).length > 0 && (
          <section>
            <SectionHeader
              title="Recent Notes"
              icon={<FileText size={13} />}
              action={{ label: "All notes", onClick: () => setView("notes") }}
            />
            <div className="space-y-2">
              {recentNotes
                .filter((n) => !n.isPinned)
                .map((note) => (
                  <div
                    key={note.id}
                    onClick={() => setView("notes")}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:border-[var(--border)] hover:bg-[var(--surface)] transition-all cursor-pointer group"
                  >
                    <FileText size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">
                        {note.title}
                      </div>
                      <div className="text-xs text-[var(--text-tertiary)] truncate">
                        {note.contentText.slice(0, 80)}
                      </div>
                    </div>
                    <span className="text-[11px] text-[var(--text-tertiary)] flex-shrink-0">
                      {formatRelative(note.updatedAt)}
                    </span>
                  </div>
                ))}
            </div>
          </section>
        )}

        {/* Recent Activity */}
        {recentActivity.length > 0 && (
          <section>
            <SectionHeader
              title="Recent Activity"
              icon={<Activity size={13} />}
            />
            <div className="space-y-0.5">
              {recentActivity.map((item) => (
                <button
                  key={item.id}
                  onClick={item.onClick}
                  className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-[var(--surface-2)] transition-colors group text-left"
                >
                  {item.type === "note" ? (
                    <FileText size={13} className="text-[var(--info)] flex-shrink-0" />
                  ) : (
                    <Circle size={13} className="text-[var(--accent)] flex-shrink-0" />
                  )}
                  <span className="flex-1 min-w-0 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">
                    {item.title}
                  </span>
                  {item.subtitle && (
                    <span className="text-[11px] text-[var(--text-tertiary)] flex-shrink-0 hidden group-hover:inline">
                      {item.subtitle}
                    </span>
                  )}
                  <span className="text-[11px] text-[var(--text-tertiary)] flex-shrink-0 tabular-nums">
                    {formatRelative(item.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Empty state */}
        {notes.length === 0 && allCards.length === 0 && (
          <div className="py-16 text-center animate-fade-in">
            <div className="text-5xl mb-4">🪨</div>
            <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
              Start building
            </h3>
            <p className="text-sm text-[var(--text-tertiary)] max-w-sm mx-auto mb-6">
              Add notes to capture ideas and tasks to track progress. Everything in one place.
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

function SectionHeader({
  title,
  icon,
  action,
}: {
  title: string;
  icon: React.ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
        {icon}
        {title}
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="text-[11px] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors flex items-center gap-1"
        >
          {action.label}
          <ArrowRight size={10} />
        </button>
      )}
    </div>
  );
}

function MiniCard({ card }: { card: TaskCard }) {
  const { getTagById } = useCairnStore();
  const cardTags = card.tagIds.slice(0, 2).map((id) => getTagById(id)).filter(Boolean);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] group hover:border-[var(--accent)]/30 transition-all">
      <Circle
        size={13}
        className="text-[var(--warning)] flex-shrink-0"
        fill="currentColor"
        fillOpacity={0.2}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">
          {card.title}
        </div>
        {card.description && (
          <div className="text-xs text-[var(--text-tertiary)] truncate">{card.description}</div>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {cardTags.map(
          (tag) =>
            tag && (
              <Badge key={tag.id} color={tag.color}>
                {tag.name}
              </Badge>
            )
        )}
        {card.dueDate && (
          <span className="text-[11px] text-[var(--text-tertiary)] flex items-center gap-0.5">
            <Calendar size={9} />
            {formatDate(card.dueDate)}
          </span>
        )}
      </div>
    </div>
  );
}

function MiniNote({ note, onClick }: { note: Note; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-left transition-all w-full group"
    >
      <div className="flex items-center gap-1.5 mb-2">
        <Pin size={10} className="text-[var(--accent)]" />
        <span className="text-xs text-[var(--accent)] font-medium">Pinned</span>
      </div>
      <div className="text-sm font-medium text-[var(--text-primary)] mb-1 truncate">
        {note.title}
      </div>
      <div className="text-xs text-[var(--text-tertiary)] line-clamp-2 leading-relaxed">
        {note.contentText.slice(0, 120)}
      </div>
      <div className="mt-3 text-[11px] text-[var(--text-tertiary)]">
        {formatRelative(note.updatedAt)}
      </div>
    </button>
  );
}

function ProgressRing({ percent, size }: { percent: number; size: number }) {
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDash = circumference - (percent / 100) * circumference;

  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke="var(--border)"
        strokeWidth="4"
        fill="none"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke="var(--accent)"
        strokeWidth="4"
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={strokeDash}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.5s ease" }}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="middle"
        textAnchor="middle"
        className="fill-[var(--text-primary)] text-[11px] font-semibold rotate-90"
        style={{ transform: `rotate(90deg)`, transformOrigin: "50% 50%", fontSize: 11 }}
      >
        {percent}%
      </text>
    </svg>
  );
}
