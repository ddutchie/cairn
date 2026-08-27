"use client";

/*
THESIS: Overview as instrument — a tactile control surface that answers "what needs attention right now?" in under 5s; it refuses the collapsible-soup where every section is a same-weight drawer hiding urgency.
OWN-WORLD: Cairn dark tokens (#0d0d0d / #141414 / #8faf6f) + Geist/Mono + Newsreader italic; gunmetal instrument grammar (2px hairlines, knurled knob, pill filters, keycap keys) — sage calm, not neon.
STORY: Returning owner instantly sees bottle-neck (Review holds 6), 2 overdue + 1 today as tappable queue, and 4 insight KPIs vs last week; one tap opens the exact card or board column.
FIRST VIEWPORT: Left editorial masthead (project icon + "Cairn — review holds 6" + pills) paired with 74px knob instrument (68% + meter ticks + 2 actions); sticky focus bar directly below.
FORM: Grounded #4 control-room console fused with creator-hardware bench — seed 4c0ec1ca; split-flap per-row state + busytown labeled continuity kept as discipline.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
*/

import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  FileText,
  Kanban,
  Calendar,
  AlertTriangle,
  Clock3,
  Pin,
  Zap,
  Activity,
  LayoutDashboard,
  Diamond,
  MessageSquare,
  Code2,
  Folder,
  FolderCode,
  Wrench,
} from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { ProjectIcon } from "@/lib/workspace-icons";
import { cn, formatDate, STATUS_COLORS, getDueDateStatus, parseIsoLocal, formatRelative } from "@/lib/utils";
import { COLUMN_COLORS, PRIORITY_CSS_COLORS } from "@/lib/constants";
import { CairnEvents, revealNote, revealCard } from "@/lib/events";
import { Badge } from "@/components/ui/badge";
import { OverflowPill } from "@/components/ui/overflow-pill";
import { sortTagsByUsage, capTags } from "@/lib/tag-utils";
import { Button } from "@/components/ui/button";
import { useProjectMetrics } from "./useProjectMetrics";
import { ChatInputArea } from "@/components/chat/ChatInputArea";
import type { SuggestionItem } from "@/components/chat/ChatInput";
import { ProjectSettingsButton } from "./project-settings";
import { SessionBrowser } from "@/components/agent/SessionBrowser";
import { useAgentSessionActions } from "@/components/agent/useAgentSessionActions";
import { CollapsibleSection } from "./primitives";
import { ConnectorLogo } from "@/components/settings/tools/ConnectorLogo";
import { useCommunityConnectorMap } from "@/components/chat/chat-panel/connector-context";
import { Tooltip } from "@/components/ui/tooltip";
import {
  RecentActivityFeed,
  RecentAutomationRunsFeed,
} from "./sections";
import type { TaskCard, ToolType } from "@/types";
import { ProjectHealthRadar, useRadarAxes } from "./radar";

type FocusFilter = "all" | "today" | "overdue" | "pinned";

function useTilt(targetRef: React.RefObject<HTMLDivElement | null>) {
  const [active, setActive] = useState(false);
  const [transform, setTransform] = useState<React.CSSProperties>({});
  const raf = useRef<number | null>(null);
  const onMove = useCallback((e: React.MouseEvent) => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = targetRef.current;
    if (!el) return;
    if (!active) setActive(true);
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      const rx = ((e.clientY - r.top - r.height / 2) / (r.height / 2)) * -2.2;
      const ry = ((e.clientX - r.left - r.width / 2) / (r.width / 2)) * 2.8;
      setTransform({ transform: `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) scale(1.012)`, transition: "transform 0.08s linear" });
    });
  }, [active, targetRef]);
  const onLeave = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    setActive(false);
    setTransform({ transform: "perspective(900px) rotateX(0) rotateY(0) scale(1)", transition: "transform 0.55s cubic-bezier(.23,1,.32,1)" });
  }, []);
  return { transform, onMove, onLeave, active };
}

function HeaderToolIcons({ projectId, workspaceId }: { projectId: string; workspaceId: string }) {
  const { mcpServers, customServices, toolAttachments, fetchTools, fetchToolAttachments, setToolAttachment, clearToolAttachment } =
    useCairnStore(
      useShallow((s) => ({
        mcpServers: s.mcpServers,
        customServices: s.customServices,
        toolAttachments: s.toolAttachments,
        fetchTools: s.fetchTools,
        fetchToolAttachments: s.fetchToolAttachments,
        setToolAttachment: s.setToolAttachment,
        clearToolAttachment: s.clearToolAttachment,
      })),
    );
  const connectorMap = useCommunityConnectorMap();

  useEffect(() => {
    if (workspaceId) void fetchTools(workspaceId);
  }, [workspaceId, fetchTools]);
  useEffect(() => {
    if (projectId) void fetchToolAttachments(projectId);
  }, [projectId, fetchToolAttachments]);

  const enabledMcp = mcpServers.filter((s) => s.enabled);
  const enabledSvc = customServices.filter((s) => s.enabled);
  const total = enabledMcp.length + enabledSvc.length;
  if (total === 0) return null;

  const isAttached = (toolType: ToolType, toolId: string) =>
    toolAttachments.some((a) => a.projectId === projectId && a.toolType === toolType && a.toolId === toolId && a.enabled);
  const toggle = (toolType: ToolType, toolId: string, on: boolean) => {
    if (on) setToolAttachment(projectId, toolType, toolId, true);
    else clearToolAttachment(projectId, toolType, toolId);
  };

  const items: Array<{ key: string; name: string; kind: "mcp" | "service"; id: string; connectorKey: string }> = [
    ...enabledMcp.map((s) => ({ key: `mcp-${s.id}`, name: s.name, kind: "mcp" as const, id: s.id, connectorKey: `mcp__${s.id}__` })),
    ...enabledSvc.map((s) => ({ key: `svc-${s.id}`, name: s.name, kind: "service" as const, id: s.id, connectorKey: `svc__${s.id}__` })),
  ];

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span className="inline-flex items-center gap-1 text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)]">
        <Wrench size={10} /> Tools
      </span>
      <span className="flex items-center gap-1">
        {items.slice(0, 6).map((it) => {
          const attached = isAttached(it.kind, it.id);
          const meta = connectorMap[it.connectorKey];
          return (
            <Tooltip key={it.key} content={it.name}>
              <button
                type="button"
                onClick={() => toggle(it.kind, it.id, !attached)}
                aria-pressed={attached}
                className={cn(
                  "w-7 h-7 rounded-full grid place-items-center border transition-all",
                  attached
                    ? "bg-[var(--accent-dim)] border-[var(--accent)] shadow-sm ring-1 ring-[var(--accent)]/30"
                    : "bg-[var(--surface)] border-[var(--border)] hover:border-[var(--muted)] hover:bg-[var(--surface-2)]",
                )}
              >
                <ConnectorLogo iconSvg={meta?.iconSvg} kind={it.kind} color={meta?.brandColor} size={16} />
              </button>
            </Tooltip>
          );
        })}
        {items.length > 6 && <span className="text-xs text-[var(--text-tertiary)]">+{items.length - 6}</span>}
      </span>
    </span>
  );
}

