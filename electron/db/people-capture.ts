/**
 * People layer capture: resolve names/emails to people, and turn "this note is
 * a meeting with these attendees" into meeting + attendee rows. Every capture
 * path (frontmatter, agent tools, calendar, the attendee strip) goes through
 * here, so matching works the same everywhere. Plan: docs/plans/people-layer.md
 * ("Capture", decision 12).
 *
 * Matching is exact, never fuzzy: Slack id → email → name, alias or persona
 * note title (compared case- and accent-insensitively). Two candidates →
 * both become suggested attendees for the user to settle. No match → a
 * suggested stub person. A person the user dismissed is never re-created.
 *
 * Governance: runs on the caller's db handle (desktop and the MCP runtime).
 */

import type Database from "better-sqlite3";
import { foldName, formatMeetingDate, parseAttendeeList, splitAttendeeValues, type AttendeeRef } from "../../shared/people/parse";
import type { AttendeeSource, PeopleStatus, Provenance } from "../../shared/types/people";
import {
  addAttendee, createMeeting, createPerson, getMeeting, getPerson, attendeeIdsFromSource, removeAttendeeSource, setNoteMeeting, updateMeeting,
} from "./people-queries";
import { noteMeetingId, stubPersonId } from "../../shared/people/ids";

type Db = Database.Database;

export interface PersonLookup {
  slackId?: string;
  email?: string;
  name?: string;
}

export type Resolution =
  | { kind: "match"; personId: string }
  | { kind: "ambiguous"; personIds: string[] }
  | { kind: "dismissed"; personId: string }
  | { kind: "none" };

interface Candidate {
  id: string;
  status: PeopleStatus;
  slackId: string | null;
  emails: string[];
  keys: Set<string>;
}

