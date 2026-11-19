/**
 * The 1:1 loop's data side (W6): Today's calendar events become meetings with
 * attendees, the cadence nudges are worked out from them, and the meetings a
 * prep brief should run ahead of are found. Plan: docs/plans/people-layer.md
 * ("1:1 loop").
 *
 * Calendar attendance is one source among several (`calendar`, per-source
 * claims, see `people-queries.ts`): a calendar refresh never removes someone
 * the note or the user added, and never brings back someone the user removed.
 * Every write is skipped when nothing changed, so repeated Today runs (on this
 * device or another) don't churn synced rows.
 *
 * Governance: runs on the caller's db handle. Never constructs a Database.
 */

import type Database from "better-sqlite3";
import { foldName, type AttendeeRef } from "../../shared/people/parse";
import { nudgeDue, nudgeItemId, nudgeTitle, daysBetween } from "../../shared/people/oneonone";
import type { TodayEvent, TodayNudge } from "../../shared/today/brief";
import type { Meeting, Person } from "../../shared/types/people";
import { stubPersonId } from "../../shared/people/ids";
import { ensureStubPerson, loadCandidates, removedBySomeoneElse, resolveIn, stubName, toRefs, type Candidate } from "./people-capture";
import {
  addAttendee, attendeeIdsFromSource, listPeople, removeAttendeeSource, upsertMeetingByExternalId,
} from "./people-queries";

type Db = Database.Database;

/** A meeting with more invitees than this doesn't turn unknown invitees into stub people (a town hall would create a hundred). */
export const SMALL_MEETING_ATTENDEES = 6;

/** A prep brief starts this long before a calendar meeting. */
export const PREP_LEAD_MS = 2 * 3_600_000;

/** A nudge is held back when a 1:1 with the person is already booked within this many days. */
export const NUDGE_BOOKED_WITHIN_DAYS = 3;

const DAY_MS = 86_400_000;

/** "2026-11-18" + "10:35" as the local instant, in ISO form. Null for a malformed pair. */
export function localInstant(date: string, hhmm: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!d || !t || Number(t[1]) > 23 || Number(t[2]) > 59) return null;
  const at = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The calendar's external id for one occurrence: the event id plus its day, so a series reusing an id stays one row per day. */
export function eventExternalId(date: string, event: Pick<TodayEvent, "id">): string {
  return `${event.id}@${date}`;
}

export interface CalendarSyncResult {
  /** Meetings written or already in place. */
  meetings: number;
  /** Event ids skipped: no attendees, a bad time, or a meeting the user deleted. */
  skipped: number;
}

/**
 * Upsert one meeting per Today event that lists attendees, and link the people.
 * Matching is the shared resolver (Slack id → email → name, exact), so a name two
 * people share becomes two suggested attendees. Unknown invitees become stubs only
 * in small meetings.
 */
export function syncCalendarMeetings(db: Db, workspaceId: string, date: string, events: readonly TodayEvent[]): CalendarSyncResult {
  const result: CalendarSyncResult = { meetings: 0, skipped: 0 };
  let candidates: Candidate[] | null = null;
  for (const event of events) {
    const invitees = (event.attendees ?? []).filter((a) => !a.self);
    const startsAt = localInstant(date, event.start);
    if (invitees.length === 0 || !startsAt) { result.skipped++; continue; }
    const endsAt = event.end ? localInstant(date, event.end) ?? undefined : undefined;
    const meeting = db.transaction(() => {
      const m = upsertMeetingByExternalId(db, {
        workspaceId, title: event.title, startsAt, endsAt, externalId: eventExternalId(date, event),
        seriesKey: event.seriesId ? seriesKeyOf(event.seriesId) : undefined,
      });
      if (!m) return null;
      candidates ??= loadCandidates(db, workspaceId);
      linkInvitees(db, m, toRefs(invitees.map((a) => ({ ...(a.name ? { name: a.name } : {}), ...(a.email ? { email: a.email } : {}) }))), candidates);
      return m;
    })();
    if (meeting) result.meetings++; else result.skipped++;
  }
  return result;
}

