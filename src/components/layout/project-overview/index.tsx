"use client";

import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  FileText, Kanban, Calendar,
  AlertCircle, Activity, BarChart2, Clock, Pin, Zap,
} from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { ProjectIcon } from "@/lib/workspace-icons";
import { cn, formatDate, STATUS_COLORS } from "@/lib/utils";
import { CairnEvents, revealNote, revealCard } from "@/lib/events";
import { Badge } from "@/components/ui/badge";
import { OverflowPill } from "@/components/ui/overflow-pill";
import { sortTagsByUsage, capTags } from "@/lib/tag-utils";
import { Button } from "@/components/ui/button";
import { useProjectMetrics } from "./useProjectMetrics";
import { ChatInputArea } from "@/components/chat/ChatInputArea";
import type { SuggestionItem } from "@/components/chat/ChatInput";
import type { SessionKind } from "@/types";
import { ProgressRing, CollapsibleSection } from "./primitives";
import { ToolsAttachPanel } from "./ToolsAttachPanel";
import { ProjectSettingsButton } from "./project-settings";
import { SessionBrowser } from "@/components/agent/SessionBrowser";
import { useAgentSessionActions } from "@/components/agent/useAgentSessionActions";
import {
  TaskFlowCard,
  PriorityBreakdownCard,
  DueCard,
  PinnedNoteCard,
  NoteRow,
  RecentActivityFeed,
  RecentAutomationRunsFeed,
  MiniHealthBar,
} from "./sections";

