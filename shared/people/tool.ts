/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The agent's People tools (docs/plans/people-layer.md, "Agent and MCP
 * surface"): the `people` tool and the internal handlers behind the
 * `attendees` / `date` arguments of the note tools and `owner` on task tools.
 *
 * Handlers return `{ error }` instead of throwing, like the other tools here.
 * Private persona notes are removed from the results by the dispatcher
 * (`scrubAgentPrivate`), not here.
 */
import type { SyncDb } from "../sync/db-adapter";
import {
  addAttendee, addEdge, listAttendees, updateMeeting, addMention, createPerson, getPerson, getRelations, listOwnedCardIds,
  listPeople, listPersonMeetings, listPersonMentionNoteIds, listMeetingNoteIds, removeAttendeeSource, removeEdge,
  removeMention, setCardOwner, updatePerson,
} from "./queries";
import { captureNoteMeeting, loadCandidates, meetingLinkPending, resolvePerson } from "./capture";
import { ownedItemsIn } from "./action-items";
import { edgeRowId } from "./ids";
import { cleanProfileField, cleanRelationshipLabel, parseMeetingDate, PROFILE_FIELDS } from "./parse";
import {
  PEOPLE_STATUSES, PERSON_EDGE_TYPES, PROVENANCES, RELATIONSHIP_TYPES,
  type Person, type PeopleStatus, type PersonPatch, type Provenance, type Relationship,
} from "../types/people";

type Args = Record<string, any>;
type Db = SyncDb;

/**
 * What differs between platforms: `meetingsChanged` runs after attendee
 * writes (the desktop rewrites the note files' frontmatter; mobile has no
 * files, so it does nothing).
 */
export interface PeopleToolContext {
  meetingsChanged?: (noteIds: string[]) => void;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const strList = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : []);
const oneOf = <T extends string>(all: readonly T[], v: unknown): T | undefined => (all as readonly unknown[]).includes(v) ? v as T : undefined;

/** What an agent writes is confirmed when stated, a suggestion when inferred, unless it says otherwise. */
function writeStatus(args: Args): { status: PeopleStatus; provenance: Provenance } {
  const provenance = oneOf(PROVENANCES, args.provenance) ?? "explicit";
  const status = oneOf(PEOPLE_STATUSES, args.status) ?? (provenance === "inferred" ? "suggested" : "confirmed");
  return { status, provenance };
}

function personSummary(p: Person) {
  return {
    id: p.id,
    name: p.name,
    ...(p.aliases.length ? { aliases: p.aliases } : {}),
    ...(p.relationship.length ? { relationship: p.relationship.map((r) => (r.label ? `${r.type} (${r.label})` : r.type)) } : {}),
    ...(p.status !== "confirmed" ? { status: p.status } : {}),
    ...(p.title ? { title: p.title } : {}),
    ...(p.team ? { team: p.team } : {}),
    ...(p.location ? { location: p.location } : {}),
    ...(p.cadence ? { cadence: p.cadence } : {}),
    ...(p.isMe ? { isMe: true } : {}),
    ...(p.personaNoteId ? { personaNoteId: p.personaNoteId } : {}),
    ...(p.archivedAt ? { archived: true } : {}),
  };
}

/**
 * Find the person a call is about: by id, else by exact name/alias/email in
 * the workspace. Ambiguous names are an error that lists the candidates.
 */
function findPerson(db: Db, workspaceId: string, args: Args): Person | { error: string } {
  if (typeof args.personId === "string" && args.personId) {
    const p = getPerson(db, args.personId);
    return p && p.workspaceId === workspaceId ? p : { error: `No person with id "${args.personId}"` };
  }
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { error: "Pass personId or name" };
  const r = resolvePerson(db, workspaceId, name.includes("@") ? { email: name } : { name });
  if (r.kind === "match" || r.kind === "dismissed") return getPerson(db, r.personId)!;
  if (r.kind === "ambiguous") {
    const names = r.personIds.map((id) => `${getPerson(db, id)?.name ?? id} (${id})`).join(", ");
    return { error: `"${name}" matches more than one person: ${names}. Pass personId.` };
  }
  return { error: `No person named "${name}"` };
}

const isErr = (x: unknown): x is { error: string } => !!x && typeof x === "object" && typeof (x as Args).error === "string";

function noteTitle(db: Db, id: string): string | undefined {
  return (db.prepare("SELECT title FROM notes WHERE id = ? AND deleted_at IS NULL").get(id) as { title: string } | undefined)?.title;
}

// ── people tool ─────────────────────────────────────────────────────────────

