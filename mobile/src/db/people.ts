/**
 * People layer data for the mobile screens and chat tools.
 *
 * Every read and write goes through the SAME shared code the desktop runs
 * (`shared/people/*`, over `SyncDb`), so attendee rows carry per-source claims
 * (`shared/people/claims.ts`), ids are deterministic, and removals are
 * tombstones exactly as on the desktop; plain UPDATEs/INSERTs let the capture
 * triggers (generated from SYNCABLE_TABLES) stage them for sync. This module
 * only binds that code to the active expo-sqlite handle and fires the
 * local-write signal.
 *
 * Mobile keeps no action-item index and rewrites no files: open items are read
 * from note bodies on demand (`shared/people/action-items.ts`), and the desktop
 * re-indexes and rewrites frontmatter when the rows arrive.
 */

import type { SyncDb } from "@cairn/shared/sync/db-adapter";
import { getActiveSource, getDb, getMeta, setMeta } from "./index";
import { createExpoSyncDb } from "./expo-sync-db";
import { notifyLocalWrite } from "@/sync/write-signal";
import { LIVE, NOT_CONFLICT } from "./sql";
import * as pq from "@cairn/shared/people/queries";
// Registers the city data behind place search and place-to-zone lookups (the desktop imports it too).
import "@cairn/shared/people/place-data";
import { cleanProfileFieldWithPlaces, zoneForPlace } from "@cairn/shared/people/place-zone";
import type { ProfileField } from "@cairn/shared/people/parse";
import { captureNoteMeeting, loadCandidates, meetingLinkPending } from "@cairn/shared/people/capture";
import { getPersonPage, listPersonSummaries } from "@cairn/shared/people/view-queries";
import { ownedItemsIn, setItemDone } from "@cairn/shared/people/action-items";
import type {
  AddMemberInput, Cadence, MeetingAttendee, PeopleStatus, Person, PersonCreateInput, Relationship, Team, TeamCreateInput, TeamMembership, TeamPatch,
} from "@cairn/shared/types/people";
import type { PersonPage, PersonSummary } from "@cairn/shared/types/people-view";
import { updateNote } from "./queries";
import * as tq from "@cairn/shared/people/team-queries";
import { mergePeople as mergePeopleShared, type MergeResult } from "@cairn/shared/people/merge";
import { flattenTeams, groupByTeam, teamForest, type TeamGroup, type TeamNode } from "@cairn/shared/people/teams";
import { LIST_GROUPINGS, type ListGrouping } from "@cairn/shared/people/list-groups";
import { DEFAULT_ZONE_GROUPING, ZONE_GROUPINGS, type ZoneGrouping } from "@cairn/shared/people/zones";

/** The portable handle over the active source's database. */
export function peopleDb(): SyncDb {
  return createExpoSyncDb(getDb());
}

/** The workspace the People screens show: the active source, else the first workspace row. */
export function peopleWorkspaceId(): string | null {
  const active = getActiveSource();
  if (active) return active;
  const row = getDb().getFirstSync<{ id: string }>("SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1");
  return row?.id ?? null;
}

/** Run a write, then tell sync there is something to send. */
function write<T>(fn: (db: SyncDb) => T): T {
  const out = fn(peopleDb());
  notifyLocalWrite();
  return out;
}

// ── List ─────────────────────────────────────

/** Confirmed (and, on request, suggested) people with their last/next meeting. */
export function loadPeople(statuses: PeopleStatus[] = ["confirmed"]): PersonSummary[] {
  const ws = peopleWorkspaceId();
  return ws ? listPersonSummaries(peopleDb(), ws, { statuses }) : [];
}

/** Confirm or dismiss a suggested person (dismissed ones are remembered, so they don't come back). */
export function setPersonStatus(personId: string, status: PeopleStatus): void {
  write((db) => pq.updatePerson(db, personId, { status }));
}

// ── Teams ────────────────────────────────────

/** Every live team in the workspace, by name. */
export function loadTeams(): Team[] {
  const ws = peopleWorkspaceId();
  return ws ? tq.listTeams(peopleDb(), ws) : [];
}

