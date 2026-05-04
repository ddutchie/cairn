"use client";

/**
 * ViewVisibilitySettings — toggle which views are shown in the sidebar.
 * Overview and Notes are always visible and shown as locked.
 */

import { Kanban, Workflow, Terminal, GitBranch, BarChart2, MessageSquare, Lock } from "lucide-react";
import { useCairnStore } from "@/store";
import type { ToggleableView } from "@/store/slices/ui";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./shared";

interface ViewOption {
  view: ToggleableView;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const VIEW_OPTIONS: ViewOption[] = [
  { view: "board",    label: "Board",           description: "Kanban task board",               icon: <Kanban size={13} /> },
  { view: "flow",     label: "Idea Flow",        description: "Visual node graph for ideas",     icon: <Workflow size={13} /> },
  { view: "agent",    label: "Agent",            description: "Embedded coding agent terminal",  icon: <Terminal size={13} /> },
  { view: "graph",    label: "Knowledge Graph",  description: "Workspace-wide connection graph", icon: <GitBranch size={13} /> },
  { view: "insights", label: "Insights",         description: "Analytics and progress charts",   icon: <BarChart2 size={13} /> },
  { view: "chat",     label: "AI Chat",          description: "In-app AI chat panel",            icon: <MessageSquare size={13} /> },
];

export function ViewVisibilitySettings() {
  const { hiddenViews, toggleViewVisibility } = useCairnStore();

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
          <div className="w-8 h-4 rounded-full bg-[var(--accent)] opacity-40 flex-shrink-0" />
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
            <button
              role="switch"
              aria-checked={visible}
              onClick={() => toggleViewVisibility(view)}
              className={cn(
                "relative w-8 h-4 rounded-full transition-colors flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                visible ? "bg-[var(--accent)]" : "bg-[var(--surface-3)]"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform",
                  visible ? "translate-x-4" : "translate-x-0.5"
                )}
              />
            </button>
          </div>
        );
      })}
    </SettingsGroup>
  );
}
