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

/** "FRI" for "2026-11-27", "?" when the key isn't a date. */
export function dayShort(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return "?";
  return DOW[new Date(+m[1], +m[2] - 1, +m[3]).getDay()];
}

/** The Sunday-start week containing `anchor`, as midnight-local dates. */
export function weekDates(anchor: Date): Date[] {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay());
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/** Pin this office's dated open cards onto the anchor's week (`today` sets the highlight and what counts overdue). */
export function bucketWeek(projects: readonly OfficeProject[], today: Date, anchor: Date = today): { days: WeekDay[]; overdue: WeekCard[] } {
  const todayKey = toDateKey(today);
  const dates = weekDates(anchor);
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

/**
 * The demo office's due dates, relative to today: its overdue cards fell due
 * yesterday (so the wall agrees with the done board), and every other card in
 * progress or review is spread over the next few days.
 */
export function withDemoDates(projects: readonly OfficeProject[], today: Date): OfficeProject[] {
  const day = (n: number) => toDateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
  let next = 0;
  return projects.map((p) => ({
    ...p,
    cards: p.cards.map((c) => {
      if (c.overdue) return { ...c, dueKey: day(-1) };
      if (c.zone !== "doing" && c.zone !== "review") return c;
      return { ...c, dueKey: day(next++ % 4) };
    }),
  }));
}
