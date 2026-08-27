"use client";

import React from "react";
import { FileText, Kanban, Workflow, Terminal, Hash, BarChart2, GitBranch, Zap, Settings, Search, Bell } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { SyncStatusIndicator } from "../sync-status-indicator";

const NAV = [
  { id: "overview", label: "Overview", icon: Hash },
  { id: "notes", label: "Notes", icon: FileText },
  { id: "board", label: "Board", icon: Kanban },
  { id: "flow", label: "Flow", icon: Workflow },
  { id: "agent", label: "Agent", icon: Terminal },
] as const;

export function CalmRail() {
  const { activeView, setView, toggleSearch, hiddenViews } = useCairnStore(
    useShallow((s) => ({ activeView: s.activeView, setView: s.setView, toggleSearch: s.toggleSearch, hiddenViews: s.hiddenViews }))
  );
  return (
    <nav className="w-[52px] flex-shrink-0 flex flex-col items-center py-3 gap-1.5 border-r border-[var(--border-subtle)] bg-[var(--background)]">
      <div className="w-8 h-8 rounded-lg bg-[var(--surface)] border border-[var(--border)] grid place-items-center text-[var(--accent)]">◆</div>
      <div className="w-4 h-px bg-[var(--border)] my-1" />
      {NAV.filter((n) => !(n.id !== "overview" && n.id !== "notes" && hiddenViews.has(n.id as never))).map((n) => {
        const Icon = n.icon;
        const on = activeView === n.id;
        return (
          <button
            key={n.id}
            onClick={() => setView(n.id as never)}
            aria-label={n.label}
            aria-current={on ? "page" : undefined}
            className={cn("w-8 h-8 rounded-lg grid place-items-center border", on ? "bg-[var(--surface)] text-[var(--text-primary)] border-[var(--border)] shadow-sm" : "text-[var(--text-tertiary)] border-transparent hover:text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:border-[var(--border)]")}
            title={n.label}
          >
            <Icon size={14} />
          </button>
        );
      })}
      <button aria-label="Search (⌘K)" onClick={toggleSearch} className="w-8 h-8 rounded-lg grid place-items-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] border border-transparent hover:border-[var(--border)]" title="Search (⌘K)">
        <Search size={14} />
      </button>
      <div className="w-4 h-px bg-[var(--border)] my-1" />
      {!hiddenViews.has("graph") && (
        <button aria-label="Knowledge Graph" onClick={() => setView("graph")} className={cn("w-8 h-8 rounded-lg grid place-items-center border", activeView === "graph" ? "bg-[var(--surface)] text-[var(--text-primary)] border-[var(--border)]" : "text-[var(--text-tertiary)] border-transparent hover:bg-[var(--surface)]")} title="Graph">
          <GitBranch size={14} />
        </button>
      )}
      {!hiddenViews.has("insights") && (
        <button aria-label="Insights" onClick={() => setView("insights")} className={cn("w-8 h-8 rounded-lg grid place-items-center border", activeView === "insights" ? "bg-[var(--surface)] text-[var(--text-primary)] border-[var(--border)]" : "text-[var(--text-tertiary)] border-transparent hover:bg-[var(--surface)]")} title="Insights">
          <BarChart2 size={14} />
        </button>
      )}
      <button aria-label="Automations" onClick={() => setView("automations")} className={cn("w-8 h-8 rounded-lg grid place-items-center border", activeView === "automations" ? "bg-[var(--surface)] text-[var(--text-primary)] border-[var(--border)]" : "text-[var(--text-tertiary)] border-transparent hover:bg-[var(--surface)]")} title="Automations">
        <Zap size={14} />
      </button>
      <div className="flex-1" />
      <button aria-label="Settings" onClick={() => setView("settings")} className={cn("w-8 h-8 rounded-lg grid place-items-center border", activeView === "settings" ? "bg-[var(--surface)] text-[var(--text-primary)] border-[var(--border)]" : "text-[var(--text-tertiary)] border-transparent hover:bg-[var(--surface)]")} title="Settings">
        <Settings size={14} />
      </button>
      <div className="w-7 h-7 rounded-full bg-[linear-gradient(145deg,var(--accent),#6e8f4f)] grid place-items-center text-[var(--accent-fg)] text-xs font-bold border border-[color-mix(in_srgb,var(--accent)_40%,transparent)]">G</div>
    </nav>
  );
}

