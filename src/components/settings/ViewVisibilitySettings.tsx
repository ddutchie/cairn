"use client";

/**
 * ViewVisibilitySettings — toggle which views are shown in the sidebar.
 * Overview and Notes are always visible and shown as locked.
 */

import { Kanban, CalendarDays, Workflow, GitBranch, BarChart2, Terminal, MessageSquare, Lock, Users } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { ToggleableView } from "@/store/slices/ui";
import { SettingsGroup, SettingsRow, Toggle } from "./shared";

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

/** Listed only while the People layer flag (`feature.people`) is on. */
const PEOPLE_OPTION: ViewOption = {
  view: "people", label: "People", description: "People you work with, their meetings and notes", icon: <Users size={13} />,
};

/**
 * The People layer is unreleased: its switch shows in development builds, and
 * anywhere once the flag is on (so it can be turned off again). Release users
 * with the flag off see nothing.
 */
const SHOW_PEOPLE_PREVIEW = process.env.NODE_ENV === "development";

export function ViewVisibilitySettings() {
  const { hiddenViews, toggleViewVisibility, peopleEnabled, setPeopleEnabled } = useCairnStore(useShallow((s) => ({
    hiddenViews: s.hiddenViews,
    toggleViewVisibility: s.toggleViewVisibility,
    peopleEnabled: s.peopleEnabled,
    setPeopleEnabled: s.setPeopleEnabled,
  })));
  const options = peopleEnabled ? [...VIEW_OPTIONS, PEOPLE_OPTION] : VIEW_OPTIONS;

  return (
    <>
    <SettingsGroup
      title="Visible views"
      description="Overview and Notes are always shown. Hidden views also drop out of the ⌘3–⌘9 shortcuts."
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
              <p className="text-xs text-[var(--text-tertiary)]">Always visible</p>
            </div>
          </div>
            <Toggle checked disabled onChange={() => {}} label={`${label} — always visible`} />
        </div>
      ))}

      {/* Toggleable rows */}
      {options.map(({ view, label, description, icon }) => {
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
                <p className="text-xs text-[var(--text-tertiary)]">{description}</p>
              </div>
            </div>
            <Toggle checked={visible} onChange={() => toggleViewVisibility(view)} label={`Toggle ${label}`} />
          </div>
        );
      })}
    </SettingsGroup>
    {(SHOW_PEOPLE_PREVIEW || peopleEnabled) && (
      <div className="mt-8">
        <SettingsGroup
          title="People (preview)"
          description="Unreleased. Turns on the People layer for this workspace; the People view then appears above."
        >
          <SettingsRow label="People layer" description="People, meetings and relationships">
            <Toggle checked={peopleEnabled} onChange={(on) => void setPeopleEnabled(on)} label="Toggle the People layer" />
          </SettingsRow>
        </SettingsGroup>
      </div>
    )}
    </>
  );
}
