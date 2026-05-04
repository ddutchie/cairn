"use client";

/**
 * StepViews — onboarding step to choose which views to enable.
 * All views are on by default. Users uncheck what they don't want.
 */

import { Kanban, Workflow, Terminal, GitBranch, BarChart2, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToggleableView } from "@/store/slices/ui";
import { Shell, NavRow } from "./shared";

interface ViewChoice {
  view: ToggleableView;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const VIEW_CHOICES: ViewChoice[] = [
  { view: "board",    label: "Board",          description: "Kanban board to track tasks and progress",    icon: <Kanban size={15} /> },
  { view: "flow",     label: "Idea Flow",       description: "Visual node canvas to connect your ideas",    icon: <Workflow size={15} /> },
  { view: "agent",    label: "Agent",           description: "Spawn and interact with coding agents",       icon: <Terminal size={15} /> },
  { view: "graph",    label: "Knowledge Graph", description: "See connections across your entire workspace", icon: <GitBranch size={15} /> },
  { view: "insights", label: "Insights",        description: "Analytics: velocity, activity, and trends",   icon: <BarChart2 size={15} /> },
  { view: "chat",     label: "AI Chat",         description: "Ask your AI assistant anything in-app",       icon: <MessageSquare size={15} /> },
];

interface Props {
  hidden: Set<ToggleableView>;
  onToggle: (view: ToggleableView) => void;
  onBack: () => void;
  onNext: () => void;
}

export function StepViews({ hidden, onToggle, onBack, onNext }: Props) {
  return (
    <Shell step="views">
      <div className="w-full max-w-md bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 flex flex-col gap-5">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-0.5">Choose your workspace</h2>
          <p className="text-xs text-[var(--text-tertiary)]">
            Enable the views you want. You can change this any time in Settings → General.
          </p>
        </div>

        {/* Always-on notice */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border-subtle)]">
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">
            <strong className="text-[var(--text-secondary)]">Overview</strong> and{" "}
            <strong className="text-[var(--text-secondary)]">Notes</strong> are always visible.
          </span>
        </div>

        {/* View toggles */}
        <div className="space-y-1.5">
          {VIEW_CHOICES.map(({ view, label, description, icon }) => {
            const enabled = !hidden.has(view);
            return (
              <button
                key={view}
                type="button"
                onClick={() => onToggle(view)}
                className={cn(
                  "flex items-center gap-3 w-full rounded-xl border px-4 py-3 text-left transition-all",
                  enabled
                    ? "border-[var(--accent)] bg-[var(--accent-dim)]"
                    : "border-[var(--border)] hover:border-[var(--accent)]/40 hover:bg-[var(--surface-2)]"
                )}
              >
                <span className={cn("flex-shrink-0", enabled ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]")}>
                  {icon}
                </span>
                <div className="flex-1 min-w-0">
                  <p className={cn("text-xs font-medium", enabled ? "text-[var(--accent)]" : "text-[var(--text-primary)]")}>
                    {label}
                  </p>
                  <p className="text-[0.714rem] text-[var(--text-tertiary)] truncate">{description}</p>
                </div>
                {/* Checkbox indicator */}
                <span
                  className={cn(
                    "w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors",
                    enabled
                      ? "bg-[var(--accent)] border-[var(--accent)]"
                      : "border-[var(--border)] bg-[var(--surface)]"
                  )}
                >
                  {enabled && (
                    <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                      <path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <NavRow onBack={onBack} onNext={onNext} />
      </div>
    </Shell>
  );
}
