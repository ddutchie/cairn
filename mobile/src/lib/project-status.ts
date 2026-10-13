import { dayKey, dueDayKey } from "../components/calendar/grid";

/**
 * The small status summaries shown beside the Board and the Calendar when a wide
 * window gives them the big column (see ProjectsSplitView): pure maths over the
 * project's columns / cards, tested in project-status.test.ts.
 */

export interface StatusColumn {
  id: string;
  name: string;
  type: string;
}
export interface StatusCard {
  column_id: string;
  priority: string | null;
}
export interface DatedCard {
  due_date: string;
  is_done: number;
}

export interface BoardStatus {
  open: number;
  done: number;
  /** Open tasks that are high or urgent priority. */
  important: number;
  /** Open tasks past their due date / due today (dated tasks only). */
  overdue: number;
  dueToday: number;
  perColumn: { id: string; name: string; count: number; done: boolean }[];
}

export function boardStatus(
  columns: StatusColumn[],
  cards: StatusCard[],
  dated: DatedCard[],
  todayKey: string,
): BoardStatus {
  const doneIds = new Set(columns.filter((c) => c.type === "done").map((c) => c.id));
  const counts = new Map<string, number>();
  let open = 0;
  let done = 0;
  let important = 0;
  for (const c of cards) {
    counts.set(c.column_id, (counts.get(c.column_id) ?? 0) + 1);
    if (doneIds.has(c.column_id)) done++;
    else {
      open++;
      if (c.priority === "high" || c.priority === "urgent") important++;
    }
  }
  let overdue = 0;
  let dueToday = 0;
  for (const d of dated) {
    if (d.is_done) continue;
    const key = dueDayKey(d.due_date);
    if (!key) continue;
    if (key < todayKey) overdue++;
    else if (key === todayKey) dueToday++;
  }
  return {
    open,
    done,
    important,
    overdue,
    dueToday,
    perColumn: columns.map((c) => ({ id: c.id, name: c.name, count: counts.get(c.id) ?? 0, done: doneIds.has(c.id) })),
  };
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
