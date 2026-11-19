/**
 * People layer indexing (W4): what a note's body says about people, rebuilt on
 * every save in the same incremental pass as the auto-relationships
 * (`computeAutoRelationships`). Plan: docs/plans/people-layer.md ("Capture",
 * "Data model", "Graph and Insights").
 *
 * Three passes per note, all no-ops while the `feature.people` flag is off:
 *   - Mentions: `[[Persona note]]` → a `note_mentions` row (source `wikilink`)
 *     for each person whose persona note that is. Wikilink mentions that are
 *     gone from the body are removed; manual and owner mentions are not touched.
 *   - Action items: the note's owned checklist lines → `note_action_items`
 *     (device-local, rebuilt from scratch). The owner resolves to a person only
 *     on a single exact match; team owners, ambiguous and unknown names stay
 *     unassigned and never create stub people.
 *   - Body meeting lines: `**Attendees:**` / `**When:**` → the note's meeting
 *     (`captureNoteMeeting`, source `body_line`, provenance `convention`).
 *     Only people who already exist are matched: names nobody matches stay
 *     plain text, because saves happen while typing and a stub per half-typed
 *     name ("Ch", "Chri", "Chris") churned synced rows. A note with no
 *     matching name doesn't become a meeting. The people it lists are
 *     SUGGESTED attendees, never applied silently, so they stay out of meeting
 *     lists, the graph and the frontmatter until the user confirms them.
 *     Someone the user removed or dismissed is not added again while the line
 *     still lists them. Removing the lines removes the attendees they added,
 *     as removing the `attendees` frontmatter key does. A body "When:" never
 *     overrides a date a frontmatter `attendees` list governs.
 *
 * The frontmatter is NOT rewritten from body lines: the body line is the
 * user's own record, and mirroring it into `attendees` would make the file
 * watcher read the same people back as a second (frontmatter) source.
 */

import type Database from "better-sqlite3";
import { parseWikilinks } from "../../shared/notes/wikilinks";
import { foldName, parseAttendeeValue, parseBodyMeetingLines, withoutCode } from "../../shared/people/parse";
import { ownedItemsIn } from "../../shared/people/action-items";
import { parseClaims, serializeClaims } from "../../shared/people/claims";
import { mentionRowId } from "../../shared/people/ids";
import { addMention, attendeeIdsFromSource, getMeeting, isPeopleEnabled } from "./people-queries";
import { captureNoteMeeting, loadCandidates, resolveIn, type Candidate } from "./people-capture";

type Db = Database.Database;

interface NoteRow {
  id: string;
  content: string;
}

/** Stay well under SQLite's bound-parameter limit. */
const ID_CHUNK = 500;

/**
 * Re-index the People facts of these notes (live notes of `workspaceId` only;
 * other ids are ignored). With no `noteIds`, every live note of the workspace.
 * Idempotent: running it twice on the same bodies changes nothing.
 */
export function indexNotePeople(
  db: Db,
  workspaceId: string,
  noteIds?: readonly string[],
  /** `bodyMeetings: false` leaves the `**Attendees:**` pass out (the migration attaches meetings only for notes the user approved). */
  opts: { bodyMeetings?: boolean } = {},
): void {
  if (!isPeopleEnabled(db)) return;
  const notes = noteIds ? liveNotes(db, workspaceId, noteIds) : (db.prepare(
    "SELECT id, content FROM notes WHERE workspace_id = ? AND archived_at IS NULL AND deleted_at IS NULL",
  ).all(workspaceId) as NoteRow[]);
  if (notes.length === 0) return;

  const personaPeople = personaIndex(db, workspaceId);
  // Loaded once for the whole batch: neither pass below creates people.
  const bodyCandidates = loadCandidates(db, workspaceId);
  const candidates = bodyCandidates;

  db.transaction(() => {
    for (const n of notes) {
      const body = n.content ?? "";
      // One bad note must not leave the rest of the batch unindexed.
      try {
        indexMentions(db, n.id, body, personaPeople);
        indexActionItems(db, n.id, body, candidates);
      } catch (err) {
        console.error(`[people] couldn't index note ${n.id}:`, err);
      }
    }
  })();

  // Meeting capture runs per note in its own transaction (captureNoteMeeting
  // opens one) and may create people, so it goes last.
  if (opts.bodyMeetings === false) return;
  for (const n of notes) {
    try {
      indexBodyMeeting(db, n.id, n.content ?? "", bodyCandidates);
    } catch (err) {
      console.error(`[people] couldn't capture meeting lines of note ${n.id}:`, err);
    }
  }
}

