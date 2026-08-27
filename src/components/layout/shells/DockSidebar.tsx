"use client";

import React, { useMemo, useState, useCallback } from "react";
import { FileText, Kanban, Workflow, Terminal, Hash, BarChart2, GitBranch, CalendarDays, Zap, Settings, Search, MessageSquare, Layers, Plus, FolderOpen, Bell, Activity, ChevronLeft } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn, getDueDateStatus } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { ProjectIcon, WorkspaceIcon } from "@/lib/workspace-icons";
import { countOpenCardsByProject } from "../sidebar-utils";
import { SessionBrowser } from "@/components/agent/SessionBrowser";
import { ProjectCreateForm } from "../sidebar/ProjectCreateForm";
import { useProjectMetrics } from "../project-overview/useProjectMetrics";
import { useRadarAxes } from "../project-overview/radar";

export function DockSidebar() {
  const {
    sidebarCollapsed,
    toggleSidebar,
    activeWorkspaceId,
    activeProjectId,
    activeSessionId,
    activeView,
    workspaces,
    getWorkspaceProjects,
    setActiveProject,
    setView,
    toggleSearch,
    toggleChat,
    cards,
    hiddenViews,
    chatOpen,
    searchOpen,
    createProject,
    notificationUnreadCount,
    notificationOpen,
    setNotificationOpen,
  } = useCairnStore(
    useShallow((s) => ({
      sidebarCollapsed: s.sidebarCollapsed,
      toggleSidebar: s.toggleSidebar,
      activeWorkspaceId: s.activeWorkspaceId,
      activeProjectId: s.activeProjectId,
      activeSessionId: s.activeSessionId,
      activeView: s.activeView,
      workspaces: s.workspaces,
      getWorkspaceProjects: s.getWorkspaceProjects,
      setActiveProject: s.setActiveProject,
      setView: s.setView,
      toggleSearch: s.toggleSearch,
      toggleChat: s.toggleChat,
      cards: s.cards,
      hiddenViews: s.hiddenViews,
      chatOpen: s.chatOpen,
      searchOpen: s.searchOpen,
      createProject: s.createProject,
      notificationUnreadCount: s.notificationUnreadCount,
      notificationOpen: s.notificationOpen,
      setNotificationOpen: s.setNotificationOpen,
    }))
  );

  const workspace = useMemo(() => workspaces.find((w) => w.id === activeWorkspaceId), [workspaces, activeWorkspaceId]);
  const projects = useMemo(() => (activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : []), [activeWorkspaceId, getWorkspaceProjects]);
  const openCounts = useMemo(() => countOpenCardsByProject(cards), [cards]);

  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  const commitCreateProject = useCallback(async () => {
    if (!activeWorkspaceId || !newProjectName.trim()) { setCreatingProject(false); return; }
    setCreatingProject(false);
    setNewProjectName("");
    const proj = await createProject(activeWorkspaceId, newProjectName.trim());
    setActiveProject(proj.id);
  }, [activeWorkspaceId, newProjectName, createProject, setActiveProject]);

  const cancelCreateProject = useCallback(() => { setCreatingProject(false); setNewProjectName(""); }, []);

  // collapsed = dock icons only (64px). expanded = 244px with labels.
  const collapsed = sidebarCollapsed;

  return (
    <>
      {!collapsed && (
        <div className="fixed inset-0 bg-[color-mix(in_srgb,var(--background)_40%,transparent)] z-30 md:hidden" onClick={toggleSidebar} />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-[var(--border)] bg-[var(--surface)] flex-shrink-0 overflow-hidden md:static md:translate-x-0 transition-all duration-300 ease-in-out",
          collapsed ? "w-12 py-3 gap-1" : "w-[244px]"
        )}
        style={{ top: 44 }}
      >
        {/* collapsed dock */}
        <div className={cn("flex flex-col items-center gap-1 w-full flex-1 min-h-0 transition-opacity duration-300", collapsed ? "opacity-100" : "opacity-0 pointer-events-none absolute inset-x-0 top-3")}>
          <Tooltip content="Expand sidebar" side="right">
            <button onClick={toggleSidebar} className="p-2 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]">
              <Layers size={16} />
            </button>
          </Tooltip>
          {activeProjectId && (
            <Tooltip content="Health" side="right">
              <button className="p-2 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors">
                <SidebarMiniRadar projectId={activeProjectId} size={20} bare />
              </button>
            </Tooltip>
          )}
          <div className="w-5 h-px bg-[var(--border)] my-1" />
          <Tooltip content="Search" side="right"><button onClick={toggleSearch} className={cn("p-2 rounded-md", searchOpen ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><Search size={15} /></button></Tooltip>
          {!hiddenViews.has("chat") && (
            <Tooltip content="Chat" side="right"><button onClick={toggleChat} className={cn("p-2 rounded-md", chatOpen ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><MessageSquare size={15} /></button></Tooltip>
          )}
          <div className="w-5 h-px bg-[var(--border)] my-1" />
          <Tooltip content="Overview" side="right"><button onClick={() => setView("overview")} className={cn("p-2 rounded-md", activeView === "overview" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)]")}><Hash size={15} /></button></Tooltip>
          <Tooltip content="Notes" side="right"><button onClick={() => setView("notes")} className={cn("p-2 rounded-md", activeView === "notes" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)]")}><FileText size={15} /></button></Tooltip>
          <Tooltip content="Board" side="right"><button onClick={() => setView("board")} className={cn("p-2 rounded-md", activeView === "board" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)]")}><Kanban size={15} /></button></Tooltip>
          {!hiddenViews.has("flow") && <Tooltip content="Flow" side="right"><button onClick={() => setView("flow")} className={cn("p-2 rounded-md", activeView === "flow" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)]")}><Workflow size={15} /></button></Tooltip>}
          {!hiddenViews.has("agent") && <Tooltip content="Agent" side="right"><button onClick={() => setView("agent")} className={cn("p-2 rounded-md", activeView === "agent" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)]")}><Terminal size={15} /></button></Tooltip>}
          <div className="flex-1" aria-hidden="true" />
          <div className="mt-auto w-full flex flex-col items-center gap-1 pt-2 border-t border-[var(--border)]">
            <Tooltip content="Automations" side="right"><button onClick={() => setView("automations")} className={cn("p-2 rounded-md", activeView === "automations" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><Zap size={15} /></button></Tooltip>
            <Tooltip content="Calendar" side="right"><button onClick={() => setView("calendar-all")} className={cn("p-2 rounded-md", activeView === "calendar-all" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><CalendarDays size={15} /></button></Tooltip>
            {!hiddenViews.has("graph") && <Tooltip content="Knowledge Graph" side="right"><button onClick={() => setView("graph")} className={cn("p-2 rounded-md", activeView === "graph" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><GitBranch size={15} /></button></Tooltip>}
            {!hiddenViews.has("insights") && <Tooltip content="Insights" side="right"><button onClick={() => setView("insights")} className={cn("p-2 rounded-md", activeView === "insights" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><BarChart2 size={15} /></button></Tooltip>}
            {!hiddenViews.has("usage") && <Tooltip content="Usage" side="right"><button onClick={() => setView("usage")} className={cn("p-2 rounded-md", activeView === "usage" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><Activity size={15} /></button></Tooltip>}
            <Tooltip content="Notifications" side="right">
              <button onClick={() => setNotificationOpen(!notificationOpen)} className={cn("p-2 rounded-md relative", notificationUnreadCount > 0 ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}>
                <Bell size={15} />
                {notificationUnreadCount > 0 && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[var(--accent)] border border-[var(--surface)]" />}
              </button>
            </Tooltip>
            <div className="w-5 h-px bg-[var(--border)] my-1" />
            <Tooltip content="Settings" side="right"><button onClick={() => setView("settings")} className={cn("p-2 rounded-md", activeView === "settings" ? "text-[var(--text-primary)] bg-[var(--surface-2)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><Settings size={15} /></button></Tooltip>
          </div>
        </div>

        {/* expanded */}
        <div className={cn("flex flex-col flex-1 min-h-0 w-full transition-opacity duration-300", collapsed ? "opacity-0 pointer-events-none absolute inset-x-0 top-0 h-0 overflow-hidden" : "opacity-100")}>
          {/* workspace header */}
          <div className="flex items-center gap-2 px-3 h-11 border-b border-[var(--border-subtle)] flex-shrink-0">
            <WorkspaceIcon name={workspace?.icon} size={16} className="text-[var(--text-tertiary)]" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold truncate">{workspace?.name ?? "Workspace"}</div>
              <div className="text-[0.643rem] text-[var(--text-tertiary)]">{projects.length} projects · local</div>
            </div>
            <Tooltip content="Collapse sidebar" side="right">
              <button onClick={toggleSidebar} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors">
                <ChevronLeft size={13} />
              </button>
            </Tooltip>
          </div>

          {/* current project — radar bottom-right aligned inside card */}
          {(() => {
            const project = projects.find((p) => p.id === activeProjectId);
            if (!project) return null;
            return (
              <div className="mx-2 mt-3 p-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
                <div className="flex gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <ProjectIcon name={project.icon} size={14} className="text-[var(--accent)]" />
                      <span className="text-xs font-semibold truncate flex-1">{project.name}</span>
                      <span className="text-[0.643rem] px-1.5 py-0.5 rounded-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text-tertiary)] shrink-0">{openCounts.get(project.id) ?? 0} open</span>
                    </div>
                    <div className="text-[0.714rem] text-[var(--text-tertiary)] mt-1 truncate">{project.description ?? "No description"}</div>
                  </div>
                  <div className="shrink-0 self-end">
                    <SidebarMiniRadar projectId={project.id} size={72} bare />
                  </div>
                </div>
              </div>
            );
          })()}

          {/* scrollable: Views + Conversations + Projects */}
          <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-4 min-h-0">
            <div>
              <div className="text-[0.571rem] font-semibold tracking-[0.08em] uppercase text-[var(--text-tertiary)] px-2 mb-1.5">Views</div>
              <div className="space-y-0.5">
                <button onClick={() => setView("overview")} className={cn("flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs font-medium", activeView === "overview" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}><Hash size={13} /> Overview</button>
                <button onClick={() => setView("notes")} className={cn("flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs font-medium", activeView === "notes" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}><FileText size={13} /> Notes</button>
                {!hiddenViews.has("board") && <button onClick={() => setView("board")} className={cn("flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs", activeView === "board" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><Kanban size={13} /> Board</button>}
                {!hiddenViews.has("flow") && <button onClick={() => setView("flow")} className={cn("flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs", activeView === "flow" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><Workflow size={13} /> Flow</button>}
                {!hiddenViews.has("agent") && <button onClick={() => setView("agent")} className={cn("flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs", activeView === "agent" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><Terminal size={13} /> Agent</button>}
                {!hiddenViews.has("calendar") && <button onClick={() => setView("calendar")} className={cn("flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs", activeView === "calendar" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><CalendarDays size={13} /> Calendar</button>}
              </div>
            </div>

            {/* Conversations — between Views and Workspace */}
            {activeProjectId && (
              <div>
                <div className="text-[0.571rem] font-semibold tracking-[0.08em] uppercase text-[var(--text-tertiary)] px-2 mb-1.5">Conversations</div>
                <SessionBrowser projectId={activeProjectId} variant="project" activeSessionId={activeSessionId} />
              </div>
            )}

            <div>
              <div className="flex items-center justify-between px-2 mb-1.5">
                <span className="text-[0.571rem] font-semibold tracking-[0.08em] uppercase text-[var(--text-tertiary)]">Projects</span>
                <Tooltip content="New project">
                  <button onClick={() => { setCreatingProject(true); setNewProjectName(""); }} className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]">
                    <Plus size={12} />
                  </button>
                </Tooltip>
              </div>
              <div className="space-y-0.5">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => { setActiveProject(p.id); setView("overview"); }}
                    className={cn("flex items-center gap-2 w-full px-2.5 py-1 rounded-md text-xs", p.id === activeProjectId ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]")}
                  >
                    <ProjectIcon name={p.icon} size={12} className="text-[var(--text-tertiary)]" />
                    <span className="truncate flex-1 text-left">{p.name}</span>
                    <span className="text-[0.643rem] font-mono">{openCounts.get(p.id) ?? 0}</span>
                  </button>
                ))}
                {creatingProject && (
                  <ProjectCreateForm value={newProjectName} onChange={setNewProjectName} onCommit={commitCreateProject} onCancel={cancelCreateProject} />
                )}
                {projects.length === 0 && !creatingProject && (
                  <div className="px-2 py-4 text-center">
                    <FolderOpen size={16} className="mx-auto mb-1 text-[var(--text-tertiary)]" />
                    <p className="text-xs text-[var(--text-tertiary)]">No projects yet</p>
                    <button onClick={() => setCreatingProject(true)} className="mt-1 text-xs text-[var(--accent)] hover:bg-[var(--accent-dim)] px-2 py-0.5 rounded">Create one</button>
                  </div>
                )}
              </div>
            </div>

          </nav>

          {/* Workspace — pinned to bottom like original sidebar (border-t, not scrollable) */}
          <div className="border-t border-[var(--border)] p-2 space-y-0.5 flex-shrink-0 bg-[var(--surface)]">
            {/* Automations — prominent, above workspace views */}
            <button onClick={() => setView("automations")} className={cn("flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs transition-colors", activeView === "automations" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
              <Zap size={13} /><span>Automations</span>
            </button>
            <div className="my-1.5 border-t border-[var(--border-subtle)]" />
            <button onClick={() => setView("calendar-all")} className={cn("flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs transition-colors", activeView === "calendar-all" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
              <CalendarDays size={13} /><span>Calendar</span><span className="ml-auto text-[0.643rem] text-[var(--text-tertiary)]">all</span>
            </button>
            {!hiddenViews.has("graph") && <button onClick={() => setView("graph")} className={cn("flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs transition-colors", activeView === "graph" ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}><GitBranch size={13} /><span>Knowledge Graph</span></button>}
            {!hiddenViews.has("insights") && <button onClick={() => setView("insights")} className={cn("flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs transition-colors", activeView === "insights" ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}><BarChart2 size={13} /><span>Insights</span></button>}
            {!hiddenViews.has("usage") && <button onClick={() => setView("usage")} className={cn("flex items-center gap-2 w-full rounded-md px-2 py-1.5 rounded-md text-xs transition-colors", activeView === "usage" ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}><Activity size={13} /><span>Usage</span></button>}
            <button onClick={() => setNotificationOpen(!notificationOpen)} data-notification-toggle aria-expanded={notificationOpen} className={cn("flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs transition-colors", "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
              <Bell size={13} /><span>Notifications</span>
              {notificationUnreadCount > 0 && <span className="ml-auto min-w-4 h-4 px-1 rounded-full bg-[var(--accent)] text-[var(--accent-fg)] text-[0.625rem] leading-4 text-center font-semibold">{notificationUnreadCount}</span>}
            </button>
            <div className="my-1.5 border-t border-[var(--border-subtle)]" />
            <button onClick={() => setView("settings")} className={cn("flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs", activeView === "settings" ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}><Settings size={13} /> Settings</button>
          </div>
        </div>
      </aside>
    </>
  );
}

function SidebarMiniRadar({ projectId, size: sizeProp, bare }: { projectId: string; size?: number; bare?: boolean }) {
  const metrics = useProjectMetrics(projectId);
  const todayCount = metrics ? metrics.dueCards.filter((c) => getDueDateStatus(c.dueDate) === "today").length : 0;
  const bottleneck = (() => {
    if (!metrics) return null;
    const doneId = metrics.columns.find((c) => c.type === "done")?.id;
    let best: { name: string; count: number } | null = null;
    let max = -1;
    for (const col of metrics.columns.filter((c) => c.id !== doneId)) {
      const cnt = metrics.allCards.filter((c) => c.columnId === col.id).length;
      if (cnt > max) { max = cnt; best = { name: col.name, count: cnt }; }
    }
    return best;
  })();
  const axes = useRadarAxes({
    completionRate: metrics?.completionRate ?? 0,
    openCards: metrics?.openCards ?? { length: 0 } as never,
    overdueCount: metrics?.overdueCount ?? 0,
    todayCount,
    notes: metrics?.notes ?? { length: 0 } as never,
    pinnedNotes: metrics?.pinnedNotes ?? { length: 0 } as never,
    recentNotes: metrics?.recentNotes ?? { length: 0 } as never,
    bottleneck,
    priorityCounts: metrics?.priorityCounts ?? { urgent: 0, high: 0, medium: 0, low: 0 },
    columns: metrics?.columns ?? [],
    allCards: metrics?.allCards ?? { length: 0 } as never,
    activityByDay: metrics?.activityByDay ?? [],
  });

  if (!metrics) return null;

  const size = sizeProp ?? 110;
  const cx = size / 2;
  const cy = size / 2;
  const radius = bare ? size * 0.38 : 34;
  const n = axes.length;
  const angleFor = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pointFor = (v: number, i: number) => {
    const a = angleFor(i);
    const r = radius * Math.max(0, Math.min(1, v));
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  };
  const pts = axes.map((ax, i) => pointFor(ax.value, i).join(",")).join(" ");
  const gridPts = axes.map((_, i) => {
    const a = angleFor(i);
    return `${cx + Math.cos(a) * radius},${cy + Math.sin(a) * radius}`;
  }).join(" ");

  const avg = Math.round(axes.reduce((s, a) => s + a.value, 0) / axes.length * 100);

  if (bare) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block overflow-visible shrink-0" aria-label={`Health ${avg}%`}>
        <polygon points={gridPts} fill="none" stroke="var(--border)" strokeWidth={1} opacity={0.45} />
        <polygon points={pts} fill="color-mix(in srgb,var(--accent) 18%, transparent)" stroke="var(--accent)" strokeWidth={1.25} strokeLinejoin="round" />
        {axes.map((ax, i) => {
          const [x, y] = pointFor(ax.value, i);
          return <circle key={ax.key} cx={x} cy={y} r={1.8} fill="var(--accent)" stroke="var(--surface-2)" strokeWidth={0.8} />;
        })}
      </svg>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
        <span className="text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)]">Health</span>
        <span className="ml-auto text-[0.643rem] font-mono text-[var(--text-secondary)]">{avg}%</span>
      </div>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block mx-auto overflow-visible">
        <polygon points={gridPts} fill="none" stroke="var(--border)" strokeWidth={1} opacity={0.5} />
        {[0.33, 0.66].map((f) => {
          const r = radius * f;
          const g = axes.map((_, i) => {
            const a = angleFor(i);
            return `${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`;
          }).join(" ");
          return <polygon key={f} points={g} fill="none" stroke="var(--border)" strokeWidth={1} opacity={0.3} />;
        })}
        {axes.map((_, i) => {
          const a = angleFor(i);
          const x2 = cx + Math.cos(a) * radius;
          const y2 = cy + Math.sin(a) * radius;
          return <line key={i} x1={cx} y1={cy} x2={x2} y2={y2} stroke="var(--border)" strokeWidth={1} opacity={0.4} />;
        })}
        <polygon points={pts} fill="color-mix(in srgb,var(--accent) 16%, transparent)" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" />
        {axes.map((ax, i) => {
          const [x, y] = pointFor(ax.value, i);
          return <circle key={ax.key} cx={x} cy={y} r={2.5} fill="var(--accent)" stroke="var(--surface-2)" strokeWidth={1} />;
        })}
      </svg>
    </div>
  );
}
