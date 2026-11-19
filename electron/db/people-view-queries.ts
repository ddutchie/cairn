/**
 * Cairn — read models for the People view (W5): the list with last/next
 * meeting dates, and the person page (relations with names, timeline,
 * persona note). Built on `people-queries.ts`; writes stay there.
 * Plan: docs/plans/people-layer.md ("Surfaces").
 *
 * Governance: NEVER construct a Database here — these run on the
 * already-constructed handle passed in by the caller.
 */

import type Database from "better-sqlite3";
import { getPerson, getRelations, listPeople, listPersonMeetings, toEdge, type ListPeopleOptions } from "./people-queries";
import { NETWORK_MAX_MEETING_SIZE } from "../../shared/types/people-view";
import type {
  PeopleNetwork, PersonPage, PersonRelationView, PersonSummary, PersonTimelineItem, PersonaNote, TimelineNoteRef,
} from "../../shared/types/people-view";

type Db = Database.Database;

interface MeetingDates { lastMetAt?: string; nextMeetingAt?: string }

/** Last and next confirmed meeting per person in a workspace, relative to `now`. */
function meetingDates(db: Db, workspaceId: string, now: string): Map<string, MeetingDates> {
  // Compared by instant in JS: `startsAt` is stored as given, so it may carry
  // an offset or fractional seconds that text ordering gets wrong.
  const rows = db.prepare(`
    SELECT a.person_id AS personId, m.starts_at AS startsAt
    FROM meeting_attendees a
    JOIN meetings m ON m.id = a.meeting_id AND m.deleted_at IS NULL
    WHERE m.workspace_id = ? AND a.deleted_at IS NULL AND a.status = 'confirmed'
  `).all(workspaceId) as { personId: string; startsAt: string }[];
  const nowMs = Date.parse(now);
  const best = new Map<string, { last?: { ms: number; at: string }; next?: { ms: number; at: string } }>();
  for (const r of rows) {
    const ms = Date.parse(r.startsAt);
    if (Number.isNaN(ms)) continue;
    const cur = best.get(r.personId) ?? {};
    if (ms <= nowMs) { if (!cur.last || ms > cur.last.ms) cur.last = { ms, at: r.startsAt }; }
    else if (!cur.next || ms < cur.next.ms) cur.next = { ms, at: r.startsAt };
    best.set(r.personId, cur);
  }
  return new Map([...best].map(([id, v]) => [id, {
    ...(v.last ? { lastMetAt: v.last.at } : {}),
    ...(v.next ? { nextMeetingAt: v.next.at } : {}),
  }]));
}

/** `listPeople` plus each person's last and next meeting. */
export function listPersonSummaries(
  db: Db, workspaceId: string, opts: ListPeopleOptions = {}, now = new Date().toISOString(),
): PersonSummary[] {
  const dates = meetingDates(db, workspaceId, now);
  return listPeople(db, workspaceId, opts).map((p) => ({ ...p, ...dates.get(p.id) }));
}

/** Relations of a person with the other person's name. */
export function listRelationViews(db: Db, personId: string): PersonRelationView[] {
  const out: PersonRelationView[] = [];
  for (const r of getRelations(db, personId)) {
    const other = getPerson(db, r.otherId);
    if (other) out.push({ ...r, otherName: other.name });
  }
  return out;
}

const NOTE_REF_COLS = "n.id AS id, n.project_id AS projectId, n.title AS title, n.updated_at AS updatedAt";

/**
 * A person's timeline, newest first: meetings they attended (with linked notes
 * and the other attendees), notes that mention them (their persona note
 * excluded), and cards they own.
 */