/** The `people` tool. `workspaceId` is resolved by the dispatcher. */
export function peopleTool(db: Db, ctx: PeopleToolContext, args: Args): unknown {
  const workspaceId = String(args.workspaceId ?? "");
  if (!workspaceId) return { error: "No workspace found" };
  try {
    switch (args.action) {
      case "query": return queryPeople(db, workspaceId, args);
      case "get": return getOne(db, workspaceId, args);
      case "timeline": return timeline(db, workspaceId, args);
      case "relationships": return relationships(db, workspaceId, args);
      case "upsert": return upsert(db, workspaceId, args);
      case "link": return link(db, ctx, workspaceId, args);
      default: return { error: `Unknown people action "${args.action}"` };
    }
  } catch (err) {
    return { error: errMsg(err) };
  }
}

function queryPeople(db: Db, workspaceId: string, args: Args) {
  const status = oneOf(PEOPLE_STATUSES, args.status);
  const relationship = oneOf(RELATIONSHIP_TYPES, args.relationship);
  if (args.relationship && !relationship) return { error: `Unknown relationship "${args.relationship}". Use one of: ${RELATIONSHIP_TYPES.join(", ")}` };
  let list = listPeople(db, workspaceId, { statuses: status ? [status] : ["confirmed", "suggested"], relationship });
  const q = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
  if (q) list = list.filter((p) => [p.name, ...p.aliases, ...p.emails].some((s) => s.toLowerCase().includes(q)));
  const limit = listLimit(args.limit);
  return { people: list.slice(0, limit).map(personSummary), total: list.length };
}

/** A positive whole number, else the default page size. */
const PENDING_MEETING = "This note's meeting hasn't synced to this device yet. Try again after the next sync.";

function listLimit(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 25;
}

function ownedChecklistItems(db: Db, workspaceId: string, personId: string, limit: number): { noteId: string; text: string; done: number }[] {
  try {
    return db.prepare(`
      SELECT a.note_id AS noteId, a.text, a.done FROM note_action_items a
      JOIN notes n ON n.id = a.note_id AND n.deleted_at IS NULL
      WHERE a.owner_person_id = ? ORDER BY a.done, n.updated_at DESC LIMIT ?
    `).all(personId, limit) as { noteId: string; text: string; done: number }[];
  } catch (e) {
    if (!/no such table/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
  const candidates = loadCandidates(db, workspaceId);
  const notes = db.prepare(
    "SELECT id, content FROM notes WHERE workspace_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND content LIKE '%[%]%' ORDER BY updated_at DESC",
  ).all(workspaceId) as { id: string; content: string | null }[];
  const out: { noteId: string; text: string; done: number }[] = [];
  for (const n of notes) {
    for (const i of ownedItemsIn(n.content ?? "", candidates)) {
      if (i.ownerPersonId === personId) out.push({ noteId: n.id, text: i.text, done: i.done ? 1 : 0 });
    }
  }
  return out.sort((a, b) => a.done - b.done).slice(0, limit);
}

function relationsOf(db: Db, personId: string) {
  return getRelations(db, personId, { statuses: ["confirmed", "suggested"] }).map((r) => ({
    role: r.role,
    personId: r.otherId,
    name: getPerson(db, r.otherId)?.name,
    ...(r.edge.label ? { label: r.edge.label } : {}),
    ...(r.edge.endedAt ? { ended: r.edge.endedAt } : {}),
    ...(r.edge.status !== "confirmed" ? { status: r.edge.status } : {}),
  }));
}

function getOne(db: Db, workspaceId: string, args: Args) {
  const p = findPerson(db, workspaceId, args);
  if (isErr(p)) return p;
  const last = listPersonMeetings(db, p.id, 1)[0];
  return {
    ...personSummary(p),
    emails: p.emails,
    ...(p.slackId ? { slackId: p.slackId } : {}),
    ...(p.stage ? { stage: p.stage } : {}),
    ...(p.timezone ? { timezone: p.timezone } : {}),
    relations: relationsOf(db, p.id),
    ...(last ? { lastMeeting: { id: last.id, title: last.title, startsAt: last.startsAt } } : {}),
  };
}

function timeline(db: Db, workspaceId: string, args: Args) {
  const p = findPerson(db, workspaceId, args);
  if (isErr(p)) return p;
  const limit = listLimit(args.limit);
  const meetings = listPersonMeetings(db, p.id, limit).map((m) => ({
    id: m.id,
    title: m.title,
    startsAt: m.startsAt,
    notes: listMeetingNoteIds(db, m.id).map((id) => ({ id, title: noteTitle(db, id) })).filter((n) => n.title !== undefined),
  }));
  const meetingNotes = new Set(meetings.flatMap((m) => m.notes.map((n) => n.id)));
  const mentions = listPersonMentionNoteIds(db, p.id)
    .filter((id) => !meetingNotes.has(id) && id !== p.personaNoteId)
    .slice(0, limit)
    .map((id) => ({ id, title: noteTitle(db, id) }))
    .filter((n) => n.title !== undefined);
  const cardIds = listOwnedCardIds(db, p.id).slice(0, limit);
  const cards = cardIds.length === 0 ? [] : db.prepare(`
    SELECT c.id, c.title, COALESCE(b.name, '') AS column FROM task_cards c LEFT JOIN board_columns b ON b.id = c.column_id
    WHERE c.id IN (${cardIds.map(() => "?").join(",")}) AND c.deleted_at IS NULL
  `).all(...cardIds);
  // Checklist items in notes that name this person as owner: the desktop indexes them; a device
  // without that index (mobile) reads them from the note bodies.
  const items = ownedChecklistItems(db, workspaceId, p.id, limit);
  return {
    person: { id: p.id, name: p.name },
    meetings,
    mentions,
    tasks: cards,
    actionItems: items.map((i) => ({ noteId: i.noteId, text: i.text, done: i.done === 1 })),
  };
}

function relationships(db: Db, workspaceId: string, args: Args) {
  if (args.personId || args.name) {
    const p = findPerson(db, workspaceId, args);
    if (isErr(p)) return p;
    return { person: { id: p.id, name: p.name }, relations: relationsOf(db, p.id) };
  }
  const rows = db.prepare(`
    SELECT e.source_id AS sourceId, s.name AS sourceName, e.type, e.target_id AS targetId, t.name AS targetName,
           e.label, e.ended_at AS ended, e.status
    FROM person_edges e
    JOIN people s ON s.id = e.source_id AND s.deleted_at IS NULL
    JOIN people t ON t.id = e.target_id AND t.deleted_at IS NULL
    WHERE e.workspace_id = ? AND e.deleted_at IS NULL AND e.status != 'dismissed'
    ORDER BY s.name COLLATE NOCASE, e.type
  `).all(workspaceId) as Args[];
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 100;
  return {
    edges: rows.slice(0, limit).map((r) => Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== null && !(k === "status" && v === "confirmed")))),
    total: rows.length,
  };
}

