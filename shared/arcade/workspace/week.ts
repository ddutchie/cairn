/**
 * The week wall for calendar mode: which due tasks land on which day.
 * Pure (no date-fns, no platform code), so the sim and the tests share it.
 * Due dates are "yyyy-MM-dd" keys; lexicographic compare is chronological.
 */

import type { OfficeProject } from "./data";
import type { Ref } from "./layout";

export interface WeekCard {
  ref: Ref;
  title: string;
  project: string;
  accent: string;
  priority: "low" | "medium" | "high" | "urgent";
  /** Due before the wall's today: also in the overdue tray. */
  overdue: boolean;
}

export interface WeekDay {
  /** "yyyy-MM-dd" key. */
  key: string;
  /** Short header: "SUN 23". */
  label: string;
  isToday: boolean;
  /** Sat/Sun: dimmed on the wall. */
  isWeekend: boolean;
  cards: WeekCard[];
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local "yyyy-MM-dd" key for a date (matches TaskCard.dueDate). */
export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** The Sunday-start week containing `anchor`, as midnight-local dates. */
export function weekDates(anchor: Date): Date[] {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay());
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/** Pin this office's dated open cards onto the anchor's week. */
export function bucketWeek(projects: readonly OfficeProject[], today: Date): { days: WeekDay[]; overdue: WeekCard[] } {
  const todayKey = toDateKey(today);
  const dates = weekDates(today);
  const days: WeekDay[] = dates.map((d) => ({
    key: toDateKey(d),
    label: `${DOW[d.getDay()]} ${d.getDate()}`,
    isToday: toDateKey(d) === todayKey,
    isWeekend: d.getDay() === 0 || d.getDay() === 6,
    cards: [],
  }));
  const byKey = new Map(days.map((d) => [d.key, d]));
  const overdue: WeekCard[] = [];
  for (const p of projects) {
    for (const c of p.cards) {
      if (!c.dueKey) continue;
      const w: WeekCard = { ref: { type: "task", id: c.id }, title: c.title, project: p.name, accent: p.accent, priority: c.priority, overdue: c.dueKey < todayKey };
      const day = byKey.get(c.dueKey);
      if (day) day.cards.push(w);
      if (w.overdue) overdue.push(w);
    }
  }
  return { days, overdue };
}
