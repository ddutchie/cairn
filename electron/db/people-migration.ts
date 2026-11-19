/**
 * People migration gate (W9): find the person and meeting notes a workspace
 * already has, and, only when the user approves candidates, turn them into
 * People layer rows. Plan: docs/plans/people-layer.md ("Migrating existing
 * person notes"; the playbook's inventory, person-entity and meeting-backlink
 * phases).
 *
 *  - `buildInventory` only reads. It runs whether or not the `feature.people`
 *    flag is on, so the user can look before turning anything on.
 *  - `applyMigration` writes, and only what the caller lists in `approvals`.
 *    It does nothing while the flag is off. It never edits a note body, never
 *    deletes, and is safe to re-run: person ids are deterministic
 *    (`migratedPersonId`), every other write goes through the existing
 *    idempotent paths (`createPerson`/`updatePerson`, `captureNoteMeeting`,
 *    `indexNotePeople`), and a person the user deleted or dismissed stays so.
 *    A dry run executes the same code inside a transaction that is rolled back,
 *    so the preview is exactly what an apply would do.
 *
 * Matching is the capture resolver's (`resolveIn`): exact, never fuzzy. A name
 * two candidates share is skipped until the user gives one a distinct name. A
 * first name ("Chris") is never guessed: the inventory suggests it as an alias
 * when it points at exactly one candidate, and the user has to accept it.
 */

import type Database from "better-sqlite3";
import { parseWikilinks } from "../../shared/notes/wikilinks";
import {
  firstName, guessMeeting, guessPersona, type InventoryNote, type NoteFrontmatterHints, type PersonaGuess,
} from "../../shared/people/inventory";
import {
  foldName, isGroupName, parseAttendeeValue, parseChecklist, withoutCode, type AttendeeRef,
} from "../../shared/people/parse";
import { migratedPersonId } from "../../shared/people/ids";
import type {
  AmbiguousShortName, MeetingCandidate, MigrationAction, MigrationApprovals, MigrationInventory, MigrationResult,
  MigrationSkipReason, NameResolution, OwnerUse, PersonaCandidate, ResolvedName,
} from "../../shared/types/people-migration";
import { createPerson, getMeeting, getPerson, isPeopleEnabled, listAttendees, updatePerson } from "./people-queries";
import { captureNoteMeeting, loadCandidates, resolveIn, type Candidate } from "./people-capture";
import { indexNotePeople } from "./people-indexing";

type Db = Database.Database;

/** Reads a note file's frontmatter keys Cairn doesn't store (supplied by the caller; null when unreadable). */
export type FrontmatterReader = (noteId: string) => NoteFrontmatterHints | null;

export interface InventoryOptions {
  readFrontmatter?: FrontmatterReader;
}

interface LoadedNote extends InventoryNote {
  projectId: string;
  archived: boolean;
  meetingId: string | null;
}

interface PersonRow {
  id: string;
  name: string;
  status: string;
  persona_note_id: string | null;
}

// ── Loading ───────────────────────────────────

function loadNotes(db: Db, workspaceId: string, readFrontmatter?: FrontmatterReader): LoadedNote[] {
  const tags = new Map(
    (db.prepare("SELECT id, name FROM tags WHERE workspace_id = ?").all(workspaceId) as { id: string; name: string }[]).map((t) => [t.id, t.name]),
  );
  const rows = db.prepare(`
    SELECT id, project_id, title, folder, content, tag_ids, archived_at, meeting_id FROM notes
    WHERE workspace_id = ? AND deleted_at IS NULL AND type != 'template'
    ORDER BY created_at, id
  `).all(workspaceId) as {
    id: string; project_id: string; title: string; folder: string; content: string; tag_ids: string; archived_at: string | null; meeting_id: string | null;
  }[];
  return rows.map((r) => {
    let ids: unknown = [];
    try { ids = JSON.parse(r.tag_ids); } catch { /* damaged tag list: no tags */ }
    return {
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      folder: r.folder ?? "",
      content: r.content ?? "",
      tagNames: (Array.isArray(ids) ? ids : []).map((id) => tags.get(String(id))).filter((n): n is string => !!n),
      archived: r.archived_at != null,
      meetingId: r.meeting_id,
      frontmatter: readFrontmatter?.(r.id) ?? null,
    };
  });
}

