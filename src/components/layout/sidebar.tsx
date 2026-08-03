"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  FileText, Kanban, Settings, Search, MessageSquare,
  ChevronDown, ChevronRight, Plus, MoreHorizontal,
  FolderOpen, Hash, Layers, Pencil, Trash2, GitBranch, BarChart2, Workflow, Terminal, CalendarDays, Download, GitMerge, Check, Zap, Bell,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { ProjectIcon } from "@/lib/workspace-icons";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { NotificationCenter } from "@/components/automations/notification-center";
import { WorkspaceSwitcher } from "./sidebar/WorkspaceSwitcher";
import { ProjectCreateForm } from "./sidebar/ProjectCreateForm";
import { buildShortcutMap, modKey, countOpenCardsByProject, dueDateSeverity, dueDateDiffDays } from "./sidebar-utils";
import { getActiveCrossProjectDrag, setActiveCrossProjectDrag } from "@/lib/cross-project-dnd";
import type { Project } from "@/types";

// ── View nav config ───────────────────────────────────────────────────────────

interface ViewNavItem {
  view: "board" | "calendar" | "calendar-all" | "flow" | "agent" | "graph" | "insights" | "chat";
  label: string;
  icon: React.ReactNode;
  iconSm: React.ReactNode;
  /** Which hiddenView key this maps to */
  hiddenKey: "board" | "calendar" | "calendar-all" | "flow" | "agent" | "graph" | "insights";
  /** Whether it lives inside the project tree (true) or bottom bar (false) */
  inProject: boolean;
}

const VIEW_NAV: ViewNavItem[] = [
  { view: "board",    label: "Board",           icon: <Kanban size={13} />,   iconSm: <Kanban size={15} />,   hiddenKey: "board",    inProject: true  },
  { view: "calendar", label: "Calendar",         icon: <CalendarDays size={13} />, iconSm: <CalendarDays size={15} />, hiddenKey: "calendar", inProject: true  },
  { view: "flow",     label: "Idea Flow",        icon: <Workflow size={11} />, iconSm: <Workflow size={15} />, hiddenKey: "flow",     inProject: true  },
  { view: "agent",    label: "Agent",            icon: <Terminal size={11} />, iconSm: <Terminal size={15} />, hiddenKey: "agent",   inProject: true  },
  { view: "calendar-all", label: "Calendar",     icon: <CalendarDays size={13} />, iconSm: <CalendarDays size={15} />, hiddenKey: "calendar-all", inProject: false },
  { view: "graph",    label: "Knowledge Graph",  icon: <GitBranch size={13} />,iconSm: <GitBranch size={15} />,hiddenKey: "graph",    inProject: false },
  { view: "insights", label: "Insights",         icon: <BarChart2 size={13} />,iconSm: <BarChart2 size={15} />,hiddenKey: "insights", inProject: false },
];

