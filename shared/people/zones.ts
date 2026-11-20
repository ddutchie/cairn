/**
 * Where the people you work with are on the clock (People view, "Time zones").
 * Every time is in the viewer's local hours (0 to 24), so the strip answers
 * "when are they at work, as I live it". Pure; zones are IANA names and an
 * unknown one is treated as unset.
 */
import type { PersonSummary } from "../types/people-view";

export const WORK_START = 9;
export const WORK_END = 17;

/** Minutes the zone is ahead of UTC at `at`, or null for a zone the runtime doesn't know. */
export function zoneOffsetMinutes(timezone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(at);
    const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
    return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  } catch {
    return null;
  }
}

/** The viewer's own zone, for when "me" has none set. */
export function systemZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** The hours (0 to 24, viewer time) a 9-to-5 day in a zone `diffMinutes` ahead of the viewer covers: one or two spans. */
export function workSpans(diffMinutes: number, start = WORK_START, end = WORK_END): Array<[number, number]> {
  const shift = diffMinutes / 60;
  const a = (((start - shift) % 24) + 24) % 24;
  const len = end - start;
  const b = a + len;
  return b <= 24 ? [[a, b]] : [[a, 24], [0, b - 24]];
}

/** Hours of the viewer's own working day that fall inside the person's. */
export function overlapHours(diffMinutes: number, start = WORK_START, end = WORK_END): number {
  let total = 0;
  for (const [a, b] of workSpans(diffMinutes, start, end)) total += Math.max(0, Math.min(b, end) - Math.max(a, start));
  return Math.round(total * 10) / 10;
}

/** Local hour of day (fractional) in a zone at `at`, or null for a zone the runtime doesn't know. */
export function localHourAt(timezone: string, at: Date): number | null {
  const off = zoneOffsetMinutes(timezone, at);
  return off === null ? null : (((at.getTime() / 3_600_000 + off / 60) % 24) + 24) % 24;
}

export type Availability = "work" | "edge" | "asleep";

/** At work (9 to 17), asleep (22 to 07), or early or late in between. */
export function availabilityAt(hour: number): Availability {
  return hour >= WORK_START && hour < WORK_END ? "work" : hour >= 22 || hour < 7 ? "asleep" : "edge";
}

export interface ZonePerson {
  person: PersonSummary;
  timezone: string;
  /** Their offset from the viewer, in minutes (positive: ahead of you). */
  diffMinutes: number;
  /** "14:05" where they are. */
  localTime: string;
  /** Local hour of day (fractional) where they are. */
  localHour: number;
  /** Inside 9 to 5 there right now. */
  atWork: boolean;
  /** Between 22:00 and 07:00 there right now. */
  asleep: boolean;
  spans: Array<[number, number]>;
  overlap: number;
}

export interface ZoneModel {
  /** The viewer's zone and where it came from. */
  me: { timezone: string; fromProfile: boolean };
  /** Sorted from furthest behind you to furthest ahead, then by name. */
  rows: ZonePerson[];
  /** People with no zone, or one this runtime doesn't know. */
  unset: PersonSummary[];
  /** Viewer's current hour of day (fractional), for the "now" marker. */
  nowHour: number;
}

export function buildZoneModel(people: readonly PersonSummary[], me: PersonSummary | null, now: Date): ZoneModel {
  const myZone = me?.timezone && zoneOffsetMinutes(me.timezone, now) !== null ? me.timezone : systemZone();
  const myOffset = zoneOffsetMinutes(myZone, now) ?? 0;
  const hourIn = (offset: number) => (((now.getTime() / 3_600_000 + offset / 60) % 24) + 24) % 24;
  const rows: ZonePerson[] = [];
  const unset: PersonSummary[] = [];
  for (const p of people) {
    if (p.isMe) continue;
    const off = p.timezone ? zoneOffsetMinutes(p.timezone, now) : null;
    if (!p.timezone || off === null) { unset.push(p); continue; }
    const diff = off - myOffset;
    const h = hourIn(off);
    // Integer minutes, not the fractional hour: 12:01 must not come out as 12:00.
    const minuteOfDay = (((Math.floor(now.getTime() / 60_000) + off) % 1440) + 1440) % 1440;
    const hh = Math.floor(minuteOfDay / 60); const mm = minuteOfDay % 60;
    rows.push({
      person: p, timezone: p.timezone, diffMinutes: diff,
      localTime: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
      localHour: h, atWork: h >= WORK_START && h < WORK_END, asleep: h >= 22 || h < 7,
      spans: workSpans(diff), overlap: overlapHours(diff),
    });
  }
  rows.sort((a, b) => a.diffMinutes - b.diffMinutes || a.person.name.localeCompare(b.person.name));
  unset.sort((a, b) => a.name.localeCompare(b.name));
  return { me: { timezone: myZone, fromProfile: myZone === me?.timezone }, rows, unset, nowHour: hourIn(myOffset) };
}

/** "+2h", "-5h 30m", "same time". */
export function formatDiff(diffMinutes: number): string {
  if (diffMinutes === 0) return "same time";
  const sign = diffMinutes > 0 ? "+" : "-";
  const abs = Math.abs(diffMinutes);
  const h = Math.floor(abs / 60); const m = abs % 60;
  return `${sign}${h ? `${h}h` : ""}${h && m ? " " : ""}${m ? `${m}m` : ""}`;
}