/**
 * Re-index these notes wherever they live (the file watcher and sync call this
 * for notes that changed outside the app's save path). Groups by workspace.
 * No-op while the flag is off; never throws.
 */
export function indexNotesPeople(db: Db, noteIds: readonly string[]): void {
  try {
    if (noteIds.length === 0 || !isPeopleEnabled(db)) return;
    const byWorkspace = new Map<string, string[]>();
    for (let i = 0; i < noteIds.length; i += ID_CHUNK) {
      const chunk = noteIds.slice(i, i + ID_CHUNK);
      const rows = db.prepare(
        `SELECT id, workspace_id FROM notes WHERE deleted_at IS NULL AND id IN (${chunk.map(() => "?").join(",")})`,
      ).all(...chunk) as { id: string; workspace_id: string }[];
      for (const r of rows) {
        const list = byWorkspace.get(r.workspace_id);
        if (list) list.push(r.id);
        else byWorkspace.set(r.workspace_id, [r.id]);
      }
    }
    for (const [workspaceId, ids] of byWorkspace) indexNotePeople(db, workspaceId, ids);
  } catch (err) {
    console.error("[people] indexing failed:", err);
  }
}

function liveNotes(db: Db, workspaceId: string, ids: readonly string[]): NoteRow[] {
  const out: NoteRow[] = [];
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
    out.push(...db.prepare(
      `SELECT id, content FROM notes
       WHERE workspace_id = ? AND archived_at IS NULL AND deleted_at IS NULL AND id IN (${chunk.map(() => "?").join(",")})`,
    ).all(workspaceId, ...chunk) as NoteRow[]);
  }
  return out;
}

// ── Mentions ──────────────────────────────────

interface PersonaIndex {
  /** Folded persona note title → people whose persona note it is. */
  byTitle: Map<string, string[]>;
  /** Persona note id → people, to skip a persona note linking to itself. */
  byNote: Map<string, Set<string>>;
}

/** Live, non-dismissed people with a live persona note, keyed by that note's title. */
function personaIndex(db: Db, workspaceId: string): PersonaIndex {
  const rows = db.prepare(`
    SELECT p.id, n.id AS note_id, n.title FROM people p
    JOIN notes n ON n.id = p.persona_note_id AND n.deleted_at IS NULL
    WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND p.status != 'dismissed'
  `).all(workspaceId) as { id: string; note_id: string; title: string }[];
  const byTitle = new Map<string, string[]>();
  const byNote = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = foldName(r.title);
    if (!key) continue;
    const list = byTitle.get(key);
    if (list) list.push(r.id);
    else byTitle.set(key, [r.id]);
    let set = byNote.get(r.note_id);
    if (!set) byNote.set(r.note_id, (set = new Set()));
    set.add(r.id);
  }
  return { byTitle, byNote };
}

/**
 * People a body links to through `[[Persona note]]`. A title two people share
 * is ambiguous and links to neither (as in `resolveIn`).
 */
function mentionedPersonIds(body: string, index: PersonaIndex, noteId?: string): Set<string> {
  const out = new Set<string>();
  const own = noteId ? index.byNote.get(noteId) : undefined;
  for (const link of parseWikilinks(withoutCode(body))) {
    const ref = parseAttendeeValue(link.raw);
    if (!ref?.name) continue;
    const hits = index.byTitle.get(foldName(ref.name)) ?? [];
    if (hits.length !== 1) continue;
    if (!own?.has(hits[0])) out.add(hits[0]);
  }
  return out;
}

/**
 * A mention row marks who tombstoned it by its source: this pass releases a
 * mention (link gone) by setting `owner`, which nothing else writes yet; a
 * tombstone that still says `wikilink` or `manual` was the user's removal and
 * is not revived while the link stays.
 */
const RELEASED_SOURCE = "owner";