export function CalmTop() {
  const [platform, setPlatform] = React.useState<"darwin" | "win32" | "linux" | null>(null);
  const { workspaces, projects, activeWorkspaceId, activeProjectId, notificationUnreadCount, notificationOpen, setNotificationOpen, runningAutomationCount, setView } = useCairnStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      projects: s.projects,
      activeWorkspaceId: s.activeWorkspaceId,
      activeProjectId: s.activeProjectId,
      notificationUnreadCount: s.notificationUnreadCount,
      notificationOpen: s.notificationOpen,
      setNotificationOpen: s.setNotificationOpen,
      runningAutomationCount: s.runningAutomationCount,
      setView: s.setView,
    }))
  );
  React.useEffect(() => {
    queueMicrotask(() => {
      const isElectron = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
      if (window.electron && isElectron) setPlatform(window.electron.platform ?? "linux");
      else setPlatform(null);
    });
  }, []);
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const project = projects.find((p) => p.id === activeProjectId);
  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  if (!platform) return <div className="h-10 border-b border-[var(--border-subtle)] bg-[var(--background)] flex-shrink-0" />;
  return (
    <div
      className="h-10 flex items-center border-b border-[var(--border-subtle)] bg-[var(--background)] flex-shrink-0 px-3 gap-2"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {isMac && <div style={{ width: 80, flexShrink: 0 }} aria-hidden="true" />}
      <span className="text-[0.714rem] font-semibold tracking-[0.14em] uppercase text-[var(--text-tertiary)]">C A I R N</span>
      <span className="mx-2 text-[var(--border)] hidden sm:inline">·</span>
      <span className="text-xs text-[var(--text-secondary)] truncate max-w-[20ch] hidden sm:inline">{ws?.name ?? ""} {project ? ` / ${project.name}` : ""}</span>
      <div className="flex-1" style={{ WebkitAppRegion: "drag" } as React.CSSProperties} />
      <div className="flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {runningAutomationCount > 0 && (
          <button
            onClick={() => setView("automations")}
            className="w-7 h-7 grid place-items-center rounded-md text-[var(--accent)] hover:bg-[var(--surface-2)]"
            aria-label="Automations running"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
          </button>
        )}
        <button
          onClick={() => setNotificationOpen(!notificationOpen)}
          data-notification-toggle
          className={cn(
            "w-7 h-7 grid place-items-center rounded-md",
            notificationUnreadCount > 0 ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
          )}
          aria-label="Notifications"
        >
          <Bell size={14} className={cn(notificationUnreadCount > 0 && "animate-bell-wobble fill-[var(--accent)]")} />
        </button>
        <SyncStatusIndicator />
        {process.env.NODE_ENV === "development" && (
          <span className="hidden sm:inline-flex ml-1">
            <ShellSwitcherCompact />
          </span>
        )}
      </div>
      {isWin && <div style={{ width: 138, flexShrink: 0 }} aria-hidden="true" />}
    </div>
  );
}

function ShellSwitcherCompact() {
  // inline to avoid circular import
  const { shellVariant, setShellVariant } = useCairnStore(useShallow((s) => ({ shellVariant: s.shellVariant, setShellVariant: s.setShellVariant })));
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)]">
      {(["current", "A", "B", "C"] as const).map((v) => (
        <button
          key={v}
          onClick={() => setShellVariant(v)}
          className={cn("px-2 py-1 rounded-full text-[0.643rem] font-medium", shellVariant === v ? "bg-[var(--text-primary)] text-[var(--background)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}
        >
          {v === "current" ? "·" : v}
        </button>
      ))}
    </div>
  );
}
