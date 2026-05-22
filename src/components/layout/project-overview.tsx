"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  FileText, Kanban, Calendar, Pin, ArrowRight, Clock,
  AlertCircle, Activity, Circle, BarChart2, Pencil, Check, FolderOpen, Terminal,
  Send, Sparkles,
} from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { ProjectIcon, WORKSPACE_ICONS } from "@/lib/workspace-icons";
import { cn, formatDate, formatRelative, STATUS_COLORS } from "@/lib/utils";
import { COLUMN_COLORS, PRIORITY_CSS_COLORS } from "@/lib/constants";
import { CairnEvents } from "@/lib/events";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TaskCard, Note, BoardColumn } from "@/types";
import { useProjectMetrics, type ActivityGroup } from "./project-overview/useProjectMetrics";

export function ProjectOverview() {
  const { activeProjectId, projects, setView, updateProject, chatOpen } = useCairnStore(useShallow((s) => ({
    activeProjectId: s.activeProjectId,
    projects:        s.projects,
    setView:         s.setView,
    updateProject:   s.updateProject,
    chatOpen:        s.chatOpen,
  })));
  const project = projects.find((p) => p.id === activeProjectId);
  const metrics = useProjectMetrics(activeProjectId);

  const [chatInput, setChatInput] = useState("");

  function handleSendChat() {
    const text = chatInput.trim();
    if (!text) return;
    setChatInput("");
    window.dispatchEvent(CairnEvents.openChat(text, true));
  }

  const [editOpen, setEditOpen] = useState(false);
  const [editIcon, setEditIcon] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [codeDirInput, setCodeDirInput] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editOpen && project) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditIcon(project.icon ?? "");
      setEditDesc(project.description ?? "");
    }
  }, [editOpen, project]);

  // Keep codeDirInput in sync when project changes externally
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCodeDirInput(project?.codeDirectory ?? "");
  }, [project?.codeDirectory]);

  async function handlePickCodeDir() {
    const result = await window.electron?.agent.pickDirectory() as { data: string | null } | undefined;
    if (result?.data) setCodeDirInput(result.data);
  }

  function handleSaveCodeDir() {
    if (!project) return;
    updateProject(project.id, { codeDirectory: codeDirInput.trim() || null });
  }

  function handleSaveEdit() {
    if (!project) return;
    updateProject(project.id, {
      icon: editIcon.trim() || undefined,
      description: editDesc.trim() || undefined,
    });
    setEditOpen(false);
  }

  useEffect(() => {
    if (!editOpen) return;
    function handle(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setEditOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [editOpen]);

  if (!project || !metrics) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-[var(--text-tertiary)]">
          <Kanban size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">Select a project to get started</p>
        </div>
      </div>
    );
  }

  const {
    notes, columns, allCards, doneCards, openCards, completionRate,
    today, dueCards, overdueCount, priorityCounts, hasAnyCategorised,
    pinnedNotes, recentNotes, projectTags, activityByDay,
  } = metrics;

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <div className="flex-1 overflow-y-auto">
        <div className={cn("max-w-3xl mx-auto px-8 py-8 space-y-8", !chatOpen && "pb-32")}>

        {/* ── Header ─────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-6">
          <div className="flex-1 min-w-0">
            <div className="group flex items-center gap-2.5 mb-1.5">
              <ProjectIcon name={project.icon} size={26} className="text-[var(--text-secondary)]" />
              <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight truncate">
                {project.name}
              </h1>
              {/* Edit icon/description popover */}
              <div className="relative flex-shrink-0">
                <button
                  onClick={() => setEditOpen((o) => !o)}
                  className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors opacity-0 group-hover:opacity-100"
                  title="Edit icon & description"
                >
                  <Pencil size={13} />
                </button>
                {editOpen && (
                  <div
                    ref={popoverRef}
                    className="absolute left-0 top-full mt-2 z-50 w-72 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] shadow-2xl p-4 space-y-3"
                  >
                    <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">Edit project</p>
                    {/* Icon grid */}
                    <div>
                      <label className="text-[0.786rem] text-[var(--text-tertiary)] block mb-1.5">Icon</label>
                      <div className="flex flex-wrap gap-1.5">
                        {WORKSPACE_ICONS.map(({ name: iconName }) => (
                          <button
                            key={iconName}
                            type="button"
                            onClick={() => setEditIcon(iconName)}
                            className={cn(
                              "w-7 h-7 rounded-lg flex items-center justify-center transition-colors",
                              editIcon === iconName
                                ? "bg-[var(--accent-dim)] ring-1 ring-[var(--accent)] text-[var(--accent)]"
                                : "bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--surface-3,var(--surface-2))]"
                            )}
                          >
                            <ProjectIcon name={iconName} size={13} />
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* Description */}
                    <div>
                      <label className="text-[0.786rem] text-[var(--text-tertiary)] block mb-1">Description</label>
                      <textarea
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        placeholder="What is this project about?"
                        rows={3}
                        className="w-full px-2 py-1.5 text-xs rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)] resize-none"
                      />
                    </div>
                    <div className="flex justify-end">
                      <Button variant="accent" size="xs" onClick={handleSaveEdit}>
                        <Check size={11} /> Save
                      </Button>
                    </div>
                  </div>
                )}
              </div>
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
                  <Calendar size={10} />{formatDate(project.dueDate)}
                </span>
              )}
              {projectTags.map((tag) => tag && <Badge key={tag.id} color={tag.color}>{tag.name}</Badge>)}
            </div>
          </div>
          <div className="flex-shrink-0 flex flex-col items-center gap-1.5">
            <ProgressRing percent={completionRate} size={68} />
            <span className="text-[0.786rem] text-[var(--text-tertiary)]">
              {doneCards.length}/{allCards.length} done
            </span>
          </div>
        </div>

        {/* ── Code directory ────────────────────────────────── */}
        <div className="flex items-center gap-2 group">
          <Terminal size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
          <input
            value={codeDirInput}
            onChange={(e) => setCodeDirInput(e.target.value)}
            onBlur={handleSaveCodeDir}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            placeholder="Set code directory for agent sessions…"
            className="flex-1 min-w-0 bg-transparent text-[0.786rem] font-mono text-[var(--text-secondary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:text-[var(--text-primary)] transition-colors"
          />
          {typeof window !== "undefined" && window.electron && (
            <button
              onClick={handlePickCodeDir}
              className="flex-shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors opacity-0 group-hover:opacity-100"
              title="Browse"
            >
              <FolderOpen size={12} />
            </button>
          )}
        </div>

        {/* ── Stats ─────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-3">
          <StatCard icon={<FileText size={14} />} iconColor="var(--info)" iconBg="color-mix(in srgb, var(--info) 12%, transparent)"
            value={notes.length} label="Notes" onClick={() => setView("notes")} />
          <StatCard icon={<Kanban size={14} />} iconColor="var(--accent)" iconBg="var(--accent-dim)"
            value={openCards.length} label="Open tasks" onClick={() => setView("board")} />
          <StatCard icon={<AlertCircle size={14} />}
            iconColor={overdueCount > 0 ? "var(--danger)" : "var(--text-tertiary)"}
            iconBg={overdueCount > 0 ? "color-mix(in srgb, var(--danger) 12%, transparent)" : "var(--surface-2)"}
            value={overdueCount} label="Overdue"
            valueColor={overdueCount > 0 ? "var(--danger)" : undefined}
            danger={overdueCount > 0} onClick={() => setView("board")} />
        </div>

        {/* ── Health ────────────────────────────────────────── */}
        {(hasAnyCategorised || columns.length > 0) && (
          <section>
            <SectionHeader title="Health" icon={<BarChart2 size={12} />} />
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-4">
              <ColumnBreakdownCard columns={columns} allCards={allCards} setView={setView} />
              <PriorityBreakdownCard priorityCounts={priorityCounts} hasAnyCategorised={hasAnyCategorised} setView={setView} />
            </div>
          </section>
        )}

        {/* ── Board snapshot ────────────────────────────────── */}
        {columns.length > 0 && (
          <section>
            <SectionHeader title="Board" icon={<Kanban size={12} />} action={{ label: "View board", onClick: () => setView("board") }} />
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {columns.map((col) => (
                <ColumnPill key={col.id} column={col} cards={allCards.filter((c) => c.columnId === col.id)}
                  onClick={() => { setView("board"); setTimeout(() => window.dispatchEvent(CairnEvents.scrollToColumn(col.id)), 50); }} />
              ))}
            </div>
          </section>
        )}

        {/* ── Due soon ──────────────────────────────────────── */}
        {dueCards.length > 0 && (
          <section>
            <SectionHeader title="Due soon" icon={<Clock size={12} />} />
            <div className="space-y-2">
              {dueCards.map((card) => (
                <DueCard key={card.id} card={card} columns={columns} today={today}
                  onClick={() => { setView("board"); window.dispatchEvent(CairnEvents.openCard(card.id)); }} />
              ))}
            </div>
          </section>
        )}

        {/* ── Pinned notes ──────────────────────────────────── */}
        {pinnedNotes.length > 0 && (
          <section>
            <SectionHeader title="Pinned" icon={<Pin size={12} />} action={{ label: "All notes", onClick: () => setView("notes") }} />
            <div className="grid grid-cols-2 gap-3">
              {pinnedNotes.map((note) => (
                <PinnedNoteCard key={note.id} note={note}
                  onClick={() => { setView("notes"); window.dispatchEvent(CairnEvents.selectNote(note.id)); }} />
              ))}
            </div>
          </section>
        )}

        {/* ── Recent notes ──────────────────────────────────── */}
        {recentNotes.length > 0 && (
          <section>
            <SectionHeader title="Recent notes" icon={<FileText size={12} />} action={{ label: "All notes", onClick: () => setView("notes") }} />
            <div className="space-y-0.5">
              {recentNotes.map((note) => (
                <NoteRow key={note.id} note={note}
                  onClick={() => { setView("notes"); window.dispatchEvent(CairnEvents.selectNote(note.id)); }} />
              ))}
            </div>
          </section>
        )}

        {/* ── Recent activity ───────────────────────────────── */}
        {activityByDay.length > 0 && (
          <section>
            <SectionHeader title="Recent activity" icon={<Activity size={12} />} />
            <RecentActivityFeed activityByDay={activityByDay} />
          </section>
        )}

        {/* ── Empty state ───────────────────────────────────── */}
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

      {/* Pinned bottom Chat Input (shown only when chat sidebar is closed) */}
      {!chatOpen && (
        <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-[var(--background)] via-[color-mix(in srgb,var(--background)_80%,transparent)] to-transparent pointer-events-none z-10">
          <div className="max-w-3xl mx-auto pointer-events-auto">
            <div className="relative flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[color-mix(in srgb,var(--surface-2)_85%,transparent)] backdrop-blur-md px-4 py-3 shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all duration-300 hover:border-[color-mix(in srgb,var(--accent)_40%,transparent)] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent-dim)]">
              <div className="flex-shrink-0 w-8 h-8 rounded-xl bg-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center animate-pulse">
                <Sparkles size={14} />
              </div>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSendChat();
                  }
                }}
                placeholder="What would you like to do today?"
                className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none py-1 leading-relaxed"
              />
              <button
                onClick={handleSendChat}
                disabled={!chatInput.trim()}
                className="flex-shrink-0 w-8 h-8 rounded-xl bg-[var(--accent)] text-white hover:bg-[color-mix(in srgb,var(--accent)_90%,black)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95 shadow-md shadow-[var(--accent)]/10"
              >
                <Send size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
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
      <div className="flex items-center gap-1.5 text-[0.786rem] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
        {icon}{title}
      </div>
      {action && (
        <button onClick={action.onClick}
          className="text-[0.786rem] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors flex items-center gap-1">
          {action.label}<ArrowRight size={10} />
        </button>
      )}
    </div>
  );
}

