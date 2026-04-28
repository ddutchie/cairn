"use client";

import React from "react";
import {
  Hash,
  FileText,
  Kanban,
  MessageSquare,
  ChevronRight,
  MoreHorizontal,
  Bell,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { STATUS_COLORS, PRIORITY_COLORS } from "@/lib/utils";

const VIEW_TABS = [
  { id: "overview" as const, label: "Overview", icon: Hash },
  { id: "notes" as const, label: "Notes", icon: FileText },
  { id: "board" as const, label: "Board", icon: Kanban },
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
  } = useCairnStore();

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const project = projects.find((p) => p.id === activeProjectId);

  if (activeView === "settings") {
    return (
      <header className="flex items-center h-11 px-4 border-b border-[var(--border)] flex-shrink-0 bg-[var(--surface)]">
        <span className="text-sm font-medium text-[var(--text-primary)]">Settings</span>
      </header>
    );
  }

  return (
    <header className="flex items-center h-11 px-4 border-b border-[var(--border)] flex-shrink-0 bg-[var(--surface)] gap-3">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-xs text-[var(--text-tertiary)] flex-shrink-0">
        <span>{workspace?.icon ?? "🗂"}</span>
        <span>{workspace?.name}</span>
        {project && (
          <>
            <ChevronRight size={11} />
            <span className="text-[var(--text-secondary)]">{project.icon ?? "📁"}</span>
            <span className="text-[var(--text-secondary)] font-medium">{project.name}</span>
          </>
        )}
      </nav>

      {/* Project meta pills */}
      {project && (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span
            className={cn(
              "text-[10px] font-medium px-1.5 py-0.5 rounded-full border",
              STATUS_COLORS[project.status]
            )}
            style={{
              backgroundColor: "transparent",
              borderColor: "var(--border)",
            }}
          >
            {project.status.replace("_", " ")}
          </span>
          <span
            className={cn(
              "text-[10px] font-medium px-1.5 py-0.5 rounded-full border",
              PRIORITY_COLORS[project.priority]
            )}
            style={{
              backgroundColor: "transparent",
              borderColor: "var(--border)",
            }}
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
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
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
      </div>
    </header>
  );
}