/** The workspace's people as match candidates (live rows, any status, archived included: former colleagues still match). Load once per capture. */
export function loadCandidates(db: Db, workspaceId: string): Candidate[] {
  const rows = db.prepare(`
    SELECT p.id, p.status, p.slack_id, p.emails, p.name, p.aliases, n.title AS persona_title
    FROM people p
    LEFT JOIN notes n ON n.id = p.persona_note_id AND n.deleted_at IS NULL
    WHERE p.workspace_id = ? AND p.deleted_at IS NULL
  `).all(workspaceId) as Array<{
    id: string; status: PeopleStatus; slack_id: string | null; emails: string; name: string; aliases: string; persona_title: string | null;
  }>;
  return rows.map((r) => {
    const keys = new Set<string>([foldName(r.name)]);
    for (const a of safeArray(r.aliases)) keys.add(foldName(a));
    if (r.persona_title) keys.add(foldName(r.persona_title));
    return { id: r.id, status: r.status, slackId: r.slack_id, emails: safeArray(r.emails).map((e) => e.toLowerCase()), keys };
  });
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Resolve one reference against preloaded candidates. */
export function resolveIn(candidates: Candidate[], ref: PersonLookup): Resolution {
  const pick = (hits: Candidate[]): Resolution | null => {
    if (hits.length === 0) return null;
    const live = hits.filter((h) => h.status !== "dismissed");
    if (live.length === 0) return { kind: "dismissed", personId: hits[0].id };
    return live.length === 1 ? { kind: "match", personId: live[0].id } : { kind: "ambiguous", personIds: live.map((h) => h.id) };
  };
  const slack = ref.slackId?.trim();
  if (slack) {
    const r = pick(candidates.filter((c) => c.slackId === slack));
    if (r) return r;
  }
  const email = ref.email?.trim().toLowerCase();
  if (email) {
    const r = pick(candidates.filter((c) => c.emails.includes(email)));
    if (r) return r;
  }
  const name = ref.name ? foldName(ref.name) : "";
  if (name) {
    const r = pick(candidates.filter((c) => c.keys.has(name)));
    if (r) return r;
  }
  return { kind: "none" };
}

/** Resolve one reference in a workspace (loads candidates; use resolveIn for batches). */
export function resolvePerson(db: Db, workspaceId: string, ref: PersonLookup): Resolution {
  return resolveIn(loadCandidates(db, workspaceId), ref);
}

/** A label for a stub person: the name, or the part of the email before the @. */
function stubName(ref: AttendeeRef): string | null {
  if (ref.name?.trim()) return ref.name.trim();
  if (ref.email) return ref.email.split("@")[0];
  return null;
}

/**
 * The suggested stub for an unmatched name or email, with a deterministic id
 * (`stubPersonId`). A stub that was deleted (not dismissed) is revived.
 */
function ensureStubPerson(db: Db, workspaceId: string, name: string, email: string | undefined, provenance: Provenance) {
  const id = stubPersonId(workspaceId, email ?? foldName(name));
  const row = db.prepare("SELECT deleted_at FROM people WHERE id = ?").get(id) as { deleted_at: string | null } | undefined;
  if (!row) {
    return createPerson(db, { id, workspaceId, name, emails: email ? [email] : [], status: "suggested", provenance });
  }
  if (row.deleted_at) {
    const now = new Date().toISOString();
    db.prepare("UPDATE people SET deleted_at = NULL, status = 'suggested', archived_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
  }
  return getPerson(db, id)!;
}

/** The note's own meeting (`noteMeetingId`), created or revived. */
function ensureNoteMeeting(db: Db, note: { id: string; workspace_id: string; title: string }, startsAt: string) {
  const id = noteMeetingId(note.workspace_id, note.id);
  const row = db.prepare("SELECT deleted_at FROM meetings WHERE id = ?").get(id) as { deleted_at: string | null } | undefined;
  if (!row) return createMeeting(db, { id, workspaceId: note.workspace_id, title: note.title, startsAt, source: "note" });
  if (row.deleted_at) {
    db.prepare("UPDATE meetings SET deleted_at = NULL, title = ?, starts_at = ?, updated_at = ? WHERE id = ?")
      .run(note.title, startsAt, new Date().toISOString(), id);
  }
  return getMeeting(db, id)!;
}

export interface CaptureInput {
  noteId: string;
  /** Raw values (strings as written) or parsed refs. */
  attendees: unknown[] | AttendeeRef[];
  /** People already identified by id (an agent passing person ids); added as confirmed and kept. */
  personIds?: string[];
  /** ISO date/time of the meeting; null/undefined keeps the current one. */
  date?: string | null;
  /** Which path is writing. Attendees previously added by this path and not listed now are removed. */
  source: AttendeeSource;
  provenance: Provenance;
}

export interface CaptureResult {
  meetingId: string;
  /** Person ids now attending through this source. */
  attendees: string[];
  /** Person ids added as suggestions (ambiguous names). */
  suggested: string[];
  /** Stub people created for names nobody matched. */
  created: string[];
  /** Person ids removed because this source no longer lists them. */
  removed: string[];
}

function toRefs(list: unknown[] | AttendeeRef[]): AttendeeRef[] {
  const raw = list.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? refToString(x as AttendeeRef) : x));
  return parseAttendeeList(raw);
}

function refToString(ref: AttendeeRef): string {
  if (ref.name && ref.email) return `${ref.name} <${ref.email}>`;
  return ref.email ?? ref.name ?? "";
}

/**
 * Make a note a meeting with these attendees, as stated by one source. Creates
 * the meeting (titled after the note) when the note has none, sets its date
 * when given, adds the resolved people, and removes people this same source
 * had added before but no longer lists. Attendees from other sources (the
 * calendar, the attendee strip) are left alone. Idempotent: running it again
 * with the same input changes nothing.
 */
