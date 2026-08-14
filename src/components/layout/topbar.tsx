"use client";

import React, { useMemo } from "react";
import {
  Hash,
  FileText,
  Kanban,
  CalendarDays,
  Workflow,
  Code2,
  MessageSquare,
  ChevronRight,
  Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import type { ToggleableView } from "@/store/slices/ui";
import { useShallow } from "zustand/react/shallow";
import { WorkspaceIcon, ProjectIcon } from "@/lib/workspace-icons";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Select } from "@/components/ui/select";
import { STATUS_COLORS, PRIORITY_COLORS } from "@/lib/utils";
import { QuickSettings } from "./QuickSettings";
import { modKey } from "./sidebar-utils";

const VIEW_TABS = [
  { id: "overview" as const, label: "Overview", icon: Hash },
  { id: "notes" as const, label: "Notes", icon: FileText },
  { id: "board" as const, label: "Board", icon: Kanban },
  { id: "calendar" as const, label: "Calendar", icon: CalendarDays },
  { id: "flow" as const, label: "Flow", icon: Workflow },
  { id: "agent" as const, label: "Agent", icon: Code2 },
] as const;

/** Tab id type derived from VIEW_TABS so it can't drift from the entries. */
type ViewTabId = (typeof VIEW_TABS)[number]["id"];

/** A VIEW_TABS id that is also a user-toggleable view. */
function isHidden(hidden: Set<ToggleableView>, id: ViewTabId): boolean {
  return hidden.has(id as ToggleableView);
}

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
    hiddenViews,
    toggleSidebar,
    lastContentView,
  } = useCairnStore(useShallow((s) => ({
    activeWorkspaceId: s.activeWorkspaceId,
    activeProjectId:   s.activeProjectId,
    activeView:        s.activeView,
    setView:           s.setView,
    toggleChat:        s.toggleChat,
    chatOpen:          s.chatOpen,
    workspaces:        s.workspaces,
    projects:          s.projects,
    hiddenViews:       s.hiddenViews,
    toggleSidebar:     s.toggleSidebar,
    lastContentView:   s.lastContentView,
  })));

  const workspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId],
  );
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId),
    [projects, activeProjectId],
  );
  const mod = useMemo(() => modKey(), []);

  if (activeView === "settings") {
    return (
      <header className="flex items-center h-11 px-4 border-b border-[var(--border)] flex-shrink-0 bg-[var(--surface)] gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleSidebar}
          className="md:hidden p-1 mr-1 text-[var(--text-secondary)] shrink-0"
        >
          <Menu size={16} />
        </Button>
        <span className="text-sm font-medium text-[var(--text-primary)] flex-1">Settings</span>
        <QuickSettings />
      </header>
    );
  }

  return (
    <header className="flex items-center h-11 px-4 border-b border-[var(--border)] flex-shrink-0 bg-[var(--surface)] gap-3">
      {/* Sidebar toggle for mobile */}
      <Button
        variant="ghost"
        size="sm"
        onClick={toggleSidebar}
        className="md:hidden p-1 mr-1 text-[var(--text-secondary)] shrink-0"
      >
        <Menu size={16} />
      </Button>

      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-xs text-[var(--text-tertiary)] flex-shrink-0 min-w-0 max-w-[30%] sm:max-w-none">
        <WorkspaceIcon name={workspace?.icon} size={13} className="text-[var(--text-tertiary)] shrink-0" />
        <span className="truncate hidden sm:inline">{workspace?.name}</span>
        {project && (
          <>
            <ChevronRight size={11} className="shrink-0" />
            <ProjectIcon name={project.icon} size={13} className="text-[var(--text-secondary)] shrink-0" />
            <span className="text-[var(--text-secondary)] font-medium truncate">{project.name}</span>
          </>
        )}
      </nav>

      {/* Project meta pills */}
      {project && (
        <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
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

      {/* View Selector (Dropdown on Mobile, Tabs on Desktop) */}
      {project && (
        <>
          {/* Mobile dropdown view selector */}
          <div className="flex sm:hidden items-center ml-2">
            <Select
              value={activeView}
              onChange={(v) => setView(v as ViewTabId)}
              ariaLabel="View"
              options={VIEW_TABS.filter((tab) => !isHidden(hiddenViews, tab.id)).map((tab) => ({
                value: tab.id,
                label: tab.label,
              }))}
            />
          </div>

          {/* Desktop tabs view selector */}
          <nav data-tutorial="view-tabs" className="hidden sm:flex items-center gap-0.5 ml-2 overflow-x-auto scrollbar-none flex-nowrap shrink">
            {VIEW_TABS.filter((tab) => !isHidden(hiddenViews, tab.id)).map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setView(tab.id)}
                  aria-current={activeView === tab.id ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                    activeView === tab.id
                      ? "text-[var(--text-primary)] bg-[var(--surface-2)]"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                  )}
                >
                  <Icon size={12} className="shrink-0" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </>
      )}

      <div className="flex-1" />

      {/* Right actions */}
      <div className="flex items-center gap-1">
        {!hiddenViews.has("chat") && (
          <Tooltip side="bottom" content={`AI Chat (${mod}/)`}>
            <Button
              data-tutorial="chat-toggle"
              variant="ghost"
              size="sm"
              onClick={activeView === "chat" ? () => setView(lastContentView) : toggleChat}
              className={cn(
                (chatOpen || activeView === "chat") && "text-[var(--accent)] bg-[var(--accent-dim)]"
              )}
            >
              <MessageSquare size={13} />
              <span className="text-xs hidden sm:inline">Chat</span>
            </Button>
          </Tooltip>
        )}
        <QuickSettings />
      </div>
    </header>
  );
}