function indexMentions(db: Db, noteId: string, body: string, index: PersonaIndex): void {
  const want = mentionedPersonIds(body, index, noteId);
  const had = db.prepare(
    "SELECT person_id FROM note_mentions WHERE note_id = ? AND source = 'wikilink' AND deleted_at IS NULL",
  ).all(noteId) as { person_id: string }[];
  const release = db.prepare(
    "UPDATE note_mentions SET deleted_at = ?, source = ?, updated_at = ? WHERE note_id = ? AND person_id = ? AND deleted_at IS NULL",
  );
  const now = new Date().toISOString();
  for (const { person_id } of had) if (!want.has(person_id)) release.run(now, RELEASED_SOURCE, now, noteId, person_id);
  const row = db.prepare("SELECT deleted_at, source FROM note_mentions WHERE id = ?");
  for (const pid of want) {
    const existing = row.get(mentionRowId(noteId, pid)) as { deleted_at: string | null; source: string } | undefined;
    if (existing?.deleted_at && existing.source !== RELEASED_SOURCE) continue; // the user removed it
    // addMention leaves an existing live mention (and its source) as it is.
    addMention(db, noteId, pid, "wikilink");
  }
}

// ── Action items ──────────────────────────────

function indexActionItems(db: Db, noteId: string, body: string, candidates: Candidate[]): void {
  db.prepare("DELETE FROM note_action_items WHERE note_id = ?").run(noteId);
  const insert = db.prepare(
    "INSERT INTO note_action_items (note_id, line_key, owner_text, owner_person_id, text, done) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // Keys, owners and duplicate-line suffixes come from the shared parser, the same one mobile ticks lines with.
  for (const item of ownedItemsIn(body, candidates)) {
    insert.run(noteId, item.lineKey, item.ownerText, item.ownerPersonId, item.text, item.done ? 1 : 0);
  }
}

// ── Body meeting lines ────────────────────────

function indexBodyMeeting(db: Db, noteId: string, body: string, candidates: Candidate[]): void {
  const lines = parseBodyMeetingLines(body);
  const current = db.prepare("SELECT meeting_id FROM notes WHERE id = ?").get(noteId) as { meeting_id: string | null } | undefined;
  const meetingId = current?.meeting_id ?? null;
  if (!lines) {
    if (!meetingId) return;
    if (attendeeIdsFromSource(db, meetingId, "body_line").length > 0) {
      captureNoteMeeting(db, { noteId, attendees: [], source: "body_line", provenance: "convention", candidates });
    }
    releaseBodyClaims(db, meetingId, new Set());
    return;
  }
  // Names nobody matches stay plain text (no stub people from half-typed or
  // prose names); with nothing to match, a note that isn't a meeting yet
  // doesn't become one.
  const matchesSomeone = lines.attendees.some((a) => resolveIn(candidates, a).kind !== "none");
  if (!meetingId && !matchesSomeone) return;

  const meeting = meetingId ? getMeeting(db, meetingId) : null;
  // One rule for the date: a frontmatter `date` (read with `attendees`) wins, so
  // a body "When:" moves only a meeting this note made that no frontmatter claims.
  const fromFrontmatter = !!meetingId && attendeeIdsFromSource(db, meetingId, "frontmatter").length > 0;
  const date = (!meeting || meeting.source === "note") && !fromFrontmatter ? lines.date : null;
  const r = captureNoteMeeting(db, {
    noteId, attendees: lines.attendees, date, source: "body_line", provenance: "convention",
    status: "suggested", keepRemoved: true, noStubs: true, candidates,
  });
  releaseBodyClaims(db, r.meetingId, new Set([...r.attendees, ...r.suggested, ...r.skipped]));
}

/**
 * A person removed from the meeting by someone else keeps this source's claim
 * on (that's how `keepRemoved` knows not to re-add them). Once the body no
 * longer lists them, turn the claim off, so adding them to the line again later
 * is a fresh request rather than a revival of the removal.
 */
function releaseBodyClaims(db: Db, meetingId: string, listed: ReadonlySet<string>): void {
  const rows = db.prepare("SELECT id, person_id, sources FROM meeting_attendees WHERE meeting_id = ? AND deleted_at IS NOT NULL")
    .all(meetingId) as { id: string; person_id: string; sources: string }[];
  const now = new Date().toISOString();
  for (const r of rows) {
    if (listed.has(r.person_id)) continue;
    const claims = parseClaims(r.sources);
    if (claims.body_line?.on !== true) continue;
    claims.body_line = { on: false, at: now };
    db.prepare("UPDATE meeting_attendees SET sources = ?, updated_at = ? WHERE id = ?").run(serializeClaims(claims), now, r.id);
  }
}