export function Sidebar() {
  const {
    sidebarCollapsed, toggleSidebar,
    activeWorkspaceId, activeProjectId, activeView,
    workspaces, projects: allProjects, getWorkspaceProjects,
    setActiveProject, setView, toggleSearch, toggleChat,
    createProject, updateProject, deleteProject, mergeProject,
     cards, chatOpen, searchOpen,
     hiddenViews,
     pendingApprovalCount,
     notificationUnreadCount,
     moveFolderToProject, moveCardToProject, moveNoteToProject,
   } = useCairnStore(useShallow((s) => ({    sidebarCollapsed:    s.sidebarCollapsed,
     toggleSidebar:       s.toggleSidebar,
     activeWorkspaceId:   s.activeWorkspaceId,
     activeProjectId:     s.activeProjectId,
     activeView:          s.activeView,
     workspaces:          s.workspaces,
     projects:            s.projects,
     getWorkspaceProjects: s.getWorkspaceProjects,
     setActiveProject:    s.setActiveProject,
     setView:             s.setView,
     toggleSearch:        s.toggleSearch,
     toggleChat:          s.toggleChat,
     createProject:       s.createProject,
     updateProject:       s.updateProject,
     deleteProject:       s.deleteProject,
     mergeProject:        s.mergeProject,
     cards:               s.cards,
     chatOpen:            s.chatOpen,
     searchOpen:          s.searchOpen,
     hiddenViews:         s.hiddenViews,
     pendingApprovalCount: s.pendingApprovalCount,
     notificationUnreadCount: s.notificationUnreadCount,
     moveFolderToProject: s.moveFolderToProject,
     moveCardToProject:   s.moveCardToProject,
     moveNoteToProject:   s.moveNoteToProject,
   })));

  const [notificationOpen, setNotificationOpen] = useState(false);

  // All navigable views in order (overview + notes always first)
  const visibleNavItems = React.useMemo(
    () => VIEW_NAV.filter((item) => !hiddenViews.has(item.hiddenKey)),
    [hiddenViews],
  );
  // ⌘1 = overview, ⌘2 = notes, then visible views in order
  const shortcutMap = React.useMemo(
    () => buildShortcutMap(visibleNavItems),
    [visibleNavItems],
  );
  // Platform-appropriate modifier symbol ("⌘" on macOS, "Ctrl+" elsewhere) for
  // the fixed shortcut hints below — must match buildShortcutMap's prefix.
  const mod = React.useMemo(() => modKey(), []);
  function shortcutLabel(item: ViewNavItem): string {
    return shortcutMap.get(item.view) ?? "";
  }

  const closeSidebarOnMobile = useCallback(() => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches && !sidebarCollapsed) {
      toggleSidebar();
    }
  }, [sidebarCollapsed, toggleSidebar]);

  // Cross-project drop: a notes folder or a task card dragged onto a project row.
  // Returns true if a move was dispatched. Reads the active drag payload from the
  // shared cross-project-dnd module (works for both native and dnd-kit sources).
  const handleCrossProjectDrop = useCallback((targetProjectId: string): boolean => {
    const drag = getActiveCrossProjectDrag();
    if (!drag || drag.sourceProjectId === targetProjectId) return false;
    if (drag.kind === "folder") {
      moveFolderToProject(drag.sourceProjectId, drag.folderPath, targetProjectId);
    } else if (drag.kind === "note") {
      moveNoteToProject(drag.noteId, targetProjectId);
    } else {
      moveCardToProject(drag.cardId, targetProjectId);
    }
    setActiveCrossProjectDrag(null);
    return true;
  }, [moveFolderToProject, moveCardToProject, moveNoteToProject]);

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set([activeProjectId ?? ""]));
  const [creatingProject, setCreatingProject]   = useState(false);
  const [newProjectName, setNewProjectName]     = useState("");

  const workspace = React.useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId],
  );
  const projects = React.useMemo(
    () => activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeWorkspaceId, workspaces, allProjects],
  );

  function toggleProjectExpand(projectId: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) { next.delete(projectId); } else { next.add(projectId); }
      return next;
    });
  }

  const commitCreateProject = useCallback(async () => {
    if (!activeWorkspaceId || !newProjectName.trim()) { setCreatingProject(false); return; }
    setCreatingProject(false);
    setNewProjectName("");
    const proj = await createProject(activeWorkspaceId, newProjectName.trim());
    setActiveProject(proj.id);
  }, [activeWorkspaceId, newProjectName, createProject, setActiveProject]);

  const cancelCreateProject = useCallback(() => { setCreatingProject(false); setNewProjectName(""); }, []);

  return (
    <>
      {/* Mobile backdrop */}
      {!sidebarCollapsed && (
        <div
          className="fixed inset-0 bg-[color-mix(in_srgb,var(--background)_40%,transparent)] z-30 md:hidden animate-fade-in"
          onClick={toggleSidebar}
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-[var(--border)] bg-[var(--surface)] flex-shrink-0 overflow-hidden md:static md:translate-x-0 transition-all duration-300 ease-in-out relative",
          sidebarCollapsed ? "w-12 py-3 gap-1" : "w-56"
        )}
      >
        {/* Collapsed UI */}
        <div
          className={cn(
            "flex flex-col items-center gap-1 w-full transition-opacity duration-300",
            sidebarCollapsed ? "opacity-100" : "opacity-0 pointer-events-none absolute inset-x-0 top-3"
          )}
        >
          <Tooltip content="Expand sidebar" side="right">
            <button onClick={toggleSidebar} className="p-2 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors">
              <Layers size={16} />
            </button>
          </Tooltip>
          <div className="w-5 h-px bg-[var(--border)] my-1" />
          <Tooltip content={`Search (${mod}K)`} side="right">
            <button onClick={toggleSearch}
              className={cn("p-2 rounded-md transition-colors", searchOpen ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
              <Search size={15} />
            </button>
          </Tooltip>
          {!hiddenViews.has("chat") && (
            <Tooltip content={`AI Chat (${mod}/)`} side="right">
              <button onClick={toggleChat}
                className={cn("p-2 rounded-md transition-colors", chatOpen ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
                <MessageSquare size={15} />
              </button>
            </Tooltip>
          )}
          <div className="w-5 h-px bg-[var(--border)] my-1" />
          <Tooltip content={`Overview (${mod}1)`} side="right">
            <button onClick={() => setView("overview")}
              className={cn("p-2 rounded-md transition-colors", activeView === "overview" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
              <Hash size={15} />
            </button>
          </Tooltip>
          <Tooltip content={`Notes (${mod}2)`} side="right">
            <button onClick={() => setView("notes")}
              className={cn("p-2 rounded-md transition-colors", activeView === "notes" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
              <FileText size={15} />
            </button>
          </Tooltip>
          {visibleNavItems.map((item) => (
            <Tooltip key={item.view} content={`${item.label} (${shortcutLabel(item)})`} side="right">
              <button onClick={() => setView(item.view)}
                className={cn("p-2 rounded-md transition-colors", activeView === item.view ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
                {item.iconSm}
              </button>
            </Tooltip>
          ))}
        </div>

        {/* Expanded UI */}
        <div
          className={cn(
            "flex flex-col flex-1 min-h-0 w-full transition-opacity duration-300",
            sidebarCollapsed ? "opacity-0 pointer-events-none absolute inset-x-0 top-0 h-0 overflow-hidden" : "opacity-100"
          )}
        >
          <div data-tutorial="workspace-switcher">
            <WorkspaceSwitcher workspace={workspace} onCollapse={toggleSidebar} />
          </div>

          {/* Quick actions */}
          <div className="flex items-center gap-0.5 px-2 h-9 border-b border-[var(--border-subtle)] flex-shrink-0">
            <Tooltip content={`Search (${mod}K)`}>
              <button onClick={() => { toggleSearch(); closeSidebarOnMobile(); }}
                className={cn("flex items-center gap-1.5 flex-1 rounded-md px-2 py-1 text-xs transition-colors",
                  searchOpen ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
                <Search size={12} /><span>Search</span>
                <span className="ml-auto text-[0.714rem] text-[var(--text-tertiary)] font-mono">{mod}K</span>
              </button>
            </Tooltip>
            {!hiddenViews.has("chat") && (
              <Tooltip content={`AI Chat (${mod}/)`}>
                <button onClick={() => { toggleChat(); closeSidebarOnMobile(); }}
                  className={cn("p-1 rounded-md transition-colors", chatOpen ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
                  <MessageSquare size={13} />
                </button>
              </Tooltip>
            )}
          </div>

          {/* Projects list */}
          <nav data-tutorial="projects-list" className="flex-1 overflow-y-auto py-2 min-h-0">
            <div className="flex items-center justify-between px-3 mb-1">
              <span className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">Projects</span>
              <Tooltip content="New project">
                <button onClick={() => { setCreatingProject(true); setNewProjectName(""); }}
                  className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors">
                  <Plus size={12} />
                </button>
              </Tooltip>
            </div>

            <div className="space-y-0.5 px-1">
              {(() => {
                // Pre-compute card counts per project to avoid O(projects × cards) in the map
                const openCardCountByProject = countOpenCardsByProject(cards);
                return projects.map((project) => (
                  <ProjectItem
                    key={project.id}
                    project={project}
                    isActive={project.id === activeProjectId}
                    isExpanded={expandedProjects.has(project.id)}
                    onToggleExpand={() => toggleProjectExpand(project.id)}
                    onSelectProject={() => { setActiveProject(project.id); setView("overview"); if (!expandedProjects.has(project.id)) toggleProjectExpand(project.id); closeSidebarOnMobile(); }}
                    activeView={activeView}
                    onSelectView={(view) => { setActiveProject(project.id); setView(view); closeSidebarOnMobile(); }}
                    onRename={(name) => updateProject(project.id, { name })}
                    onDelete={() => deleteProject(project.id)}
                    mergeTargets={projects.filter((p) => p.id !== project.id)}
                    onMerge={(targetId) => mergeProject(project.id, targetId)}
                    openCardCount={openCardCountByProject.get(project.id) ?? 0}
                    hiddenViews={hiddenViews}
                    visibleNavItems={visibleNavItems}
                    onCrossProjectDrop={handleCrossProjectDrop}
                  />
                ));
              })()}
              {creatingProject && (
                <ProjectCreateForm
                  value={newProjectName}
                  onChange={setNewProjectName}
                  onCommit={commitCreateProject}
                  onCancel={cancelCreateProject}
                />
              )}
            </div>

            {projects.length === 0 && !creatingProject && (
              <div className="px-3 py-6 text-center">
                <FolderOpen size={20} className="mx-auto mb-2 text-[var(--text-tertiary)]" />
                <p className="text-xs text-[var(--text-tertiary)]">No projects yet</p>
                <button onClick={() => setCreatingProject(true)} className="mt-2 text-xs text-[var(--accent)] hover:text-[var(--accent)] hover:bg-[var(--accent-dim)] px-2 py-0.5 rounded transition-colors">
                  Create one
                </button>
              </div>
            )}
          </nav>

          {/* Bottom nav: Automations (prominent) + workspace views + Settings + Notifications */}
          <div className="border-t border-[var(--border)] p-2 space-y-0.5">
            {/* Automations — most important, sits above the workspace views */}
            <button onClick={() => { setView("automations"); closeSidebarOnMobile(); }}
              className={cn("flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs transition-colors",
                activeView === "automations" ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
              <Zap size={13} /><span>Automations</span>
              {pendingApprovalCount > 0 && (
                <span className="ml-auto min-w-4 h-4 px-1 rounded-full bg-[var(--accent)] text-[var(--accent-fg,#fff)] text-[0.625rem] leading-4 text-center font-semibold">
                  {pendingApprovalCount}
                </span>
              )}
            </button>

            {/* Divider — separates Automations from the workspace views below */}
            <div className="my-1.5 border-t border-[var(--border-subtle)]" />

            {visibleNavItems.filter((item) => !item.inProject).map((item) => (
              <button key={item.view} onClick={() => { setView(item.view); closeSidebarOnMobile(); }}
                className={cn("flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs transition-colors",
                  activeView === item.view ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
                {item.icon}<span>{item.label}</span>
                {shortcutLabel(item) && (
                  <span className="ml-auto text-[0.714rem] font-mono text-[var(--text-tertiary)]">{shortcutLabel(item)}</span>
                )}
              </button>
            ))}
            <button onClick={() => { setView("settings"); closeSidebarOnMobile(); }}
              className={cn("flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs transition-colors",
                activeView === "settings" ? "text-[var(--text-primary)] bg-[var(--surface-2)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
              <Settings size={13} /><span>Settings</span>
            </button>
            {/* Notifications — last */}
            <button onClick={() => { setNotificationOpen(true); closeSidebarOnMobile(); }}
              className={cn("flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs transition-colors",
                "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
              <Bell size={13} /><span>Notifications</span>
              {notificationUnreadCount > 0 && (
                <span className="ml-auto min-w-4 h-4 px-1 rounded-full bg-[var(--accent)] text-[var(--accent-fg,#fff)] text-[0.625rem] leading-4 text-center font-semibold">
                  {notificationUnreadCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </aside>

      {notificationOpen && (
        <NotificationCenter onClose={() => setNotificationOpen(false)} />
      )}
    </>
  );
}

// ── ProjectItem ───────────────────────────────────────────────────────────────

interface ProjectItemProps {
  project: Project; isActive: boolean; isExpanded: boolean;
  onToggleExpand: () => void; onSelectProject: () => void;
  activeView: string;
  onSelectView: (view: "overview" | "notes" | "board" | "calendar" | "flow" | "graph" | "chat" | "agent") => void;
  onRename: (name: string) => void; onDelete: () => void;
  /** Other projects in this workspace this one can be merged into. */
  mergeTargets: Project[];
  /** Merge THIS project into the given target project id. */
  onMerge: (targetId: string) => Promise<{ notes: number; cards: number } | null>;
  openCardCount: number;
  hiddenViews: Set<string>;
  visibleNavItems: ViewNavItem[];
  onCrossProjectDrop: (targetProjectId: string) => boolean;
}

function ProjectItem({ project, isActive, isExpanded, onToggleExpand, onSelectProject, activeView, onSelectView, onRename, onDelete, mergeTargets, onMerge, openCardCount, hiddenViews: _hiddenViews, visibleNavItems, onCrossProjectDrop }: ProjectItemProps) {
  const [renaming, setRenaming]             = useState(false);
  const [renameValue, setRenameValue]       = useState(project.name);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId]   = useState<string>("");
  const [merging, setMerging]               = useState(false);
  const [isDropTarget, setIsDropTarget]     = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRenameValue(project.name);
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming, project.name]);

  function commitRename() {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== project.name) onRename(trimmed);
    setRenaming(false);
  }

  async function commitMerge() {
    if (!mergeTargetId || merging) return;
    setMerging(true);
    try {
      await onMerge(mergeTargetId);
      setMergeDialogOpen(false);
      setMergeTargetId("");
    } finally {
      setMerging(false);
    }
  }

  return (
    <>
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent size="sm">
          <DialogHeader><DialogTitle>Delete project?</DialogTitle></DialogHeader>
          <div className="px-5 py-4 space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              <strong className="text-[var(--text-primary)]">{project.name}</strong> and all its notes, tasks, and columns will be permanently deleted. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <DialogClose asChild><Button variant="ghost" size="sm">Cancel</Button></DialogClose>
              <Button variant="ghost" size="sm" className="text-[var(--danger)] hover:bg-[var(--danger)]/10"
                onClick={() => { setDeleteDialogOpen(false); onDelete(); }}>
                <Trash2 size={13} />Delete project
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={mergeDialogOpen} onOpenChange={(o) => { setMergeDialogOpen(o); if (!o) setMergeTargetId(""); }}>
        <DialogContent size="sm">
          <DialogHeader><DialogTitle>Merge project</DialogTitle></DialogHeader>
          <div className="px-5 py-4 space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              All notes, tasks, columns, and idea-flow nodes from{" "}
              <strong className="text-[var(--text-primary)]">{project.name}</strong> will be moved into the project you pick below, and{" "}
              <strong className="text-[var(--text-primary)]">{project.name}</strong> will then be deleted. This cannot be undone.
            </p>
            {mergeTargets.length === 0 ? (
              <p className="text-sm text-[var(--text-tertiary)]">
                There are no other projects in this workspace to merge into.
              </p>
            ) : (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-secondary)]">Merge into</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className={cn(
                        "w-full flex items-center justify-between gap-2 pl-2.5 pr-2 py-1.5 text-sm rounded-md",
                        "bg-[var(--surface-2)] border border-[var(--border)]",
                        "hover:border-[var(--muted)] focus:outline-none focus:border-[var(--accent)] transition-colors cursor-pointer",
                        mergeTargetId ? "text-[var(--text-primary)]" : "text-[var(--text-tertiary)]",
                      )}
                    >
                      <span className="truncate">
                        {mergeTargets.find((p) => p.id === mergeTargetId)?.name ?? "Select a project…"}
                      </span>
                      <ChevronDown size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] max-h-64 overflow-y-auto">
                    {mergeTargets.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        onSelect={() => setMergeTargetId(p.id)}
                        className={cn("text-sm", p.id === mergeTargetId && "text-[var(--accent)]")}
                      >
                        <span className="w-3.5 flex-shrink-0">
                          {p.id === mergeTargetId && <Check size={12} />}
                        </span>
                        <span className="truncate">{p.name}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </label>
            )}
            <div className="flex justify-end gap-2">
              <DialogClose asChild><Button variant="ghost" size="sm" disabled={merging}>Cancel</Button></DialogClose>
              <Button
                variant="ghost"
                size="sm"
                className="text-[var(--accent)] hover:bg-[var(--accent-dim)]"
                disabled={!mergeTargetId || merging || mergeTargets.length === 0}
                onClick={commitMerge}
              >
                <GitMerge size={13} />{merging ? "Merging…" : "Merge & delete"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <div>
        <div
          data-project-drop-id={project.id}
          className={cn("flex items-center gap-1 rounded-md px-2 py-1.5 group cursor-pointer transition-colors",
          isDropTarget
            ? "bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] outline outline-1 outline-[var(--accent)] outline-offset-[-1px]"
            : isActive ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]")}
          onDragOver={(e) => {
            const drag = getActiveCrossProjectDrag();
            if (!drag || drag.sourceProjectId === project.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!isDropTarget) setIsDropTarget(true);
          }}
          onDragLeave={() => { if (isDropTarget) setIsDropTarget(false); }}
          onDrop={(e) => {
            const drag = getActiveCrossProjectDrag();
            if (!drag || drag.sourceProjectId === project.id) return;
            e.preventDefault();
            e.stopPropagation();
            setIsDropTarget(false);
            onCrossProjectDrop(project.id);
          }}
        >
          <button onClick={onToggleExpand} className="flex-shrink-0 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
            {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
          {renaming ? (
            <input ref={renameInputRef} value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(false); }}
              className="flex-1 min-w-0 bg-transparent text-xs font-medium text-[var(--text-primary)] outline-none border-b border-[var(--accent)]"
              onClick={(e) => e.stopPropagation()} />
          ) : (
            <button onClick={onSelectProject} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
              <ProjectIcon name={project.icon} size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
              <span className="text-xs font-medium truncate flex-1">{project.name}</span>
              {openCardCount > 0 && (
                <span className="text-[0.714rem] text-[var(--text-tertiary)] tabular-nums">{openCardCount}</span>
              )}
              {project.dueDate && <DueDateDot dueDate={project.dueDate} />}
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 flex-shrink-0 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface)] transition-all"
                onClick={(e) => e.stopPropagation()}>
                <MoreHorizontal size={12} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right" className="w-40">
              <DropdownMenuItem onClick={(e: React.MouseEvent) => { e.stopPropagation(); setRenaming(true); }} className="flex items-center gap-2 text-xs">
                <Pencil size={11} />Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  window.electron?.exportMarkdown?.("project", project.id);
                }}
                className="flex items-center gap-2 text-xs"
              >
                <Download size={11} />Export as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); setMergeDialogOpen(true); }}
                className="flex items-center gap-2 text-xs"
              >
                <GitMerge size={11} />Merge into…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={(e: React.MouseEvent) => { e.stopPropagation(); setDeleteDialogOpen(true); }}
                className="flex items-center gap-2 text-xs text-[var(--danger)] focus:text-[var(--danger)]">
                <Trash2 size={11} />Delete project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {isExpanded && (
          <div className="ml-4 mt-0.5 space-y-0.5 border-l border-[var(--border)] pl-2">
            <NavItem icon={<Hash size={11} />} label="Overview" isActive={isActive && activeView === "overview"} onClick={() => onSelectView("overview")} />
            <NavItem icon={<FileText size={11} />} label="Notes" isActive={isActive && activeView === "notes"} onClick={() => onSelectView("notes")} />
            {visibleNavItems.filter((item) => item.inProject).map((item) => (
              <NavItem
                key={item.view}
                icon={item.icon}
                label={item.label}
                isActive={isActive && activeView === item.view}
                onClick={() => onSelectView(item.view as "board" | "calendar" | "flow" | "agent" | "chat")}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function DueDateDot({ dueDate }: { dueDate: string }) {
  // Computed on every render rather than memoised on `dueDate` alone: a memo
  // keyed only by dueDate would freeze Date.now() at first render, so the
  // severity/diffDays/label would go stale as wall-clock time advances while
  // the app stays open (e.g. a "due in 1 day" item never ticking to overdue).
  const due = new Date(dueDate);
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const severity = dueDateSeverity(dueDate, now);
  const diffDays = dueDateDiffDays(dueDate, now);
  const dueDateLabel = due.toLocaleDateString();
  if (severity === "danger") return (
    <Tooltip content={`Overdue — due ${dueDateLabel}`} side="right">
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--danger)] flex-shrink-0" />
    </Tooltip>
  );
  if (severity === "warning") return (
    <Tooltip content={diffDays === 0 ? "Due today" : `Due in ${diffDays} day${diffDays !== 1 ? "s" : ""}`} side="right">
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] flex-shrink-0" />
    </Tooltip>
  );
  return null;
}

function NavItem({ icon, label, isActive, onClick }: { icon: React.ReactNode; label: string; isActive: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={cn("flex items-center gap-1.5 w-full px-1.5 py-1 rounded text-[0.786rem] transition-colors text-left",
        isActive ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]")}>
      {icon}{label}
    </button>
  );
}