function StatCard({
  icon, iconColor, iconBg, value, label, valueColor, danger, onClick,
}: {
  icon: React.ReactNode; iconColor: string; iconBg: string;
  value: number; label: string; valueColor?: string; danger?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className={cn("p-4 rounded-xl border bg-[var(--surface)] hover:bg-[var(--surface-2)] transition-colors text-left flex items-center gap-3 group",
        danger ? "border-[var(--danger)]/25" : "border-[var(--border)]")}>
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: iconBg, color: iconColor }}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xl font-bold leading-none" style={{ color: valueColor ?? "var(--text-primary)" }}>{value}</div>
        <div className="text-[0.786rem] text-[var(--text-tertiary)] mt-1">{label}</div>
      </div>
      <ArrowRight size={11} className="ml-auto text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
    </button>
  );
}

function ColumnBreakdownCard({
  columns, allCards, setView,
}: {
  columns: BoardColumn[];
  allCards: TaskCard[];
  setView: (v: "board") => void;
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
              onClick={() => { setView("board"); setTimeout(() => window.dispatchEvent(CairnEvents.scrollToColumn(col.id)), 50); }}
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

function PriorityBreakdownCard({
  priorityCounts, hasAnyCategorised, setView,
}: {
  priorityCounts: { urgent: number; high: number; medium: number; low: number };
  hasAnyCategorised: boolean;
  setView: (v: "board") => void;
}) {
  if (!hasAnyCategorised) return null;
  return (
    <div>
      <div className="text-[0.714rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2.5">Open tasks by priority</div>
      <div className="grid grid-cols-4 gap-2">
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

function ColumnPill({ column, cards, onClick }: { column: BoardColumn; cards: TaskCard[]; onClick: () => void }) {
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
          <div key={c.id} className="text-[10.5px] text-[var(--text-tertiary)] truncate leading-snug">{c.title}</div>
        ))}
        {cards.length === 0 && <div className="text-[10.5px] text-[var(--text-tertiary)]">—</div>}
      </div>
    </button>
  );
}

