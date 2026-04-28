"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  FileText,
  Kanban,
  Settings,
  Search,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  Plus,
  Pin,
  MoreHorizontal,
  FolderOpen,
  Hash,
  Layers,
  Check,
  X,
} from "lucide-react";
import { cn, formatRelative } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { WorkspaceIcon, ProjectIcon } from "@/lib/workspace-icons";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import type { Project, Note } from "@/types";

export function Sidebar() {
  const {
    sidebarCollapsed,
    toggleSidebar,
    activeWorkspaceId,
    activeProjectId,
    activeView,
    workspaces,
    getWorkspaceProjects,
    getProjectNotes,
    setActiveProject,
    setView,
    toggleSearch,
    toggleChat,
    createProject,
    chatOpen,
    searchOpen,
  } = useCairnStore();

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set([activeProjectId ?? ""])
  );
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const newProjectInputRef = useRef<HTMLInputElement>(null);

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const projects = activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : [];

  useEffect(() => {
    if (creatingProject) newProjectInputRef.current?.focus();
  }, [creatingProject]);

  function toggleProjectExpand(projectId: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      next.has(projectId) ? next.delete(projectId) : next.add(projectId);
      return next;
    });
  }

  function handleCreateProject() {
    setCreatingProject(true);
    setNewProjectName("");
  }

  async function commitCreateProject() {
    if (!activeWorkspaceId || !newProjectName.trim()) {
      setCreatingProject(false);
      return;
    }
    setCreatingProject(false);
    setNewProjectName("");
    const proj = await createProject(activeWorkspaceId, newProjectName.trim());
    setActiveProject(proj.id);
  }

  function cancelCreateProject() {
    setCreatingProject(false);
    setNewProjectName("");
  }

  if (sidebarCollapsed) {
    return (
      <aside className="flex flex-col items-center gap-1 py-3 w-12 border-r border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
        <Tooltip content="Expand sidebar" side="right">
          <button
            onClick={toggleSidebar}
            className="p-2 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <Layers size={16} />
          </button>
        </Tooltip>
        <div className="w-5 h-px bg-[var(--border)] my-1" />
        <Tooltip content="Search (⌘K)" side="right">
          <button
            onClick={toggleSearch}
            className={cn(
              "p-2 rounded-md transition-colors",
              searchOpen
                ? "text-[var(--accent)] bg-[var(--accent-dim)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
            )}
          >
            <Search size={15} />
          </button>
        </Tooltip>
        <Tooltip content="AI Chat (⌘/)" side="right">
          <button
            onClick={toggleChat}
            className={cn(
              "p-2 rounded-md transition-colors",
              chatOpen
                ? "text-[var(--accent)] bg-[var(--accent-dim)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
            )}
          >
            <MessageSquare size={15} />
          </button>
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside className="flex flex-col w-56 border-r border-[var(--border)] bg-[var(--surface)] flex-shrink-0 overflow-hidden">
      {/* Workspace header */}
      <div className="flex items-center gap-2 px-3 h-11 border-b border-[var(--border)] flex-shrink-0">
        <WorkspaceIcon name={workspace?.icon} size={15} className="text-[var(--text-secondary)] flex-shrink-0" />
        <span className="text-sm font-semibold text-[var(--text-primary)] truncate flex-1">
          {workspace?.name ?? "Workspace"}
        </span>
        <button
          onClick={toggleSidebar}
          className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
        >
          <ChevronRight size={13} />
        </button>
      </div>

      {/* Quick actions */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-[var(--border-subtle)]">
        <Tooltip content="Search (⌘K)">
          <button
            onClick={toggleSearch}
            className={cn(
              "flex items-center gap-1.5 flex-1 rounded-md px-2 py-1.5 text-xs transition-colors",
              searchOpen
                ? "text-[var(--accent)] bg-[var(--accent-dim)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
            )}
          >
            <Search size={12} />
            <span>Search</span>
            <span className="ml-auto text-[10px] text-[var(--text-tertiary)] font-mono">⌘K</span>
          </button>
        </Tooltip>
        <Tooltip content="AI Chat (⌘/)">
          <button
            onClick={toggleChat}
            className={cn(
              "p-1.5 rounded-md transition-colors",
              chatOpen
                ? "text-[var(--accent)] bg-[var(--accent-dim)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
            )}
          >
            <MessageSquare size={13} />
          </button>
        </Tooltip>
      </div>

      {/* Projects list */}
      <nav className="flex-1 overflow-y-auto py-2 min-h-0">
        <div className="flex items-center justify-between px-3 mb-1">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">
            Projects
          </span>
          <Tooltip content="New project">
            <button
              onClick={handleCreateProject}
              className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
            >
              <Plus size={12} />
            </button>
          </Tooltip>
        </div>

        <div className="space-y-0.5 px-1">
          {projects.map((project) => (
            <ProjectItem
              key={project.id}
              project={project}
              isActive={project.id === activeProjectId}
              isExpanded={expandedProjects.has(project.id)}
              onToggleExpand={() => toggleProjectExpand(project.id)}
              onSelectProject={() => {
                setActiveProject(project.id);
                setView("overview");
              }}
              activeView={activeView}
              onSelectView={(view) => {
                setActiveProject(project.id);
                setView(view);
              }}
              notes={getProjectNotes(project.id).slice(0, 5)}
            />
          ))}

          {/* Inline new project input */}
          {creatingProject && (
            <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--surface-2)]">
              <ProjectIcon name={undefined} size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
              <input
                ref={newProjectInputRef}
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitCreateProject();
                  if (e.key === "Escape") cancelCreateProject();
                }}
                placeholder="Project name"
                className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
              />
              <button onClick={commitCreateProject} className="p-0.5 text-[var(--success)] hover:opacity-80">
                <Check size={11} />
              </button>
              <button onClick={cancelCreateProject} className="p-0.5 text-[var(--text-tertiary)] hover:opacity-80">
                <X size={11} />
              </button>
            </div>
          )}
        </div>

        {projects.length === 0 && !creatingProject && (
          <div className="px-3 py-6 text-center">
            <FolderOpen size={20} className="mx-auto mb-2 text-[var(--text-tertiary)]" />
            <p className="text-xs text-[var(--text-tertiary)]">No projects yet</p>
            <button
              onClick={handleCreateProject}
              className="mt-2 text-xs text-[var(--accent)] hover:underline"
            >
              Create one
            </button>
          </div>
        )}
      </nav>

      {/* Bottom: Settings */}
      <div className="border-t border-[var(--border)] p-2">
        <button
          onClick={() => setView("settings")}
          className={cn(
            "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs transition-colors",
            activeView === "settings"
              ? "text-[var(--text-primary)] bg-[var(--surface-2)]"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
          )}
        >
          <Settings size={13} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

