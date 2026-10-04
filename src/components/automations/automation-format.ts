import type { RelativeTimeOptions } from "@/lib/utils";
import type { Automation, AutomationRun } from "@/store/slices/automations";

/** Formatting helpers shared by the automations list and its dialogs. */

/** Run/schedule times: "5m ago" / "3h away", absolute after a month. */
export const RUN_TIME: RelativeTimeOptions = { fallback: "—", future: true, absoluteAfterDays: 30 };

export const STATUS_COLOR: Record<string, string> = {
  done: "text-[var(--ok)]",
  running: "text-[var(--accent)]",
  pending: "text-[var(--text-secondary)]",
  skipped: "text-[var(--text-tertiary)]",
  exhausted: "text-[var(--warning)]",
  error: "text-[var(--danger)]",
  denied: "text-[var(--danger)]",
};

export function scheduleLabel(a: Automation): string {
  switch (a.scheduleKind) {
    case "every": return `Every ${a.scheduleExpr.replace(/^every\s+/i, "")}`;
    case "cron": return a.scheduleExpr;
    case "once": return `Once at ${new Date(a.scheduleExpr.replace(/^once\s+/i, "")).toLocaleString()}`;
  }
}

/** Read the currently-executing tool from a run's scratch JSON (set by the runner). */
export function runScratchTool(run: AutomationRun | undefined): string | null {
  if (!run?.scratch) return null;
  try {
    const scratch = JSON.parse(run.scratch) as { currentTool?: string };
    return typeof scratch.currentTool === "string" && scratch.currentTool ? scratch.currentTool : null;
  } catch {
    return null;
  }
}

export interface ArtifactRef { type: "note" | "task"; id: string; title: string }

/** Notes/cards a run created, from its scratch JSON (set by the runner). */
export function runScratchArtifacts(run: AutomationRun | undefined): ArtifactRef[] {
  if (!run?.scratch) return [];
  try {
    const scratch = JSON.parse(run.scratch) as { artifacts?: ArtifactRef[] };
    return Array.isArray(scratch.artifacts) ? scratch.artifacts : [];
  } catch {
    return [];
  }
}
