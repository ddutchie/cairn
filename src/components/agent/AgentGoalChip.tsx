"use client";

/**
 * AgentGoalChip — compact current-goal line above the coding-agent composer.
 *
 * Data comes from the dsh goal domain: an initial `session:goal` snapshot on
 * pane mount, then live `session:projection kind:"goal"` updates from
 * goal-bridge. Renders the objective text + phase; hidden when there is no
 * current goal (pre-create / cleared / complete shows as a settled line).
 * Set via `/goal` (human) or the model's `create_goal`/`update_goal` tools.
 */

import { useState } from "react";
import { Target, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GoalSummary } from "../../../shared/agent/session-projection";

interface AgentGoalChipProps {
  goal: GoalSummary | null;
}

function phaseStyle(phase: GoalSummary["phase"]): string {
  switch (phase) {
    case "active":
      return "bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-[var(--success)]";
    case "paused":
      return "bg-[color-mix(in_srgb,var(--warning,#f59e0b)_15%,transparent)] text-[var(--warning,#f59e0b)]";
    case "blocked":
      return "bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] text-[var(--danger)]";
    case "complete":
      return "bg-[var(--surface-3)] text-[var(--text-tertiary)]";
  }
}

export function AgentGoalChip({ goal }: AgentGoalChipProps) {
  const [expanded, setExpanded] = useState(false);
  if (!goal) return null;

  const rounds = goal.maxGoalRounds > 0 ? ` · ${goal.roundsStarted}/${goal.maxGoalRounds} rounds` : "";

  return (
    <div className="border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
      {expanded && goal.blockedReason && (
        <div className="px-3 pt-2 pb-1 text-[0.714rem] leading-relaxed text-[var(--text-secondary)]">
          <span className="font-mono text-[var(--danger)]">{goal.blockedReason.code}</span>
          {": "}{goal.blockedReason.message}
        </div>
      )}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--surface-2)] transition-colors text-left"
        title={goal.blockedReason ? "Toggle blocker detail" : "Current session goal"}
      >
        <Target size={12} className="text-[var(--accent)] shrink-0" />
        <span className="text-[0.714rem] font-medium text-[var(--text-secondary)] flex-1 truncate">
          {goal.objective}
          <span className="text-[var(--text-tertiary)] font-normal">{rounds}</span>
        </span>
        <span className={cn("text-[0.643rem] font-semibold px-1.5 py-0.5 rounded-full shrink-0", phaseStyle(goal.phase))}>
          {goal.phase.toUpperCase()}
        </span>
        {goal.blockedReason && (expanded
          ? <ChevronDown size={10} className="text-[var(--text-tertiary)] shrink-0" />
          : <ChevronUp size={10} className="text-[var(--text-tertiary)] shrink-0" />)}
      </button>
    </div>
  );
}