interface ProjectItemProps {
  project: Project;
  isActive: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSelectProject: () => void;
  activeView: string;
  onSelectView: (view: "overview" | "notes" | "board" | "chat") => void;
  notes: Note[];
}

function ProjectItem({
  project,
  isActive,
  isExpanded,
  onToggleExpand,
  onSelectProject,
  activeView,
  onSelectView,
  notes,
}: ProjectItemProps) {
  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1.5 group cursor-pointer transition-colors",
          isActive
            ? "bg-[var(--surface-2)] text-[var(--text-primary)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
        )}
      >
        <button
          onClick={onToggleExpand}
          className="flex-shrink-0 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
        >
          {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        <button
          onClick={onSelectProject}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        >
          <ProjectIcon name={project.icon} size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
          <span className="text-xs font-medium truncate">{project.name}</span>
        </button>
      </div>

      {isExpanded && isActive && (
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-[var(--border)] pl-2">
          {/* Overview */}
          <NavItem
            icon={<Hash size={11} />}
            label="Overview"
            isActive={activeView === "overview"}
            onClick={() => onSelectView("overview")}
          />
          {/* Notes */}
          <NavItem
            icon={<FileText size={11} />}
            label="Notes"
            isActive={activeView === "notes"}
            onClick={() => onSelectView("notes")}
          />
          {/* Board */}
          <NavItem
            icon={<Kanban size={11} />}
            label="Board"
            isActive={activeView === "board"}
            onClick={() => onSelectView("board")}
          />

          {/* Recent notes */}
          {activeView === "notes" && notes.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {notes.map((note) => (
                <div
                  key={note.id}
                  className="flex items-center gap-1.5 px-1.5 py-1 rounded text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
                >
                  {note.isPinned && <Pin size={9} className="text-[var(--accent)] flex-shrink-0" />}
                  <span className="truncate">{note.title}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NavItem({
  icon,
  label,
  isActive,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 w-full px-1.5 py-1 rounded text-[11px] transition-colors text-left",
        isActive
          ? "text-[var(--accent)] bg-[var(--accent-dim)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
      )}
    >
      {icon}
      {label}
    </button>
  );
}