/** A series id, folded, so "Weekly 1:1" and "weekly 1:1 " are one series. */
export function seriesKeyOf(seriesId: string): string {
  return `ser:${foldName(seriesId)}`;
}

function linkInvitees(db: Db, meeting: Meeting, refs: AttendeeRef[], candidates: Candidate[]): void {
  const keep = new Set<string>();
  const small = refs.length <= SMALL_MEETING_ATTENDEES;
  const add = (personId: string, status: "confirmed" | "suggested", provenance: "explicit" | "inferred") => {
    keep.add(personId);
    // Someone the user (or another device) took off the meeting stays off while the calendar still lists them.
    if (removedBySomeoneElse(db, meeting.id, personId, "calendar")) return;
    addAttendee(db, { meetingId: meeting.id, personId, status, source: "calendar", provenance });
  };
  for (const ref of refs) {
    const r = resolveIn(candidates, ref);
    if (r.kind === "dismissed") continue;
    if (r.kind === "match") add(r.personId, "confirmed", "explicit");
    else if (r.kind === "ambiguous") for (const id of r.personIds) add(id, "suggested", "inferred");
    else {
      const name = stubName(ref);
      if (!name || !small) continue;
      const id = stubPersonId(meeting.workspaceId, ref.email ?? foldName(name));
      if (removedBySomeoneElse(db, meeting.id, id, "calendar")) { keep.add(id); continue; }
      const person = ensureStubPerson(db, meeting.workspaceId, name, ref.email, "explicit");
      candidates.push({ id: person.id, status: "suggested", slackId: null, emails: person.emails, keys: new Set([foldName(name)]) });
      add(person.id, "suggested", "explicit");
    }
  }
  for (const personId of attendeeIdsFromSource(db, meeting.id, "calendar")) {
    if (!keep.has(personId)) removeAttendeeSource(db, meeting.id, personId, "calendar");
  }
}

// ── 1:1s and cadence ──────────────────────────

interface MeetingRow { id: string; title: string; starts_at: string; ends_at: string | null; series_key: string | null; people: string }

/**
 * Meetings with their confirmed attendees (ids of everyone except the user),
 * for one workspace. Attendee ids are joined into one string to keep it one query.
 */
function meetingsWithAttendees(db: Db, workspaceId: string, window?: { fromMs: number; toMs: number }): Array<{ meeting: MeetingRow; others: string[] }> {
  // Starts are stored as given (offsets, fractions), so the SQL bounds are loose (a day either side) and callers compare instants.
  const lo = window ? new Date(window.fromMs - DAY_MS).toISOString() : "";
  const hi = window ? new Date(window.toMs + DAY_MS).toISOString() : "\uffff";
  const rows = db.prepare(`
    SELECT m.id, m.title, m.starts_at, m.ends_at, m.series_key,
      COALESCE((
        SELECT group_concat(a.person_id, ',') FROM meeting_attendees a
        JOIN people p ON p.id = a.person_id AND p.deleted_at IS NULL AND p.is_me = 0 AND p.archived_at IS NULL
        WHERE a.meeting_id = m.id AND a.deleted_at IS NULL AND a.status = 'confirmed'
      ), '') AS people
    FROM meetings m WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND m.starts_at >= ? AND m.starts_at <= ?
  `).all(workspaceId, lo, hi) as MeetingRow[];
  return rows.map((meeting) => ({ meeting, others: meeting.people ? meeting.people.split(",") : [] }));
}

export interface OneOnOneDates {
  /** Start of their latest past 1:1 (they are the only other confirmed attendee). */
  last?: string;
  /** Start of their next 1:1 that hasn't begun. */
  next?: string;
}

