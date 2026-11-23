/**
 * The phone's own Today: what needs you today, computed from synced data alone
 * (due tasks, meetings, people you are due to meet). Pure, so the screen, the
 * pinned accessory's live line and the `get_today` chat tool all agree.
 *
 * This is not the desktop's AI brief (`brief.ts`), which is a file that does not
 * sync; see docs/plans/mobile-today.md.
 */
import { getDueDateStatus } from "../format/date";

export interface LocalTodayTask {
  id: string;
  title: string;
  dueDate: string;
  projectName?: string;
  priority?: string | null;
}

export interface LocalTodayMeeting {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
}

export interface LocalTodayPerson {
  id: string;
  name: string;
  /** Days past the cadence you set. */
  daysOver: number;
}

export interface LocalToday {
  /** Local `YYYY-MM-DD`. */
  date: string;
  overdue: LocalTodayTask[];
  dueToday: LocalTodayTask[];
  /** Today's meetings, earliest first. */
  meetings: LocalTodayMeeting[];
  /** People you are overdue to meet, most overdue first. */
  peopleDue: LocalTodayPerson[];
}

export interface LocalTodayInput {
  /** Open tasks with a due date on or before today (the caller's query decides the cut-off and cap). */
  tasks: LocalTodayTask[];
  meetings: LocalTodayMeeting[];
  peopleDue: LocalTodayPerson[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local `YYYY-MM-DD` for a time. */
export function localDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO bounds of the local day containing `now`: `[start, nextStart)`. */
export function localDayBounds(now: number): { start: string; end: string } {
  const s = new Date(now);
  s.setHours(0, 0, 0, 0);
  const e = new Date(s);
  e.setDate(e.getDate() + 1);
  return { start: s.toISOString(), end: e.toISOString() };
}

export function buildLocalToday(input: LocalTodayInput, now: number = Date.now()): LocalToday {
  const overdue: LocalTodayTask[] = [];
  const dueToday: LocalTodayTask[] = [];
  for (const t of input.tasks) {
    const s = getDueDateStatus(t.dueDate, now);
    if (s === "overdue") overdue.push(t);
    else if (s === "today") dueToday.push(t);
  }
  const byDue = (a: LocalTodayTask, b: LocalTodayTask) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title);
  return {
    date: localDay(now),
    overdue: overdue.sort(byDue),
    dueToday: dueToday.sort(byDue),
    meetings: [...input.meetings].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    peopleDue: [...input.peopleDue].sort((a, b) => b.daysOver - a.daysOver),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One short line: "2 overdue, 3 due today, 1 meeting", or a calm sentence when there is nothing. */
export function localTodayLine(t: LocalToday): string {
  const parts: string[] = [];
  if (t.overdue.length) parts.push(`${t.overdue.length} overdue`);
  if (t.dueToday.length) parts.push(`${t.dueToday.length} due today`);
  if (t.meetings.length) parts.push(plural(t.meetings.length, "meeting", "meetings"));
  if (t.peopleDue.length) parts.push(`${t.peopleDue.length} to catch up with`);
  return parts.length ? parts.join(", ") : "Nothing due today";
}