function DueCard({ card, columns, today, onClick }: { card: TaskCard; columns: BoardColumn[]; today: Date; onClick: () => void }) {
  const col = columns.find((c) => c.id === card.columnId);
  const due = new Date(card.dueDate!);
  const isOverdue = due < today;
  const isToday   = due.getTime() === today.getTime();
  const daysLeft  = Math.round((due.getTime() - today.getTime()) / 86_400_000);
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

function PinnedNoteCard({ note, onClick }: { note: Note; onClick: () => void }) {
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
        {note.contentText.slice(0, 120) || "Empty note"}
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

function NoteRow({ note, onClick }: { note: Note; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-[var(--surface-2)] transition-colors group text-left">
      <FileText size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors truncate">{note.title}</div>
        <div className="text-[0.786rem] text-[var(--text-tertiary)] truncate">{note.contentText.slice(0, 80) || "Empty note"}</div>
      </div>
      <span className="text-[0.786rem] text-[var(--text-tertiary)] flex-shrink-0 tabular-nums">{formatRelative(note.updatedAt)}</span>
    </button>
  );
}

function RecentActivityFeed({ activityByDay }: { activityByDay: ActivityGroup[] }) {
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

function ProgressRing({ percent, size }: { percent: number; size: number }) {
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDash = circumference - (percent / 100) * circumference;
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} stroke="var(--border)" strokeWidth="4" fill="none" />
      <circle cx={size / 2} cy={size / 2} r={radius} stroke="var(--accent)" strokeWidth="4" fill="none"
        strokeDasharray={circumference} strokeDashoffset={strokeDash} strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.5s ease" }} />
      <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle"
        style={{ transform: "rotate(90deg)", transformOrigin: "50% 50%", fontSize: 11, fontWeight: 700, fill: "var(--text-primary)" }}>
        {percent}%
      </text>
    </svg>
  );
}