/** Last and next 1:1 per person, by instant (starts are stored as given, offsets and all). */
export function oneOnOneDates(db: Db, workspaceId: string, nowMs: number): Map<string, OneOnOneDates> {
  const best = new Map<string, { last?: { ms: number; at: string }; next?: { ms: number; at: string } }>();
  for (const { meeting, others } of meetingsWithAttendees(db, workspaceId)) {
    if (others.length !== 1) continue;
    const ms = Date.parse(meeting.starts_at);
    if (Number.isNaN(ms)) continue;
    const cur = best.get(others[0]) ?? {};
    if (ms <= nowMs) { if (!cur.last || ms > cur.last.ms) cur.last = { ms, at: meeting.starts_at }; }
    else if (!cur.next || ms < cur.next.ms) cur.next = { ms, at: meeting.starts_at };
    best.set(others[0], cur);
  }
  return new Map([...best].map(([id, v]) => [id, { ...(v.last ? { last: v.last.at } : {}), ...(v.next ? { next: v.next.at } : {}) }]));
}

/** People a nudge applies to: confirmed, live, not archived, not the user, with a cadence. */
function cadencePeople(db: Db, workspaceId: string): Person[] {
  return listPeople(db, workspaceId).filter((p) => !p.isMe && !!p.cadence && !p.archivedAt);
}

/**
 * "No 1:1 with X in 3 weeks": one per person whose last 1:1 is further back than
 * their cadence allows, and who has no 1:1 booked in the next few days. People
 * with no 1:1 on record yet get none (nothing says when they last met).
 */
export function getCadenceNudges(db: Db, workspaceId: string, now: Date = new Date()): TodayNudge[] {
  const people = cadencePeople(db, workspaceId);
  if (people.length === 0) return [];
  const nowMs = now.getTime();
  const dates = oneOnOneDates(db, workspaceId, nowMs);
  const out: TodayNudge[] = [];
  for (const p of people) {
    const d = dates.get(p.id);
    if (!d?.last) continue;
    const lastMs = Date.parse(d.last);
    if (!nudgeDue(p.cadence, lastMs, nowMs)) continue;
    if (d.next && Date.parse(d.next) - nowMs <= NUDGE_BOOKED_WITHIN_DAYS * DAY_MS) continue;
    const days = daysBetween(lastMs, nowMs);
    out.push({ id: nudgeItemId(p.id), personId: p.id, name: p.name, title: nudgeTitle(p.name, days), days });
  }
  return out.sort((a, b) => b.days - a.days);
}

export interface PrepTarget {
  personId: string;
  meetingId: string;
  meetingTitle: string;
  meetingStartsAt: string;
}

/**
 * Who to prepare for ahead of a calendar meeting: for each person with a
 * cadence on the invite of a calendar meeting starting within `leadMs`, the
 * soonest such meeting. The caller skips people who already have today's brief.
 */
export function duePrepTargets(db: Db, workspaceId: string, nowMs: number, leadMs = PREP_LEAD_MS): PrepTarget[] {
  const withCadence = new Set(cadencePeople(db, workspaceId).map((p) => p.id));
  if (withCadence.size === 0) return [];
  const best = new Map<string, { ms: number; target: PrepTarget }>();
  for (const { meeting, others } of meetingsWithAttendees(db, workspaceId, { fromMs: nowMs, toMs: nowMs + leadMs })) {
    const ms = Date.parse(meeting.starts_at);
    if (Number.isNaN(ms) || ms < nowMs || ms - nowMs > leadMs) continue;
    if (!isCalendarMeeting(db, meeting.id)) continue;
    for (const personId of others) {
      if (!withCadence.has(personId)) continue;
      const cur = best.get(personId);
      if (!cur || ms < cur.ms) best.set(personId, { ms, target: { personId, meetingId: meeting.id, meetingTitle: meeting.title, meetingStartsAt: meeting.starts_at } });
    }
  }
  return [...best.values()].sort((a, b) => a.ms - b.ms).map((v) => v.target);
}

function isCalendarMeeting(db: Db, meetingId: string): boolean {
  const row = db.prepare("SELECT source FROM meetings WHERE id = ?").get(meetingId) as { source: string } | undefined;
  return row?.source === "calendar";
}