function relationshipList(x: unknown, provenance: Provenance): Relationship[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: Relationship[] = [];
  for (const r of x) {
    const type = oneOf(RELATIONSHIP_TYPES, r?.type);
    if (!type) throw new Error(`Unknown relationship "${r?.type}". Use one of: ${RELATIONSHIP_TYPES.join(", ")}`);
    const { label, error } = cleanRelationshipLabel(r?.label);
    if (error) throw new Error(error);
    out.push({ type, ...(label ? { label } : {}), provenance });
  }
  return out;
}

function upsert(db: Db, workspaceId: string, args: Args) {
  const { status, provenance } = writeStatus(args);
  const aliases = strList(args.aliases);
  const emails = strList(args.emails).map((e) => e.toLowerCase());
  const rel = relationshipList(args.relationships, provenance);
  const cadence = args.cadence === "" ? null : oneOf(["weekly", "biweekly", "monthly"] as const, args.cadence);
  if (args.personaNoteId) {
    const ws = (db.prepare("SELECT workspace_id AS ws FROM notes WHERE id = ? AND deleted_at IS NULL").get(args.personaNoteId) as { ws: string } | undefined)?.ws;
    if (ws !== workspaceId) return { error: `No note with id "${args.personaNoteId}" in this workspace` };
  }

  let existing: Person | null = null;
  if (args.personId) {
    const p = findPerson(db, workspaceId, { personId: args.personId });
    if (isErr(p)) return p;
    existing = p;
  } else if (typeof args.name === "string" && args.name.trim()) {
    const r = resolvePerson(db, workspaceId, { name: args.name, email: emails[0] });
    if (r.kind === "ambiguous") {
      return { error: `"${args.name}" matches more than one person (${r.personIds.join(", ")}). Pass personId.` };
    }
    if (r.kind === "match" || r.kind === "dismissed") existing = getPerson(db, r.personId);
  } else {
    return { error: "Pass personId or name" };
  }

  // Profile fields: what the user typed wins. A call that only infers a value fills a gap; it never replaces one.
  const profile: Partial<Record<(typeof PROFILE_FIELDS)[number], string>> = {};
  for (const field of PROFILE_FIELDS) {
    if (args[field] === undefined) continue;
    const { value, error } = cleanProfileField(field, args[field]);
    if (error) return { error };
    if (value && (!existing?.[field] || provenance === "explicit")) profile[field] = value;
  }
  const slackId = typeof args.slackId === "string" && args.slackId.trim() ? args.slackId.trim() : undefined;
  if (slackId && !/^[A-Za-z0-9]{3,32}$/.test(slackId)) return { error: "slackId looks like U0123ABCD (a Slack member id)" };

  if (!existing) {
    const p = createPerson(db, {
      workspaceId, name: String(args.name).trim(), aliases, emails, relationship: rel, cadence: cadence ?? undefined,
      personaNoteId: args.personaNoteId, status, provenance, ...profile, ...(slackId ? { slackId } : {}),
    });
    return { created: true, person: personSummary(p) };
  }

  const patch: PersonPatch = {};
  if (args.personId && typeof args.name === "string" && args.name.trim() && args.name.trim() !== existing.name) patch.name = args.name.trim();
  if (aliases.length) patch.aliases = [...new Set([...existing.aliases, ...aliases])];
  if (emails.length) patch.emails = [...new Set([...existing.emails, ...emails])];
  if (rel) patch.relationship = rel;
  if (cadence !== undefined) patch.cadence = cadence;
  if (args.personaNoteId) patch.personaNoteId = args.personaNoteId;
  Object.assign(patch, profile);
  if (slackId && (!existing.slackId || provenance === "explicit")) patch.slackId = slackId;
  // An agent can confirm a suggestion, but never resurrects someone the user dismissed.
  if (oneOf(PEOPLE_STATUSES, args.status) && existing.status !== "dismissed") patch.status = args.status;
  if (Object.keys(patch).length === 0) return { updated: false, person: personSummary(existing) };
  return { updated: true, person: personSummary(updatePerson(db, existing.id, patch)) };
}