/** Every membership in the workspace, past ones included. */
export function loadMemberships(): TeamMembership[] {
  const ws = peopleWorkspaceId();
  return ws ? tq.listMemberships(peopleDb(), ws) : [];
}

export interface TeamsView {
  people: PersonSummary[];
  teams: Team[];
  memberships: TeamMembership[];
  /** `groupByTeam`: one group per team plus the people without one. */
  groups: TeamGroup[];
  /** The team tree (`teamForest`), roots first. */
  forest: TeamNode[];
  /** Every node of the tree, depth first. */
  nodes: TeamNode[];
}

/** Everything the Teams list and a team's page read, in one go. */
export function loadTeamsView(): TeamsView {
  const people = loadPeople(["confirmed"]);
  const teams = loadTeams();
  const groups = groupByTeam(people, teams);
  const forest = teamForest(groups);
  return { people, teams, memberships: loadMemberships(), groups, forest, nodes: flattenTeams(forest) };
}

/** A past stint on a team, for "Before: …" on a person's page. */
export interface PastTeam {
  team: Team;
  endedAt: string;
}

/** Teams a person has left (not on them now), most recently left first. */
export function loadPastTeams(personId: string, current: readonly { teamId: string }[]): PastTeam[] {
  const now = new Set(current.map((t) => t.teamId));
  const byId = new Map(loadTeams().map((t) => [t.id, t]));
  return loadMemberships()
    .filter((m) => m.personId === personId && m.endedAt && !now.has(m.teamId) && byId.has(m.teamId))
    .map((m) => ({ team: byId.get(m.teamId)!, endedAt: m.endedAt! }))
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt));
}

export type NewPersonInput = Pick<PersonCreateInput, "name" | "relationship" | "title" | "team" | "location" | "timezone" | "isMe">;

/**
 * Add a person to the active workspace, as the desktop's Add person does. Role, team, location and time zone are
 * checked the same way the person page checks them; a location that names a zone fills an empty time zone.
 * Throws with a sentence to show when there is no name or a field is refused.
 */
export function createPerson(input: NewPersonInput): Person {
  const ws = peopleWorkspaceId();
  if (!ws) throw new Error("There is no workspace to add the person to.");
  const clean = (field: ProfileField, raw: string | undefined): string | undefined => {
    const out = cleanProfileFieldWithPlaces(field, raw);
    if (out.error) throw new Error(out.error);
    return out.value;
  };
  const location = clean("location", input.location);
  const timezone = clean("timezone", input.timezone) ?? (location ? zoneForPlace(location) ?? undefined : undefined);
  return write((db) => pq.createPerson(db, {
    ...input,
    workspaceId: ws,
    title: clean("title", input.title),
    team: clean("team", input.team),
    location,
    timezone,
  }));
}

/** Make a team in the active workspace. Throws (with a sentence to show) when the name is taken or empty. */
export function createTeam(input: Omit<TeamCreateInput, "workspaceId">): Team {
  const ws = peopleWorkspaceId();
  if (!ws) throw new Error("There is no workspace to add the team to.");
  return write((db) => tq.createTeam(db, { ...input, workspaceId: ws }));
}

/** Change a team's details; `null` clears an optional one. Throws on a clash of names or a loop in the tree. */
export function updateTeam(id: string, patch: TeamPatch): Team {
  return write((db) => tq.updateTeam(db, id, patch));
}

/** Remove a team and its memberships; teams under it move up. */
export function deleteTeam(id: string): void {
  write((db) => tq.deleteTeam(db, id));
}

/** Fold `dropId` into `keepId`: members, sub-teams and missing details move over. */
export function mergeTeams(keepId: string, dropId: string): Team {
  return write((db) => tq.mergeTeams(db, keepId, dropId));
}

/** Put someone on a team, or change their role there (`role: null` clears it). Never takes them off another team. */
export function addTeamMember(input: AddMemberInput): TeamMembership {
  return write((db) => tq.addMember(db, input));
}

