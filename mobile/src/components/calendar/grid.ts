/**
 * Pure date/grid helpers for the mobile Calendar view, extracted so the
 * month/week grid construction and day-key parsing can be unit-tested without
 * rendering the calendar.
 *
 * DELIBERATELY `date-fns`-free (hand-rolled Date math) — this is NOT shared with
 * the desktop calendar (`src/components/calendar/calendar-utils.ts`), which uses
 * date-fns, `Date` params and a different cell shape. Mobile uses a `todayKey:
 * string` param and an extra `dueDayKey` ISO/bare parser; unifying the two would
 * drag date-fns into mobile (or rewrite desktop) for no behavioural gain.
 */

/** A single cell in the grid. */
export interface Cell {
  key: string;
  date: Date;
  inMonth: boolean;
  isToday: boolean;
}

/** LOCAL `yyyy-MM-dd` key for a Date. */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse a card `due_date` (bare `yyyy-MM-dd` or full ISO) to a LOCAL day key.
 * Mirrors getDueDateStatus so a date-only value isn't shifted by UTC-midnight.
 */
export function dueDayKey(due: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(due);
  if (Number.isNaN(d.getTime())) return "";
  return dayKey(d);
}

/**
 * Build a 6×7 month grid (42 cells) for the month containing `anchor`, padded
 * with leading/trailing adjacent-month days. Sunday-start. Mirrors the desktop
 * buildMonthGrid so the two apps lay out identically.
 */
export function buildMonthGrid(anchor: Date, todayKey: string): Cell[] {
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - monthStart.getDay());
  const cells: Cell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const key = dayKey(d);
    cells.push({ key, date: d, inMonth: d.getMonth() === anchor.getMonth(), isToday: key === todayKey });
  }
  return cells;
}

/** Build a 7-cell week grid (Sunday-start) for the week containing `anchor`. */
export function buildWeekGrid(anchor: Date, todayKey: string): Cell[] {
  const weekStart = new Date(anchor);
  weekStart.setDate(anchor.getDate() - anchor.getDay());
  const cells: Cell[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i);
    const key = dayKey(d);
    cells.push({ key, date: d, inMonth: true, isToday: key === todayKey });
  }
  return cells;
}

/** Format a `yyyy-MM-dd` key as e.g. "Monday, July 7". */
export function formatDayLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}
