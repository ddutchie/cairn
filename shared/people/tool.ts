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
import {
  addMember, createTeam, deleteTeam, endMember, findTeamByName, foldTeamName, getTeam, listMemberships, listTeams,
  mergeTeams, normTeamName, teamKind, updateTeam,
} from "./team-queries";
import { mergePeople } from "./merge";
import { cleanProfileFieldWithPlaces, zoneForPlace } from "./place-zone";
import { cleanRelationshipLabel, parseMeetingDate, PROFILE_FIELDS } from "./parse";
import {
  LINK_KINDS, PEOPLE_STATUSES, PERSON_EDGE_TYPES, PROVENANCES, RELATIONSHIP_TYPES, TEAM_KINDS,
  type Person, type PeopleStatus, type PersonPatch, type Provenance, type Relationship, type Team, type TeamPatch,
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

/**
 * What an agent writes is confirmed by default; status "suggested" marks it as
 * inferred, which only fills gaps. `provenance` is no longer offered to the
 * model but is still read from older calls.
 */
function writeStatus(args: Args): { status: PeopleStatus; provenance: Provenance } {
  const given = oneOf(PROVENANCES, args.provenance);
  const status = oneOf(PEOPLE_STATUSES, args.status) ?? (given === "inferred" ? "suggested" : "confirmed");
  return { status, provenance: given ?? (status === "suggested" ? "inferred" : "explicit") };
}

function personSummary(p: Person) {
  return {
    id: p.id,
    name: p.name,
    ...(p.aliases.length ? { aliases: p.aliases } : {}),
    ...(p.relationship.length ? { relationship: p.relationship.map((r) => (r.label ? `${r.type} (${r.label})` : r.type)) } : {}),
    ...(p.status !== "confirmed" ? { status: p.status } : {}),
    ...(p.title ? { title: p.title } : {}),
    ...(p.teams.length ? { teams: p.teams.map((t) => [t.name, t.kind !== "team" ? t.kind : null, t.role].filter(Boolean).join(", ")) } : {}),
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
      case "archive": return archive(db, workspaceId, args);
      case "merge": return merge(db, ctx, workspaceId, args);
      case "teams": return teams(db, workspaceId, args);
      case "team_upsert": return teamUpsert(db, workspaceId, args);
      case "team_delete": return teamDelete(db, workspaceId, args);
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
    const { value, error } = cleanProfileFieldWithPlaces(field, args[field]);
    if (error) return { error };
    if (value && (!existing?.[field] || provenance === "explicit")) profile[field] = value;
  }
  // A place that names a zone fills a missing time zone, so the person lands on the map.
  if (profile.location && !profile.timezone && !existing?.timezone) {
    const zone = zoneForPlace(profile.location);
    if (zone) profile.timezone = zone;
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
  // An agent can confirm a suggestion, but never resurrects someone the user dismissed. Writing a person
  // as a stated fact (explicit, no status given) confirms a suggestion: capture often creates the stub
  // (an attendee name) a moment before the agent fills the person in, and that person is real.
  if (oneOf(PEOPLE_STATUSES, args.status) && existing.status !== "dismissed") patch.status = args.status;
  else if (args.status === undefined && existing.status === "suggested" && status === "confirmed") patch.status = "confirmed";
  if (Object.keys(patch).length === 0) return { updated: false, person: personSummary(existing) };
  return { updated: true, person: personSummary(updatePerson(db, existing.id, patch)) };
}

// ── archive and merge ───────────────────────────────────────────────────────

/** Archive someone (they leave the list, nothing is lost); `remove: true` brings them back. */
function archive(db: Db, workspaceId: string, args: Args) {
  const p = findPerson(db, workspaceId, args);
  if (isErr(p)) return p;
  const restore = args.remove === true;
  if (!!p.archivedAt === !restore) return { [restore ? "restored" : "archived"]: false, person: personSummary(p) };
  return { [restore ? "restored" : "archived"]: true, person: personSummary(updatePerson(db, p.id, { archivedAt: restore ? null : new Date().toISOString() })) };
}

/** Two people who are one: `otherPersonId` folds into this person, who keeps their own name. */
function merge(db: Db, ctx: PeopleToolContext, workspaceId: string, args: Args) {
  const p = findPerson(db, workspaceId, args);
  if (isErr(p)) return p;
  const other = findPerson(db, workspaceId, { personId: args.otherPersonId });
  if (isErr(other)) return { error: `otherPersonId: ${other.error}` };
  const { person, meetingNoteIds } = mergePeople(db, p.id, other.id);
  if (meetingNoteIds.length) ctx.meetingsChanged?.(meetingNoteIds);
  return { merged: true, person: personSummary(person), removed: { id: other.id, name: other.name } };
}

// ── teams ───────────────────────────────────────────────────────────────────

/** The team a call names: by id, else by name (the oldest when two share it). */
function findTeam(db: Db, workspaceId: string, ref: unknown): Team | { error: string } {
  const s = typeof ref === "string" ? ref.trim() : "";
  if (!s) return { error: "Pass team (the team's name)" };
  const byId = getTeam(db, s);
  if (byId && byId.workspaceId === workspaceId) return byId;
  return findTeamByName(db, workspaceId, s) ?? { error: `No team named "${s}". Teams: ${listTeams(db, workspaceId).map((t) => t.name).join(", ") || "none yet"}` };
}

/** Every team with its people, or one (with who used to be on it) when `team` names it. */
function teams(db: Db, workspaceId: string, args: Args) {
  const rows = listTeams(db, workspaceId);
  const people = new Map(listPeople(db, workspaceId, { includeArchived: true }).map((p) => [p.id, p]));
  const memberships = listMemberships(db, workspaceId);
  const byId = new Map(rows.map((t) => [t.id, t]));
  const nameCount = new Map<string, number>();
  for (const t of rows) nameCount.set(foldTeamName(t.name), (nameCount.get(foldTeamName(t.name)) ?? 0) + 1);
  const view = (t: Team, withPast: boolean) => {
    const mine = memberships.filter((m) => m.teamId === t.id && people.has(m.personId))
      .sort((a, b) => people.get(a.personId)!.name.localeCompare(people.get(b.personId)!.name));
    const member = (m: (typeof mine)[number]) => {
      const p = people.get(m.personId)!;
      return {
        id: p.id, name: p.name, ...(p.title ? { title: p.title } : {}), ...(m.role ? { role: m.role } : {}),
        ...(m.startedAt ? { since: m.startedAt } : {}), ...(m.endedAt ? { left: m.endedAt } : {}),
      };
    };
    const current = mine.filter((m) => !m.endedAt && !people.get(m.personId)!.archivedAt);
    const lead = t.leadPersonId ? people.get(t.leadPersonId) : undefined;
    const zones = [...new Set(current.map((m) => people.get(m.personId)!.timezone).filter(Boolean))];
    return {
      teamId: t.id,
      name: t.name,
      ...(t.kind !== "team" ? { kind: t.kind } : {}),
      ...(t.description ? { description: t.description } : {}),
      ...(lead ? { lead: { id: lead.id, name: lead.name, ...(current.some((m) => m.personId === lead.id) ? {} : { onTeam: false }) } } : {}),
      ...(t.parentTeamId && byId.get(t.parentTeamId) ? { parentTeam: byId.get(t.parentTeamId)!.name } : {}),
      ...(t.channel ? { channel: t.channel } : {}),
      ...(t.links.length ? { links: t.links } : {}),
      members: current.map(member),
      ...(withPast && mine.some((m) => m.endedAt) ? { pastMembers: mine.filter((m) => m.endedAt).map(member) } : {}),
      ...(zones.length ? { timezones: zones } : {}),
      ...((nameCount.get(foldTeamName(t.name)) ?? 0) > 1 ? { duplicateName: true } : {}),
    };
  };
  if (typeof args.team === "string" && args.team.trim()) {
    const t = findTeam(db, workspaceId, args.team);
    return isErr(t) ? t : view(t, true);
  }
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 50;
  const onATeam = new Set(memberships.filter((m) => !m.endedAt).map((m) => m.personId));
  const live = [...people.values()].filter((p) => !p.archivedAt && p.status === "confirmed");
  return {
    teams: rows.slice(0, limit).map((t) => view(t, false)),
    total: rows.length,
    withoutTeam: live.filter((p) => !onATeam.has(p.id)).length,
    ...([...nameCount.values()].some((n) => n > 1) ? { note: "Teams marked duplicateName share a name; merge them with team_upsert teamInfo.mergeInto (by teamId)." } : {}),
  };
}

const personRef = (db: Db, workspaceId: string, ref: string) => findPerson(db, workspaceId, getPerson(db, ref) ? { personId: ref } : { name: ref });

/**
 * Create or update a team's details (`teamInfo`), add people to it
 * (`teamInfo.members`, with `teamInfo.role`), take people off it
 * (`teamInfo.removeMembers`), or fold it into another (`teamInfo.mergeInto`).
 * What the user set wins over an inferred value.
 */
function teamUpsert(db: Db, workspaceId: string, args: Args) {
  const name = typeof args.team === "string" ? normTeamName(args.team) : "";
  if (!name) return { error: "Pass team (the team's name)" };
  const info = (args.teamInfo && typeof args.teamInfo === "object" ? args.teamInfo : {}) as Args;
  const { provenance } = writeStatus(args);
  const fill = provenance === "explicit";
  if (info.kind !== undefined && !(TEAM_KINDS as readonly unknown[]).includes(info.kind)) return { error: `kind must be one of: ${TEAM_KINDS.join(", ")}` };

  if (typeof info.mergeInto === "string" && info.mergeInto.trim()) {
    const drop = findTeam(db, workspaceId, args.team);
    if (isErr(drop)) return drop;
    const keep = findTeam(db, workspaceId, info.mergeInto);
    if (isErr(keep)) return { error: `mergeInto: ${keep.error}` };
    const kept = mergeTeams(db, keep.id, drop.id);
    return { merged: true, removed: { teamId: drop.id, name: drop.name }, team: teams(db, workspaceId, { team: kept.id }) };
  }

  const lead = typeof info.lead === "string" && info.lead.trim() ? personRef(db, workspaceId, info.lead) : undefined;
  if (isErr(lead)) return { error: `lead: ${lead.error}` };
  let parentTeamId: string | null | undefined;
  if (info.parentTeam === "") parentTeamId = null;
  else if (typeof info.parentTeam === "string" && info.parentTeam.trim()) {
    // A parent that doesn't exist is an error, not a new team: a typo would otherwise make one.
    const parent = findTeam(db, workspaceId, info.parentTeam);
    if (isErr(parent)) return { error: `parentTeam: ${parent.error}. Create it first with team_upsert.` };
    parentTeamId = parent.id;
  }
  const links = Array.isArray(info.links) ? info.links : undefined;
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);

  const found = getTeam(db, name) ?? findTeamByName(db, workspaceId, name);
  let team = found && found.workspaceId === workspaceId ? found : null;
  const created = !team;
  if (!team) {
    team = createTeam(db, {
      workspaceId, name, kind: info.kind !== undefined ? teamKind(info.kind) : undefined,
      description: text(info.description), channel: text(info.channel), links,
      leadPersonId: lead?.id, parentTeamId: parentTeamId ?? undefined,
    });
  } else {
    const t = team;
    const patch: TeamPatch = {};
    const take = (has: boolean) => fill || !has;
    if (text(info.rename)?.trim()) patch.name = text(info.rename)!;
    if (info.kind !== undefined && take(t.kind !== "team")) patch.kind = teamKind(info.kind);
    if (text(info.description) !== undefined && take(!!t.description)) patch.description = text(info.description)!;
    if (text(info.channel) !== undefined && take(!!t.channel)) patch.channel = text(info.channel)!;
    if (links && take(t.links.length > 0)) patch.links = links;
    if (lead && take(!!t.leadPersonId)) patch.leadPersonId = lead.id;
    if (parentTeamId !== undefined && take(!!t.parentTeamId)) patch.parentTeamId = parentTeamId;
    if (Object.keys(patch).length) team = updateTeam(db, t.id, patch);
  }

  // Members join (a guild or project beside their own team; nobody moves). The lead is one of them.
  const added: string[] = [];
  const role = text(info.role)?.trim() || undefined;
  const memberArgs = [...strList(info.members), ...(lead ? [lead.id] : [])];
  const current = new Set(listMemberships(db, workspaceId).filter((m) => m.teamId === team!.id && !m.endedAt).map((m) => m.personId));
  for (const m of memberArgs) {
    const p = personRef(db, workspaceId, m);
    if (isErr(p)) return { error: `members: ${p.error}` };
    if (current.has(p.id) && !role) continue;
    addMember(db, { teamId: team.id, personId: p.id, ...(role && strList(info.members).includes(m) ? { role } : {}) });
    if (!current.has(p.id)) added.push(p.name);
    current.add(p.id);
  }
  const removed: string[] = [];
  for (const m of strList(info.removeMembers)) {
    const p = personRef(db, workspaceId, m);
    if (isErr(p)) return { error: `removeMembers: ${p.error}` };
    if (!current.has(p.id)) continue;
    endMember(db, team.id, p.id);
    removed.push(p.name);
  }
  return {
    [created ? "created" : "updated"]: true,
    team: teams(db, workspaceId, { team: team.id }),
    ...(added.length ? { addedMembers: added } : {}),
    ...(removed.length ? { removedMembers: removed } : {}),
  };
}

/** Delete a team: its memberships go with it, and teams under it move up. */
function teamDelete(db: Db, workspaceId: string, args: Args) {
  const t = findTeam(db, workspaceId, args.team);
  if (isErr(t)) return t;
  deleteTeam(db, t.id);
  return { deleted: true, team: { teamId: t.id, name: t.name } };
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

  // `link` names the edge type itself; older calls passed link "edge" with `edgeType`.
  const edgeType = oneOf(PERSON_EDGE_TYPES, args.link) ?? (args.link === "edge" ? oneOf(PERSON_EDGE_TYPES, args.edgeType) : undefined);
  if (args.link === "edge" && !edgeType) return { error: `link must be one of: ${LINK_KINDS.join(", ")}` };
  switch (edgeType ? "edge" : args.link) {
    case "edge": {
      const type = edgeType!;
      const other = findPerson(db, workspaceId, { personId: args.otherPersonId });
      if (isErr(other)) return other;
      if (remove) {
        removeEdge(db, edgeRowId(type, p.id, other.id));
        return { removed: true, edge: { source: p.name, type, target: other.name } };
      }
      // `endedAt` records that it's over ("former manager", history kept); without it the edge is current.
      let endedAt: string | undefined;
      if (typeof args.endedAt === "string" && args.endedAt.trim()) {
        endedAt = args.endedAt.trim() === "now" ? new Date().toISOString() : parseMeetingDate(args.endedAt) ?? undefined;
        if (!endedAt) return { error: `Couldn't read endedAt "${args.endedAt}". Use YYYY-MM-DD, an ISO datetime or "now".` };
      }
      const { label, error } = cleanRelationshipLabel(args.label);
      if (error) return { error };
      const edge = addEdge(db, { workspaceId, sourceId: p.id, targetId: other.id, type, status, provenance, ...(label !== undefined ? { label } : {}), endedAt });
      return {
        linked: true,
        edge: { id: edge.id, source: p.name, type, target: other.name, status: edge.status, ...(edge.label ? { label: edge.label } : {}), ...(edge.endedAt ? { ended: edge.endedAt } : {}) },
      };
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
      return { error: `link must be one of: ${LINK_KINDS.join(", ")}` };
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