export function captureNoteMeeting(db: Db, input: CaptureInput): CaptureResult {
  const note = db.prepare("SELECT id, workspace_id, title, created_at, meeting_id FROM notes WHERE id = ? AND deleted_at IS NULL")
    .get(input.noteId) as { id: string; workspace_id: string; title: string; created_at: string; meeting_id: string | null } | undefined;
  if (!note) throw new Error(`Note not found: ${input.noteId}`);
  const refs = toRefs(input.attendees);

  return db.transaction((): CaptureResult => {
    let meeting = note.meeting_id ? getMeeting(db, note.meeting_id) : null;
    if (!meeting) {
      meeting = ensureNoteMeeting(db, note, input.date ?? note.created_at);
      setNoteMeeting(db, note.id, meeting.id);
    } else if (input.date && Date.parse(input.date) !== Date.parse(meeting.startsAt)) {
      meeting = updateMeeting(db, meeting.id, { startsAt: input.date });
    }

    const candidates = loadCandidates(db, note.workspace_id);
    const result: CaptureResult = { meetingId: meeting.id, attendees: [], suggested: [], created: [], removed: [] };
    const keep = new Set<string>();

    for (const pid of input.personIds ?? []) {
      if (keep.has(pid) || !candidates.some((c) => c.id === pid)) continue;
      addAttendee(db, { meetingId: meeting.id, personId: pid, source: input.source, provenance: input.provenance });
      keep.add(pid);
      result.attendees.push(pid);
    }

    for (const ref of refs) {
      const r = resolveIn(candidates, ref);
      if (r.kind === "dismissed") continue;
      if (r.kind === "match") {
        if (keep.has(r.personId)) continue;
        addAttendee(db, { meetingId: meeting.id, personId: r.personId, source: input.source, provenance: input.provenance });
        keep.add(r.personId);
        result.attendees.push(r.personId);
      } else if (r.kind === "ambiguous") {
        for (const pid of r.personIds) {
          addAttendee(db, { meetingId: meeting.id, personId: pid, status: "suggested", source: input.source, provenance: "inferred" });
          keep.add(pid);
          result.suggested.push(pid);
        }
      } else {
        const name = stubName(ref);
        if (!name) continue;
        const person = ensureStubPerson(db, note.workspace_id, name, ref.email, input.provenance);
        // The new stub is a candidate for the rest of this list ("Chris, chris@…").
        candidates.push({ id: person.id, status: "suggested", slackId: null, emails: person.emails, keys: new Set([foldName(name)]) });
        addAttendee(db, { meetingId: meeting.id, personId: person.id, source: input.source, provenance: input.provenance });
        keep.add(person.id);
        result.created.push(person.id);
        result.attendees.push(person.id);
      }
    }

    for (const person_id of attendeeIdsFromSource(db, meeting.id, input.source)) {
      if (keep.has(person_id)) continue;
      if (removeAttendeeSource(db, meeting.id, person_id, input.source)) result.removed.push(person_id);
    }
    return result;
  })();
}

/** What a meeting note's frontmatter should say: attendee wikilinks/names and the date. */
export interface MeetingFrontmatter {
  attendees: string[];
  date: string;
  meetingId: string;
  /**
   * Confirmed attendees no written reference can identify (no persona title or
   * email, and their name is shared). They are written by name, which reads
   * back as a suggestion; the caller should pin them (`pinUnreferenced`) so
   * the file no longer owns their attendance.
   */
  unreferenced: string[];
}

/**
 * Render the `attendees`/`date` frontmatter for a note's meeting, or null when
 * the note isn't a meeting. Confirmed attendees are written as `[[persona note
 * title]]` when they have a persona note, else their plain name. Values already
 * in the file that don't resolve to exactly one live person (an ambiguous name,
 * someone unknown) are kept as written, so a write-back never drops what the
 * user typed.
 */
