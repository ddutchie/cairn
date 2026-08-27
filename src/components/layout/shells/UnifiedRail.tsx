"use client";

import React, { useEffect, useState, useMemo } from "react";
import {
  Search,
  Plus,
  Bell,
  Menu,
  Loader2,
  Hash,
  FileText,
  Kanban,
  CalendarDays,
  Workflow,
  Code2,
  MessageSquare,
} from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn, STATUS_COLORS, PRIORITY_COLORS } from "@/lib/utils";
import { ShellSwitcher } from "./ShellSwitcher";
import { SyncStatusIndicator } from "../sync-status-indicator";
import { QuickSettings } from "../QuickSettings";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { SlotOutlet } from "@/lib/plugin-ui/SlotOutlet";
import { WorkspaceIcon, ProjectIcon } from "@/lib/workspace-icons";
import type { ToggleableView } from "@/store/slices/ui";
import { modKey } from "../sidebar-utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { revealCard } from "@/lib/events";

const VIEW_TABS = [
  { id: "overview" as const, label: "Overview", icon: Hash },
  { id: "notes" as const, label: "Notes", icon: FileText },
  { id: "board" as const, label: "Board", icon: Kanban },
  { id: "calendar" as const, label: "Calendar", icon: CalendarDays },
  { id: "flow" as const, label: "Flow", icon: Workflow },
  { id: "agent" as const, label: "Agent", icon: Code2 },
] as const;

type ViewTabId = (typeof VIEW_TABS)[number]["id"];

function isHidden(hidden: Set<ToggleableView>, id: ViewTabId): boolean {
  return hidden.has(id as ToggleableView);
}