function livePeople(db: Db, workspaceId: string): PersonRow[] {
  return db.prepare("SELECT id, name, status, persona_note_id FROM people WHERE workspace_id = ? AND deleted_at IS NULL").all(workspaceId) as PersonRow[];
}

// ── Analysis ──────────────────────────────────

interface Guessed {
  note: LoadedNote;
  guess: PersonaGuess;
}

/** Persona guesses and meeting-like notes, with a note that is both resolved one way. */
function classify(notes: LoadedNote[], personaOf: Map<string, string>): { personas: Guessed[]; meetings: Array<{ note: LoadedNote; guess: NonNullable<ReturnType<typeof guessMeeting>> }> } {
  const personas: Guessed[] = [];
  const meetings: Array<{ note: LoadedNote; guess: NonNullable<ReturnType<typeof guessMeeting>> }> = [];
  for (const note of notes) {
    const persona = guessPersona(note);
    const meeting = personaOf.has(note.id) ? null : guessMeeting(note);
    // A confident persona note isn't a meeting; a weak persona guess on a note that lists attendees is a meeting.
    if (persona && (!meeting || persona.confidence !== "low")) personas.push({ note, guess: persona });
    else if (meeting) meetings.push({ note, guess: meeting });
  }
  return { personas, meetings };
}

function keysOf(g: PersonaGuess, title: string): Set<string> {
  return new Set([g.name, title, ...g.aliases].map(foldName).filter(Boolean));
}

interface Collision {
  person?: PersonRow;
  matchedBy?: "persona_note" | "email" | "name";
  skip?: MigrationSkipReason;
}

/** How a persona note relates to the people that exist now. */
function collide(people: PersonRow[], existing: Candidate[], note: LoadedNote, g: PersonaGuess, name: string): Collision {
  const byId = new Map(people.map((p) => [p.id, p]));
  const linked = people.find((p) => p.persona_note_id === note.id);
  if (linked) return { person: linked, matchedBy: "persona_note", skip: "already_linked" };
  const hits = new Map<string, "email" | "name">();
  let conflict = false;
  for (const email of g.emails) {
    const r = resolveIn(existing, { email });
    if (r.kind === "match") hits.set(r.personId, "email");
    else if (r.kind === "ambiguous") conflict = true;
    else if (r.kind === "dismissed") return { person: byId.get(r.personId), matchedBy: "email", skip: "dismissed" };
  }
  const r = resolveIn(existing, { name });
  if (r.kind === "match" && !hits.has(r.personId)) hits.set(r.personId, "name");
  else if (r.kind === "ambiguous") conflict = true;
  else if (r.kind === "dismissed") return { person: byId.get(r.personId), matchedBy: "name", skip: "dismissed" };
  if (conflict || hits.size > 1) {
    const first = [...hits.keys()][0];
    return { person: first ? byId.get(first) : undefined, matchedBy: first ? hits.get(first) : undefined, skip: "identity_conflict" };
  }
  const [id, by] = [...hits.entries()][0] ?? [];
  if (!id) return {};
  const person = byId.get(id)!;
  return { person, matchedBy: by, skip: person.persona_note_id && person.persona_note_id !== note.id ? "person_has_persona" : undefined };
}

function nameOf(ref: AttendeeRef): string {
  return ref.name ?? ref.email ?? "";
}

interface Analysis {
  inventory: MigrationInventory;
  guesses: Map<string, Guessed>;
}