export function ProjectOverview() {
  const { activeProjectId, activeWorkspaceId, activeSessionId, activeChatThreadId, projects, openSession, setView, setSessionPresentation, chatOpen, setSettingsSection, overviewCollapsedSections, toggleOverviewSection, recentProjectRuns, fetchRecentProjectRuns } = useCairnStore(useShallow((s) => ({
    activeProjectId: s.activeProjectId,
    activeWorkspaceId: s.activeWorkspaceId,
    activeSessionId: s.activeSessionId,
    activeChatThreadId: s.activeChatThreadId,
    projects:        s.projects,
    openSession:     s.openSession,
    setView:         s.setView,
    setSessionPresentation: s.setSessionPresentation,
    chatOpen:        s.chatOpen,
    setSettingsSection: s.setSettingsSection,
    overviewCollapsedSections: s.overviewCollapsedSections,
    toggleOverviewSection: s.toggleOverviewSection,
    recentProjectRuns: s.recentProjectRuns,
    fetchRecentProjectRuns: s.fetchRecentProjectRuns,
  })));
  const project = projects.find((p) => p.id === activeProjectId);
  const metrics = useProjectMetrics(activeProjectId);
  const { handleNewSession: handleNewAgentSession } = useAgentSessionActions();
  const [sessionKind, setSessionKind] = useState<"chat" | "coding">("chat");

  // Fetch recent automation runs for the active project so the "Recent run
  // results" feed on the Overview has data. Re-fetches on project/workspace
  // switch. Stale-result guard is inside the slice action.
  useEffect(() => {
    if (!activeWorkspaceId || !activeProjectId) return;
    void fetchRecentProjectRuns(activeWorkspaceId, activeProjectId);
  }, [activeWorkspaceId, activeProjectId, fetchRecentProjectRuns]);

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
    if (sessionKind === "coding" && project?.codeDirectory) {
      void handleNewAgentSession("center", text);
      return;
    }
    setView("chat");
    window.dispatchEvent(CairnEvents.openChat(text, true));
  }

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

  // Per-project collapse state (presence in the map = collapsed; sections
  // default expanded). Wired to the CollapsibleSection primitive; persistence
  // lives in the UI store.
  const isCollapsed = (section: string) => Boolean(overviewCollapsedSections[`${project.id}:${section}`]);
  const toggleSection = (section: string) => toggleOverviewSection(project.id, section);
  const recentActivityCount = activityByDay.reduce((n, g) => n + g.items.length, 0);

  // Header tags — sorted by usage and capped so a heavily-tagged project
  // doesn't blow up the header row; the rest collapse behind a "+N" pill.
  const headerTags = capTags(sortTagsByUsage(projectTags, notes, allCards), 4);

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
            <div className="flex items-center gap-2.5 mb-1.5 w-full min-w-0">
              <ProjectIcon name={project.icon} size={26} className="text-[var(--text-secondary)] flex-shrink-0" />
              <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight truncate flex-1 min-w-0">
                {project.name}
              </h1>
              <ProjectSettingsButton project={project} />
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
              {headerTags.shown.map((tag) => tag && <Badge key={tag.id} color={tag.color} size="xs">{tag.name}</Badge>)}
              {headerTags.hidden.length > 0 && (
                <OverflowPill count={headerTags.hidden.length} names={headerTags.hidden.map((t) => t.name)} />
              )}
            </div>
          </div>
          <div className="flex-shrink-0 flex flex-col items-center gap-1.5">
            <ProgressRing percent={completionRate} size={68} />
            <span className="text-[0.786rem] text-[var(--text-tertiary)]">
              {doneCards.length}/{allCards.length} done
            </span>
          </div>
        </div>

        {/* ── Attention queue: pending approvals from background automations ── */}

        {/* ── Due soon ──────────────────────────────────────── */}
        {dueCards.length > 0 && (
          <CollapsibleSection
            title="Due soon"
            icon={<Clock size={12} />}
            collapsed={isCollapsed("due")}
            onToggle={() => toggleSection("due")}
            collapsedView={
              <span className="text-[0.786rem] text-[var(--text-secondary)]">
                {dueCards.length} due{overdueCount > 0 && <span className="text-[var(--danger)]"> · {overdueCount} overdue</span>}
              </span>
            }
          >
            <div className="space-y-2">
              {dueCards.map((card) => (
                <DueCard key={card.id} card={card} columns={columns} today={today}
                  onClick={() => revealCard(setView, card.id)} />
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* ── Health (stats + column breakdown + priority + board) ── */}
        {(hasAnyCategorised || columns.length > 0) && (
          <CollapsibleSection
            title="Health"
            icon={<BarChart2 size={12} />}
            action={{ label: "View board", onClick: () => setView("board") }}
            collapsed={isCollapsed("health")}
            onToggle={() => toggleSection("health")}
            collapsedView={
              <div className="flex flex-col gap-2">
                <MiniHealthBar columns={columns} allCards={allCards} doneCount={doneCards.length} />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.786rem] text-[var(--text-secondary)]">
                  <span className="inline-flex items-center gap-1.5"><FileText size={11} className="text-[var(--info)]" /> {notes.length} notes</span>
                  <span className="inline-flex items-center gap-1.5"><Kanban size={11} className="text-[var(--accent)]" /> {openCards.length} open</span>
                  <span className={cn("inline-flex items-center gap-1.5", overdueCount > 0 ? "text-[var(--danger)]" : "text-[var(--text-secondary)]")}>
                    <AlertCircle size={11} /> {overdueCount} overdue
                  </span>
                </div>
              </div>
            }
          >
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.786rem] text-[var(--text-secondary)]">
                <span className="inline-flex items-center gap-1.5"><FileText size={11} className="text-[var(--info)]" /> {notes.length} notes</span>
                <span className={cn("inline-flex items-center gap-1.5", overdueCount > 0 ? "text-[var(--danger)]" : "text-[var(--text-secondary)]")}>
                  <AlertCircle size={11} /> {overdueCount} overdue
                </span>
              </div>
              <TaskFlowCard columns={columns} allCards={allCards} setView={setView} />
              <PriorityBreakdownCard priorityCounts={priorityCounts} hasAnyCategorised={hasAnyCategorised} setView={setView} />
            </div>
          </CollapsibleSection>
        )}

        {/* ── Pinned notes ──────────────────────────────────── */}
        {pinnedNotes.length > 0 && (
          <CollapsibleSection
            title="Pinned"
            icon={<Pin size={12} />}
            action={{ label: "All notes", onClick: () => setView("notes") }}
            collapsed={isCollapsed("pinned")}
            onToggle={() => toggleSection("pinned")}
            collapsedView={<span className="text-[0.786rem] text-[var(--text-secondary)]">{pinnedNotes.length} pinned</span>}
          >
            <div className="space-y-1">
              {pinnedNotes.map((note) => (
                <PinnedNoteCard key={note.id} note={note}
                  onClick={() => revealNote(setView, note.id)} />
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* ── Recent notes ──────────────────────────────────── */}
        {recentNotes.length > 0 && (
          <CollapsibleSection
            title="Recent notes"
            icon={<FileText size={12} />}
            action={{ label: "All notes", onClick: () => setView("notes") }}
            collapsed={isCollapsed("recent-notes")}
            onToggle={() => toggleSection("recent-notes")}
            collapsedView={<span className="text-[0.786rem] text-[var(--text-secondary)]">{recentNotes.length} notes</span>}
          >
            <div className="space-y-0.5">
              {recentNotes.map((note) => (
                <NoteRow key={note.id} note={note}
                  onClick={() => revealNote(setView, note.id)} />
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* ── Recent activity ───────────────────────────────── */}
        {activityByDay.length > 0 && (
          <CollapsibleSection
            title="Recent activity"
            icon={<Activity size={12} />}
            collapsed={isCollapsed("activity")}
            onToggle={() => toggleSection("activity")}
            collapsedView={<span className="text-[0.786rem] text-[var(--text-secondary)]">{recentActivityCount} item{recentActivityCount === 1 ? "" : "s"}</span>}
          >
            <RecentActivityFeed activityByDay={activityByDay} />
          </CollapsibleSection>
        )}

        {/* ── Recent automation run results ─────────────────── */}
        {recentProjectRuns.length > 0 && (
          <CollapsibleSection
            title="Recent runs"
            icon={<Zap size={12} />}
            action={{ label: "All automations", onClick: () => setView("automations") }}
            collapsed={isCollapsed("runs")}
            onToggle={() => toggleSection("runs")}
            collapsedView={<span className="text-[0.786rem] text-[var(--text-secondary)]">{recentProjectRuns.length} run{recentProjectRuns.length === 1 ? "" : "s"}</span>}
          >
            <RecentAutomationRunsFeed
              runs={recentProjectRuns}
              setView={setView}
            />
          </CollapsibleSection>
        )}

        {/* ── Tools (per-project attach) ────────────────────── */}
        <ToolsAttachPanel
          projectId={project.id}
          workspaceId={project.workspaceId}
          onManage={() => { setSettingsSection("tools"); setView("settings"); }}
          collapsed={isCollapsed("tools")}
          onToggle={() => toggleSection("tools")}
        />

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

        {/* ── Recent sessions ─────────────────────────────────── */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center justify-between mb-2.5">
            <div>
              <h2 className="text-[0.786rem] font-semibold text-[var(--text-primary)]">Recent sessions</h2>
              <p className="text-[0.643rem] text-[var(--text-tertiary)]">Chat and coding history for this project</p>
            </div>
            <button type="button" onClick={() => {
              if (activeChatThreadId) openSession(activeChatThreadId, "chat", "center");
              else setSessionPresentation("center");
              setView("chat");
            }} className="text-[0.643rem] text-[var(--accent)] hover:text-[var(--text-primary)]">Open sessions</button>
          </div>
          <SessionBrowser
            variant="preview"
            limit={4}
            activeSessionId={activeSessionId}
            onActivate={(_sessionId, _kind: SessionKind) => {
              setSessionPresentation("center");
              setView("chat");
            }}
          />
        </section>

        </div>
      </div>

      {/* Pinned bottom Chat Input (shown only when chat sidebar is closed) */}
      {!chatOpen && (
        <div ref={bottomBarRef} className="absolute bottom-0 left-0 right-0 p-6 overview-chat-overlay pointer-events-none z-10">
          <div className="max-w-3xl mx-auto pointer-events-auto">
            {project.codeDirectory && (
              <div className="flex items-center gap-1 mb-2">
                <button
                  type="button"
                  onClick={() => setSessionKind("chat")}
                  className={cn(
                    "rounded-md px-2 py-1 text-[0.643rem] transition-colors",
                    sessionKind === "chat"
                      ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                      : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]",
                  )}
                >
                  Chat
                </button>
                <button
                  type="button"
                  onClick={() => setSessionKind("coding")}
                  className={cn(
                    "rounded-md px-2 py-1 text-[0.643rem] transition-colors",
                    sessionKind === "coding"
                      ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                      : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]",
                  )}
                >
                  Coding agent
                </button>
              </div>
            )}
            <ChatInputArea
              ref={chatInputRef}
              value={chatInput}
              onChange={setChatInput}
              onSubmit={() => handleSendChat()}
              placeholder={sessionKind === "coding" ? "Describe what you want the coding agent to do" : "What would you like to do today?"}
              variant="overview"
              showSparkles
              suggestions={mentionSuggestions}
              providerModelTarget="ai"
              statusText="Shift+Enter for new line · Enter to send"
            />
          </div>
        </div>
      )}
    </div>
  );
}