export function UnifiedRail() {
  const [platform, setPlatform] = useState<"darwin" | "win32" | "linux" | null>(null);
  const {
    workspaces,
    projects,
    activeWorkspaceId,
    activeProjectId,
    activeView,
    lastContentView,
    hiddenViews,
    toggleSidebar,
    toggleSearch,
    toggleChat,
    setView,
    chatOpen,
    notificationUnreadCount,
    notificationOpen,
    setNotificationOpen,
    runningAutomationCount,
  } = useCairnStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      projects: s.projects,
      activeWorkspaceId: s.activeWorkspaceId,
      activeProjectId: s.activeProjectId,
      activeView: s.activeView,
      lastContentView: s.lastContentView,
      hiddenViews: s.hiddenViews,
      toggleSidebar: s.toggleSidebar,
      toggleSearch: s.toggleSearch,
      toggleChat: s.toggleChat,
      setView: s.setView,
      chatOpen: s.chatOpen,
      notificationUnreadCount: s.notificationUnreadCount,
      notificationOpen: s.notificationOpen,
      setNotificationOpen: s.setNotificationOpen,
      runningAutomationCount: s.runningAutomationCount,
    }))
  );

  useEffect(() => {
    queueMicrotask(() => {
      const isElectron = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
      if (window.electron && isElectron) setPlatform(window.electron.platform ?? "linux");
      else setPlatform("linux");
    });
  }, []);

  const workspace = useMemo(() => workspaces.find((w) => w.id === activeWorkspaceId), [workspaces, activeWorkspaceId]);
  const project = useMemo(() => projects.find((p) => p.id === activeProjectId), [projects, activeProjectId]);
  const mod = useMemo(() => modKey(), []);

  const isMac = platform === "darwin";
  const isWin = platform === "win32";

  // Don't render until platform known to avoid flicker — like TitleBar does, but UnifiedRail must render something to avoid layout shift.
  // Render a 44px placeholder if null.
  if (!platform) {
    return <div className="h-11 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0" />;
  }

  return (
    <header
      className="relative flex items-center h-11 px-3 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0 gap-2"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* macOS traffic lights inset — 80px like TitleBar */}
      {isMac && <div style={{ width: 80, flexShrink: 0 }} aria-hidden="true" />}

      {/* Left: mobile sidebar toggle + wordmark + breadcrumb + meta pills */}
      <div className="flex items-center gap-2 min-w-0 flex-shrink" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <Button variant="ghost" size="sm" onClick={toggleSidebar} className="md:hidden p-1 text-[var(--text-secondary)] shrink-0" aria-label="Toggle sidebar">
          <Menu size={14} />
        </Button>

        <span className="hidden sm:flex items-center gap-1.5 text-xs font-semibold tracking-tight text-[var(--text-primary)] shrink-0">
          <span className="hidden lg:inline">Cairn</span>
        </span>

        <nav className="hidden md:flex items-center gap-1 text-xs text-[var(--text-tertiary)] min-w-0 shrink">
          <span className="w-px h-3 bg-[var(--border)] mx-1 hidden lg:block" />
          <WorkspaceIcon name={workspace?.icon} size={12} className="shrink-0 hidden lg:block" />
          <span className="truncate max-w-[10ch] hidden lg:inline">{workspace?.name}</span>
          {project && (
            <>
              <span className="hidden lg:inline text-[var(--text-tertiary)]">/</span>
              <ProjectIcon name={project.icon} size={12} className="shrink-0 text-[var(--text-secondary)]" />
              <span className="text-[var(--text-secondary)] font-medium truncate max-w-[12ch]">{project.name}</span>
            </>
          )}
        </nav>

        {project && (
          <div className="hidden xl:flex items-center gap-1 shrink-0" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <span className={cn("text-[0.643rem] font-medium px-1.5 py-0.5 rounded-full border border-[var(--border)]", STATUS_COLORS[project.status])}>
              {project.status.replace("_", " ")}
            </span>
            <span className={cn("text-[0.643rem] font-medium px-1.5 py-0.5 rounded-full border border-[var(--border)]", PRIORITY_COLORS[project.priority])}>
              {project.priority}
            </span>
          </div>
        )}
      </div>

      {/* View tabs — icons + tooltips only; hidden on <lg to avoid crowding, in hamburger */}
      {project && (
        <nav className="hidden lg:flex items-center gap-0.5 ml-1 shrink-0 overflow-hidden" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties} aria-label="Views">
          {VIEW_TABS.filter((tab) => !isHidden(hiddenViews, tab.id)).map((tab) => {
            const Icon = tab.icon;
            const active = activeView === tab.id || lastContentView === tab.id;
            return (
              <Tooltip key={tab.id} side="bottom" content={tab.label}>
                <button
                  onClick={() => setView(tab.id)}
                  aria-current={active ? "page" : undefined}
                  aria-label={tab.label}
                  className={cn(
                    "w-7 h-7 grid place-items-center rounded-md transition-colors",
                    active ? "text-[var(--text-primary)] bg-[var(--surface-2)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                  )}
                >
                  <Icon size={13} className="shrink-0" />
                </button>
              </Tooltip>
            );
          })}
        </nav>
      )}

      {/* Hamburger — <lg collapses view tabs + shell switcher to avoid overflow */}
      {project && (
        <div className="lg:hidden flex items-center ml-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="w-7 h-7 grid place-items-center rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:border-[var(--muted)]" aria-label="More views">
                <Menu size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <div className="px-2 py-1.5 text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)]">Views</div>
              {VIEW_TABS.filter((tab) => !isHidden(hiddenViews, tab.id)).map((tab) => {
                const Icon = tab.icon;
                const active = activeView === tab.id || lastContentView === tab.id;
                return (
                  <DropdownMenuItem key={tab.id} onClick={() => setView(tab.id)} className={cn("flex items-center gap-2 text-xs", active && "bg-[var(--surface-2)] text-[var(--accent)]")}>
                    <Icon size={12} /> {tab.label}
                  </DropdownMenuItem>
                );
              })}
              {process.env.NODE_ENV === "development" && (
                <>
                  <div className="my-1 border-t border-[var(--border)]" />
                  <div className="px-2 py-1">
                    <div className="text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)] mb-1">Shell</div>
                    <ShellSwitcher />
                  </div>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* Center: omnibox — true window-centered (absolute) so 80px Mac inset doesn't pull it off) */}
      <div className="hidden sm:flex absolute left-1/2 -translate-x-1/2 items-center" aria-hidden="true">
        <button
          onClick={toggleSearch}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          className="w-[280px] lg:w-[320px] flex items-center gap-2 h-7 px-3 rounded-full border border-[var(--border)] bg-[var(--surface-2)] text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:border-[var(--muted)] hover:bg-[var(--surface-3)] transition-colors min-w-0"
          aria-label="Search"
        >
          <Search size={12} className="shrink-0" />
          <span className="truncate hidden lg:inline">Search notes, tasks, or ask…</span>
          <span className="truncate lg:hidden">Search…</span>
          <span className="ml-auto hidden lg:inline-flex font-mono text-[0.643rem] px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface)]">⌘K</span>
        </button>
      </div>

      {/* Spacer to keep right zone from overlapping absolute search on narrow widths */}
      <div className="flex-1 hidden sm:block" aria-hidden="true" />
      <div className="flex-1 sm:hidden" aria-hidden="true" />

      {/* Plugin per-view actions */}
      <div className="hidden md:flex shrink-0" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <SlotOutlet name="view.header.actions" props={{ view: activeView }} />
      </div>

      {/* Right zone: chat, quicksettings, running, sync, bell, new, shell switcher */}
      <div className="flex items-center gap-1 shrink-0" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {/* Shell preview — dev only */}
        {process.env.NODE_ENV === "development" && (
          <div className="hidden lg:flex mr-1">
            <ShellSwitcher compact />
          </div>
        )}

        <button onClick={toggleSearch} className="sm:hidden p-1.5 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]" aria-label="Search">
          <Search size={14} />
        </button>

        {!hiddenViews.has("chat") && (
          <Tooltip side="bottom" content={`AI Chat (${mod}/)`}>
            <Button
              variant="ghost"
              size="sm"
              onClick={activeView === "chat" ? () => setView(lastContentView) : toggleChat}
              className={cn((chatOpen || activeView === "chat") && "text-[var(--accent)] bg-[var(--accent-dim)]")}
              aria-label="Chat"
            >
              <MessageSquare size={13} />
              <span className="text-xs hidden lg:inline">Chat</span>
            </Button>
          </Tooltip>
        )}

        <QuickSettings />

        {runningAutomationCount > 0 && (
          <Tooltip side="bottom" content={`${runningAutomationCount} automation${runningAutomationCount === 1 ? "" : "s"} running`}>
            <button
              onClick={() => setView("automations")}
              className="flex items-center justify-center w-7 h-7 rounded-md text-[var(--accent)] hover:bg-[var(--surface-2)] transition-colors"
              aria-label="Automations running"
            >
              <Loader2 size={14} className="animate-spin" />
            </button>
          </Tooltip>
        )}

        <Tooltip side="bottom" content={notificationUnreadCount > 0 ? `Notifications — ${notificationUnreadCount} unread` : "Notifications"}>
          <button
            onClick={() => setNotificationOpen(!notificationOpen)}
            data-notification-toggle
            className={cn(
              "relative flex items-center justify-center w-7 h-7 rounded-md transition-colors",
              notificationUnreadCount > 0 ? "text-[var(--accent)] hover:bg-[var(--surface-2)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
            )}
            aria-label={notificationUnreadCount > 0 ? `Notifications — ${notificationUnreadCount} unread` : "Notifications"}
            aria-expanded={notificationOpen}
          >
            <Bell size={14} className={cn(notificationUnreadCount > 0 && "animate-bell-wobble fill-[var(--accent)]")} />
          </button>
        </Tooltip>

        <SyncStatusIndicator />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-semibold hover:bg-[var(--accent-hover)] transition-colors shrink-0"
              aria-label="New"
            >
              <Plus size={12} /> <span className="hidden lg:inline">New</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              onClick={() => {
                const s = useCairnStore.getState();
                if (!s.activeProjectId) return;
                // Create directly via store so it works even when NotesView isn't mounted yet
                const note = s.createNote(s.activeProjectId, "Untitled Note", "note");
                s.setView("notes");
                // Wait for NotesView to mount before revealing + scrolling in hierarchy
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: note.id } }));
                  });
                });
              }}
              className="flex items-center gap-2 text-xs"
            >
              <FileText size={12} className="text-[var(--info)]" /> New note
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const s = useCairnStore.getState();
                const pid = s.activeProjectId;
                if (!pid) return;
                const cols = s.columns.filter((c) => c.projectId === pid).sort((a, b) => a.order - b.order);
                const target = cols.find((c) => c.type === "todo") ?? cols.find((c) => c.type === "backlog") ?? cols[0];
                if (!target) return;
                const card = s.createCard(target.id, pid, "New task");
                // Reveal opens detail + ensures board is mounted and scrolled to column
                revealCard(s.setView, card.id);
              }}
              className="flex items-center gap-2 text-xs"
            >
              <Kanban size={12} className="text-[var(--accent)]" /> New task
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isWin && <div style={{ width: 138, flexShrink: 0 }} aria-hidden="true" />}
    </header>
  );
}
