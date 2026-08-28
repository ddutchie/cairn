"use client";

import React, { useMemo } from "react";
import { FileText, Kanban, Workflow, Terminal, Hash, BarChart2, GitBranch, CalendarDays, Zap, Settings } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { ProjectIcon, WorkspaceIcon } from "@/lib/workspace-icons";
import { countOpenCardsByProject } from "../sidebar-utils";

export function StudioSidebar() {
  const { activeWorkspaceId, activeProjectId, activeView, workspaces, projects: allProjects, setActiveProject, setView, cards, notes, hiddenViews, toggleSidebar } =
    useCairnStore(
      useShallow((s) => ({
        activeWorkspaceId: s.activeWorkspaceId,
        activeProjectId: s.activeProjectId,
        activeView: s.activeView,
        workspaces: s.workspaces,
        projects: s.projects,
        setActiveProject: s.setActiveProject,
        setView: s.setView,
        cards: s.cards,
        notes: s.notes,
        hiddenViews: s.hiddenViews,
        toggleSidebar: s.toggleSidebar,
      }))
    );

  const workspace = useMemo(() => workspaces.find((w) => w.id === activeWorkspaceId), [workspaces, activeWorkspaceId]);
  const projects = useMemo(() => (activeWorkspaceId ? allProjects.filter((p) => p.workspaceId === activeWorkspaceId) : []), [activeWorkspaceId, allProjects]);
  const openCounts = useMemo(() => countOpenCardsByProject(cards), [cards]);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  return (
    <aside className="w-[260px] flex-shrink-0 flex flex-col border-r border-[var(--border)] bg-[linear-gradient(180deg,#141414,#111)] overflow-hidden">
      {/* tray */}
      <div className="m-3 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] relative overflow-hidden" style={{ boxShadow: "0 8px 20px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.04)" }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(300px 120px at 80% 0%, color-mix(in srgb,var(--accent) 10%, transparent), transparent 60%)" }} />
        <div className="relative flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-[linear-gradient(180deg,var(--surface-3),var(--surface-2))] border border-[var(--border)] grid place-items-center text-[var(--accent)]">
            <WorkspaceIcon name={workspace?.icon} size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold truncate">{workspace?.name ?? "Workspace"}</div>
            <div className="text-[0.643rem] text-[var(--text-tertiary)]">{projects.length} projects · local-first</div>
          </div>
          <span className="text-[0.643rem] px-1.5 py-0.5 rounded-full bg-[var(--accent-dim)] border border-[color-mix(in_srgb,var(--accent)_22%,transparent)] text-[var(--accent)]">● Live</span>
        </div>
        <div className="relative grid grid-cols-4 gap-1.5 mt-2.5">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1.5 text-center"><div className="text-xs font-bold leading-none">{projects.length}</div><div className="text-[0.571rem] tracking-wide uppercase text-[var(--text-tertiary)]">Projects</div></div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1.5 text-center"><div className="text-xs font-bold leading-none">{cards.filter((c) => !c.archivedAt).length}</div><div className="text-[0.571rem] tracking-wide uppercase text-[var(--text-tertiary)]">Tasks</div></div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1.5 text-center"><div className="text-xs font-bold leading-none text-[var(--warning)]">{cards.filter((c) => c.dueDate).length}</div><div className="text-[0.571rem] tracking-wide uppercase text-[var(--text-tertiary)]">Due</div></div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1.5 text-center"><div className="text-xs font-bold leading-none">{notes.length}</div><div className="text-[0.571rem] tracking-wide uppercase text-[var(--text-tertiary)]">Notes</div></div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 py-2 space-y-4">
        {/* active project stacks */}
        <div>
          <div className="text-[0.571rem] font-semibold tracking-[0.08em] uppercase text-[var(--text-tertiary)] px-1 mb-1.5">Active project</div>
          <div className="space-y-1.5">
            {projects.map((p) => {
              const isActive = p.id === activeProjectId;
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setActiveProject(p.id); setView("overview"); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveProject(p.id); setView("overview"); } }}
                  className={cn(
                    "w-full text-left p-2.5 rounded-xl border transition-all cursor-pointer",
                    isActive
                      ? "bg-[linear-gradient(180deg,color-mix(in_srgb,var(--accent)_10%,var(--surface)),var(--surface))] border-[color-mix(in_srgb,var(--accent)_28%,transparent)] shadow-[0_8px_18px_rgba(0,0,0,.32)]"
                      : "bg-[var(--surface)] border-[var(--border)] hover:border-[var(--muted)] hover:translate-y-[-1px]"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn("w-6 h-6 rounded-md grid place-items-center text-xs border", isActive ? "bg-[var(--accent)] text-[var(--accent-fg)] border-[var(--accent)]" : "bg-[var(--surface-2)] text-[var(--text-secondary)] border-[var(--border)]")}>
                      <ProjectIcon name={p.icon} size={12} />
                    </span>
                    <span className="text-xs font-semibold truncate flex-1">{p.name}</span>
                    <span className="text-[0.643rem] font-mono px-1.5 py-0.5 rounded-full bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-tertiary)]">{openCounts.get(p.id) ?? 0}</span>
                  </div>
                  {isActive && activeProject && (
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {(["overview", "notes", "board", "calendar", "flow", "agent"] as const)
                        .filter((v) => !(v !== "overview" && v !== "notes" && hiddenViews.has(v as never)))
                        .map((v) => (
                          <button
                            key={v}
                            onClick={(e) => { e.stopPropagation(); setView(v); }}
                            className={cn("px-2 py-1 rounded-full text-[0.714rem] font-medium border", activeView === v ? "bg-[var(--text-primary)] text-[var(--background)] border-[var(--text-primary)]" : "bg-[var(--surface-2)] text-[var(--text-tertiary)] border-[var(--border)] hover:text-[var(--text-primary)]")}
                          >
                            {v}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* views grouped */}
        <div>
          <div className="text-[0.571rem] font-semibold tracking-[0.08em] uppercase text-[var(--text-tertiary)] px-1 mb-1.5">Navigate this project</div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
            <div className="px-2.5 py-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)] border-b border-[var(--border)]">◆ Views <span className="ml-auto text-[0.643rem] font-normal text-[var(--text-tertiary)]">⌘1–5</span></div>
            <div className="p-1 space-y-0.5">
              <button onClick={() => setView("overview")} className={cn("flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs", activeView === "overview" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]")}><Hash size={13} /> Overview</button>
              <button onClick={() => setView("notes")} className={cn("flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs", activeView === "notes" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]")}><FileText size={13} /> Notes</button>
              {!hiddenViews.has("board") && <button onClick={() => setView("board")} className={cn("flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs", activeView === "board" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]")}><Kanban size={13} /> Board</button>}
              {!hiddenViews.has("calendar") && <button onClick={() => setView("calendar")} className={cn("flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs", activeView === "calendar" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]")}><CalendarDays size={13} /> Calendar</button>}
              {!hiddenViews.has("flow") && <button onClick={() => setView("flow")} className={cn("flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs", activeView === "flow" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]")}><Workflow size={13} /> Idea Flow</button>}
              {!hiddenViews.has("agent") && <button onClick={() => setView("agent")} className={cn("flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs", activeView === "agent" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]")}><Terminal size={13} /> Agent</button>}
            </div>
          </div>
        </div>

        <div>
          <div className="text-[0.571rem] font-semibold tracking-[0.08em] uppercase text-[var(--text-tertiary)] px-1 mb-1.5">Workspace tools</div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
            <div className="px-2.5 py-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)] border-b border-[var(--border)]">◉ Operate <span className="ml-auto text-[0.643rem] font-normal text-[var(--text-tertiary)]">global</span></div>
            <div className="p-1 space-y-0.5">
              <button onClick={() => setView("calendar-all")} className={cn("flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs", activeView === "calendar-all" ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]")}><CalendarDays size={13} /> Calendar</button>
              {!hiddenViews.has("graph") && <button onClick={() => setView("graph")} className={cn("flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs", activeView === "graph" ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]")}><GitBranch size={13} /> Knowledge Graph</button>}
              {!hiddenViews.has("insights") && <button onClick={() => setView("insights")} className={cn("flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs", activeView === "insights" ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]")}><BarChart2 size={13} /> Insights</button>}
              <button onClick={() => setView("automations")} className={cn("flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs", activeView === "automations" ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]")}><Zap size={13} /> Automations</button>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-[var(--border)] p-2 flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
        <button onClick={() => setView("settings")} className={cn("flex items-center gap-2 flex-1 px-2.5 py-1.5 rounded-md", activeView === "settings" ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]")}><Settings size={13} /> Settings</button>
        <button onClick={toggleSidebar} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">‹</button>
      </div>
    </aside>
  );
}