function analyse(db: Db, workspaceId: string, notes: LoadedNote[]): Analysis {
  const people = livePeople(db, workspaceId);
  const existing = loadCandidates(db, workspaceId);
  const personaOf = new Map(people.filter((p) => p.persona_note_id).map((p) => [p.persona_note_id!, p.id]));
  const { personas, meetings } = classify(notes, personaOf);
  const guesses = new Map(personas.map((p) => [p.note.id, p]));

  // Same folded name on two candidate notes (Sebastien Morel twice): neither is applied by itself.
  const byName = new Map<string, string[]>();
  for (const { note, guess } of personas) {
    if (note.archived) continue;
    const key = foldName(guess.name);
    byName.set(key, [...(byName.get(key) ?? []), note.id]);
  }

  const cands: PersonaCandidate[] = personas.map(({ note, guess }) => {
    const ambiguousWith = (byName.get(foldName(guess.name)) ?? []).filter((id) => id !== note.id);
    const c = collide(people, existing, note, guess, guess.name);
    let action: MigrationAction = "create";
    let skipReason: MigrationSkipReason | undefined;
    if (note.archived && c.skip !== "already_linked") { action = "skip"; skipReason = "archived"; }
    else if (c.skip) { action = "skip"; skipReason = c.skip; }
    else if (ambiguousWith.length) { action = "skip"; skipReason = "ambiguous_name"; }
    else if (c.person) action = "link_existing";
    return {
      noteId: note.id, projectId: note.projectId, title: note.title, folder: note.folder, tags: note.tagNames,
      confidence: guess.confidence, score: guess.score, reasons: guess.reasons,
      name: guess.name, aliases: guess.aliases, emails: guess.emails, archived: note.archived,
      ambiguousWith,
      ...(c.person ? { existingPerson: { id: c.person.id, name: c.person.name, status: c.person.status, matchedBy: c.matchedBy! } } : {}),
      action, ...(skipReason ? { skipReason } : {}),
      suggestedAliases: [], linkedFromNotes: 0, ownedItems: 0,
    };
  });
  cands.sort((a, b) => foldName(a.name).localeCompare(foldName(b.name)) || a.noteId.localeCompare(b.noteId));

  // Resolve names the way capture will once the candidates are people: existing people, plus the notes
  // that would become people (those with nothing to collide with, and the ambiguous pairs, which stay ambiguous).
  const pseudo: Candidate[] = cands
    .filter((c) => !c.archived && (c.action === "create" || c.skipReason === "ambiguous_name"))
    .map((c): Candidate => ({
      id: `note:${c.noteId}`, status: "confirmed", slackId: null, emails: c.emails,
      keys: keysOf(guesses.get(c.noteId)!.guess, c.title),
    }));
  const combined = [...existing, ...pseudo];
  const noteIdOfPerson = new Map(cands.filter((c) => c.existingPerson).map((c) => [c.existingPerson!.id, c.noteId]));
  const candByNote = new Map(cands.map((c) => [c.noteId, c]));

  const resolveName = (ref: AttendeeRef): ResolvedName => {
    const text = nameOf(ref);
    if (ref.name && !ref.email && isGroupName(ref.name)) return { text, resolution: "group" };
    const r = resolveIn(combined, ref);
    if (r.kind === "match") {
      return r.personId.startsWith("note:")
        ? { text, resolution: "candidate", candidateNoteIds: [r.personId.slice(5)] }
        : { text, resolution: "person", personId: r.personId };
    }
    if (r.kind === "ambiguous") {
      return {
        text, resolution: "ambiguous",
        candidateNoteIds: r.personIds.filter((id) => id.startsWith("note:")).map((id) => id.slice(5)),
        personIds: r.personIds.filter((id) => !id.startsWith("note:")),
      };
    }
    return { text, resolution: "unknown" };
  };

  // Checklist owners across the workspace's live notes.
  const owners = new Map<string, OwnerUse>();
  let ownedItems = 0;
  let openItems = 0;
  for (const note of notes) {
    if (note.archived) continue;
    for (const item of parseChecklist(note.content)) {
      if (!item.owner) continue;
      ownedItems++;
      if (!item.done) openItems++;
      const resolved = resolveName(item.owner);
      const key = foldName(item.owner.email ?? item.owner.name ?? "");
      const use = owners.get(key) ?? {
        key, text: resolved.text, count: 0, open: 0, resolution: resolved.resolution as NameResolution,
        ...(resolved.personId ? { personId: resolved.personId } : {}),
        ...(resolved.candidateNoteIds?.length ? { candidateNoteIds: resolved.candidateNoteIds } : {}),
      };
      use.count++;
      if (!item.done) use.open++;
      owners.set(key, use);
      const target = resolved.candidateNoteIds?.length === 1 && resolved.resolution === "candidate" ? resolved.candidateNoteIds[0]
        : resolved.personId ? noteIdOfPerson.get(resolved.personId) : undefined;
      if (target) candByNote.get(target)!.ownedItems++;
    }
  }

  // Wikilinks that point at exactly one candidate's title or name.
  const titleToNote = new Map<string, string[]>();
  for (const c of cands) {
    if (c.archived) continue;
    for (const k of new Set([foldName(c.title), foldName(c.name)])) titleToNote.set(k, [...(titleToNote.get(k) ?? []), c.noteId]);
  }
  for (const note of notes) {
    if (note.archived) continue;
    const seen = new Set<string>();
    for (const link of parseWikilinks(withoutCode(note.content))) {
      const name = parseAttendeeValue(link.raw)?.name;
      const hit = name ? titleToNote.get(foldName(name)) : undefined;
      if (hit && hit.length === 1 && hit[0] !== note.id) seen.add(hit[0]);
    }
    for (const id of seen) candByNote.get(id)!.linkedFromNotes++;
  }

  // First names the corpus uses (as an owner or an attendee) that no candidate answers to yet.
  const used = new Map<string, string>();
  const noteUnknown = (text: string, resolution: NameResolution) => { if (resolution === "unknown") used.set(foldName(text), text); };
  for (const o of owners.values()) noteUnknown(o.text, o.resolution);

  const meetingCands: MeetingCandidate[] = meetings
    .filter(({ note: n }) => !n.archived)
    .map(({ note: n, guess }) => {
      const attendees = guess.attendees.map(resolveName);
      for (const a of attendees) noteUnknown(a.text, a.resolution);
      return {
        noteId: n.id, projectId: n.projectId, title: n.title, folder: n.folder, via: guess.via, date: guess.date,
        alreadyMeeting: n.meetingId != null, attendees,
      };
    });
  meetingCands.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.title.localeCompare(b.title) || a.noteId.localeCompare(b.noteId));

  const ambiguousShortNames: AmbiguousShortName[] = [];
  for (const [key, text] of used) {
    const hits = cands.filter((c) => !c.archived && (c.action !== "skip" || c.skipReason === "ambiguous_name")
      && firstName(c.name) && foldName(firstName(c.name)!) === key);
    if (hits.length === 1) hits[0].suggestedAliases.push(text);
    else if (hits.length > 1) ambiguousShortNames.push({ text, candidateNoteIds: hits.map((h) => h.noteId) });
  }
  ambiguousShortNames.sort((a, b) => a.text.localeCompare(b.text));

  const ownerList = [...owners.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const collisions = cands.filter((c) => c.existingPerson && c.skipReason !== "already_linked").length;
  return {
    guesses,
    inventory: {
      workspaceId,
      counts: {
        notesScanned: notes.length,
        personaCandidates: cands.length,
        highConfidence: cands.filter((c) => c.confidence === "high").length,
        meetingNotes: meetingCands.length,
        ownedChecklistItems: ownedItems,
        openOwnedChecklistItems: openItems,
        archivedCandidates: cands.filter((c) => c.archived).length,
        existingPeople: people.length,
        collisions,
        ambiguousNames: cands.filter((c) => c.ambiguousWith.length > 0).length,
      },
      personas: cands,
      meetings: meetingCands,
      owners: ownerList,
      ambiguousShortNames,
    },
  };
}

