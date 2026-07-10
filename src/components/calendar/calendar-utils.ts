/**
 * Pure helpers for the Calendar view, extracted so the month/week grid
 * construction and the date-bucketing of cards can be unit-tested without
 * rendering the calendar.
 *
 * `dueDate` is always the string format "yyyy-MM-dd" (see TaskCard / DatePicker).
 * All functions accept an explicit `today` Date so tests stay deterministic
 * regardless of the wall clock or timezone.
 */

import {
  startOfMonth,
  startOfWeek,
  endOfWeek,
  startOfDay,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  format,
  addMonths,
  addWeeks,
  addDays,
} from "date-fns";
import type { TaskCard } from "@/types";

/** Canonical dueDate serialization format. */
export const DATE_KEY = "yyyy-MM-dd";

/** Serialize a Date to the "yyyy-MM-dd" key used by TaskCard.dueDate. */
export function toDateKey(date: Date): string {
  return format(date, DATE_KEY);
}

/** A single cell in a calendar grid. */
export interface CalendarCell {
  /** "yyyy-MM-dd" key — matches TaskCard.dueDate and droppable ids. */
  key: string;
  /** Midnight-local Date for this cell. */
  date: Date;
  /** False for leading/trailing days that belong to the adjacent month. */
  inMonth: boolean;
  /** True when the cell is the same calendar day as `today`. */
  isToday: boolean;
}

/**
 * Build a 6×7 month grid (always 42 cells) for the month containing `anchor`,
 * padded with leading/trailing days so every row is a full week and the grid
 * height is stable across months. Weeks start on Sunday to match the rest of
 * the app's date pickers.
 */
export function buildMonthGrid(anchor: Date, today: Date = new Date()): CalendarCell[] {
  const monthStart = startOfMonth(anchor);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  // Always 6 weeks so the grid never changes height between months.
  const gridEnd = addDays(gridStart, 41);
  const today0 = startOfDay(today);

  return eachDayOfInterval({ start: gridStart, end: gridEnd }).map((date) => ({
    key: toDateKey(date),
    date,
    inMonth: isSameMonth(date, monthStart),
    isToday: isSameDay(date, today0),
  }));
}

/**
 * Build a 7-cell week grid for the week containing `anchor` (Sunday-start).
 * All cells are `inMonth: true` — the week view has no out-of-month concept.
 */
export function buildWeekGrid(anchor: Date, today: Date = new Date()): CalendarCell[] {
  const weekStart = startOfWeek(anchor, { weekStartsOn: 0 });
  const weekEnd = endOfWeek(anchor, { weekStartsOn: 0 });
  const today0 = startOfDay(today);

  return eachDayOfInterval({ start: weekStart, end: weekEnd }).map((date) => ({
    key: toDateKey(date),
    date,
    inMonth: true,
    isToday: isSameDay(date, today0),
  }));
}

/** Step the anchor date by whole months (sign of `delta` = direction). */
export function shiftMonth(anchor: Date, delta: number): Date {
  return addMonths(anchor, delta);
}

/** Step the anchor date by whole weeks (sign of `delta` = direction). */
export function shiftWeek(anchor: Date, delta: number): Date {
  return addWeeks(anchor, delta);
}

/** Result of bucketing cards for a calendar render. */
export interface BucketedCards {
  /** dueDate key → cards due that day (past, today and future). */
  byDate: Map<string, TaskCard[]>;
  /** Cards with no dueDate. */
  unscheduled: TaskCard[];
  /** Non-done cards whose dueDate is strictly before today. */
  overdue: TaskCard[];
}

/**
 * Bucket cards into per-day groups, an unscheduled list, and an overdue list.
 *
 * Every dated card is placed in `byDate` under its due day — INCLUDING past-due
 * cards — so a past day that's visible in the grid still shows its tasks rather
 * than appearing empty. `overdue` is an ADDITIONAL list (for the overdue tray)
 * of the same cards whose dueDate is strictly before today.
 *
 * `isDone(card)` identifies cards in a done-type column: a completed task is
 * never "overdue", so a past-due done card is omitted from the `overdue` tray
 * list (it still keeps its day chip in `byDate`). Done cards with a today/future
 * due date are unaffected.
 */
export function bucketByDate(
  cards: TaskCard[],
  today: Date = new Date(),
  isDone: (card: TaskCard) => boolean = () => false,
): BucketedCards {
  const byDate = new Map<string, TaskCard[]>();
  const unscheduled: TaskCard[] = [];
  const overdue: TaskCard[] = [];
  const todayKey = toDateKey(startOfDay(today));

  for (const card of cards) {
    if (!card.dueDate) {
      unscheduled.push(card);
      continue;
    }
    // Every dated card lands in its day bucket (past cells must not be empty).
    const bucket = byDate.get(card.dueDate);
    if (bucket) bucket.push(card);
    else byDate.set(card.dueDate, [card]);
    // Additionally surface past-due, not-yet-done cards in the overdue tray.
    // Lexicographic compare is safe for the fixed-width "yyyy-MM-dd" format.
    if (card.dueDate < todayKey && !isDone(card)) overdue.push(card);
  }

  return { byDate, unscheduled, overdue };
}
