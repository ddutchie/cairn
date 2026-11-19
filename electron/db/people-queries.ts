/**
 * Cairn — People layer queries (people, person edges, meetings, attendees,
 * note mentions, card owners, the `people` feature flag).
 * Plan: docs/plans/people-layer.md.
 *
 * Every table here syncs, so deletes are tombstones (`deleted_at`), as for
 * notes: a delete arriving via sync keeps its row, and live reads filter
 * `deleted_at IS NULL`. The tables have no foreign keys (see
 * shared/sync/people-schema.ts), so deleting a person or meeting tombstones
 * the rows that point at it here.
 *
 * Governance: NEVER construct a Database here — these run on the
 * already-constructed handle passed in by the caller.
 */

import type Database from "better-sqlite3";
import { newId, ts } from "./utils";
import {
  CADENCES, PEOPLE_STATUSES, PERSON_EDGE_TYPES, PROVENANCES, RELATIONSHIP_TYPES,
  type AttendeeSource, type Cadence, type Meeting, type MeetingAttendee, type MeetingSource,
  type MentionSource, type NoteMention, type PeopleStatus, type Person, type PersonCreateInput,
  type PersonEdge, type PersonEdgeRole, type PersonEdgeType, type PersonPatch, type PersonRelation,
  type Provenance, type Relationship, type RelationshipType,
} from "../../shared/types/people";
import { attendeeRowId, calendarMeetingId, edgeRowId, mentionRowId } from "../../shared/people/ids";

type Db = Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// ── Feature flag ──────────────────────────────

/** `app_kv` key for the People layer flag (off until launch). */
export const PEOPLE_FLAG_KEY = "feature.people";

/** True when the People layer is switched on for this workspace DB. */
export function isPeopleEnabled(db: Db): boolean {
  try {
    const row = db.prepare("SELECT value FROM app_kv WHERE key = ?").get(PEOPLE_FLAG_KEY) as { value: string } | undefined;
    return row?.value === "1";
  } catch {
    return false; // app_kv missing on an odd connection: treat as off
  }
}

export function setPeopleEnabled(db: Db, on: boolean): void {
  if (!on) {
    db.prepare("DELETE FROM app_kv WHERE key = ?").run(PEOPLE_FLAG_KEY);
    return;
  }
  db.prepare(
    `INSERT INTO app_kv (key, value, updated_at) VALUES (?, '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(PEOPLE_FLAG_KEY, ts());
}

// ── Validation helpers ────────────────────────

function oneOf<T extends string>(allowed: readonly T[], value: unknown, what: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid ${what}: ${String(value)} (expected one of ${allowed.join(", ")})`);
}

