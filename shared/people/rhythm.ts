/**
 * Meeting rhythm (People view, "Rhythm"): how long since you last met each
 * person, against the cadence you set. It reflects your own intent and says
 * nothing about anyone's activity.
 */
import type { Cadence } from "../types/people";
import type { PersonSummary } from "../types/people-view";

export const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, monthly: 30 };

export type RhythmState = "overdue" | "soon" | "ok" | "never";

export interface RhythmRow {
  person: PersonSummary;
  cadenceDays: number;
  /** Whole days since the last meeting; null when there is none on record. */
  sinceDays: number | null;
  /** since / cadence; 1 is "due". Null with no meeting on record. */
  ratio: number | null;
  /** Days until the next booked meeting, when there is one. */
  bookedInDays: number | null;
  state: RhythmState;
  /** Days overdue (positive), or days left (negative); 0 for "never". */
  daysOver: number;
}

export interface RhythmModel {
  rows: RhythmRow[];
  /** Confirmed people with no cadence set. */
  noCadence: PersonSummary[];
  counts: Record<RhythmState, number>;
}

const dayDiff = (a: number, b: number) => Math.floor((a - b) / 86_400_000);

/** A meeting booked before it is due counts as being on track, so it doesn't show as overdue-and-handled. */
export function buildRhythm(people: readonly PersonSummary[], now: Date): RhythmModel {
  const t = now.getTime();
  const rows: RhythmRow[] = [];
  const noCadence: PersonSummary[] = [];
  for (const p of people) {
    if (p.isMe || p.status !== "confirmed") continue;
    if (!p.cadence) { noCadence.push(p); continue; }
    const cadenceDays = CADENCE_DAYS[p.cadence];
    const last = p.lastMetAt ? Date.parse(p.lastMetAt) : NaN;
    const next = p.nextMeetingAt ? Date.parse(p.nextMeetingAt) : NaN;
    const sinceDays = Number.isNaN(last) ? null : Math.max(0, dayDiff(t, last));
    const bookedInDays = !Number.isNaN(next) && next >= t ? Math.ceil((next - t) / 86_400_000) : null;
    const ratio = sinceDays === null ? null : sinceDays / cadenceDays;
    let state: RhythmState = sinceDays === null ? "never" : ratio! > 1 ? "overdue" : ratio! >= 0.8 ? "soon" : "ok";
    // Booked in time: the next meeting lands before the cadence runs out.
    if ((state === "overdue" || state === "soon") && bookedInDays !== null && sinceDays !== null && sinceDays + bookedInDays <= cadenceDays) state = "ok";
    rows.push({
      person: p, cadenceDays, sinceDays, ratio, bookedInDays, state,
      daysOver: sinceDays === null ? 0 : sinceDays - cadenceDays,
    });
  }
  const weight: Record<RhythmState, number> = { never: 3, overdue: 2, soon: 1, ok: 0 };
  rows.sort((a, b) => weight[b.state] - weight[a.state] || (b.ratio ?? 0) - (a.ratio ?? 0) || a.person.name.localeCompare(b.person.name));
  noCadence.sort((a, b) => a.name.localeCompare(b.name));
  const counts: Record<RhythmState, number> = { overdue: 0, soon: 0, ok: 0, never: 0 };
  for (const r of rows) counts[r.state]++;
  return { rows, noCadence, counts };
}
