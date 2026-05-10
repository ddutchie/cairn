"use client";

/**
 * ViewVisibilitySettings — toggle which views are shown in the sidebar.
 * Overview and Notes are always visible and shown as locked.
 */

import { Kanban, Workflow, GitBranch, BarChart2, Lock } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { ToggleableView } from "@/store/slices/ui";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./shared";

function Toggle({ on, disabled, onClick }: { on: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "relative inline-flex items-center w-9 h-5 rounded-full transition-colors duration-200 flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        on ? "bg-[var(--accent)]" : "bg-[var(--surface-3)]",
        disabled && "opacity-40 cursor-default",
      )}
    >
      <span
        className="absolute top-0.5 bottom-0.5 aspect-square rounded-full bg-white shadow-sm transition-[left,right] duration-200"
        style={on ? { right: "0.125rem", left: "auto" } : { left: "0.125rem", right: "auto" }}
      />
    </button>
  );
}

interface ViewOption {
  view: ToggleableView;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const VIEW_OPTIONS: ViewOption[] = [
  { view: "board",    label: "Board",           description: "Kanban task board",               icon: <Kanban size={13} /> },
  { view: "flow",     label: "Idea Flow",        description: "Visual node graph for ideas",     icon: <Workflow size={13} /> },
  { view: "graph",    label: "Knowledge Graph",  description: "Workspace-wide connection graph", icon: <GitBranch size={13} /> },
  { view: "insights", label: "Insights",         description: "Analytics and progress charts",   icon: <BarChart2 size={13} /> },
];

export function ViewVisibilitySettings() {
  const { hiddenViews, toggleViewVisibility } = useCairnStore(useShallow((s) => ({ hiddenViews: s.hiddenViews, toggleViewVisibility: s.toggleViewVisibility })));

  return (
    <SettingsGroup
      title="Views"
      description="Choose which views appear in the sidebar. Overview and Notes are always shown. Agent and AI Chat are managed in AI & Chat settings."
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
          <Toggle on disabled />
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
            <Toggle on={visible} onClick={() => toggleViewVisibility(view)} />
          </div>
        );
      })}
    </SettingsGroup>
  );
}