function noteInWorkspace(db: Db, noteId: unknown, workspaceId: string): string | { error: string } {
  const id = typeof noteId === "string" ? noteId : "";
  const row = db.prepare("SELECT workspace_id AS ws FROM notes WHERE id = ? AND deleted_at IS NULL").get(id) as { ws: string } | undefined;
  return row?.ws === workspaceId ? id : { error: `No note with id "${id}"` };
}

function link(db: Db, ctx: PeopleToolContext, workspaceId: string, args: Args) {
  const p = findPerson(db, workspaceId, args);
  if (isErr(p)) return p;
  const { status, provenance } = writeStatus(args);
  const remove = args.remove === true;

  switch (args.link) {
    case "edge": {
      const type = oneOf(PERSON_EDGE_TYPES, args.edgeType);
      if (!type) return { error: `edgeType must be one of: ${PERSON_EDGE_TYPES.join(", ")}` };
      const other = findPerson(db, workspaceId, { personId: args.otherPersonId });
      if (isErr(other)) return other;
      if (remove) {
        removeEdge(db, edgeRowId(type, p.id, other.id));
        return { removed: true, edge: { source: p.name, type, target: other.name } };
      }
      const edge = addEdge(db, { workspaceId, sourceId: p.id, targetId: other.id, type, status, provenance });
      return { linked: true, edge: { id: edge.id, source: p.name, type, target: other.name, status: edge.status } };
    }
    case "attendee": {
      const noteId = noteInWorkspace(db, args.noteId, workspaceId);
      if (isErr(noteId)) return noteId;
      let meetingId = (db.prepare("SELECT meeting_id FROM notes WHERE id = ?").get(noteId) as { meeting_id: string | null }).meeting_id;
      if (!remove && meetingLinkPending(db, meetingId)) return { error: PENDING_MEETING };
      if (remove) {
        // Withdraws only the agent's own claim; a person the user confirmed (or the calendar lists) stays.
        // False when someone else still lists them (or this call never declared them): they stay at the meeting.
        const gone = meetingId ? removeAttendeeSource(db, meetingId, p.id, "declared") : false;
        ctx.meetingsChanged?.([noteId]);
        return { removed: gone, attendee: { noteId, personId: p.id, name: p.name } };
      } else {
        if (!meetingId) meetingId = captureNoteMeeting(db, { noteId, attendees: [], source: "declared", provenance }).meetingId;
        addAttendee(db, { meetingId, personId: p.id, status, source: "declared", provenance });
      }
      ctx.meetingsChanged?.([noteId]);
      return { [remove ? "removed" : "linked"]: true, attendee: { noteId, personId: p.id, name: p.name } };
    }
    case "mention": {
      const noteId = noteInWorkspace(db, args.noteId, workspaceId);
      if (isErr(noteId)) return noteId;
      if (remove) removeMention(db, noteId, p.id);
      else addMention(db, noteId, p.id, "manual");
      return { [remove ? "removed" : "linked"]: true, mention: { noteId, personId: p.id, name: p.name } };
    }
    default:
      return { error: "link must be one of: edge, attendee, mention" };
  }
}