export interface MemberChanges {
  teamId: string;
  /** Taken off the team (kept as history). */
  end: string[];
  /** Added, or given a role: `role` null clears one. */
  set: { personId: string; role: string | null }[];
}

/** A team's member edits from the Members form, committed together: if one fails, none are saved. */
export function saveTeamMembers(changes: MemberChanges): void {
  const db = peopleDb();
  db.transaction(() => {
    for (const personId of changes.end) tq.endMember(db, changes.teamId, personId);
    for (const m of changes.set) tq.addMember(db, { teamId: changes.teamId, personId: m.personId, role: m.role });
  })();
  notifyLocalWrite();
}

/** Take someone off a team, keeping the stint as history. */
export function endTeamMember(teamId: string, personId: string): void {
  write((db) => tq.endMember(db, teamId, personId));
}

/** Move someone to a team by name (made when new), leaving their other teams of kind "team"; `null` takes them off all of those. */
export function moveToTeam(personId: string, name: string | null): void {
  write((db) => tq.setHomeTeam(db, personId, name));
}

// ── Merging people ───────────────────────────

/**
 * Fold a duplicate into the person who stays: their meetings, mentions, relationships, cards,
 * teams led and teams move over, and their name becomes an alias. The desktop's extra tables
 * (its checklist index and Slack cache) have no phone equivalent: the phone keeps no action-item
 * index and no profile cache, and the desktop re-indexes when the rows arrive.
 */
export function mergePeople(keepId: string, dropId: string): MergeResult {
  return write((db) => mergePeopleShared(db, keepId, dropId));
}

const GROUPING_KEY = "people.listGrouping";

/** How this device groups the People list (a per-device choice, kept in the meta store). */
export function loadGrouping(): ListGrouping {
  try {
    const v = getMeta(GROUPING_KEY);
    return LIST_GROUPINGS.find((g) => g.value === v)?.value ?? "relationship";
  } catch {
    return "relationship";
  }
}

export function saveGrouping(by: ListGrouping): void {
  try {
    setMeta(GROUPING_KEY, by);
  } catch {
    // A per-device convenience: not remembered is fine.
  }
}

const ZONE_GROUPING_KEY = "people.zoneGrouping";
const ZONE_AVAILABLE_KEY = "people.zoneAvailableOnly";

/** How this device arranges the Time zones segment (kept per device). Closest unless chosen otherwise. */
export function loadZoneView(): { grouping: ZoneGrouping; availableOnly: boolean } {
  try {
    const v = getMeta(ZONE_GROUPING_KEY);
    return {
      grouping: ZONE_GROUPINGS.find((g) => g.value === v)?.value ?? DEFAULT_ZONE_GROUPING,
      availableOnly: getMeta(ZONE_AVAILABLE_KEY) === "1",
    };
  } catch {
    return { grouping: DEFAULT_ZONE_GROUPING, availableOnly: false };
  }
}

export function saveZoneView(view: { grouping: ZoneGrouping; availableOnly: boolean }): void {
  try {
    setMeta(ZONE_GROUPING_KEY, view.grouping);
    setMeta(ZONE_AVAILABLE_KEY, view.availableOnly ? "1" : "0");
  } catch {
    // A per-device convenience: not remembered is fine.
  }
}

// ── Person page ──────────────────────────────

export interface OpenItem {
  /** Digest of the note body this item was read from: a tick against a changed body is refused (reload instead). */
  bodyDigest: string;
  noteId: string;
  noteTitle: string;
  lineKey: string;
  text: string;
  /** Who owns it, as written in the note. */
  ownerText: string | null;
}

export interface OpenItems {
  /** Open items the person owns, across notes. */
  theyOwe: OpenItem[];
  /** Open items the user owns in notes that concern this person (their meetings, mentions, persona note). */
  iOwe: OpenItem[];
}

interface NoteBody { id: string; title: string; content: string }