export function ProjectOverview() {
  const {
    activeProjectId,
    activeWorkspaceId,
    activeSessionId,
    activeChatThreadId,
    projects,
    openSession,
    setView,
    setSessionPresentation,
    chatOpen,
    recentProjectRuns,
    fetchRecentProjectRuns,
    overviewCollapsedSections,
    toggleOverviewSection,
  } = useCairnStore(
    useShallow((s) => ({
      activeProjectId: s.activeProjectId,
      activeWorkspaceId: s.activeWorkspaceId,
      activeSessionId: s.activeSessionId,
      activeChatThreadId: s.activeChatThreadId,
      projects: s.projects,
      openSession: s.openSession,
      setView: s.setView,
      setSessionPresentation: s.setSessionPresentation,
      chatOpen: s.chatOpen,
      recentProjectRuns: s.recentProjectRuns,
      fetchRecentProjectRuns: s.fetchRecentProjectRuns,
      overviewCollapsedSections: s.overviewCollapsedSections,
      toggleOverviewSection: s.toggleOverviewSection,
    })),
  );
  const project = projects.find((p) => p.id === activeProjectId);
  const metrics = useProjectMetrics(activeProjectId);
  const { handleNewSession: handleNewAgentSession } = useAgentSessionActions();
  const [sessionKind, setSessionKind] = useState<"chat" | "coding">("chat");
  const [focus, setFocus] = useState<FocusFilter>("all");

  useEffect(() => {
    if (!activeWorkspaceId || !activeProjectId) return;
    void fetchRecentProjectRuns(activeWorkspaceId, activeProjectId);
  }, [activeWorkspaceId, activeProjectId, fetchRecentProjectRuns]);

  const [chatInput, setChatInput] = useState("");
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const [bottomBarHeight, setBottomBarHeight] = useState(0);
  useEffect(() => {
    const el = bottomBarRef.current;
    if (!el) {
      setBottomBarHeight(0);
      return;
    }
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
      items.push({ id: card.id, type: "card", title: card.title, subtitle: `Task · ${card.priority}` });
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

  // Derived with safe defaults for hook order - hooks must be called before early return
  const notes = useMemo(() => metrics?.notes ?? [], [metrics]);
  const columns = useMemo(() => metrics?.columns ?? [], [metrics]);
  const allCards = useMemo(() => metrics?.allCards ?? [], [metrics]);
  const doneCards = useMemo(() => metrics?.doneCards ?? [], [metrics]);
  const openCards = useMemo(() => metrics?.openCards ?? [], [metrics]);
  const completionRate = metrics?.completionRate ?? 0;
  const today = useMemo(() => metrics?.today ?? new Date(), [metrics]);
  const dueCards = useMemo(() => metrics?.dueCards ?? [], [metrics]);
  const overdueCount = metrics?.overdueCount ?? 0;
  const priorityCounts = useMemo(() => metrics?.priorityCounts ?? { urgent: 0, high: 0, medium: 0, low: 0 }, [metrics]);
  const pinnedNotes = useMemo(() => metrics?.pinnedNotes ?? [], [metrics]);
  const recentNotes = useMemo(() => metrics?.recentNotes ?? [], [metrics]);
  const projectTags = useMemo(() => metrics?.projectTags ?? [], [metrics]);
  const activityByDay = useMemo(() => metrics?.activityByDay ?? [], [metrics]);

  const headerTags = capTags(sortTagsByUsage(projectTags, notes, allCards), 4);

  // ---- derived headline insights ----
  const todayCount = dueCards.filter((c) => getDueDateStatus(c.dueDate) === "today").length;
  const needsAttention = overdueCount + todayCount;

  // bottleneck: column with most open cards (excluding done)
  const doneColId = columns.find((c) => c.type === "done")?.id;
  const openColumns = columns.filter((c) => c.id !== doneColId);
  let bottleneck: { name: string; count: number } | null = null;
  if (openColumns.length > 0) {
    let max = -1;
    for (const col of openColumns) {
      const count = allCards.filter((c) => c.columnId === col.id).length;
      if (count > max) {
        max = count;
        bottleneck = { name: col.name, count };
      }
    }
  }

  // attention queue: overdue (by due asc) → today → upcoming (soonest future)
  const overdueCards = useMemo(() => dueCards.filter((c) => getDueDateStatus(c.dueDate) === "overdue"), [dueCards]);
  const todayCards = useMemo(() => dueCards.filter((c) => getDueDateStatus(c.dueDate) === "today"), [dueCards]);
  const upcomingCards = useMemo(() => dueCards.filter((c) => {
    const s = getDueDateStatus(c.dueDate);
    return s !== "overdue" && s !== "today";
  }), [dueCards]);
  const attentionQueue = useMemo<Array<{ card: TaskCard; label: string; tone: "overdue" | "today" | "upcoming" }>>(() => {
    const q: Array<{ card: TaskCard; label: string; tone: "overdue" | "today" | "upcoming" }> = [];
    if (overdueCards[0]) {
      const d = parseIsoLocal(overdueCards[0].dueDate!);
      d.setHours(0, 0, 0, 0);
      const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      q.push({
        card: overdueCards[0],
        label: `Overdue · ${Math.abs(days)}d`,
        tone: "overdue",
      });
    }
    if (todayCards[0] && q.length < 3) {
      q.push({ card: todayCards[0], label: "Due today", tone: "today" });
    }
    if (upcomingCards[0] && q.length < 3) {
      const d = parseIsoLocal(upcomingCards[0].dueDate!);
      d.setHours(0, 0, 0, 0);
      const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      q.push({
        card: upcomingCards[0],
        label: `Up next · in ${days}d`,
        tone: "upcoming",
      });
    }
    // fill to 3 with next overdue/today if still short
    if (q.length < 3 && overdueCards[1]) {
      const d = parseIsoLocal(overdueCards[1].dueDate!);
      d.setHours(0, 0, 0, 0);
      const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      q.push({ card: overdueCards[1], label: `Overdue · ${Math.abs(days)}d`, tone: "overdue" });
    }
    return q;
  }, [overdueCards, todayCards, upcomingCards, today]);

  const instrumentPct = completionRate;
  const instrumentDone = doneCards.length;
  const instrumentTotal = allCards.length;

  // filter-aware counts for bar label
  const focusCounts: Record<FocusFilter, number> = {
    all: openCards.length,
    today: todayCount,
    overdue: overdueCount,
    pinned: pinnedNotes.length,
  };

  const filteredQueue = useMemo(() => {
    if (!metrics) return [];
    if (focus === "all") return attentionQueue;
    if (focus === "overdue") return attentionQueue.filter((q) => q.tone === "overdue");
    if (focus === "today") return attentionQueue.filter((q) => q.tone === "today");
    return []; // pinned shows pinned notes instead, queue empty
  }, [attentionQueue, focus, metrics]);

  const filteredCards = useMemo(() => {
    if (!metrics) return [];
    if (focus === "overdue") return overdueCards;
    if (focus === "today") return todayCards;
    return openCards;
  }, [focus, openCards, overdueCards, todayCards, metrics]);

  const filteredPriorityCounts = useMemo(() => {
    if (!metrics) return { urgent: 0, high: 0, medium: 0, low: 0 };
    const cards = filteredCards;
    return {
      urgent: cards.filter((c) => c.priority === "urgent").length,
      high: cards.filter((c) => c.priority === "high").length,
      medium: cards.filter((c) => c.priority === "medium").length,
      low: cards.filter((c) => c.priority === "low").length,
    };
  }, [filteredCards, metrics]);

  const inProgressCol = columns.find((c) => c.type === "in_progress");
  const inProgressCount = inProgressCol ? allCards.filter((c) => c.columnId === inProgressCol.id).length : 0;
  const wipLimit = inProgressCol?.cardLimit;
  const wipStatus = wipLimit ? (inProgressCount > wipLimit ? "over" : inProgressCount === wipLimit ? "at limit" : "healthy") : null;

  const progressLabel = needsAttention > 0 ? "Progress · needs attention" : "Progress · on track";

  const radarAxes = useRadarAxes({
    completionRate,
    openCards,
    overdueCount,
    todayCount,
    notes,
    pinnedNotes,
    recentNotes,
    bottleneck,
    priorityCounts,
    columns,
    allCards,
    activityByDay,
  });

  const instrumentRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const priorityRef = useRef<HTMLDivElement>(null);
  const radarRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLDivElement>(null);
  const tiltInstrument = useTilt(instrumentRef);
  const tiltFlow = useTilt(flowRef);
  const tiltPriority = useTilt(priorityRef);
  const tiltRadar = useTilt(radarRef);
  const tiltNotes = useTilt(notesRef);

  const overviewContentId = "overview-content";
  const focusLabel: Record<FocusFilter, string> = {
    all: "All",
    today: "Due today",
    overdue: "Overdue",
    pinned: "Pinned",
  };
  const isCollapsed = (key: string) => Boolean(overviewCollapsedSections[`${project?.id ?? ""}:${key}`]);
  const toggleSection = (key: string) => {
    if (!project) return;
    toggleOverviewSection(project.id, key);
  };

  // Focus bar lift — dropshadow when sticky
  const focusBarRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [isFocusPinned, setIsFocusPinned] = useState(false);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const bar = focusBarRef.current;
    if (!sentinel || !bar) return;
    const scrollRoot = bar.closest(".overflow-y-auto") as HTMLElement | null;
    const io = new IntersectionObserver(
      ([entry]) => setIsFocusPinned(!entry.isIntersecting),
      { root: scrollRoot, threshold: 0, rootMargin: "-8px 0px 0px 0px" }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);

  // columns sorted already via hook; ensure done last for display
  const flowColumns = [...columns].sort((a, b) => {
    const order = ["backlog", "todo", "in_progress", "review", "done"];
    return order.indexOf(a.type) - order.indexOf(b.type);
  });

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

  return (
    <div className="flex-1 flex flex-col min-h-0 relative w-full min-w-0 overflow-x-hidden">
      <div className="flex-1 overflow-y-auto overflow-x-hidden w-full min-w-0">
        <div
          className="max-w-[1240px] mx-auto w-full px-4 pt-4 md:px-7 md:pt-7 pb-8"
          style={{ paddingBottom: bottomBarHeight ? bottomBarHeight + 32 : undefined }}
        >
          {/* ── masthead — card wraps below on narrow, both full-width when stacked ── */}
          <div className="flex flex-col lg:flex-row flex-wrap gap-5 items-start mb-4">
            <div className="flex gap-4 items-start min-w-0 flex-1 min-w-[280px] w-full lg:w-auto">
              <div
                className="w-[52px] h-[52px] rounded-xl flex items-center justify-center flex-shrink-0 border border-[var(--border)]"
                style={{
                  background: "linear-gradient(180deg, var(--surface-2), var(--surface-3))",
                  boxShadow: "0 4px 12px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.06)",
                  color: "var(--text-secondary)",
                }}
                aria-hidden="true"
              >
                <ProjectIcon name={project.icon} size={22} />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-[1.75rem] md:text-[2rem] font-bold tracking-tight leading-[0.95] truncate">
                  {project.name}{" "}
                  <span className="font-normal italic" style={{ fontFamily: "var(--font-display)", color: "var(--accent)", letterSpacing: "-0.02em" }}>
                    {bottleneck ? `— ${bottleneck.name.toLowerCase()} holds ${bottleneck.count}` : `— ${instrumentPct}% complete`}
                  </span>
                </h1>
                {(() => {
                  if (project.description?.trim()) {
                    return (
                      <p className="text-sm text-[var(--text-secondary)] mt-2 max-w-[48ch] leading-[1.55] break-words">
                        {project.description}
                      </p>
                    );
                  }
                  const recent = activityByDay[0]?.items[0];
                  const ctxLine = (() => {
                    if (needsAttention > 0) return `${needsAttention} needing attention · ${bottleneck ? `${bottleneck.count} in ${bottleneck.name}` : `${openCards.length} open`} · ${notes.length} notes`;
                    if (bottleneck) return `${bottleneck.name} is the bottleneck — ${bottleneck.count} of ${openCards.length} open · ${notes.length} notes · ${pinnedNotes.length} pinned`;
                    if (notes.length) return `${notes.length} notes · ${recent ? `last edit ${formatRelative(recent.updatedAt)}` : "no recent activity"}`;
                    return "Add notes and tasks to see your project context here";
                  })();
                  return <p className="text-sm text-[var(--text-secondary)] mt-2 max-w-[52ch] leading-[1.55] break-words">{ctxLine}</p>;
                })()}
                <div className="flex items-center gap-2 flex-wrap mt-3">
                  <span
                    className={cn(
                      "text-xs font-medium px-2 py-0.5 rounded-full border border-[var(--border)]",
                      STATUS_COLORS[project.status],
                    )}
                  >
                    {project.status.replace("_", " ")}
                  </span>
                  {project.dueDate && (
                    <span className="inline-flex items-center gap-1 text-xs text-[var(--text-tertiary)]">
                      <Calendar size={10} />
                      {formatDate(project.dueDate)}
                    </span>
                  )}
                  {headerTags.shown.map(
                    (tag) => tag && <Badge key={tag.id} color={tag.color} size="xs">{tag.name}</Badge>,
                  )}
                  {headerTags.hidden.length > 0 && (
                    <OverflowPill count={headerTags.hidden.length} names={headerTags.hidden.map((t) => t.name)} />
                  )}
                </div>
                {/* at-a-glance: code folder + tool toggles — fills header emptiness, tools no longer need bottom panel */}
                <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                  {project.codeDirectory ? (
                    <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]">
                      <FolderCode size={12} className="text-[var(--accent)]" />
                      <span className="truncate max-w-[16ch]">{project.codeDirectory.split("/").pop() || "Code"}</span>
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] ml-0.5" aria-hidden="true" />
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-dashed border-[var(--border)] bg-transparent text-[var(--text-tertiary)]">
                      <Folder size={12} /> No code folder
                    </span>
                  )}
                  <HeaderToolIcons projectId={project.id} workspaceId={project.workspaceId} />
                </div>
              </div>
              <div className="hidden sm:block lg:hidden">
                <ProjectSettingsButton project={project} />
              </div>
              <div className="hidden lg:flex">
                <ProjectSettingsButton project={project} />
              </div>
            </div>

            {/* instrument — lift + tilt on hover */}
            <div
              ref={instrumentRef}
              onMouseMove={tiltInstrument.onMove}
              onMouseLeave={tiltInstrument.onLeave}
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 relative overflow-hidden w-full lg:w-[360px] flex-shrink-0 will-change-transform"
              style={{ boxShadow: tiltInstrument.active ? "0 14px 36px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.06)" : "0 6px 20px rgba(0,0,0,.16), inset 0 1px 0 rgba(255,255,255,.04)", ...tiltInstrument.transform }}
            >
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  background: "radial-gradient(520px 180px at 85% -10%, color-mix(in srgb,var(--accent) 14%, transparent), transparent 60%)",
                }}
              />
              <div className="relative flex justify-between items-start gap-4">
                <div>
                  <div className="text-[0.643rem] font-semibold tracking-[0.08em] uppercase" style={{ color: needsAttention > 0 ? "var(--warning)" : "var(--text-tertiary)" }}>
                    {progressLabel}
                  </div>
                  <div className="text-[2rem] font-bold tracking-tight leading-none mt-1 flex items-baseline gap-1.5">
                    {instrumentPct}
                    <span className="text-xs font-medium text-[var(--text-tertiary)]">%</span>
                  </div>
                  <div className="text-xs text-[var(--text-tertiary)] mt-1">
                    <span className="font-mono font-semibold text-[var(--text-primary)]">
                      {instrumentDone} / {instrumentTotal}
                    </span>{" "}
                    done{instrumentTotal > 0 ? ` · ${Math.round((instrumentDone / instrumentTotal) * 100)}%` : ""} ·{" "}
                    <span className="text-[var(--text-secondary)]">
                      {openCards.length} open · {doneCards.length} done
                    </span>
                  </div>
                </div>
                <div
                  className="w-[74px] h-[74px] rounded-full grid place-items-center flex-shrink-0 border border-[var(--border)] relative"
                  style={{
                    background: "radial-gradient(120px 80px at 30% 30%, var(--surface-3), var(--surface-2))",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,.06), 0 4px 10px rgba(0,0,0,.22)",
                  }}
                  aria-hidden="true"
                >
                  <svg width={74} height={74} viewBox="0 0 74 74" className="-rotate-90">
                    <circle cx={37} cy={37} r={26} stroke="var(--surface-3)" strokeWidth={5} fill="none" />
                    <circle
                      cx={37}
                      cy={37}
                      r={26}
                      stroke="var(--accent)"
                      strokeWidth={5}
                      fill="none"
                      strokeLinecap="round"
                      strokeDasharray={163.36}
                      strokeDashoffset={163.36 - (instrumentPct / 100) * 163.36}
                      style={{ filter: "drop-shadow(0 0 6px color-mix(in srgb,var(--accent) 35%, transparent))", transition: "stroke-dashoffset .6s cubic-bezier(.4,0,.2,1)" }}
                    />
                  </svg>
                  <span className="absolute inset-0 grid place-items-center text-xs font-bold font-mono text-[var(--text-primary)]">
                    {instrumentPct}%
                  </span>
                </div>
              </div>
              <div className="relative mt-3 h-[6px] rounded-full bg-[var(--surface-3)] overflow-hidden flex items-center">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${instrumentPct}%`,
                    background: "linear-gradient(90deg,var(--accent), var(--accent-hover))",
                    boxShadow: "0 0 10px color-mix(in srgb,var(--accent) 35%, transparent)",
                    transition: "width .7s cubic-bezier(.4,0,.2,1)",
                  }}
                />
                <div className="pointer-events-none absolute inset-0 flex justify-between px-px">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <i key={i} className="w-px h-full bg-[var(--border-subtle)]" />
                  ))}
                </div>
              </div>
              <div className="relative mt-2 flex justify-between text-xs text-[var(--text-tertiary)]">
                <span>
                  Started <b className="text-[var(--text-primary)] font-semibold">{formatDate(project.createdAt)}</b>
                </span>
                <span>
                  {project.dueDate ? (
                    <>Target <b className="text-[var(--text-primary)] font-semibold">{formatDate(project.dueDate)}</b></>
                  ) : (
                    <span className="text-[var(--text-tertiary)]">No target date</span>
                  )}
                </span>
              </div>
              <div className="relative grid grid-cols-2 gap-2 mt-3.5">
                <button
                  type="button"
                  onClick={() => setView("board")}
                  className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-secondary)] text-[0.786rem] font-medium py-2 hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)] transition-colors"
                >
                  View board
                </button>
                <button
                  type="button"
                  onClick={() => setView("insights")}
                  className="rounded-[10px] border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)] text-[0.786rem] font-semibold py-2 hover:bg-[var(--accent-hover)] hover:border-[var(--accent-hover)] transition-colors"
                >
                  Insights →
                </button>
              </div>
            </div>
          </div>

          {/* sentinel for pin detection */}
          <div ref={sentinelRef} aria-hidden="true" className="h-px" />
          {/* ── focus bar (sticky) — actually filters content below ── */}
          <div
            ref={focusBarRef}
            className={cn(
              "sticky top-2 z-[5] flex items-center gap-2 px-3 py-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] mb-4 flex-wrap transition-shadow",
              isFocusPinned && "shadow-[0_8px_24px_rgba(0,0,0,.32),inset_0_1px_0_rgba(255,255,255,.04)]"
            )}
            style={{ backdropFilter: "blur(8px)" }}
            role="toolbar"
            aria-label="Focus filters"
            aria-controls={overviewContentId}
          >
            <span className="text-[0.643rem] font-semibold tracking-[0.07em] uppercase text-[var(--text-tertiary)] mr-0.5">
              Focus
            </span>
            {(["all", "today", "overdue", "pinned"] as FocusFilter[]).map((k) => {
              const label =
                k === "all"
                  ? `All · ${focusCounts.all} open`
                  : k === "today"
                    ? `Due today · ${focusCounts.today}`
                    : k === "overdue"
                      ? `Overdue · ${focusCounts.overdue}`
                      : `Pinned · ${focusCounts.pinned}`;
              const active = focus === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFocus(k)}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-[0.786rem] font-medium border transition-all whitespace-nowrap",
                    active
                      ? "bg-[var(--text-primary)] text-[var(--background)] border-[var(--text-primary)] font-semibold shadow-sm"
                      : "bg-[var(--surface-2)] text-[var(--text-secondary)] border-[var(--border)] hover:border-[var(--muted)] hover:text-[var(--text-primary)]",
                  )}
                  aria-pressed={active}
                  aria-controls={overviewContentId}
                >
                  {label}
                </button>
              );
            })}
            <span className="ml-auto text-[0.714rem] text-[var(--text-tertiary)] font-mono hidden sm:inline" aria-live="polite">
              {focus === "all" ? "Showing all" : `Filtered: ${focusLabel[focus]}`} · {filteredQueue.length || focusCounts[focus]} items
            </span>
          </div>
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {focus === "all" ? `Showing all ${openCards.length} open tasks` : `Filtered to ${focusLabel[focus]} — ${filteredQueue.length || focusCounts[focus]} items`}
          </span>

          <div id={overviewContentId}>
          {/* ── KPI strip — inline stats, not 4 template cards — shares one hairline container ── */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden divide-y sm:divide-y-0 sm:divide-x divide-[var(--border)] flex flex-col sm:flex-row mb-4" style={{ boxShadow: "0 4px 14px rgba(0,0,0,.18)" }}>
            <div className="flex-1 p-3.5 relative">
              <div className="absolute top-0 left-0 right-0 h-0.5 bg-[var(--danger)]" />
              <div className="text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)]">Needs attention</div>
              <div className="text-2xl font-bold tracking-tight leading-none mt-2 flex items-baseline gap-1.5">
                {needsAttention}
                <span className="text-sm font-medium text-[var(--text-tertiary)]">/ {openCards.length}</span>
              </div>
              <div className="text-xs mt-2 text-[var(--text-tertiary)]">
                <span className={cn(needsAttention > 0 ? "text-[var(--danger)] font-semibold" : "text-[var(--success)] font-semibold")}>
                  {needsAttention > 0 ? `${overdueCount} overdue · ${todayCount} today` : "All caught up"}
                </span>
              </div>
            </div>
            <div className="flex-1 p-3.5 relative">
              <div className="absolute top-0 left-0 right-0 h-0.5 bg-[var(--success)]" />
              <div className="text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)]">Completion</div>
              <div className="text-2xl font-bold tracking-tight leading-none mt-2 flex items-baseline gap-1.5">
                {instrumentPct}%<span className="text-sm font-medium text-[var(--text-tertiary)]">{instrumentDone}/{instrumentTotal}</span>
              </div>
              <div className="text-xs mt-2 text-[var(--text-tertiary)]">
                {instrumentTotal > 0 ? `${instrumentDone} done · ${openCards.length} open` : "No tasks yet"}
              </div>
            </div>
            <div className="flex-1 p-3.5 relative bg-[var(--surface-2)]/60">
              <div className="absolute top-0 left-0 right-0 h-0.5 bg-[var(--info)]" />
              <div className="text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)]">Knowledge</div>
              <div className="text-2xl font-bold tracking-tight leading-none mt-2 flex items-baseline gap-1.5">
                {notes.length}
                <span className="text-sm font-medium text-[var(--text-tertiary)]">notes</span>
              </div>
              <div className="text-xs mt-2 text-[var(--text-tertiary)]">
                {pinnedNotes.length} pinned{notes.length > 0 && recentNotes[0] && <span> · {formatRelative(recentNotes[0].updatedAt)}</span>}
              </div>
            </div>
            <div className="flex-1 p-3.5 relative bg-[var(--surface-2)]/60">
              <div className="absolute top-0 left-0 right-0 h-0.5 bg-[var(--warning)]" />
              <div className="text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)]">
                Bottleneck
              </div>
              <div className="text-2xl font-bold tracking-tight leading-none mt-2 flex items-baseline gap-1.5">
                {bottleneck ? bottleneck.count : "—"}
                <span className="text-sm font-medium text-[var(--text-tertiary)]">{bottleneck ? `in ${bottleneck.name}` : "—"}</span>
              </div>
              <div className="text-xs mt-2 text-[var(--text-tertiary)]">
                {bottleneck ? `${openCards.length} open total` : "Add columns"}
              </div>
            </div>
          </div>

          {/* ── attention queue — filtered by Focus, honest empty states ── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4" role="list" aria-label="Needs attention">
            {(focus === "pinned" ? [] : filteredQueue).length === 0 ? (
              <div className="md:col-span-3 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)]/60 p-4 flex items-center gap-3">
                <span className="w-8 h-8 rounded-full grid place-items-center bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/20">
                  <Kanban size={14} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-[var(--text-primary)]">
                    {focus === "overdue" ? "No overdue tasks" : focus === "today" ? "Nothing due today" : focus === "pinned" ? `${pinnedNotes.length} pinned notes — see below` : "All caught up"}
                  </span>
                  <span className="block text-xs text-[var(--text-tertiary)]">
                    {focus === "all" && openCards.length > 0 ? `${openCards.length} open · ${bottleneck ? `${bottleneck.count} in ${bottleneck.name}` : "no bottleneck"}` : focus === "pinned" ? "Scroll to Pinned keeps focus" : "No action needed — nice."}
                  </span>
                </span>
                <button type="button" onClick={() => (focus === "pinned" ? setView("notes") : setView("board"))} className="ml-auto text-xs font-semibold px-3 py-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--muted)]">
                  {focus === "pinned" ? "Open notes →" : "View board →"}
                </button>
              </div>
            ) : (
              (focus === "pinned" ? [] : filteredQueue).map(({ card, label, tone }) => {
                const col = columns.find((c) => c.id === card.columnId);
                const prioColor = PRIORITY_CSS_COLORS[card.priority] ?? "var(--text-tertiary)";
                return (
                  <button
                    key={card.id}
                    type="button"
                    role="listitem"
                    onClick={() => revealCard(setView, card.id)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border text-left transition-all",
                      tone === "overdue"
                        ? "border-[var(--danger)]/25 hover:border-[var(--danger)]/40"
                        : tone === "today"
                          ? "border-[var(--warning)]/25 hover:border-[var(--warning)]/40"
                          : "border-[var(--border)] hover:border-[var(--border)]",
                      "bg-[var(--surface)] hover:translate-y-[-1px] hover:shadow-[0_10px_22px_rgba(0,0,0,.32)]",
                    )}
                    style={{
                      background:
                        tone === "overdue"
                          ? "linear-gradient(180deg, color-mix(in srgb,var(--danger) 7%, var(--surface)), var(--surface))"
                          : tone === "today"
                            ? "linear-gradient(180deg, color-mix(in srgb,var(--warning) 7%, var(--surface)), var(--surface))"
                            : undefined,
                    }}
                  >
                    <span
                      className="w-[34px] h-[34px] rounded-[10px] grid place-items-center flex-shrink-0 border text-sm"
                      style={{
                        background:
                          tone === "overdue"
                            ? "color-mix(in srgb,var(--danger) 14%, transparent)"
                            : tone === "today"
                              ? "color-mix(in srgb,var(--warning) 14%, transparent)"
                              : "var(--accent-dim)",
                        color: tone === "overdue" ? "var(--danger)" : tone === "today" ? "var(--warning)" : "var(--accent)",
                        borderColor:
                          tone === "overdue"
                            ? "color-mix(in srgb,var(--danger) 18%, transparent)"
                            : tone === "today"
                              ? "color-mix(in srgb,var(--warning) 18%, transparent)"
                              : "color-mix(in srgb,var(--accent) 18%, transparent)",
                      }}
                      aria-hidden="true"
                    >
                      {tone === "overdue" ? <AlertTriangle size={14} /> : tone === "today" ? <Clock3 size={14} /> : <Diamond size={12} />}
                    </span>
                    <span className="min-w-0 flex-1 text-left">
                      <span className={cn("text-[0.643rem] font-semibold tracking-[0.06em] uppercase", tone === "overdue" ? "text-[var(--danger)]" : tone === "today" ? "text-[var(--warning)]" : "text-[var(--text-tertiary)]")}>
                        {label}
                      </span>
                      <span className="block text-sm font-semibold text-[var(--text-primary)] truncate">{card.title}</span>
                      <span className="block text-xs text-[var(--text-tertiary)] truncate">
                        {col?.name ?? "—"} · {card.priority} priority
                      </span>
                    </span>
                    <span className="hidden sm:inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-secondary)] group-hover:bg-[var(--text-primary)] group-hover:text-[var(--background)] flex-shrink-0">
                      Open →
                    </span>
                    <span className="w-0.5 self-stretch rounded-full flex-shrink-0" style={{ background: prioColor }} aria-hidden="true" />
                  </button>
                );
              })
            )}
            </div>

          {/* ── bento: task flow + priority ───────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-[1.55fr_0.95fr] gap-3.5 mb-3.5">
            <div
              ref={flowRef}
              onMouseMove={tiltFlow.onMove}
              onMouseLeave={tiltFlow.onLeave}
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 md:p-[18px] will-change-transform"
              style={{ boxShadow: tiltFlow.active ? "0 14px 32px rgba(0,0,0,.24), inset 0 1px 0 rgba(255,255,255,.04)" : "0 8px 24px rgba(0,0,0,.14)", ...tiltFlow.transform }}
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
                <p className="text-sm text-[var(--text-tertiary)] py-6 text-center">No columns yet</p>
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
            </div>

            <div
              ref={priorityRef}
              onMouseMove={tiltPriority.onMove}
              onMouseLeave={tiltPriority.onLeave}
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 md:p-[18px] will-change-transform"
              style={{ boxShadow: tiltPriority.active ? "0 14px 32px rgba(0,0,0,.24), inset 0 1px 0 rgba(255,255,255,.04)" : "0 8px 24px rgba(0,0,0,.14)", ...tiltPriority.transform }}
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
                  const counts = focus === "overdue" || focus === "today" ? filteredPriorityCounts : priorityCounts;
                  const n = counts[key as keyof typeof counts] ?? 0;
                  const active = n > 0;
                  return (
                    <div
                      key={key}
                      className="rounded-xl border p-3.5 text-center"
                      style={{
                        background: bg,
                        borderColor: active ? (color === "var(--text-tertiary)" ? "var(--border)" : color) : "var(--border)",
                        boxShadow: active && color !== "var(--text-tertiary)" ? `inset 0 1px 0 rgba(255,255,255,.06)` : undefined,
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
            </div>
          </div>

          {/* ── project health radar — 6-axis instrument, same data as KPIs but shape reads balance at a glance ── */}
          <div
            ref={radarRef}
            onMouseMove={tiltRadar.onMove}
            onMouseLeave={tiltRadar.onLeave}
            className="mb-3.5 will-change-transform"
            style={{ ...tiltRadar.transform, filter: tiltRadar.active ? "drop-shadow(0 12px 24px rgba(0,0,0,.16))" : undefined }}
          >
            <ProjectHealthRadar axes={radarAxes} size={280} />
          </div>

          {/* ── notes summary — single CTA, replaces two All notes links ── */}
          <div className="mb-3.5">
            <div
              ref={notesRef}
              onMouseMove={tiltNotes.onMove}
              onMouseLeave={tiltNotes.onLeave}
              className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-4 md:p-[16px] will-change-transform"
              style={{ boxShadow: tiltNotes.active ? "0 12px 28px rgba(0,0,0,.18)" : "0 4px 14px rgba(0,0,0,.12)", ...tiltNotes.transform }}
            >
              <div className="flex items-center justify-between gap-3 mb-4">
                <h2 className="text-[0.813rem] font-semibold flex items-center gap-2">
                  <span className="w-5 h-5 rounded-md grid place-items-center bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-tertiary)]">
                    <FileText size={10} />
                  </span>
                  Notes
                  <span className="font-normal text-[var(--text-tertiary)] text-xs">
                    · {notes.length} total{pinnedNotes.length > 0 ? ` · ${pinnedNotes.length} pinned` : ""} · {recentNotes.length} recent
                  </span>
                </h2>
                <button type="button" onClick={() => setView("notes")} className="text-xs font-semibold text-[var(--accent)] hover:text-[var(--accent-hover)]">
                  Open notes →
                </button>
              </div>
              {notes.length === 0 ? (
                <p className="text-sm text-[var(--text-tertiary)] py-6 text-center">No notes yet — capture ideas to see them here</p>
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
            </div>
          </div>
          {/* ── activity log — full width, trace LLM/MCP changes ── */}
          <div className="mb-3.5">
            <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-4 md:p-[16px]" style={{ boxShadow: "0 4px 14px rgba(0,0,0,.18)", borderLeft: "2px solid color-mix(in srgb, var(--accent) 60%, transparent)" }}>
              <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="text-[0.813rem] font-semibold flex items-center gap-2">
                  <span className="w-5 h-5 rounded-md grid place-items-center bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-tertiary)]">
                    <Activity size={10} />
                  </span>
                  Activity log <span className="font-normal text-[var(--text-tertiary)] text-xs">· full history · trace MCP / LLM</span>
                </h2>
                <span className="text-[0.643rem] text-[var(--text-tertiary)] font-mono tabular-nums">
                  {activityByDay.reduce((n, g) => n + g.items.length, 0)} events
                </span>
              </div>
              {activityByDay.length === 0 ? (
                <p className="text-sm text-[var(--text-tertiary)] py-6 text-center">No activity yet — LLM and MCP changes will appear here</p>
              ) : (
                <div className="max-h-[320px] overflow-y-auto pr-1 -mr-1">
                  <RecentActivityFeed activityByDay={activityByDay} />
                </div>
              )}
            </div>
          </div>

          {/* ── runs + sessions — full width stacked ── */}
          <div className="grid grid-cols-1 gap-3.5 mb-3.5">
            <CollapsibleSection
              title="Recent runs"
              icon={<Zap size={12} />}
              collapsed={isCollapsed("runs")}
              onToggle={() => toggleSection("runs")}
              action={{ label: "All automations", onClick: () => setView("automations") }}
              collapsedView={<span className="text-[0.714rem] text-[var(--text-secondary)]">{recentProjectRuns.length} runs · last 5</span>}
            >
              <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-4 md:p-[16px]" style={{ boxShadow: "0 4px 14px rgba(0,0,0,.18)" }}>
                {recentProjectRuns.length === 0 ? (
                  <p className="text-sm text-[var(--text-tertiary)] py-4 text-center">No runs yet</p>
                ) : (
                  <RecentAutomationRunsFeed runs={recentProjectRuns.slice(0, 5)} setView={setView} />
                )}
                <p className="text-[0.643rem] text-[var(--text-tertiary)] mt-3">Status pills are labeled + color — distinguishable without hue alone.</p>
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              title="Recent sessions"
              icon={<Diamond size={12} />}
              collapsed={isCollapsed("sessions")}
              onToggle={() => toggleSection("sessions")}
              action={{ label: "Open sessions", onClick: () => { if (activeChatThreadId) openSession(activeChatThreadId, "chat", "center"); else setSessionPresentation("center"); setView("chat"); } }}
              collapsedView={<span className="text-[0.714rem] text-[var(--text-secondary)]">Resume where you left</span>}
            >
              <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-4 md:p-[16px]" style={{ boxShadow: "0 4px 14px rgba(0,0,0,.18)" }}>
                <SessionBrowser variant="preview" limit={4} activeSessionId={activeSessionId} />
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <Button variant="default" size="sm" className="w-full" onClick={() => setView("chat")}>
                    New chat
                  </Button>
                  <Button variant="accent" size="sm" className="w-full" onClick={() => {
                    if (project.codeDirectory) void handleNewAgentSession("center", "");
                    else setView("chat");
                  }}>
                    New coding agent
                  </Button>
                </div>
              </div>
            </CollapsibleSection>
          </div>
        </div>

          {/* ── Empty state ───────────────────────────────────── */}
          {notes.length === 0 && allCards.length === 0 && (
            <div className="py-16 text-center">
              <Kanban size={40} strokeWidth={1.5} className="mx-auto mb-3 text-[var(--text-tertiary)] opacity-30" />
              <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Start building</h3>
              <p className="text-sm text-[var(--text-tertiary)] max-w-sm mx-auto mb-6">Add notes to capture ideas and tasks to track progress.</p>
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

      {/* pinned bottom composer — polished float, segmented control doesn't vanish */}
      {!chatOpen &&
        (() => {
          const placeholder =
            sessionKind === "coding"
              ? project.codeDirectory
                ? `Build in ${project.name} — e.g. clear ${bottleneck ? `${bottleneck.count} in ${bottleneck.name}` : `${openCards.length} open`}`
                : "Coding agent needs a code directory — open chat instead"
              : focus === "overdue" && overdueCount > 0
                ? `Fix ${overdueCount} overdue — ask Cairn to triage`
                : focus === "today" && todayCount > 0
                  ? `Plan ${todayCount} due today — ask Cairn`
                  : needsAttention > 0
                    ? `Fix ${needsAttention} needing attention — ask Cairn`
                    : bottleneck
                      ? `Summarize ${bottleneck.count} in ${bottleneck.name} — ask Cairn`
                      : `Ask Cairn about ${project.name} — notes, tasks, or vault`;
          return (
            <div ref={bottomBarRef} className="absolute bottom-0 left-0 right-0 p-2 md:p-3 pointer-events-none z-10">
              <div className="max-w-[1240px] mx-auto pointer-events-auto rounded-xl border border-[var(--border)] overflow-hidden supports-[backdrop-filter]:bg-[color-mix(in_srgb,var(--surface)_78%,transparent)] bg-[var(--surface)] backdrop-blur-xl" style={{ boxShadow: "0 12px 32px rgba(0,0,0,.38), 0 1px 4px rgba(0,0,0,.2)" }}>
                <div className="flex items-center gap-2 px-2.5 pt-2.5">
                  <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-[var(--surface-2)] border border-[var(--border)]">
                    <button
                      type="button"
                      onClick={() => setSessionKind("chat")}
                      aria-pressed={sessionKind === "chat"}
                      className={cn(
                        "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[0.714rem] font-semibold border transition-colors",
                        sessionKind === "chat"
                          ? "bg-[var(--text-primary)] text-[var(--background)] border-[var(--text-primary)] shadow-sm"
                          : "bg-transparent text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)]",
                      )}
                    >
                      <MessageSquare size={11} /> Chat
                    </button>
                    <button
                      type="button"
                      onClick={() => setSessionKind("coding")}
                      aria-pressed={sessionKind === "coding"}
                      disabled={!project.codeDirectory}
                      title={project.codeDirectory ? "Coding agent — has code directory" : "No code directory — chat only"}
                      className={cn(
                        "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[0.714rem] font-semibold border transition-colors",
                        !project.codeDirectory
                          ? "bg-transparent text-[var(--text-tertiary)] border-transparent opacity-60 cursor-not-allowed"
                          : sessionKind === "coding"
                            ? "bg-[var(--accent)] text-[var(--accent-fg)] border-[var(--accent)] shadow-sm"
                            : "bg-transparent text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)]",
                      )}
                    >
                      <Code2 size={11} /> Coding agent
                    </button>
                  </div>
                  <span className="hidden sm:inline-flex items-center gap-1 text-[0.643rem] text-[var(--text-tertiary)] ml-1">
                    <span className="w-1 h-1 rounded-full bg-[var(--success)]" /> {project.name} · {instrumentDone}/{instrumentTotal}
                  </span>
                  <span className="ml-auto hidden md:inline text-[0.643rem] text-[var(--text-tertiary)]">⌘/ · Shift+Enter</span>
                </div>
                <div className="p-1.5 md:p-2">
                  <ChatInputArea
                    ref={chatInputRef}
                    value={chatInput}
                    onChange={setChatInput}
                    onSubmit={() => handleSendChat()}
                    placeholder={placeholder}
                    variant="overview"
                    showSparkles
                    suggestions={mentionSuggestions}
                    providerModelTarget="ai"
                    statusText="Enter to send · mentions with @"
                  />
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