// ── arguments on other tools ────────────────────────────────────────────────

/**
 * `attendees` / `date` on `ensure_note` / `update_notes`: make the note a
 * meeting with these attendees, as declared by the agent. Values that are a
 * person id are taken as that person; others go through the name resolver
 * (ambiguous names become suggestions, unknown ones suggested stubs).
 */
export function setNoteAttendees(db: Db, ctx: PeopleToolContext, args: Args): unknown {
  const noteId = String(args.noteId ?? "");
  const note = db.prepare("SELECT workspace_id AS ws, meeting_id AS meetingId FROM notes WHERE id = ? AND deleted_at IS NULL")
    .get(noteId) as { ws: string; meetingId: string | null } | undefined;
  if (!note) return { error: `No note with id "${noteId}"` };
  const date = args.date !== undefined ? parseMeetingDate(args.date) : null;
  if (args.date !== undefined && args.date !== "" && !date) return { error: `Couldn't read the date "${args.date}". Use YYYY-MM-DD or an ISO datetime.` };
  const values = Array.isArray(args.attendees) ? args.attendees.filter((v: unknown) => typeof v === "string") as string[] : undefined;
  if (meetingLinkPending(db, note.meetingId)) return { error: PENDING_MEETING };
  // Only a date: set it on the note's meeting (a note without attendees doesn't become one).
  if (!values && !note.meetingId) return { meeting: null };
  try {
    const name = (id: string) => getPerson(db, id)?.name ?? id;
    if (!values && note.meetingId) {
      // Date only: move the meeting and leave attendance exactly as it is (re-capturing
      // would confirm suggestions and drop attendees who are now dismissed or archived).
      if (date) updateMeeting(db, note.meetingId, { startsAt: date });
      ctx.meetingsChanged?.([noteId]);
      const current = listAttendees(db, note.meetingId);
      const suggested = current.filter((a) => a.status === "suggested").map((a) => a.personId);
      return {
        meeting: {
          id: note.meetingId,
          attendees: current.filter((a) => a.status === "confirmed").map((a) => name(a.personId)),
          ...(suggested.length ? { needsConfirming: suggested.map((id) => `${name(id)} (${id})`) } : {}),
        },
      };
    }
    let attendees: string[] = [];
    let personIds: string[] = [];
    if (values) {
      const isPerson = db.prepare("SELECT 1 FROM people WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL");
      personIds = values.filter((v) => isPerson.get(v, note.ws));
      attendees = values.filter((v) => !personIds.includes(v));
    }
    const r = captureNoteMeeting(db, { noteId, attendees, personIds, date, source: "declared", provenance: "explicit" });
    ctx.meetingsChanged?.([noteId]);
    return {
      meeting: {
        id: r.meetingId,
        attendees: r.attendees.map(name),
        ...(r.suggested.length ? { needsConfirming: r.suggested.map((id) => `${name(id)} (${id})`) } : {}),
        ...(r.created.length ? { newPeople: r.created.map(name) } : {}),
        ...(r.removed.length ? { removed: r.removed.map(name) } : {}),
      },
    };
  } catch (err) {
    return { error: errMsg(err) };
  }
}

/** `owner` on `create_task` / `update_tasks`: a person id, email or exact name; empty clears. */
export function setCardOwnerArg(db: Db, ctx: PeopleToolContext, args: Args): unknown {
  const cardId = String(args.cardId ?? "");
  const card = db.prepare("SELECT workspace_id AS ws FROM task_cards WHERE id = ? AND deleted_at IS NULL").get(cardId) as { ws: string } | undefined;
  if (!card) return { error: `No task with id "${cardId}"` };
  if (args.owner !== undefined && args.owner !== null && typeof args.owner !== "string") return { error: "owner must be a name, email or person id, or an empty string to clear" };
  const owner = typeof args.owner === "string" ? args.owner.trim() : "";
  if (!owner) {
    setCardOwner(db, cardId, null);
    return { owner: null };
  }
  const p = findPerson(db, card.ws, getPerson(db, owner) ? { personId: owner } : { name: owner });
  if (isErr(p)) return { error: `owner: ${p.error}` };
  setCardOwner(db, cardId, p.id);
  return { owner: { id: p.id, name: p.name } };
}
