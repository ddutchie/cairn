/**
 * The phone's own Today: what needs you today, computed from synced data alone
 * (due tasks, meetings, people you are due to meet). Pure, so the screen, the
 * pinned accessory's live line and the `get_today` chat tool all agree.
 *
 * This is not the desktop's AI brief (`brief.ts`), which is a file that does not
 * sync; see docs/plans/mobile-today.md.
 */
import { getDueDateStatus } from "../format/date";
import { dayBlocks, formatMinutes, type TodayDay } from "./brief";

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

/** An open action item the user owns, read from a note. */
export interface LocalTodayOwed {
  noteId: string;
  noteTitle: string;
  text: string;
  /** Opaque handle the screen passes back to tick the item. */
  lineKey: string;
  bodyDigest: string;
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
  /** Today's meetings as blocks of busy and free time (8:00 to 18:00), free time first-class. */
  day: TodayDay;
  /** Open action items the user owns, across notes. */
  youOwe: LocalTodayOwed[];
}

export interface LocalTodayInput {
  /** Open tasks with a due date on or before today (the caller's query decides the cut-off and cap). */
  tasks: LocalTodayTask[];
  meetings: LocalTodayMeeting[];
  peopleDue: LocalTodayPerson[];
  youOwe?: LocalTodayOwed[];
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

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A meeting's end as "HH:MM": same-day as is, a later day as "24:00", unknown as undefined (the strip assumes a short meeting). */
function endOf(endsAt: string | null | undefined, now: number): string | undefined {
  if (!endsAt) return undefined;
  const t = new Date(endsAt).getTime();
  const day = localDay(now);
  const endDay = localDay(t);
  return endDay === day ? hhmm(endsAt) : endDay > day ? "24:00" : undefined;
}

/** Meetings as the shared day strip's events. A meeting that runs past midnight is cut at 24:00. */
function toDay(meetings: LocalTodayMeeting[], now: number): TodayDay {
  const d = new Date(now);
  return dayBlocks(
    meetings.map((m) => ({
      id: m.id,
      title: m.title,
      start: hhmm(m.startsAt),
      end: endOf(m.endsAt, now),
    })),
    d.getHours() * 60 + d.getMinutes(),
  );
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
  const meetings = [...input.meetings].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return {
    date: localDay(now),
    overdue: overdue.sort(byDue),
    dueToday: dueToday.sort(byDue),
    meetings,
    peopleDue: [...input.peopleDue].sort((a, b) => b.daysOver - a.daysOver),
    day: toDay(meetings, now),
    youOwe: input.youOwe ?? [],
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One short line: "2 overdue, 3 due today, 1 meeting", or a calm sentence when there is nothing. */
export function localTodayLine(t: LocalToday): string {
  const parts: string[] = [];
  if (t.overdue.length) parts.push(`${t.overdue.length} overdue`);
  if (t.dueToday.length) parts.push(`${t.dueToday.length} due today`);
  if (t.meetings.length) parts.push(plural(t.meetings.length, "meeting", "meetings"));
  if (t.youOwe.length) parts.push(`${t.youOwe.length} you owe`);
  if (t.peopleDue.length) parts.push(`${t.peopleDue.length} to catch up with`);
  return parts.length ? parts.join(", ") : "Nothing due today";
}

/** "3h 20m free, longest 1h 30m": the free time left today, or null when there is none worth saying. */
export function freeTimeLine(day: TodayDay): string | null {
  if (day.freeBlocksLeft === 0) return null;
  const left = formatMinutes(day.freeLeft);
  return day.freeBlocksLeft === 1 ? `${left} free` : `${left} free, longest ${formatMinutes(day.largestFree)}`;
}
