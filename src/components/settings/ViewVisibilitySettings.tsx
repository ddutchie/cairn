"use client";

/**
 * ViewVisibilitySettings — toggle which views are shown in the sidebar.
 * Overview and Notes are always visible and shown as locked.
 */

import { Kanban, CalendarDays, Workflow, GitBranch, BarChart2, Terminal, MessageSquare, Lock } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { ToggleableView } from "@/store/slices/ui";
import { SettingsGroup, Toggle } from "./shared";

interface ViewOption {
  view: ToggleableView;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const VIEW_OPTIONS: ViewOption[] = [
  { view: "board",    label: "Board",           description: "Kanban task board",               icon: <Kanban size={13} /> },
  { view: "calendar", label: "Calendar",         description: "Schedule tasks by due date",      icon: <CalendarDays size={13} /> },
  { view: "flow",     label: "Idea Flow",        description: "Visual node graph for ideas",     icon: <Workflow size={13} /> },
  { view: "graph",    label: "Knowledge Graph",  description: "Workspace-wide connection graph", icon: <GitBranch size={13} /> },
  { view: "insights", label: "Insights",         description: "Analytics and progress charts",   icon: <BarChart2 size={13} /> },
  { view: "agent",    label: "Agent",            description: "Embedded coding agent in the sidebar", icon: <Terminal size={13} /> },
  { view: "chat",     label: "AI Chat",          description: "In-app AI chat panel",            icon: <MessageSquare size={13} /> },
];

export function ViewVisibilitySettings() {
  const { hiddenViews, toggleViewVisibility } = useCairnStore(useShallow((s) => ({ hiddenViews: s.hiddenViews, toggleViewVisibility: s.toggleViewVisibility })));

  return (
    <SettingsGroup
      title="Views"
      description="Choose which views appear in the sidebar. Overview and Notes are always shown."
    >
      {/* Always-on rows */}
      {(["Overview", "Notes"] as const).map((label) => (
        <div
          key={label}
          className="flex items-center justify-between py-2.5 border-b border-[var(--border-subtle)] last:border-0"
        >
          <div className="flex items-center gap-2.5">
            <Lock size={12} className="text-[var(--text-tertiary)]" />
            <div>
              <p className="text-xs font-medium text-[var(--text-secondary)]">{label}</p>
              <p className="text-[0.714rem] text-[var(--text-tertiary)]">Always visible</p>
            </div>
          </div>
            <Toggle checked disabled onChange={() => {}} label={`${label} — always visible`} />
        </div>
      ))}

      {/* Toggleable rows */}
      {VIEW_OPTIONS.map(({ view, label, description, icon }) => {
        const visible = !hiddenViews.has(view);
        return (
          <div
            key={view}
            className="flex items-center justify-between py-2.5 border-b border-[var(--border-subtle)] last:border-0"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-[var(--text-tertiary)]">{icon}</span>
              <div>
                <p className="text-xs font-medium text-[var(--text-primary)]">{label}</p>
                <p className="text-[0.714rem] text-[var(--text-tertiary)]">{description}</p>
              </div>
            </div>
            <Toggle checked={visible} onChange={() => toggleViewVisibility(view)} label={`Toggle ${label}`} />
          </div>
        );
      })}
    </SettingsGroup>
  );
}