function cleanStrings(list: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list ?? []) {
    const s = String(raw).trim();
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Validate and de-duplicate a relationship set (one entry per type + label). */
export function normaliseRelationships(list: readonly Relationship[] | undefined): Relationship[] {
  const out: Relationship[] = [];
  const seen = new Set<string>();
  for (const r of list ?? []) {
    const type = oneOf(RELATIONSHIP_TYPES, r?.type, "relationship type");
    const label = typeof r.label === "string" && r.label.trim() ? r.label.trim() : undefined;
    const key = `${type}|${(label ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, ...(label ? { label } : {}), provenance: oneOf(PROVENANCES, r.provenance ?? "explicit", "provenance") });
  }
  return out;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const opt = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

// ── Row mappers ───────────────────────────────

function toPerson(r: Row): Person {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    aliases: parseJson<string[]>(r.aliases, []),
    emails: parseJson<string[]>(r.emails, []),
    slackId: opt(r.slack_id),
    relationship: parseJson<Relationship[]>(r.relationship, []),
    cadence: opt(r.cadence) as Cadence | undefined,
    personaNoteId: opt(r.persona_note_id),
    status: r.status as PeopleStatus,
    provenance: r.provenance as Provenance,
    stage: opt(r.stage),
    // Two devices can each mark a different person as "me" before they sync; only the canonical one counts.
    isMe: r.is_me === 1 && (r.canonical_me === undefined || r.canonical_me === r.id),
    agentPrivate: r.agent_private === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: opt(r.archived_at),
  };
}

function toEdge(r: Row): PersonEdge {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    sourceId: r.source_id,
    targetId: r.target_id,
    type: r.type as PersonEdgeType,
    label: opt(r.label),
    endedAt: opt(r.ended_at),
    status: r.status as PeopleStatus,
    provenance: r.provenance as Provenance,
    sourceNoteId: opt(r.source_note_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toMeeting(r: Row): Meeting {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    startsAt: r.starts_at,
    endsAt: opt(r.ends_at),
    source: r.source as MeetingSource,
    externalId: opt(r.external_id),
    seriesKey: opt(r.series_key),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toAttendee(r: Row): MeetingAttendee {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    personId: r.person_id,
    status: r.status as PeopleStatus,
    source: r.source as AttendeeSource,
    sources: sourcesOf(r),
    provenance: r.provenance as Provenance,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Every source listing this attendee; rows from before `sources` existed fall back to `source`. */
function sourcesOf(r: Row): AttendeeSource[] {
  let list: unknown = [];
  try { list = JSON.parse(r.sources ?? "[]"); } catch { /* treat as empty */ }
  const out = Array.isArray(list) ? list.filter((x): x is AttendeeSource => typeof x === "string" && x in SOURCE_RANK) : [];
  return out.length ? out : [r.source as AttendeeSource];
}

function toMention(r: Row): NoteMention {
  return {
    id: r.id,
    noteId: r.note_id,
    personId: r.person_id,
    source: r.source as MentionSource,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── People ────────────────────────────────────

/**
 * Person columns plus the workspace's canonical "me": the oldest live `is_me`
 * row (then lowest id). `is_me` is only kept unique per device (clearOtherMe),
 * so after a sync two rows can carry it; readers treat only this one as me.
 */
const PERSON_COLS = `*, (SELECT m.id FROM people m WHERE m.workspace_id = people.workspace_id AND m.is_me = 1
  AND m.deleted_at IS NULL ORDER BY m.created_at, m.id LIMIT 1) AS canonical_me`;

export function getPerson(db: Db, id: string): Person | null {
  const row = db.prepare(`SELECT ${PERSON_COLS} FROM people WHERE id = ? AND deleted_at IS NULL`).get(id) as Row | undefined;
  return row ? toPerson(row) : null;
}

export interface ListPeopleOptions {
  /** Default: confirmed only. */
  statuses?: PeopleStatus[];
  /** Only people whose relationship set includes this type. */
  relationship?: RelationshipType;
  includeArchived?: boolean;
}

export function listPeople(db: Db, workspaceId: string, opts: ListPeopleOptions = {}): Person[] {
  const statuses = (opts.statuses ?? ["confirmed"]).map((s) => oneOf(PEOPLE_STATUSES, s, "status"));
  const where = ["workspace_id = ?", "deleted_at IS NULL", `status IN (${statuses.map(() => "?").join(", ")})`];
  const params: unknown[] = [workspaceId, ...statuses];
  if (!opts.includeArchived) where.push("archived_at IS NULL");
  if (opts.relationship) {
    where.push("EXISTS (SELECT 1 FROM json_each(people.relationship) j WHERE json_extract(j.value, '$.type') = ?)");
    params.push(oneOf(RELATIONSHIP_TYPES, opts.relationship, "relationship type"));
  }
  const rows = db.prepare(`SELECT ${PERSON_COLS} FROM people WHERE ${where.join(" AND ")} ORDER BY name COLLATE NOCASE`).all(...params) as Row[];
  return rows.map(toPerson);
}

/** The person row for the user themself, if one exists. */
export function getMe(db: Db, workspaceId: string): Person | null {
  const row = db
    .prepare("SELECT *, id AS canonical_me FROM people WHERE workspace_id = ? AND is_me = 1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1")
    .get(workspaceId) as Row | undefined;
  return row ? toPerson(row) : null;
}

/** Keep at most one `is_me` person per workspace: clear the flag on everyone else. */
function clearOtherMe(db: Db, workspaceId: string, keepId: string, now: string): void {
  db.prepare(
    "UPDATE people SET is_me = 0, updated_at = ? WHERE workspace_id = ? AND is_me = 1 AND id != ? AND deleted_at IS NULL",
  ).run(now, workspaceId, keepId);
}

export function createPerson(db: Db, input: PersonCreateInput): Person {
  const name = input.name?.trim();
  if (!name) throw new Error("A person needs a name");
  const id = input.id ?? newId();
  const now = ts();
  const status = oneOf(PEOPLE_STATUSES, input.status ?? "confirmed", "status");
  const provenance = oneOf(PROVENANCES, input.provenance ?? "explicit", "provenance");
  const cadence = input.cadence == null ? null : oneOf(CADENCES, input.cadence, "cadence");
  db.transaction(() => {
    db.prepare(`
      INSERT INTO people (id, workspace_id, name, aliases, emails, slack_id, relationship, cadence, persona_note_id,
        status, provenance, stage, is_me, agent_private, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.workspaceId, name,
      JSON.stringify(cleanStrings(input.aliases)),
      JSON.stringify(cleanStrings(input.emails).map((e) => e.toLowerCase())),
      input.slackId?.trim() || null,
      JSON.stringify(normaliseRelationships(input.relationship)),
      cadence,
      input.personaNoteId ?? null,
      status, provenance,
      input.stage?.trim() || null,
      input.isMe ? 1 : 0,
      input.agentPrivate ? 1 : 0,
      now, now,
    );
    if (input.isMe) clearOtherMe(db, input.workspaceId, id, now);
  })();
  return getPerson(db, id)!;
}

