"use client";

import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  FileText, Kanban, Calendar,
  AlertCircle, Activity, BarChart2, Pencil, Check, FolderOpen, Terminal, Clock, Pin,
} from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { ProjectIcon, WORKSPACE_ICONS } from "@/lib/workspace-icons";
import { cn, formatDate, STATUS_COLORS } from "@/lib/utils";
import { PRIORITY_CSS_COLORS, PRIORITY_OPTIONS, PROJECT_STATUS_OPTIONS, STATUS_CSS_COLORS } from "@/lib/constants";
import { CairnEvents, revealNote, revealCard, revealColumn } from "@/lib/events";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ProjectStatus, Priority } from "@/types";
import { useProjectMetrics } from "./useProjectMetrics";
import { ChatInput, SuggestionItem } from "@/components/chat/ChatInput";
import { SectionHeader, StatCard, ProgressRing } from "./primitives";
import { ToolsAttachPanel } from "./ToolsAttachPanel";
import {
  ColumnBreakdownCard,
  PriorityBreakdownCard,
  ColumnPill,
  DueCard,
  PinnedNoteCard,
  NoteRow,
  RecentActivityFeed,
} from "./sections";

export function ProjectOverview() {
  const { activeProjectId, projects, setView, updateProject, chatOpen, setSettingsSection } = useCairnStore(useShallow((s) => ({
    activeProjectId: s.activeProjectId,
    projects:        s.projects,
    setView:         s.setView,
    updateProject:   s.updateProject,
    chatOpen:        s.chatOpen,
    setSettingsSection: s.setSettingsSection,
  })));
  const project = projects.find((p) => p.id === activeProjectId);
  const metrics = useProjectMetrics(activeProjectId);

  const [chatInput, setChatInput] = useState("");
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  // The pinned bottom chat bar (shown only when the chat sidebar is closed) is
  // absolutely positioned, so it doesn't reserve layout space. Measure its
  // height and pad the scroll content by that amount so the last items can
  // scroll fully clear of the bar instead of being trapped behind it. The bar
  // grows as the textarea expands, so a fixed pb-* class isn't reliable.
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const [bottomBarHeight, setBottomBarHeight] = useState(0);
  useEffect(() => {
    const el = bottomBarRef.current;
    if (!el) { setBottomBarHeight(0); return; }
    const ro = new ResizeObserver(() => setBottomBarHeight(el.offsetHeight));
    ro.observe(el);
    setBottomBarHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [chatOpen]);

  const mentionSuggestions = useMemo<SuggestionItem[]>(() => {
    if (!metrics) return [];
    const items: SuggestionItem[] = [];
    for (const note of metrics.notes) {
      items.push({ id: note.id, type: "note", title: note.title, subtitle: "Note" });
    }
    for (const card of metrics.allCards) {
      items.push({ id: card.id, type: "card", title: card.title, subtitle: `Task - ${card.priority}` });
    }
    return items;
  }, [metrics]);

  function handleSendChat() {
    const text = chatInput.trim();
    if (!text) return;
    setChatInput("");
    setView("chat");
    window.dispatchEvent(CairnEvents.openChat(text, true));
  }

  const [editOpen, setEditOpen] = useState(false);
  const [editIcon, setEditIcon] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editStatus, setEditStatus] = useState<ProjectStatus | "">("");
  const [editPriority, setEditPriority] = useState<Priority | "">("");
  const [codeDirInput, setCodeDirInput] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editOpen && project) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditIcon(project.icon ?? "");
      setEditDesc(project.description ?? "");
      setEditStatus(project.status);
      setEditPriority(project.priority);
    }
  }, [editOpen, project]);

  // Keep codeDirInput in sync when project changes externally
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCodeDirInput(project?.codeDirectory ?? "");
  }, [project?.codeDirectory]);

  async function handlePickCodeDir() {
    const result = await window.electron?.agent.pickDirectory() as { data: string | null } | undefined;
    if (result?.data && project) {
      setCodeDirInput(result.data);
      updateProject(project.id, { codeDirectory: result.data });
    }
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
      status: editStatus || undefined,
      priority: editPriority || undefined,
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
    <div className="flex-1 flex flex-col min-h-0 relative w-full min-w-0 overflow-x-hidden">
      <div className="flex-1 overflow-y-auto overflow-x-hidden w-full min-w-0">
        <div
          className="max-w-3xl mx-auto px-4 pt-4 md:px-8 md:pt-8 space-y-6 md:space-y-8 pb-8"
          style={{ paddingBottom: bottomBarHeight ? bottomBarHeight + 32 : undefined }}
        >

        {/* ── Header ─────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row items-start justify-between gap-4 sm:gap-6 w-full min-w-0">
          <div className="flex-1 min-w-0 w-full">
            <div className="group flex items-center gap-2.5 mb-1.5 w-full min-w-0">
              <ProjectIcon name={project.icon} size={26} className="text-[var(--text-secondary)] flex-shrink-0" />
              <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight truncate flex-1 min-w-0">
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
                        className="w-full px-2 py-1.5 text-xs rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] resize-none"
                      />
                    </div>
                    {/* Status */}
                    <div>
                      <label className="text-[0.786rem] text-[var(--text-tertiary)] block mb-1">Status</label>
                      <div className="grid grid-cols-2 gap-1">
                        {PROJECT_STATUS_OPTIONS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setEditStatus(s)}
                            className={cn(
                              "flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-colors capitalize",
                              editStatus === s
                                ? "bg-[var(--surface)] ring-1 ring-[var(--accent)] text-[var(--text-primary)]"
                                : "text-[var(--text-tertiary)] hover:bg-[var(--surface)]"
                            )}
                          >
                            <span
                              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                              style={{ background: STATUS_CSS_COLORS[s] ?? "var(--text-tertiary)" }}
                            />
                            {s.replace("_", " ")}
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* Priority */}
                    <div>
                      <label className="text-[0.786rem] text-[var(--text-tertiary)] block mb-1">Priority</label>
                      <div className="grid grid-cols-2 gap-1">
                        {PRIORITY_OPTIONS.map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setEditPriority(p)}
                            className={cn(
                              "flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs capitalize transition-colors",
                              editPriority === p
                                ? "bg-[var(--surface)] ring-1 ring-[var(--accent)] text-[var(--text-primary)]"
                                : "text-[var(--text-tertiary)] hover:bg-[var(--surface)]"
                            )}
                          >
                            <span
                              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                              style={{ background: PRIORITY_CSS_COLORS[p] ?? "var(--text-tertiary)" }}
                            />
                            {p}
                          </button>
                        ))}
                      </div>
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
              <p className="text-sm text-[var(--text-secondary)] mb-3 max-w-full break-words">{project.description}</p>
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
        <div className="flex items-center gap-2 group w-full min-w-0">
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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

        {/* ── Tools (per-project attach) ────────────────────── */}
        <ToolsAttachPanel projectId={project.id} workspaceId={project.workspaceId} onManage={() => { setSettingsSection("tools"); setView("settings"); }} />

        {/* ── Board snapshot ────────────────────────────────── */}
        {columns.length > 0 && (
          <section>
            <SectionHeader title="Board" icon={<Kanban size={12} />} action={{ label: "View board", onClick: () => setView("board") }} />
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {columns.map((col) => (
                <ColumnPill key={col.id} column={col} cards={allCards.filter((c) => c.columnId === col.id)}
                  onClick={() => revealColumn(setView, col.id)} />
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
                  onClick={() => revealCard(setView, card.id)} />
              ))}
            </div>
          </section>
        )}

        {/* ── Pinned notes ──────────────────────────────────── */}
        {pinnedNotes.length > 0 && (
          <section>
            <SectionHeader title="Pinned" icon={<Pin size={12} />} action={{ label: "All notes", onClick: () => setView("notes") }} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {pinnedNotes.map((note) => (
                <PinnedNoteCard key={note.id} note={note}
                  onClick={() => revealNote(setView, note.id)} />
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
                  onClick={() => revealNote(setView, note.id)} />
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
        <div ref={bottomBarRef} className="absolute bottom-0 left-0 right-0 p-6 overview-chat-overlay pointer-events-none z-10">
          <div className="max-w-3xl mx-auto pointer-events-auto">
            <ChatInput
              ref={chatInputRef}
              value={chatInput}
              onChange={setChatInput}
              onSubmit={handleSendChat}
              placeholder="What would you like to do today?"
              variant="overview"
              showSparkles
              suggestions={mentionSuggestions}
            />
          </div>
        </div>
      )}
    </div>
  );
}
