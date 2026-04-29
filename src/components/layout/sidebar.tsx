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
  Pencil,
  Trash2,
} from "lucide-react";
import { cn, formatRelative } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { WorkspaceIcon, ProjectIcon } from "@/lib/workspace-icons";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
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
    updateProject,
    deleteProject,
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
        <Tooltip content="Collapse sidebar" side="right">
          <button
            onClick={toggleSidebar}
            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <ChevronRight size={13} />
          </button>
        </Tooltip>
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
              onRename={(name) => updateProject(project.id, { name })}
              onDelete={() => deleteProject(project.id)}
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
              <Tooltip content="Confirm">
                <button onClick={commitCreateProject} className="p-0.5 text-[var(--success)] hover:opacity-80">
                  <Check size={11} />
                </button>
              </Tooltip>
              <Tooltip content="Cancel">
                <button onClick={cancelCreateProject} className="p-0.5 text-[var(--text-tertiary)] hover:opacity-80">
                  <X size={11} />
                </button>
              </Tooltip>
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
  onRename: (name: string) => void;
  onDelete: () => void;
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
  onRename,
  onDelete,
}: ProjectItemProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(project.name);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      setRenameValue(project.name);
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming, project.name]);

  function commitRename() {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== project.name) {
      onRename(trimmed);
    }
    setRenaming(false);
  }

  return (
    <>
    {/* Delete confirmation dialog */}
    <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Delete project?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          <strong className="text-[var(--text-primary)]">{project.name}</strong> and all its notes, tasks, and columns will be permanently deleted. This cannot be undone.
        </p>
        <div className="flex justify-end gap-2 mt-5">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">Cancel</Button>
          </DialogClose>
          <Button
            variant="ghost"
            size="sm"
            className="text-[var(--danger)] hover:bg-[var(--danger)]/10"
            onClick={() => { setDeleteDialogOpen(false); onDelete(); }}
          >
            <Trash2 size={13} />
            Delete project
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            className="flex-1 min-w-0 bg-transparent text-xs font-medium text-[var(--text-primary)] outline-none border-b border-[var(--accent)]"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <button
            onClick={onSelectProject}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          >
            <ProjectIcon name={project.icon} size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
            <span className="text-xs font-medium truncate flex-1">{project.name}</span>
            {project.dueDate && <DueDateDot dueDate={project.dueDate} />}
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface)] transition-all"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal size={12} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right" className="w-40">
            <DropdownMenuItem
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); setRenaming(true); }}
              className="flex items-center gap-2 text-xs"
            >
              <Pencil size={11} />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); setDeleteDialogOpen(true); }}
              className="flex items-center gap-2 text-xs text-[var(--danger)] focus:text-[var(--danger)]"
            >
              <Trash2 size={11} />
              Delete project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isExpanded && (
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-[var(--border)] pl-2">
          {/* Overview */}
          <NavItem
            icon={<Hash size={11} />}
            label="Overview"
            isActive={isActive && activeView === "overview"}
            onClick={() => onSelectView("overview")}
          />
          {/* Notes */}
          <NavItem
            icon={<FileText size={11} />}
            label="Notes"
            isActive={isActive && activeView === "notes"}
            onClick={() => onSelectView("notes")}
          />
          {/* Board */}
          <NavItem
            icon={<Kanban size={11} />}
            label="Board"
            isActive={isActive && activeView === "board"}
            onClick={() => onSelectView("board")}
          />

          {/* Recent notes — clickable, deep-link into notes view */}
          {isActive && activeView === "notes" && notes.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {notes.map((note) => (
                <button
                  key={note.id}
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: note.id } }));
                  }}
                  className="flex items-center gap-1.5 w-full px-1.5 py-1 rounded text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors text-left"
                >
                  {note.isPinned && <Pin size={9} className="text-[var(--accent)] flex-shrink-0" />}
                  <span className="truncate">{note.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
    </>
  );
}

function DueDateDot({ dueDate }: { dueDate: string }) {
  const now = new Date();
  const due = new Date(dueDate);
  const diffDays = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return (
      <Tooltip content={`Overdue — due ${due.toLocaleDateString()}`} side="right">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--danger)] flex-shrink-0" />
      </Tooltip>
    );
  }
  if (diffDays <= 7) {
    return (
      <Tooltip content={`Due in ${diffDays} day${diffDays !== 1 ? "s" : ""}`} side="right">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] flex-shrink-0" />
      </Tooltip>
    );
  }
  return null;
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