export function updatePerson(db: Db, id: string, patch: PersonPatch): Person {
  const current = getPerson(db, id);
  if (!current) throw new Error(`Person not found: ${id}`);
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, value: unknown) => { sets.push(`${col} = ?`); params.push(value); };

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("A person needs a name");
    set("name", name);
  }
  if (patch.aliases !== undefined) set("aliases", JSON.stringify(cleanStrings(patch.aliases)));
  if (patch.emails !== undefined) set("emails", JSON.stringify(cleanStrings(patch.emails).map((e) => e.toLowerCase())));
  if (patch.slackId !== undefined) set("slack_id", patch.slackId?.trim() || null);
  if (patch.relationship !== undefined) set("relationship", JSON.stringify(normaliseRelationships(patch.relationship)));
  if (patch.cadence !== undefined) set("cadence", patch.cadence === null ? null : oneOf(CADENCES, patch.cadence, "cadence"));
  if (patch.personaNoteId !== undefined) set("persona_note_id", patch.personaNoteId);
  if (patch.status !== undefined) set("status", oneOf(PEOPLE_STATUSES, patch.status, "status"));
  if (patch.provenance !== undefined) set("provenance", oneOf(PROVENANCES, patch.provenance, "provenance"));
  if (patch.stage !== undefined) set("stage", patch.stage?.trim() || null);
  if (patch.isMe !== undefined) set("is_me", patch.isMe ? 1 : 0);
  if (patch.agentPrivate !== undefined) set("agent_private", patch.agentPrivate ? 1 : 0);
  if (patch.archivedAt !== undefined) set("archived_at", patch.archivedAt);
  if (sets.length === 0) return current;

  const now = ts();
  set("updated_at", now);
  db.transaction(() => {
    db.prepare(`UPDATE people SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    if (patch.isMe) clearOtherMe(db, current.workspaceId, id, now);
  })();
  return getPerson(db, id)!;
}

/**
 * Tombstone a person and everything that points at them here: their edges,
 * attendance and mentions. Cards they own lose the owner; the persona note is
 * left alone (it's the user's writing).
 */
export function deletePerson(db: Db, id: string): void {
  const now = ts();
  db.transaction(() => {
    db.prepare("UPDATE people SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, id);
    db.prepare(
      "UPDATE person_edges SET deleted_at = ?, updated_at = ? WHERE (source_id = ? OR target_id = ?) AND deleted_at IS NULL",
    ).run(now, now, id, id);
    db.prepare("UPDATE meeting_attendees SET deleted_at = ?, updated_at = ? WHERE person_id = ? AND deleted_at IS NULL").run(now, now, id);
    db.prepare("UPDATE note_mentions SET deleted_at = ?, updated_at = ? WHERE person_id = ? AND deleted_at IS NULL").run(now, now, id);
    db.prepare(
      "UPDATE task_cards SET owner_person_id = NULL, updated_at = ?, version = version + 1 WHERE owner_person_id = ? AND deleted_at IS NULL",
    ).run(now, id);
    db.prepare("UPDATE note_action_items SET owner_person_id = NULL WHERE owner_person_id = ?").run(id);
    db.prepare("DELETE FROM person_profile_cache WHERE person_id = ?").run(id);
  })();
}

// ── Person edges ──────────────────────────────

export interface AddEdgeInput {
  workspaceId: string;
  sourceId: string;
  targetId: string;
  type: PersonEdgeType;
  label?: string;
  endedAt?: string;
  status?: PeopleStatus;
  provenance?: Provenance;
  sourceNoteId?: string;
}

/**
 * Add a person-to-person edge. Idempotent: the row id comes from (type, source,
 * target) (`edgeRowId`; `partner` in either direction is one row), so a live
 * edge is returned with its label/end date updated when given, and a removed
 * one is revived.
 */
export function addEdge(db: Db, input: AddEdgeInput): PersonEdge {
  const type = oneOf(PERSON_EDGE_TYPES, input.type, "edge type");
  if (input.sourceId === input.targetId) throw new Error("A person can't have an edge to themself");
  for (const pid of [input.sourceId, input.targetId]) {
    if (!getPerson(db, pid)) throw new Error(`Person not found: ${pid}`);
  }
  const now = ts();
  const id = edgeRowId(type, input.sourceId, input.targetId);
  const existing = db.prepare("SELECT * FROM person_edges WHERE id = ?").get(id) as Row | undefined;
  if (existing && !existing.deleted_at) {
    if (input.label !== undefined || input.endedAt !== undefined) {
      db.prepare("UPDATE person_edges SET label = COALESCE(?, label), ended_at = COALESCE(?, ended_at), updated_at = ? WHERE id = ?")
        .run(input.label ?? null, input.endedAt ?? null, now, id);
    }
    return toEdge(db.prepare("SELECT * FROM person_edges WHERE id = ?").get(id) as Row);
  }
  if (existing) {
    // Revive the removed edge with the new facts (an UPDATE, so sync sends a put that has seen the delete).
    db.prepare(`
      UPDATE person_edges SET deleted_at = NULL, workspace_id = ?, source_id = ?, target_id = ?, label = ?, ended_at = ?,
        status = ?, provenance = ?, source_note_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.workspaceId, input.sourceId, input.targetId, input.label?.trim() || null, input.endedAt ?? null,
      oneOf(PEOPLE_STATUSES, input.status ?? "confirmed", "status"),
      oneOf(PROVENANCES, input.provenance ?? "explicit", "provenance"),
      input.sourceNoteId ?? null, now, id,
    );
    return toEdge(db.prepare("SELECT * FROM person_edges WHERE id = ?").get(id) as Row);
  }
  db.prepare(`
    INSERT INTO person_edges (id, workspace_id, source_id, target_id, type, label, ended_at, status, provenance,
      source_note_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.workspaceId, input.sourceId, input.targetId, type,
    input.label?.trim() || null, input.endedAt ?? null,
    oneOf(PEOPLE_STATUSES, input.status ?? "confirmed", "status"),
    oneOf(PROVENANCES, input.provenance ?? "explicit", "provenance"),
    input.sourceNoteId ?? null, now, now,
  );
  return toEdge(db.prepare("SELECT * FROM person_edges WHERE id = ?").get(id) as Row);
}

export function updateEdge(
  db: Db,
  id: string,
  patch: Partial<{ label: string | null; endedAt: string | null; status: PeopleStatus }>,
): PersonEdge {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.label !== undefined) { sets.push("label = ?"); params.push(patch.label?.trim() || null); }
  if (patch.endedAt !== undefined) { sets.push("ended_at = ?"); params.push(patch.endedAt); }
  if (patch.status !== undefined) { sets.push("status = ?"); params.push(oneOf(PEOPLE_STATUSES, patch.status, "status")); }
  if (sets.length) {
    sets.push("updated_at = ?");
    params.push(ts());
    db.prepare(`UPDATE person_edges SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`).run(...params, id);
  }
  const row = db.prepare("SELECT * FROM person_edges WHERE id = ? AND deleted_at IS NULL").get(id) as Row | undefined;
  if (!row) throw new Error(`Edge not found: ${id}`);
  return toEdge(row);
}

export function removeEdge(db: Db, id: string): void {
  const now = ts();
  db.prepare("UPDATE person_edges SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, id);
}

/** The role `personId` plays in an edge, deriving the inverse when they're the target. */
export function edgeRole(edge: Pick<PersonEdge, "type" | "sourceId">, personId: string): PersonEdgeRole {
  if (edge.type === "partner") return "partner";
  const asSource = edge.sourceId === personId;
  switch (edge.type) {
    case "manager_of": return asSource ? "manager_of" : "reports_to";
    case "mentor_of": return asSource ? "mentor_of" : "mentee_of";
    case "buddy_of": return asSource ? "buddy_of" : "buddy_to";
    case "stakeholder_of": return asSource ? "stakeholder_of" : "has_stakeholder";
  }
}

export interface RelationsOptions {
  /** Default: confirmed only. */
  statuses?: PeopleStatus[];
  /** Include edges that have ended ("former manager"). Default true. */
  includeEnded?: boolean;
}

/** Every live edge touching `personId`, seen from their side. Edges to deleted people are skipped. */
export function getRelations(db: Db, personId: string, opts: RelationsOptions = {}): PersonRelation[] {
  const statuses = (opts.statuses ?? ["confirmed"]).map((s) => oneOf(PEOPLE_STATUSES, s, "status"));
  const rows = db.prepare(`
    SELECT e.* FROM person_edges e
    JOIN people o ON o.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END AND o.deleted_at IS NULL
    WHERE (e.source_id = ? OR e.target_id = ?) AND e.deleted_at IS NULL
      AND e.status IN (${statuses.map(() => "?").join(", ")})
      ${opts.includeEnded === false ? "AND e.ended_at IS NULL" : ""}
    ORDER BY e.created_at
  `).all(personId, personId, personId, ...statuses) as Row[];
  return rows.map((r) => {
    const edge = toEdge(r);
    return { edge, role: edgeRole(edge, personId), otherId: edge.sourceId === personId ? edge.targetId : edge.sourceId };
  });
}

/** People on the far side of `personId`'s edges in a given role, e.g. ("reports_to") → their managers. */
export function listRelated(db: Db, personId: string, role: PersonEdgeRole, opts: RelationsOptions = {}): Person[] {
  const ids = getRelations(db, personId, opts).filter((r) => r.role === role).map((r) => r.otherId);
  return ids.map((id) => getPerson(db, id)).filter((p): p is Person => p !== null);
}

// ── Meetings ──────────────────────────────────

export interface CreateMeetingInput {
  id?: string;
  workspaceId: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  source?: MeetingSource;
  externalId?: string;
  seriesKey?: string;
}

export function getMeeting(db: Db, id: string): Meeting | null {
  const row = db.prepare("SELECT * FROM meetings WHERE id = ? AND deleted_at IS NULL").get(id) as Row | undefined;
  return row ? toMeeting(row) : null;
}

export function createMeeting(db: Db, input: CreateMeetingInput): Meeting {
  const title = input.title?.trim();
  if (!title) throw new Error("A meeting needs a title");
  if (!input.startsAt) throw new Error("A meeting needs a start time");
  const id = input.id ?? newId();
  const now = ts();
  db.prepare(`
    INSERT INTO meetings (id, workspace_id, title, starts_at, ends_at, source, external_id, series_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.workspaceId, title, input.startsAt, input.endsAt ?? null,
    input.source ?? "manual", input.externalId ?? null, input.seriesKey ?? null, now, now,
  );
  return getMeeting(db, id)!;
}

/**
 * Create or update the meeting for a calendar event. The id comes from
 * (workspace, externalId) (`calendarMeetingId`), so repeated Today runs, on
 * this device or another, always write the same row. Returns null when the
 * user deleted that meeting: a calendar refresh doesn't bring it back.
 */
export function upsertMeetingByExternalId(db: Db, input: Omit<CreateMeetingInput, "id"> & { externalId: string }): Meeting | null {
  const id = calendarMeetingId(input.workspaceId, input.externalId);
  const row = db.prepare("SELECT deleted_at FROM meetings WHERE id = ?").get(id) as { deleted_at: string | null } | undefined;
  if (!row) return createMeeting(db, { ...input, id, source: input.source ?? "calendar" });
  if (row.deleted_at) return null;
  db.prepare(`
    UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, series_key = COALESCE(?, series_key), updated_at = ?
    WHERE id = ?
  `).run(input.title.trim(), input.startsAt, input.endsAt ?? null, input.seriesKey ?? null, ts(), id);
  return getMeeting(db, id)!;
}

export function updateMeeting(
  db: Db,
  id: string,
  patch: Partial<{ title: string; startsAt: string; endsAt: string | null; seriesKey: string | null }>,
): Meeting {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new Error("A meeting needs a title");
    sets.push("title = ?"); params.push(patch.title.trim());
  }
  if (patch.startsAt !== undefined) { sets.push("starts_at = ?"); params.push(patch.startsAt); }
  if (patch.endsAt !== undefined) { sets.push("ends_at = ?"); params.push(patch.endsAt); }
  if (patch.seriesKey !== undefined) { sets.push("series_key = ?"); params.push(patch.seriesKey); }
  if (sets.length) {
    sets.push("updated_at = ?");
    params.push(ts());
    db.prepare(`UPDATE meetings SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`).run(...params, id);
  }
  const m = getMeeting(db, id);
  if (!m) throw new Error(`Meeting not found: ${id}`);
  return m;
}

