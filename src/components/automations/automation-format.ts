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

export function scheduleLabel(a: Pick<Automation, "scheduleKind" | "scheduleExpr">): string {
  switch (a.scheduleKind) {
    case "every": return describeInterval(a.scheduleExpr);
    case "cron": return describeCron(a.scheduleExpr) ?? a.scheduleExpr;
    case "once": return `Once at ${new Date(a.scheduleExpr.replace(/^once\s+/i, "")).toLocaleString()}`;
  }
}

/** "every 1 hours" → "Every hour", "every 6 hours" → "Every 6 hours". */
export function describeInterval(expr: string): string {
  const m = expr.replace(/^every\s+/i, "").match(/^(\d+(?:\.\d+)?)\s*([a-z]+?)s?$/i);
  if (!m) return `Every ${expr.replace(/^every\s+/i, "")}`;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return n === 1 ? `Every ${unit}` : `Every ${m[1]} ${unit}s`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Day-of-week field → "weekdays", "Monday and Friday", "Monday–Wednesday"; null if not simple. */
function describeDays(field: string): string | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) {
      for (let d = Number(range[1]); d <= Number(range[2]); d++) days.add(d % 7);
    } else if (/^\d$/.test(part)) {
      days.add(Number(part) % 7);
    } else {
      return null;
    }
  }
  const sorted = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday first
  const key = sorted.join(",");
  if (key === "1,2,3,4,5") return "weekdays";
  if (key === "6,0") return "weekends";
  if (sorted.length === 7) return "every day";
  const names = sorted.map((d) => DAY_NAMES[d]);
  if (/^\d-\d$/.test(field) && names.length > 2) return `${names[0]}–${names[names.length - 1]}`;
  return names.length === 1 ? `${names[0]}s` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Plain-language cron for the shapes the schedule builder makes (daily,
 * weekly, monthly, every N minutes / hours). Returns null for anything else,
 * so the caller can show the raw expression.
 */
export function describeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return describeInterval(`${everyMin[1]} minutes`);
  }
  const everyHour = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(min) && everyHour && dom === "*" && mon === "*" && dow === "*") {
    return describeInterval(`${everyHour[1]} hours`) + (min === "0" ? "" : ` at :${min.padStart(2, "0")}`);
  }
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || mon !== "*") return null;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (dom === "*" && dow === "*") return `Daily at ${time}`;
  if (dom === "*") {
    const days = describeDays(dow);
    if (!days) return null;
    if (days === "every day") return `Daily at ${time}`;
    return `${days.charAt(0).toUpperCase()}${days.slice(1)} at ${time}`;
  }
  if (/^\d+$/.test(dom) && dow === "*") return `Monthly on day ${dom} at ${time}`;
  return null;
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
