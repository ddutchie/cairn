"use client";

import React, { useMemo } from "react";
import {
  Hash,
  FileText,
  Kanban,
  Workflow,
  Terminal,
  MessageSquare,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { WorkspaceIcon, ProjectIcon } from "@/lib/workspace-icons";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { STATUS_COLORS, PRIORITY_COLORS } from "@/lib/utils";
import { QuickSettings } from "./QuickSettings";

const VIEW_TABS = [
  { id: "overview" as const, label: "Overview", icon: Hash },
  { id: "notes" as const, label: "Notes", icon: FileText },
  { id: "board" as const, label: "Board", icon: Kanban },
  { id: "flow" as const, label: "Flow", icon: Workflow },
  { id: "agent" as const, label: "Agent", icon: Terminal },
] as const;

export function Topbar() {
  const {
    activeWorkspaceId,
    activeProjectId,
    activeView,
    setView,
    toggleChat,
    chatOpen,
    workspaces,
    projects,
    aiConfig,
  } = useCairnStore(useShallow((s) => ({
    activeWorkspaceId: s.activeWorkspaceId,
    activeProjectId:   s.activeProjectId,
    activeView:        s.activeView,
    setView:           s.setView,
    toggleChat:        s.toggleChat,
    chatOpen:          s.chatOpen,
    workspaces:        s.workspaces,
    projects:          s.projects,
    aiConfig:          s.aiConfig,
  })));
  const aiEnabled = aiConfig.aiEnabled ?? true;

  const workspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId],
  );
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId),
    [projects, activeProjectId],
  );

  if (activeView === "settings") {
    return (
      <header className="flex items-center h-11 px-4 border-b border-[var(--border)] flex-shrink-0 bg-[var(--surface)] gap-3">
        <span className="text-sm font-medium text-[var(--text-primary)] flex-1">Settings</span>
        <QuickSettings />
      </header>
    );
  }

  return (
    <header className="flex items-center h-11 px-4 border-b border-[var(--border)] flex-shrink-0 bg-[var(--surface)] gap-3">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-xs text-[var(--text-tertiary)] flex-shrink-0">
        <WorkspaceIcon name={workspace?.icon} size={13} className="text-[var(--text-tertiary)]" />
        <span>{workspace?.name}</span>
        {project && (
          <>
            <ChevronRight size={11} />
            <ProjectIcon name={project.icon} size={13} className="text-[var(--text-secondary)]" />
            <span className="text-[var(--text-secondary)] font-medium">{project.name}</span>
          </>
        )}
      </nav>

      {/* Project meta pills */}
      {project && (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span
            className={cn(
              "text-[0.714rem] font-medium px-1.5 py-0.5 rounded-full border border-[var(--border)]",
              STATUS_COLORS[project.status]
            )}
          >
            {project.status.replace("_", " ")}
          </span>
          <span
            className={cn(
              "text-[0.714rem] font-medium px-1.5 py-0.5 rounded-full border border-[var(--border)]",
              PRIORITY_COLORS[project.priority]
            )}
          >
            {project.priority}
          </span>
        </div>
      )}

      {/* View tabs */}
      {project && (
        <nav className="flex items-center gap-0.5 ml-2">
          {VIEW_TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setView(tab.id)}
                aria-current={activeView === tab.id ? "page" : undefined}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                  activeView === tab.id
                    ? "text-[var(--text-primary)] bg-[var(--surface-2)]"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                )}
              >
                <Icon size={12} />
                {tab.label}
              </button>
            );
          })}
        </nav>
      )}

      <div className="flex-1" />

      {/* Right actions */}
      <div className="flex items-center gap-1">
        {aiEnabled && (
          <Tooltip content="AI Chat (⌘/)">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleChat}
              className={cn(
                chatOpen && "text-[var(--accent)] bg-[var(--accent-dim)]"
              )}
            >
              <MessageSquare size={13} />
              <span className="text-xs">Chat</span>
            </Button>
          </Tooltip>
        )}
        <QuickSettings />
      </div>
    </header>
  );
}