/** Tombstone a meeting and its attendance, and unlink its notes (the notes stay). */
export function deleteMeeting(db: Db, id: string): void {
  const now = ts();
  db.transaction(() => {
    db.prepare("UPDATE meetings SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, id);
    db.prepare("UPDATE meeting_attendees SET deleted_at = ?, updated_at = ? WHERE meeting_id = ? AND deleted_at IS NULL").run(now, now, id);
    db.prepare("UPDATE notes SET meeting_id = NULL, updated_at = ?, version = version + 1 WHERE meeting_id = ? AND deleted_at IS NULL").run(now, id);
  })();
}

export interface AddAttendeeInput {
  meetingId: string;
  personId: string;
  status?: PeopleStatus;
  source?: AttendeeSource;
  provenance?: Provenance;
}

/**
 * Add a person to a meeting. Idempotent per (meeting, person) (`attendeeRowId`):
 * a second call returns the existing row, upgrading `suggested` to `confirmed`
 * if asked, and re-adding someone who was removed revives their row.
 */
/** Ranks sources: the strongest listed source is the row's `source` (the user's own actions win). */
const SOURCE_RANK: Record<AttendeeSource, number> = { body_line: 0, frontmatter: 1, calendar: 2, declared: 3, manual: 4 };

function strongest(sources: readonly AttendeeSource[]): AttendeeSource {
  return sources.reduce((a, b) => (SOURCE_RANK[b] > SOURCE_RANK[a] ? b : a));
}

export function addAttendee(db: Db, input: AddAttendeeInput): MeetingAttendee {
  if (!getMeeting(db, input.meetingId)) throw new Error(`Meeting not found: ${input.meetingId}`);
  if (!getPerson(db, input.personId)) throw new Error(`Person not found: ${input.personId}`);
  const status = oneOf(PEOPLE_STATUSES, input.status ?? "confirmed", "status");
  const now = ts();
  const id = attendeeRowId(input.meetingId, input.personId);
  const source = input.source ?? "manual";
  const existing = db.prepare("SELECT * FROM meeting_attendees WHERE id = ?").get(id) as Row | undefined;
  if (existing && !existing.deleted_at) {
    // One row per meeting/person, remembering every source that lists them: a
    // source dropping the person only removes attendance when it was the last.
    const current = sourcesOf(existing);
    const sources = current.includes(source) ? current : [...current, source];
    const top = strongest(sources);
    const takeOver = SOURCE_RANK[source] > SOURCE_RANK[existing.source as AttendeeSource];
    const confirm = existing.status !== status && status === "confirmed";
    if (sources.length === current.length && !takeOver && !confirm) return toAttendee(existing);
    db.prepare("UPDATE meeting_attendees SET status = ?, source = ?, sources = ?, provenance = ?, updated_at = ? WHERE id = ?")
      .run(confirm ? "confirmed" : existing.status, top, JSON.stringify(sources),
        takeOver ? (input.provenance ?? "explicit") : existing.provenance, now, id);
    return toAttendee(db.prepare("SELECT * FROM meeting_attendees WHERE id = ?").get(id) as Row);
  }
  if (existing) {
    db.prepare(`
      UPDATE meeting_attendees SET deleted_at = NULL, status = ?, source = ?, sources = ?, provenance = ?, updated_at = ? WHERE id = ?
    `).run(status, source, JSON.stringify([source]), input.provenance ?? "explicit", now, id);
    return toAttendee(db.prepare("SELECT * FROM meeting_attendees WHERE id = ?").get(id) as Row);
  }
  db.prepare(`
    INSERT INTO meeting_attendees (id, meeting_id, person_id, status, source, sources, provenance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.meetingId, input.personId, status, source, JSON.stringify([source]), input.provenance ?? "explicit", now, now);
  return toAttendee(db.prepare("SELECT * FROM meeting_attendees WHERE id = ?").get(id) as Row);
}

/** People currently listed at a meeting by this source. */
export function attendeeIdsFromSource(db: Db, meetingId: string, source: AttendeeSource): string[] {
  const rows = db.prepare("SELECT * FROM meeting_attendees WHERE meeting_id = ? AND deleted_at IS NULL").all(meetingId) as Row[];
  return rows.filter((r) => sourcesOf(r).includes(source)).map((r) => r.person_id as string);
}

/**
 * One source stops listing a person. They leave the meeting only when no other
 * source lists them; otherwise the row stays with the remaining sources.
 * Returns true when the attendee was removed.
 */
export function removeAttendeeSource(db: Db, meetingId: string, personId: string, source: AttendeeSource): boolean {
  const row = db.prepare(
    "SELECT * FROM meeting_attendees WHERE meeting_id = ? AND person_id = ? AND deleted_at IS NULL",
  ).get(meetingId, personId) as Row | undefined;
  if (!row) return false;
  const rest = sourcesOf(row).filter((x) => x !== source);
  if (rest.length === 0) { removeAttendee(db, meetingId, personId); return true; }
  db.prepare("UPDATE meeting_attendees SET source = ?, sources = ?, updated_at = ? WHERE id = ?")
    .run(strongest(rest), JSON.stringify(rest), ts(), row.id);
  return false;
}

export function removeAttendee(db: Db, meetingId: string, personId: string): void {
  const now = ts();
  db.prepare(
    "UPDATE meeting_attendees SET deleted_at = ?, updated_at = ? WHERE meeting_id = ? AND person_id = ? AND deleted_at IS NULL",
  ).run(now, now, meetingId, personId);
}

/** Attendance rows for a meeting (live people only). Default: confirmed and suggested. */
export function listAttendees(db: Db, meetingId: string, statuses: PeopleStatus[] = ["confirmed", "suggested"]): MeetingAttendee[] {
  const rows = db.prepare(`
    SELECT a.* FROM meeting_attendees a
    JOIN people p ON p.id = a.person_id AND p.deleted_at IS NULL
    WHERE a.meeting_id = ? AND a.deleted_at IS NULL AND a.status IN (${statuses.map(() => "?").join(", ")})
    ORDER BY a.created_at
  `).all(meetingId, ...statuses) as Row[];
  return rows.map(toAttendee);
}

/** Meetings a person attended (confirmed), newest first. */
export function listPersonMeetings(db: Db, personId: string, limit = 100): Meeting[] {
  const rows = db.prepare(`
    SELECT DISTINCT m.* FROM meetings m
    JOIN meeting_attendees a ON a.meeting_id = m.id AND a.deleted_at IS NULL AND a.status = 'confirmed'
    WHERE a.person_id = ? AND m.deleted_at IS NULL
    ORDER BY m.starts_at DESC
    LIMIT ?
  `).all(personId, limit) as Row[];
  return rows.map(toMeeting);
}

// ── Notes ↔ meetings ──────────────────────────

/** Link a note to a meeting (or unlink with null). A note has at most one meeting. */
export function setNoteMeeting(db: Db, noteId: string, meetingId: string | null): void {
  if (meetingId && !getMeeting(db, meetingId)) throw new Error(`Meeting not found: ${meetingId}`);
  const res = db.prepare(
    "UPDATE notes SET meeting_id = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL AND meeting_id IS NOT ?",
  ).run(meetingId, ts(), noteId, meetingId);
  if (res.changes === 0) {
    const exists = db.prepare("SELECT 1 FROM notes WHERE id = ? AND deleted_at IS NULL").get(noteId);
    if (!exists) throw new Error(`Note not found: ${noteId}`);
  }
}

/** Live note ids linked to a meeting. */
export function listMeetingNoteIds(db: Db, meetingId: string): string[] {
  return (db.prepare("SELECT id FROM notes WHERE meeting_id = ? AND deleted_at IS NULL ORDER BY created_at").all(meetingId) as { id: string }[])
    .map((r) => r.id);
}

// ── Mentions ──────────────────────────────────

/** Record that a note mentions a person. Idempotent per (note, person) (`mentionRowId`); revives a removed mention. */
export function addMention(db: Db, noteId: string, personId: string, source: MentionSource = "manual"): NoteMention {
  const id = mentionRowId(noteId, personId);
  const now = ts();
  const existing = db.prepare("SELECT * FROM note_mentions WHERE id = ?").get(id) as Row | undefined;
  if (existing && !existing.deleted_at) return toMention(existing);
  if (existing) {
    db.prepare("UPDATE note_mentions SET deleted_at = NULL, source = ?, updated_at = ? WHERE id = ?").run(source, now, id);
    return toMention(db.prepare("SELECT * FROM note_mentions WHERE id = ?").get(id) as Row);
  }
  db.prepare("INSERT INTO note_mentions (id, note_id, person_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, noteId, personId, source, now, now);
  return toMention(db.prepare("SELECT * FROM note_mentions WHERE id = ?").get(id) as Row);
}

export function removeMention(db: Db, noteId: string, personId: string): void {
  const now = ts();
  db.prepare("UPDATE note_mentions SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND person_id = ? AND deleted_at IS NULL")
    .run(now, now, noteId, personId);
}

/** Live note ids that mention a person, newest note first. */
export function listPersonMentionNoteIds(db: Db, personId: string): string[] {
  return (db.prepare(`
    SELECT DISTINCT n.id, n.updated_at FROM note_mentions m JOIN notes n ON n.id = m.note_id AND n.deleted_at IS NULL
    WHERE m.person_id = ? AND m.deleted_at IS NULL
    ORDER BY n.updated_at DESC
  `).all(personId) as { id: string }[]).map((r) => r.id);
}

// ── Card owners ───────────────────────────────

/** Set (or clear) who owns a card. */
export function setCardOwner(db: Db, cardId: string, personId: string | null): void {
  if (personId && !getPerson(db, personId)) throw new Error(`Person not found: ${personId}`);
  const res = db.prepare("UPDATE task_cards SET owner_person_id = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL")
    .run(personId, ts(), cardId);
  if (res.changes === 0) throw new Error(`Card not found: ${cardId}`);
}

/** Live card ids owned by a person. */
export function listOwnedCardIds(db: Db, personId: string): string[] {
  return (db.prepare("SELECT id FROM task_cards WHERE owner_person_id = ? AND deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC")
    .all(personId) as { id: string }[]).map((r) => r.id);
}

// ── Note lifecycle ────────────────────────────

/**
 * A persona note was renamed: keep its old title as an alias of the person, so
 * `[[Old title]]` in existing files and other notes still names them (and a
 * later read of such a file never makes a stub for it). Aliases sync with the
 * person, so a rename on any device covers every device.
 */
export function onNoteRenamed(db: Db, noteId: string, oldTitle: string, newTitle: string): void {
  if (!isPeopleEnabled(db) || !oldTitle.trim() || oldTitle === newTitle) return;
  for (const p of db.prepare("SELECT id FROM people WHERE persona_note_id = ? AND deleted_at IS NULL").all(noteId) as { id: string }[]) {
    const person = getPerson(db, p.id);
    if (!person) continue;
    const known = [person.name, ...person.aliases].map((x) => x.toLowerCase());
    if (!known.includes(oldTitle.toLowerCase())) updatePerson(db, p.id, { aliases: [...person.aliases, oldTitle] });
  }
}

/**
 * Clean up after a note is deleted: people whose persona it was lose the link,
 * its mentions are tombstoned, and its checklist index rows go. The meeting it
 * belonged to stays (other notes or the calendar may still point at it).
 */
export function onNoteDeleted(db: Db, noteId: string): void {
  const now = ts();
  db.prepare("UPDATE people SET persona_note_id = NULL, updated_at = ? WHERE persona_note_id = ? AND deleted_at IS NULL").run(now, noteId);
  db.prepare("UPDATE note_mentions SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND deleted_at IS NULL").run(now, now, noteId);
  db.prepare("DELETE FROM note_action_items WHERE note_id = ?").run(noteId);
}

/**
 * Drop People links that point across workspaces after a project's notes and
 * cards moved (`mergeProject` into a project of another workspace): a note's
 * meeting, its mentions, a persona link and a card owner must all live in the
 * project's own workspace. Within one workspace this changes nothing.
 */
export function detachForeignPeopleLinks(db: Db, projectId: string): void {
  const now = ts();
  db.prepare(`
    UPDATE notes SET meeting_id = NULL, updated_at = ?
    WHERE project_id = ? AND meeting_id IS NOT NULL
      AND meeting_id NOT IN (SELECT id FROM meetings WHERE workspace_id = notes.workspace_id)
  `).run(now, projectId);
  db.prepare(`
    UPDATE note_mentions SET deleted_at = ?, updated_at = ?
    WHERE deleted_at IS NULL AND note_id IN (SELECT id FROM notes WHERE project_id = ?)
      AND person_id NOT IN (SELECT p.id FROM people p JOIN notes n ON n.id = note_mentions.note_id WHERE p.workspace_id = n.workspace_id)
  `).run(now, now, projectId);
  db.prepare(`
    UPDATE people SET persona_note_id = NULL, updated_at = ?
    WHERE deleted_at IS NULL AND persona_note_id IN (SELECT id FROM notes WHERE project_id = ? AND workspace_id != people.workspace_id)
  `).run(now, projectId);
  db.prepare(`
    UPDATE task_cards SET owner_person_id = NULL, updated_at = ?
    WHERE project_id = ? AND owner_person_id IS NOT NULL
      AND owner_person_id NOT IN (SELECT id FROM people WHERE workspace_id = task_cards.workspace_id)
  `).run(now, projectId);
}