/** A cheap content digest (FNV-1a) to detect that a note changed between listing and tapping. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length}:${h.toString(16)}`;
}

/** Live notes in the workspace that contain an unchecked task line. */
function notesWithOpenTasks(ws: string): NoteBody[] {
  return getDb().getAllSync<NoteBody>(
    `SELECT id, title, content FROM notes WHERE workspace_id = ? AND ${LIVE} AND ${NOT_CONFLICT} AND content LIKE '%[ ]%' AND type = 'note'`,
    ws,
  );
}

/** Ids of notes that concern a person: their meetings' notes, notes mentioning them, and their persona note. */
function notesAbout(person: Person): Set<string> {
  const db = getDb();
  const ids = new Set<string>();
  for (const r of db.getAllSync<{ id: string }>(
    `SELECT n.id FROM notes n JOIN meeting_attendees a ON a.meeting_id = n.meeting_id AND a.deleted_at IS NULL AND a.status = 'confirmed'
     WHERE a.person_id = ? AND n.deleted_at IS NULL`, person.id)) ids.add(r.id);
  for (const r of db.getAllSync<{ id: string }>(
    `SELECT n.id FROM note_mentions m JOIN notes n ON n.id = m.note_id AND n.deleted_at IS NULL WHERE m.person_id = ? AND m.deleted_at IS NULL`, person.id)) ids.add(r.id);
  if (person.personaNoteId) ids.add(person.personaNoteId);
  return ids;
}

/** Open action items both ways for a person, read from note bodies. */
export function loadOpenItems(person: Person): OpenItems {
  const empty: OpenItems = { theyOwe: [], iOwe: [] };
  const db = peopleDb();
  const me = pq.getMe(db, person.workspaceId);
  const notes = notesWithOpenTasks(person.workspaceId);
  if (notes.length === 0) return empty;
  const candidates = loadCandidates(db, person.workspaceId);
  const about = me && me.id !== person.id ? notesAbout(person) : new Set<string>();
  const out: OpenItems = { theyOwe: [], iOwe: [] };
  for (const n of notes) {
    for (const item of ownedItemsIn(n.content ?? "", candidates)) {
      if (item.done) continue;
      const row: OpenItem = { bodyDigest: digest(n.content ?? ""), noteId: n.id, noteTitle: n.title, lineKey: item.lineKey, text: item.text, ownerText: item.ownerText };
      if (item.ownerPersonId === person.id) out.theyOwe.push(row);
      else if (me && item.ownerPersonId === me.id && about.has(n.id)) out.iOwe.push(row);
    }
  }
  return out;
}

/** Just the person (no timeline or open items), or null when they are gone: what the edit forms read. */
export function loadPerson(personId: string): Person | null {
  return pq.getPerson(peopleDb(), personId);
}

/** Everything the person page shows, or null when the person is gone. */
export function loadPersonPage(personId: string): (PersonPage & { items: OpenItems }) | null {
  const page = getPersonPage(peopleDb(), personId);
  return page ? { ...page, items: loadOpenItems(page.person) } : null;
}

/**
 * Tick or untick an owned checklist line. Only the box in the note body
 * changes; the note is saved like any edit, so it syncs and the desktop
 * re-indexes it. Returns false when the line is gone or the note changed since the list was read (the caller reloads).
 */
export function setActionItemDone(noteId: string, lineKey: string, done: boolean, bodyDigest?: string): boolean {
  const note = getDb().getFirstSync<NoteBody>("SELECT id, title, content FROM notes WHERE id = ? AND deleted_at IS NULL", noteId);
  if (!note) return false;
  if (bodyDigest !== undefined && digest(note.content ?? "") !== bodyDigest) return false;
  const next = setItemDone(note.content ?? "", lineKey, done);
  if (next === null) return false;
  if (next !== note.content) updateNote(noteId, note.title, next);
  return true;
}

/** Relationship and cadence edits from the person page. */
export function saveRelationship(personId: string, relationship: Relationship[], cadence: Cadence | null): Person {
  return write((db) => pq.updatePerson(db, personId, { relationship, cadence }));
}