/**
 * Scan a workspace for person notes, meeting notes, checklist owners, ambiguous
 * names and collisions with existing people. Read-only: never writes, and
 * works with the People flag off.
 */
export function buildInventory(db: Db, workspaceId: string, opts: InventoryOptions = {}): MigrationInventory {
  return analyse(db, workspaceId, loadNotes(db, workspaceId, opts.readFrontmatter)).inventory;
}

// ── Apply ─────────────────────────────────────

export interface ApplyOptions extends InventoryOptions {
  /** Run everything, report it, and roll it back. */
  dryRun?: boolean;
  /**
   * Bring these meeting notes' `attendees`/`date` frontmatter in line with their
   * meetings (`refreshMeetingFrontmatter`); returns the notes it rewrote.
   * Skipped in a dry run. Without it, files are never touched.
   */
  refreshFrontmatter?: (noteIds: string[]) => { written: string[]; failed: string[] };
}

class Rollback extends Error {}

/** Approvals come from the renderer: keep only well-formed entries. */
function sanitize(a: MigrationApprovals | undefined): MigrationApprovals {
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.trim() !== "") : []);
  return {
    personas: (Array.isArray(a?.personas) ? a!.personas! : [])
      .filter((p) => p && typeof p.noteId === "string")
      .map((p) => ({ noteId: p.noteId, ...(typeof p.name === "string" ? { name: p.name } : {}), aliases: strings(p.aliases) })),
    meetings: strings(a?.meetings),
  };
}