export function getPersonTimeline(db: Db, personId: string, limit = 100): PersonTimelineItem[] {
  const person = getPerson(db, personId);
  if (!person) return [];
  const items: PersonTimelineItem[] = [];

  const meetingNotes = db.prepare(
    `SELECT ${NOTE_REF_COLS} FROM notes n WHERE n.meeting_id = ? AND n.deleted_at IS NULL ORDER BY n.created_at`,
  );
  const others = db.prepare(`
    SELECT p.id AS personId, p.name AS name FROM meeting_attendees a
    JOIN people p ON p.id = a.person_id AND p.deleted_at IS NULL
    WHERE a.meeting_id = ? AND a.person_id != ? AND a.deleted_at IS NULL AND a.status = 'confirmed'
    ORDER BY p.name COLLATE NOCASE
  `);
  for (const meeting of listPersonMeetings(db, personId, limit)) {
    items.push({
      kind: "meeting",
      at: meeting.startsAt,
      meeting,
      notes: meetingNotes.all(meeting.id) as TimelineNoteRef[],
      with: others.all(meeting.id, personId) as { personId: string; name: string }[],
    });
  }

  const mentions = db.prepare(`
    SELECT DISTINCT ${NOTE_REF_COLS} FROM note_mentions m
    JOIN notes n ON n.id = m.note_id AND n.deleted_at IS NULL
    WHERE m.person_id = ? AND m.deleted_at IS NULL AND n.id IS NOT ?
    ORDER BY n.updated_at DESC LIMIT ?
  `).all(personId, person.personaNoteId ?? null, limit) as TimelineNoteRef[];
  for (const note of mentions) items.push({ kind: "mention", at: note.updatedAt, note });

  const cards = db.prepare(`
    SELECT c.id AS id, c.project_id AS projectId, c.title AS title, c.updated_at AS updatedAt,
      COALESCE(col.name, '') AS columnName, CASE WHEN col.type = 'done' THEN 1 ELSE 0 END AS done
    FROM task_cards c LEFT JOIN board_columns col ON col.id = c.column_id
    WHERE c.owner_person_id = ? AND c.deleted_at IS NULL AND c.archived_at IS NULL
    ORDER BY c.updated_at DESC LIMIT ?
  `).all(personId, limit) as { id: string; projectId: string; title: string; updatedAt: string; columnName: string; done: number }[];
  for (const c of cards) items.push({ kind: "card", at: c.updatedAt, card: { ...c, done: c.done === 1 } });

  const ms = (at: string) => { const t = Date.parse(at); return Number.isNaN(t) ? 0 : t; };
  return items.sort((a, b) => ms(b.at) - ms(a.at));
}

function getPersonaNote(db: Db, noteId: string | undefined): PersonaNote | null {
  if (!noteId) return null;
  const row = db.prepare(
    "SELECT id, project_id AS projectId, title, content FROM notes WHERE id = ? AND deleted_at IS NULL",
  ).get(noteId) as PersonaNote | undefined;
  return row ? { ...row, content: row.content ?? "" } : null;
}

/** Everything the person page shows, or null for a missing/deleted person. */
export function getPersonPage(db: Db, personId: string, now = new Date().toISOString()): PersonPage | null {
  const person = getPerson(db, personId);
  if (!person) return null;
  const dates = meetingDates(db, person.workspaceId, now).get(personId) ?? {};
  return {
    person,
    relations: listRelationViews(db, personId),
    timeline: getPersonTimeline(db, personId),
    persona: getPersonaNote(db, person.personaNoteId),
    ...dates,
  };
}

/**
 * Edges and co-attendance for the Insights canvases. Only live, confirmed
 * people at both ends; archived people stay out, like the list.
 */
export function getPeopleNetwork(db: Db, workspaceId: string): PeopleNetwork {
  const edgeRows = db.prepare(`
    SELECT e.* FROM person_edges e
    JOIN people s ON s.id = e.source_id AND s.deleted_at IS NULL AND s.status = 'confirmed' AND s.archived_at IS NULL
    JOIN people t ON t.id = e.target_id AND t.deleted_at IS NULL AND t.status = 'confirmed' AND t.archived_at IS NULL
    WHERE e.workspace_id = ? AND e.deleted_at IS NULL AND e.status = 'confirmed'
    ORDER BY e.created_at, e.id
  `).all(workspaceId) as Record<string, unknown>[];

  const rows = db.prepare(`
    SELECT a.meeting_id AS meetingId, a.person_id AS personId,
      CASE WHEN p.status = 'confirmed' AND p.archived_at IS NULL THEN 1 ELSE 0 END AS shown
    FROM meeting_attendees a
    JOIN meetings m ON m.id = a.meeting_id AND m.deleted_at IS NULL
    JOIN people p ON p.id = a.person_id AND p.deleted_at IS NULL
    WHERE m.workspace_id = ? AND a.deleted_at IS NULL AND a.status = 'confirmed'
  `).all(workspaceId) as { meetingId: string; personId: string; shown: number }[];
  // The size limit counts everyone confirmed at the meeting (archived people too);
  // only shown people become pair members.
  const byMeeting = new Map<string, { size: number; ids: string[] }>();
  for (const r of rows) {
    const m = byMeeting.get(r.meetingId) ?? { size: 0, ids: [] };
    m.size++;
    if (r.shown) m.ids.push(r.personId);
    byMeeting.set(r.meetingId, m);
  }
  const pairs = new Map<string, { a: string; b: string; meetings: number }>();
  for (const { size, ids } of byMeeting.values()) {
    if (ids.length < 2 || size > NETWORK_MAX_MEETING_SIZE) continue;
    const sorted = [...new Set(ids)].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = JSON.stringify([sorted[i], sorted[j]]);
        const cur = pairs.get(key);
        if (cur) cur.meetings++; else pairs.set(key, { a: sorted[i], b: sorted[j], meetings: 1 });
      }
    }
  }
  return { edges: edgeRows.map(toEdge), coAttendance: [...pairs.values()] };
}