export type ProfileEdit = { title: string; team: string; location: string; timezone: string; slackId: string };

/** Role, team, location, time zone and Slack id from the person page. Blank clears a field. */
export function saveProfile(personId: string, edit: Partial<ProfileEdit>): Person {
  return write((db) => pq.updatePerson(db, personId, edit));
}

// ── Attendee strip ───────────────────────────

export interface StripAttendee {
  personId: string;
  name: string;
  status: PeopleStatus;
}

export interface NoteMeetingStrip {
  meetingId: string | null;
  startsAt: string | null;
  attendees: StripAttendee[];
}

/** A note's meeting and its attendees (confirmed and suggested), for the strip above the body. */
export function loadNoteMeeting(noteId: string): NoteMeetingStrip {
  const db = peopleDb();
  const row = getDb().getFirstSync<{ meeting_id: string | null }>("SELECT meeting_id FROM notes WHERE id = ? AND deleted_at IS NULL", noteId);
  const meeting = row?.meeting_id ? pq.getMeeting(db, row.meeting_id) : null;
  if (!meeting) return { meetingId: null, startsAt: null, attendees: [] };
  const attendees: StripAttendee[] = [];
  for (const a of pq.listAttendees(db, meeting.id)) {
    const p = pq.getPerson(db, a.personId);
    if (p && p.status !== "dismissed") attendees.push({ personId: p.id, name: p.name, status: a.status });
  }
  return { meetingId: meeting.id, startsAt: meeting.startsAt, attendees };
}

/** People who could be added to this note's meeting: confirmed people not already listed. */
export function attendeeCandidates(noteId: string): Person[] {
  const ws = peopleWorkspaceId();
  if (!ws) return [];
  const here = new Set(loadNoteMeeting(noteId).attendees.map((a) => a.personId));
  return pq.listPeople(peopleDb(), ws).filter((p) => !here.has(p.id));
}

/** Add a person to the note's meeting (made on the first add), as the user's own manual choice. */
export function addNoteAttendee(noteId: string, personId: string): MeetingAttendee {
  // Capture (which may make the meeting and link the note) and the attendee insert commit together:
  // a rejected add (say the person was deleted by sync) leaves the note unlinked.
  const db = peopleDb();
  const out = db.transaction(() => {
    const note = getDb().getFirstSync<{ meeting_id: string | null }>("SELECT meeting_id FROM notes WHERE id = ? AND deleted_at IS NULL", noteId);
    if (!note) throw new Error("This note is gone.");
    let meetingId = note.meeting_id;
    if (meetingLinkPending(db, meetingId)) {
      // The note points at a calendar meeting whose row hasn't synced yet; capturing now would
      // replace that link with a new meeting. Retry after the next sync.
      throw new Error("This note's meeting hasn't synced to this device yet. Sync, then try again.");
    }
    // A missing link, or one to a deleted meeting (a restored note), gets a meeting of its own.
    if (!meetingId || !pq.getMeeting(db, meetingId)) {
      // Nobody is listed yet, so nothing this call could remove.
      meetingId = captureNoteMeeting(db, { noteId, attendees: [], source: "manual", provenance: "explicit" }).meetingId;
    }
    return pq.addAttendee(db, { meetingId, personId, status: "confirmed", source: "manual", provenance: "explicit" });
  })();
  notifyLocalWrite();
  return out;
}

/** Confirm a suggested attendee (the user's own claim, so a file or line dropping them later doesn't remove them). */
export function confirmNoteAttendee(noteId: string, personId: string): void {
  addNoteAttendee(noteId, personId);
}

/** Remove (or dismiss, for a suggestion) an attendee from the note's meeting. */
export function removeNoteAttendee(noteId: string, personId: string): void {
  write((db) => {
    const meetingId = getDb().getFirstSync<{ meeting_id: string | null }>("SELECT meeting_id FROM notes WHERE id = ? AND deleted_at IS NULL", noteId)?.meeting_id;
    if (meetingId) pq.removeAttendee(db, meetingId, personId);
  });
}