const countMentions = (db: Db, ws: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM note_mentions m JOIN notes n ON n.id = m.note_id WHERE n.workspace_id = ? AND m.deleted_at IS NULL").get(ws) as { n: number }).n;
const countOwned = (db: Db, ws: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM note_action_items a JOIN notes n ON n.id = a.note_id WHERE n.workspace_id = ? AND a.owner_person_id IS NOT NULL").get(ws) as { n: number }).n;

/** Everything one attendee row says that a re-run could change. */
function attendanceSignature(db: Db, meetingId: string | null): string {
  if (!meetingId) return "";
  const m = getMeeting(db, meetingId);
  if (!m) return "";
  const rows = db.prepare("SELECT person_id, status, sources, deleted_at FROM meeting_attendees WHERE meeting_id = ? ORDER BY person_id").all(meetingId);
  return JSON.stringify([m.startsAt, m.title, rows]);
}

/**
 * Apply what the user approved. Returns what happened per approval; with
 * `dryRun` the same result without any write. A no-op (`applied: false`) while
 * the People flag is off.
 */
export function applyMigration(db: Db, workspaceId: string, approvals: MigrationApprovals, opts: ApplyOptions = {}): MigrationResult {
  const dryRun = opts.dryRun === true;
  const zero = { mentionsBefore: 0, mentionsAfter: 0, ownedItemsBefore: 0, ownedItemsAfter: 0 };
  if (!isPeopleEnabled(db)) {
    return { dryRun, applied: false, reason: "flag_off", personas: [], meetings: [], index: zero, frontmatterNotes: [] };
  }
  approvals = sanitize(approvals);
  const notes = loadNotes(db, workspaceId, opts.readFrontmatter);
  let result!: MigrationResult;
  let meetingNotes: string[] = [];
  try {
    db.transaction(() => {
      ({ result, meetingNotes } = run(db, workspaceId, approvals, notes, dryRun));
      if (dryRun) throw new Rollback();
    })();
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  // Files change only after the database committed, and never in a dry run.
  if (dryRun) result.frontmatterNotes = meetingNotes;
  else if (opts.refreshFrontmatter) {
    // The database already committed; a note whose file couldn't be written is reported and retried by re-running.
    const r = opts.refreshFrontmatter(meetingNotes);
    result.frontmatterNotes = r.written;
    if (r.failed.length) result.frontmatterFailed = r.failed;
  }
  return result;
}

function run(db: Db, workspaceId: string, approvals: MigrationApprovals, notes: LoadedNote[], dryRun: boolean): { result: MigrationResult; meetingNotes: string[] } {
  const { inventory, guesses } = analyse(db, workspaceId, notes);
  const byNote = new Map(inventory.personas.map((c) => [c.noteId, c]));
  const result: MigrationResult = {
    dryRun, applied: true, personas: [], meetings: [], index: { mentionsBefore: 0, mentionsAfter: 0, ownedItemsBefore: 0, ownedItemsAfter: 0 }, frontmatterNotes: [],
  };

  const seen = new Set<string>();
  const approvedNotes = new Set((approvals.personas ?? []).map((a) => a.noteId));
  const blocked = blockedGroups(db, workspaceId, approvals, byNote, guesses);
  for (const approval of approvals.personas ?? []) {
    if (seen.has(approval.noteId)) continue;
    seen.add(approval.noteId);
    result.personas.push(blocked.has(approval.noteId)
      ? { noteId: approval.noteId, outcome: "skipped", reason: "ambiguous_name" }
      : applyPersona(db, workspaceId, approval, byNote, guesses, approvedNotes));
  }

  // Mentions and action items for every note, now that the people exist. The
  // body "Attendees:" pass stays out: it suggests attendees for notes nobody approved.
  const touched = (approvals.personas?.length ?? 0) > 0 || (approvals.meetings?.length ?? 0) > 0;
  result.index.mentionsBefore = countMentions(db, workspaceId);
  result.index.ownedItemsBefore = countOwned(db, workspaceId);
  if (touched) indexNotePeople(db, workspaceId, undefined, { bodyMeetings: false });
  result.index.mentionsAfter = countMentions(db, workspaceId);
  result.index.ownedItemsAfter = countOwned(db, workspaceId);

  const meetingNotes: string[] = [];
  const noteById = new Map(notes.map((n) => [n.id, n]));
  const meetingIds = new Set<string>();
  const meetingCandidates = new Set(inventory.meetings.map((m) => m.noteId));
  for (const noteId of approvals.meetings ?? []) {
    if (meetingIds.has(noteId)) continue;
    meetingIds.add(noteId);
    const r = applyMeeting(db, workspaceId, noteId, noteById.get(noteId), meetingCandidates);
    result.meetings.push(r);
    if (r.outcome !== "skipped" && r.attendees.length > 0) meetingNotes.push(noteId);
  }
  return { result, meetingNotes };
}

/**
 * Notes that share a name are migrated all or none. A group is blocked (every
 * approved member skipped) when two members would get the same final name, or
 * when any member couldn't be migrated now (another person answers to the name,
 * the user deleted or dismissed theirs): migrating the rest would leave the
 * bare name pointing at one of them.
 */
function blockedGroups(
  db: Db,
  workspaceId: string,
  approvals: MigrationApprovals,
  byNote: Map<string, PersonaCandidate>,
  guesses: Map<string, Guessed>,
): Set<string> {
  const approved = new Map((approvals.personas ?? []).map((a) => [a.noteId, a]));
  const people = livePeople(db, workspaceId);
  const existing = loadCandidates(db, workspaceId);
  const blocked = new Set<string>();
  const seenGroup = new Set<string>();
  for (const [noteId] of approved) {
    const g = guesses.get(noteId);
    const cand = byNote.get(noteId);
    if (!g || !cand || seenGroup.has(noteId)) continue;
    const keys = new Set([cand.name, cand.title].map(foldName));
    const members = [...guesses.values()].filter((o) => !o.note.archived && [o.guess.name, o.note.title].some((k) => keys.has(foldName(k))));
    if (members.length < 2) continue;
    members.forEach((m) => seenGroup.add(m.note.id));
    const mine = members.filter((m) => approved.has(m.note.id));
    const finalNames = mine.map((m) => foldName(approved.get(m.note.id)!.name?.trim() || byNote.get(m.note.id)!.name));
    const clash = new Set(finalNames).size !== finalNames.length;
    const stuck = mine.some((m) => {
      const name = approved.get(m.note.id)!.name?.trim() || byNote.get(m.note.id)!.name;
      const c = collide(people, existing, m.note, { ...m.guess, name }, name);
      const gone = !!(db.prepare("SELECT deleted_at FROM people WHERE id = ?").get(migratedPersonId(workspaceId, m.note.id)) as { deleted_at: string | null } | undefined)?.deleted_at;
      return gone || (!!c.skip && c.skip !== "already_linked") || !!c.person;
    });
    if (clash || stuck) mine.forEach((m) => blocked.add(m.note.id));
  }
  return blocked;
}

function applyPersona(
  db: Db,
  workspaceId: string,
  approval: NonNullable<MigrationApprovals["personas"]>[number],
  byNote: Map<string, PersonaCandidate>,
  guesses: Map<string, Guessed>,
  approved: ReadonlySet<string>,
): MigrationResult["personas"][number] {
  const skip = (reason: MigrationSkipReason, personId?: string): MigrationResult["personas"][number] =>
    ({ noteId: approval.noteId, outcome: reason === "already_linked" ? "unchanged" : "skipped", ...(personId ? { personId } : {}), reason });
  const cand = byNote.get(approval.noteId);
  const guessed = guesses.get(approval.noteId);
  if (!cand || !guessed) return skip("not_a_candidate");
  if (cand.archived) return skip("archived");

  const name = approval.name?.trim() || cand.name;
  const people = livePeople(db, workspaceId);
  const existing = loadCandidates(db, workspaceId);
  const c = collide(people, existing, guessed.note, { ...guessed.guess, name }, name);
  if (c.skip === "already_linked") return skip("already_linked", c.person?.id);

  // The person this run made from the note earlier and the user deleted since: leave them deleted.
  const id = migratedPersonId(workspaceId, approval.noteId);
  const row = db.prepare("SELECT deleted_at FROM people WHERE id = ?").get(id) as { deleted_at: string | null } | undefined;
  if (row?.deleted_at) return skip("removed_by_user", id);
  if (c.skip) return skip(c.skip, c.person?.id);

  // Notes that share this one's name or title (two "Sam Whitfield"s) are decided together: the title of each
  // stays a way to find that person, so migrating one alone would make the bare name point at them only.
  // Every other note of the group must be approved in this run (or already linked); the user names them apart.
  if (!c.person) {
    const keys = new Set([cand.name, cand.title].map(foldName));
    const group = [...guesses.values()].filter((g) => g.note.id !== approval.noteId && !g.note.archived
      && [g.guess.name, g.note.title].some((k) => keys.has(foldName(k))));
    const settled = (id: string) => approved.has(id) || people.some((p) => p.persona_note_id === id);
    if (group.some((g) => !settled(g.note.id))) return skip("ambiguous_name");
  }

  // Aliases: what the note says, what the user accepted, and the title it is known by. An alias that is
  // another person's name or alias is left out: it would make every later match on it ambiguous.
  const takenElsewhere = (alias: string) => existing.some((e) => e.id !== c.person?.id && e.keys.has(foldName(alias)));
  // Nor a name or title another candidate note carries (two "Sam Whitfield"s): that name must stay ambiguous.
  const shared = new Set([...guesses.values()].filter((g) => g.note.id !== approval.noteId && !g.note.archived)
    .flatMap((g) => [g.guess.name, g.note.title].map(foldName)));
  const wanted = [...cand.aliases, ...(approval.aliases ?? []), ...(foldName(cand.title) !== foldName(name) ? [cand.title] : [])]
    .map((a) => a.trim()).filter((a) => a && foldName(a) !== foldName(name) && !shared.has(foldName(a)));
  const aliases = [...new Map(wanted.map((a) => [foldName(a), a])).values()];

  if (c.person) {
    const person = getPerson(db, c.person.id)!;
    const have = new Set([person.name, ...person.aliases].map(foldName));
    const newAliases = aliases.filter((a) => !have.has(foldName(a)) && !takenElsewhere(a));
    const newEmails = cand.emails.filter((e) => !person.emails.includes(e));
    updatePerson(db, person.id, {
      personaNoteId: approval.noteId,
      ...(person.status === "suggested" ? { status: "confirmed" as const } : {}),
      ...(newAliases.length ? { aliases: [...person.aliases, ...newAliases] } : {}),
      ...(newEmails.length ? { emails: [...person.emails, ...newEmails] } : {}),
    });
    return { noteId: approval.noteId, outcome: "linked", personId: person.id };
  }
  const person = createPerson(db, {
    id, workspaceId, name,
    aliases: aliases.filter((a) => !takenElsewhere(a)),
    emails: cand.emails,
    personaNoteId: approval.noteId,
    status: "confirmed",
    provenance: "convention",
  });
  return { noteId: approval.noteId, outcome: "created", personId: person.id };
}

function applyMeeting(
  db: Db,
  workspaceId: string,
  noteId: string,
  note: LoadedNote | undefined,
  meetingCandidates: Set<string>,
): MigrationResult["meetings"][number] {
  const skipped = (reason: MigrationSkipReason): MigrationResult["meetings"][number] =>
    ({ noteId, outcome: "skipped", attendees: [], suggested: [], unmatched: [], reason });
  if (!note || note.archived) return skipped(note?.archived ? "archived" : "not_a_candidate");
  if (!meetingCandidates.has(noteId)) return skipped("not_a_candidate");
  const guess = guessMeeting(note);
  if (!guess) return skipped("not_a_candidate");

  const candidates = loadCandidates(db, workspaceId);
  const refs = [...guess.frontmatterAttendees, ...guess.bodyAttendees];
  const matched = refs.some((a) => {
    const k = resolveIn(candidates, a).kind;
    return k === "match" || k === "ambiguous";
  });
  const before = attendanceSignature(db, note.meetingId);
  if (!matched && !note.meetingId) return skipped("no_matching_attendees");

  // The meeting's date: a frontmatter date governs when the file lists attendees (as capture reads it);
  // a body "When:" moves only a meeting this note made, never a calendar one.
  const current = note.meetingId ? getMeeting(db, note.meetingId) : null;
  const dateAllowed = !current || current.source === "note";
  const fmDate = guess.frontmatterAttendees.length ? guess.date : null; // the date the inventory showed
  const common = { noteId, provenance: "convention" as const, status: "confirmed" as const, keepRemoved: true, noStubs: true, candidates };
  let meetingId = note.meetingId;
  if (guess.frontmatterAttendees.length) {
    const r = captureNoteMeeting(db, { ...common, attendees: guess.frontmatterAttendees, date: dateAllowed ? fmDate : null, source: "frontmatter" });
    meetingId = r.meetingId;
  }
  if (guess.bodyAttendees.length) {
    const r = captureNoteMeeting(db, {
      ...common, attendees: guess.bodyAttendees, source: "body_line",
      date: dateAllowed && !guess.frontmatterAttendees.length ? guess.date : null,
    });
    meetingId = r.meetingId;
  }
  const after = attendanceSignature(db, meetingId);
  const attending = meetingId ? listAttendees(db, meetingId) : [];
  const unmatched = refs.filter((a) => resolveIn(candidates, a).kind === "none").map(nameOf);
  return {
    noteId,
    outcome: before === after ? "unchanged" : "captured",
    ...(meetingId ? { meetingId } : {}),
    attendees: attending.filter((a) => a.status === "confirmed").map((a) => a.personId),
    suggested: attending.filter((a) => a.status === "suggested").map((a) => a.personId),
    unmatched: [...new Set(unmatched)],
  };
}
