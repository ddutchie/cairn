import { dayKey, dueDayKey } from "../components/calendar/grid";

/**
 * The small status summaries shown beside the Board and the Calendar when a wide
 * window gives them the big column (see ProjectsSplitView): pure maths over the
 * project's columns / cards, tested in project-status.test.ts.
 */

export interface DatedCard {
  due_date: string;
  is_done: number;
}

export interface CalendarStatus {
  today: number;
  /** The Sunday-start week containing today (the grid's week). */
  week: number;
  month: number;
  overdue: number;
  unscheduled: number;
}

/** Open dated tasks due today / this week / this month, plus overdue and undated ones. */
export function calendarStatus(dated: DatedCard[], unscheduledOpen: number, todayKey: string): CalendarStatus {
  const [y, m, d] = todayKey.split("-").map(Number);
  const start = new Date(y, m - 1, d - new Date(y, m - 1, d).getDay());
  const weekKeys = new Set(Array.from({ length: 7 }, (_, i) => dayKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))));
  const monthPrefix = todayKey.slice(0, 7);
  const out: CalendarStatus = { today: 0, week: 0, month: 0, overdue: 0, unscheduled: unscheduledOpen };
  for (const c of dated) {
    if (c.is_done) continue;
    const key = dueDayKey(c.due_date);
    if (!key) continue;
    if (key < todayKey) out.overdue++;
    if (key === todayKey) out.today++;
    if (weekKeys.has(key)) out.week++;
    if (key.startsWith(monthPrefix)) out.month++;
  }
  return out;
}