export function renderMeetingFrontmatter(db: Db, noteId: string, existing?: unknown): MeetingFrontmatter | null {
  const row = db.prepare(`
    SELECT n.workspace_id, m.id AS meeting_id, m.starts_at FROM notes n
    JOIN meetings m ON m.id = n.meeting_id AND m.deleted_at IS NULL
    WHERE n.id = ? AND n.deleted_at IS NULL
  `).get(noteId) as { workspace_id: string; meeting_id: string; starts_at: string } | undefined;
  if (!row) return null;

  const people = db.prepare(`
    SELECT p.id, p.name, p.emails, n.title AS persona_title FROM meeting_attendees a
    JOIN people p ON p.id = a.person_id AND p.deleted_at IS NULL
    LEFT JOIN notes n ON n.id = p.persona_note_id AND n.deleted_at IS NULL
    WHERE a.meeting_id = ? AND a.deleted_at IS NULL AND a.status = 'confirmed'
    ORDER BY a.created_at, p.name
  `).all(row.meeting_id) as { id: string; name: string; emails: string; persona_title: string | null }[];

  const candidates = loadCandidates(db, row.workspace_id);
  const unreferenced: string[] = [];
  const attendees = people.map((p) => {
    const ref = attendeeReference(candidates, p);
    if (!ref) unreferenced.push(p.id);
    return ref ?? p.name;
  });
  const attending = new Set(people.map((p) => p.id));
  const noteTitleExists = db.prepare("SELECT 1 FROM notes WHERE workspace_id = ? AND deleted_at IS NULL AND lower(title) = lower(?) LIMIT 1");

  // A YAML list, or one string ("Chris" / "Ana, Ben") the way capture reads it.
  const existingValues = Array.isArray(existing) ? existing : typeof existing === "string" ? splitAttendeeValues(existing) : [];
  if (existingValues.length > 0) {
    const seen = new Set(attendees.map((a) => a.toLowerCase()));
    for (const raw of existingValues) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const [ref] = parseAttendeeList([raw]);
      const r = ref ? resolveIn(candidates, ref) : { kind: "none" as const };
      // Someone who resolves to one person is written from the DB (or was removed there); keep the rest verbatim.
      if (r.kind === "match" || r.kind === "dismissed") continue;
      if (r.kind === "ambiguous" && r.personIds.some((id) => attending.has(id))) continue;
      // A wikilink to a note that no longer exists is stale (a renamed persona note's old title), not something to keep.
      if (r.kind === "none" && ref?.name && /^\s*\[\[/.test(raw) && !noteTitleExists.get(row.workspace_id, ref.name)) continue;
      if (seen.has(raw.toLowerCase())) continue;
      seen.add(raw.toLowerCase());
      attendees.push(raw);
    }
  }
  return { attendees, date: formatMeetingDate(row.starts_at), meetingId: row.meeting_id, unreferenced };
}

/**
 * Make the given attendees "manual" so a file that can't name them faithfully
 * (see `MeetingFrontmatter.unreferenced`) never removes them on the next read.
 */
export function pinUnreferenced(db: Db, fm: Pick<MeetingFrontmatter, "meetingId" | "unreferenced">): void {
  for (const personId of fm.unreferenced) {
    addAttendee(db, { meetingId: fm.meetingId, personId, source: "manual", provenance: "explicit" });
  }
}

/**
 * How to write one attendee so that reading the file back finds the same
 * person: `[[persona note title]]` when that round-trips (a title with `#` or
 * `|` doesn't), else the name, else an email. A name two people share falls
 * back to the email. With none, there is no faithful reference (null) and
 * the caller pins the attendee instead.
 */
function attendeeReference(candidates: Candidate[], p: { id: string; name: string; emails: string; persona_title: string | null }): string | null {
  const options = [
    ...(p.persona_title ? [`[[${p.persona_title}]]`] : []),
    p.name,
    ...safeArray(p.emails),
  ];
  for (const value of options) {
    const [ref] = parseAttendeeList([value]);
    const r = ref ? resolveIn(candidates, ref) : null;
    if (r?.kind === "match" && r.personId === p.id) return value;
  }
  return null;
}

/** Note ids whose meeting frontmatter may be stale after changes to these rows. */
export function notesAffectedBy(db: Db, changed: { meetingIds?: string[]; personIds?: string[]; noteIds?: string[] }): string[] {
  const ids = new Set<string>(changed.noteIds ?? []);
  const meetingIds = new Set<string>(changed.meetingIds ?? []);
  const personIds = new Set<string>(changed.personIds ?? []);
  // A persona note's title is how its person is written in other notes' attendees.
  for (const nid of changed.noteIds ?? []) {
    for (const r of db.prepare("SELECT id FROM people WHERE persona_note_id = ? AND deleted_at IS NULL").all(nid) as { id: string }[]) {
      personIds.add(r.id);
    }
  }
  for (const pid of personIds) {
    for (const r of db.prepare("SELECT DISTINCT meeting_id FROM meeting_attendees WHERE person_id = ?").all(pid) as { meeting_id: string }[]) {
      meetingIds.add(r.meeting_id);
    }
  }
  for (const mid of meetingIds) {
    for (const r of db.prepare("SELECT id FROM notes WHERE meeting_id = ? AND deleted_at IS NULL").all(mid) as { id: string }[]) {
      ids.add(r.id);
    }
  }
  return [...ids];
}
