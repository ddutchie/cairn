/**
 * Where the people you work with are on the clock (People view, "Time zones").
 * Every time is in the viewer's local hours (0 to 24), so the strip answers
 * "when are they at work, as I live it". Pure; zones are IANA names and an
 * unknown one is treated as unset.
 */
import type { PersonSummary } from "../types/people-view";
import { PEOPLE_GROUPS, groupKeysFor } from "./model";

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

/** The zone's canonical id as the runtime knows it (aliases like Asia/Calcutta and Asia/Kolkata agree), or null for an unknown zone. */
export function canonicalZoneId(timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Whether two names are the same zone. Compares identity, not the offset at one
 * moment: Europe/Berlin and Africa/Lagos are both UTC+1 in winter and are not the same place.
 */
export function sameZone(a: string, b: string): boolean {
  const ca = canonicalZoneId(a);
  return ca !== null && ca === canonicalZoneId(b);
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
  /** You, on the same strip (offset zero, your own working day), or null when no person is marked as you. */
  meRow: ZonePerson | null;
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
  let meRow: ZonePerson | null = null;
  if (me) {
    const minuteOfDay = (((Math.floor(now.getTime() / 60_000) + myOffset) % 1440) + 1440) % 1440;
    const h = hourIn(myOffset);
    meRow = {
      person: me, timezone: myZone, diffMinutes: 0,
      localTime: `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`,
      localHour: h, atWork: h >= WORK_START && h < WORK_END, asleep: h >= 22 || h < 7,
      spans: workSpans(0), overlap: overlapHours(0),
    };
  }
  return { me: { timezone: myZone, fromProfile: myZone === me?.timezone }, rows, meRow, unset, nowHour: hourIn(myOffset) };
}

/** "+2h", "-5h 30m", "same time". */
export function formatDiff(diffMinutes: number): string {
  if (diffMinutes === 0) return "same time";
  const sign = diffMinutes > 0 ? "+" : "-";
  const abs = Math.abs(diffMinutes);
  const h = Math.floor(abs / 60); const m = abs % 60;
  return `${sign}${h ? `${h}h` : ""}${h && m ? " " : ""}${m ? `${m}m` : ""}`;
}

// ── Grouping ─────────────────────────────────

/** Ways to arrange the Time zones view. "Closest" is the default: the people you work with most, nearest first. */
export const ZONE_GROUPINGS = [
  { value: "closest", label: "Closest" },
  { value: "zone", label: "Time zone" },
  { value: "availability", label: "Availability" },
  { value: "team", label: "Team" },
] as const;
export type ZoneGrouping = (typeof ZONE_GROUPINGS)[number]["value"];
export const DEFAULT_ZONE_GROUPING: ZoneGrouping = "closest";

export interface ZoneGroup {
  key: string;
  label: string;
  /** A quiet line beside the label: the offset for a time zone. */
  note?: string;
  rows: ZonePerson[];
}

const byName = (a: ZonePerson, b: ZonePerson) => a.person.name.localeCompare(b.person.name, undefined, { sensitivity: "base" });
const cityOf = (tz: string) => (tz.split("/").pop() ?? tz).replace(/_/g, " ");
const norm = (s: string | undefined) => (s ?? "").trim().replace(/\s+/g, " ");

/** Who you keep closest first: on a 1:1 cadence, then met most recently, then by name. */
function closerFirst(a: ZonePerson, b: ZonePerson): number {
  return Number(!!b.person.cadence) - Number(!!a.person.cadence)
    || (b.person.lastMetAt ?? "").localeCompare(a.person.lastMetAt ?? "")
    || byName(a, b);
}

/** The relationship group that ranks first among the ones a person belongs to (people are listed once here). */
function closestGroupKey(p: PersonSummary): string {
  const keys = new Set<string>(groupKeysFor(p.relationship));
  return PEOPLE_GROUPS.find((g) => keys.has(g.key))?.key ?? "other";
}

/**
 * Arrange the rows (you are not among them: see `ZoneModel.meRow`). Each person lands in one group.
 * `closest`: relationship groups in list order, nearest first inside each. `zone`: one group per zone,
 * furthest behind you first. `availability`: working, early or late, asleep. `team`: by home team.
 * `availableOnly` drops anyone asleep.
 */
export function groupZoneRows(rows: readonly ZonePerson[], by: ZoneGrouping, opts: { availableOnly?: boolean } = {}): ZoneGroup[] {
  const list = opts.availableOnly ? rows.filter((r) => !r.asleep) : [...rows];
  const bucket = (keyOf: (r: ZonePerson) => { key: string; label: string; note?: string }, sort: (a: ZonePerson, b: ZonePerson) => number): Map<string, ZoneGroup> => {
    const map = new Map<string, ZoneGroup>();
    for (const r of list) {
      const k = keyOf(r);
      const g = map.get(k.key) ?? { key: k.key, label: k.label, note: k.note, rows: [] };
      g.rows.push(r);
      map.set(k.key, g);
    }
    for (const g of map.values()) g.rows.sort(sort);
    return map;
  };
  switch (by) {
    case "closest": {
      const map = bucket((r) => {
        const key = closestGroupKey(r.person);
        return { key, label: PEOPLE_GROUPS.find((g) => g.key === key)!.label };
      }, closerFirst);
      return PEOPLE_GROUPS.map((g) => map.get(g.key)).filter((g): g is ZoneGroup => !!g);
    }
    case "zone": {
      const map = bucket((r) => ({ key: r.timezone, label: cityOf(r.timezone), note: formatDiff(r.diffMinutes) }), closerFirst);
      return [...map.values()].sort((a, b) => a.rows[0].diffMinutes - b.rows[0].diffMinutes || a.label.localeCompare(b.label));
    }
    case "availability": {
      const labels = { work: "Working now", edge: "Early or late", asleep: "Asleep" } as const;
      const map = bucket((r) => {
        const key = r.atWork ? "work" : r.asleep ? "asleep" : "edge";
        return { key, label: labels[key] };
      }, closerFirst);
      return (["work", "edge", "asleep"] as const).map((k) => map.get(k)).filter((g): g is ZoneGroup => !!g);
    }
    case "team": {
      const map = bucket((r) => {
        const home = r.person.teams?.[0];
        const name = norm(home?.name ?? r.person.team);
        return name ? { key: home?.teamId ?? name.toLowerCase(), label: name } : { key: "_none", label: "No team" };
      }, closerFirst);
      return [...map.values()].sort((a, b) => {
        if ((a.key === "_none") !== (b.key === "_none")) return a.key === "_none" ? 1 : -1;
        return b.rows.length - a.rows.length || a.label.localeCompare(b.label);
      });
    }
  }
}
