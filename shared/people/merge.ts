/**
 * Merge two people who are one (capture made "Sam" while "Sam Whitfield"
 * already existed). Everything that points at the one going away moves to
 * the one that stays: meetings attended (with every source's claim),
 * mentions, edges, cards owned, teams led and team memberships. The one that
 * stays takes the other's name as an alias, their emails and relationships,
 * and any detail it lacks; the other is removed. Runs on desktop and mobile.
 *
 * Device-local tables (the desktop's checklist index and Slack cache) are the
 * caller's: see `electron/db/people-queries.ts`.
 *
 * Governance: NEVER construct a Database here — these run on the
 * already-constructed handle passed in by the caller.
 */
import type { SyncDb } from "../sync/db-adapter";
import { ts } from "./clock";
import { mergeClaims } from "./claims";
import { attendeeRowId, edgeRowId, mentionRowId } from "./ids";
import { getPerson, updatePerson } from "./queries";
import { moveMemberships } from "./team-queries";
import type { Person, PersonEdgeType, PersonPatch } from "../types/people";

type Db = SyncDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface MergeResult {
  person: Person;
  /** Notes of meetings whose attendees changed (the desktop rewrites their frontmatter). */
  meetingNoteIds: string[];
}

export function mergePeople(db: Db, keepId: string, dropId: string): MergeResult {
  if (keepId === dropId) throw new Error("Pick two different people to merge");
  const keep = getPerson(db, keepId);
  const drop = getPerson(db, dropId);
  if (!keep) throw new Error(`Person not found: ${keepId}`);
  if (!drop) throw new Error(`Person not found: ${dropId}`);
  if (keep.workspaceId !== drop.workspaceId) throw new Error("Those people are in different workspaces");
  const now = ts();
  const meetings = new Set<string>();

  db.transaction(() => {
    // Meetings: one attendee row per (meeting, person); claims from both are kept source by source.
    for (const a of db.prepare("SELECT * FROM meeting_attendees WHERE person_id = ? AND deleted_at IS NULL").all(dropId) as Row[]) {
      meetings.add(a.meeting_id);
      const id = attendeeRowId(a.meeting_id, keepId);
      const there = db.prepare("SELECT * FROM meeting_attendees WHERE id = ?").get(id) as Row | undefined;
      if (there && !there.deleted_at) {
        const status = there.status === "confirmed" || a.status === "confirmed" ? "confirmed" : there.status;
        db.prepare("UPDATE meeting_attendees SET sources = ?, status = ?, updated_at = ? WHERE id = ?")
          .run(mergeClaims(there.sources, a.sources), status, now, id);
      } else if (there) {
        db.prepare("UPDATE meeting_attendees SET deleted_at = NULL, status = ?, source = ?, sources = ?, provenance = ?, updated_at = ? WHERE id = ?")
          .run(a.status, a.source, a.sources, a.provenance, now, id);
      } else {
        db.prepare(`
          INSERT INTO meeting_attendees (id, meeting_id, person_id, status, source, sources, provenance, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, a.meeting_id, keepId, a.status, a.source, a.sources, a.provenance, a.created_at, now);
      }
      db.prepare("UPDATE meeting_attendees SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, a.id);
    }

    // Mentions.
    for (const m of db.prepare("SELECT * FROM note_mentions WHERE person_id = ? AND deleted_at IS NULL").all(dropId) as Row[]) {
      const id = mentionRowId(m.note_id, keepId);
      const there = db.prepare("SELECT deleted_at FROM note_mentions WHERE id = ?").get(id) as Row | undefined;
      if (!there) {
        db.prepare("INSERT INTO note_mentions (id, note_id, person_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, m.note_id, keepId, m.source, m.created_at, now);
      } else if (there.deleted_at) {
        db.prepare("UPDATE note_mentions SET deleted_at = NULL, source = ?, updated_at = ? WHERE id = ?").run(m.source, now, id);
      }
      db.prepare("UPDATE note_mentions SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, m.id);
    }

    // Edges: re-pointed; one between the two of them goes (nobody manages themself).
    for (const e of db.prepare("SELECT * FROM person_edges WHERE (source_id = ? OR target_id = ?) AND deleted_at IS NULL").all(dropId, dropId) as Row[]) {
      db.prepare("UPDATE person_edges SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, e.id);
      const sourceId = e.source_id === dropId ? keepId : e.source_id;
      const targetId = e.target_id === dropId ? keepId : e.target_id;
      if (sourceId === targetId) continue;
      const id = edgeRowId(e.type as PersonEdgeType, sourceId, targetId);
      const there = db.prepare("SELECT * FROM person_edges WHERE id = ?").get(id) as Row | undefined;
      if (there && !there.deleted_at) {
        // Current if either was; a confirmed edge stays confirmed.
        const endedAt = !there.ended_at || !e.ended_at ? null : there.ended_at;
        const status = there.status === "confirmed" || e.status === "confirmed" ? "confirmed" : there.status;
        db.prepare("UPDATE person_edges SET ended_at = ?, status = ?, label = COALESCE(label, ?), updated_at = ? WHERE id = ?")
          .run(endedAt, status, e.label, now, id);
      } else if (there) {
        db.prepare(`
          UPDATE person_edges SET deleted_at = NULL, source_id = ?, target_id = ?, label = ?, ended_at = ?, status = ?, provenance = ?,
            source_note_id = ?, updated_at = ? WHERE id = ?
        `).run(sourceId, targetId, e.label, e.ended_at, e.status, e.provenance, e.source_note_id, now, id);
      } else {
        db.prepare(`
          INSERT INTO person_edges (id, workspace_id, source_id, target_id, type, label, ended_at, status, provenance, source_note_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, e.workspace_id, sourceId, targetId, e.type, e.label, e.ended_at, e.status, e.provenance, e.source_note_id, e.created_at, now);
      }
    }

    // Cards, teams led, team memberships.
    db.prepare("UPDATE task_cards SET owner_person_id = ?, updated_at = ?, version = version + 1 WHERE owner_person_id = ? AND deleted_at IS NULL")
      .run(keepId, now, dropId);
    db.prepare("UPDATE teams SET lead_person_id = ?, updated_at = ? WHERE lead_person_id = ? AND deleted_at IS NULL").run(keepId, now, dropId);
    moveMemberships(db, dropId, keepId);

    // The person: the other name becomes an alias; gaps are filled, nothing set is replaced.
    const known = new Set([keep.name, ...keep.aliases].map((s) => s.toLowerCase()));
    const patch: PersonPatch = {
      aliases: [...keep.aliases, ...[drop.name, ...drop.aliases].filter((s) => !known.has(s.toLowerCase()))],
      emails: [...new Set([...keep.emails, ...drop.emails])],
      relationship: [...keep.relationship, ...drop.relationship.filter((r) => !keep.relationship.some((k) => k.type === r.type))],
    };
    if (!keep.slackId && drop.slackId) patch.slackId = drop.slackId;
    if (!keep.cadence && drop.cadence) patch.cadence = drop.cadence;
    if (!keep.personaNoteId && drop.personaNoteId) patch.personaNoteId = drop.personaNoteId;
    if (!keep.stage && drop.stage) patch.stage = drop.stage;
    for (const f of ["title", "location", "timezone"] as const) if (!keep[f] && drop[f]) patch[f] = drop[f];
    if (keep.status !== "confirmed" && drop.status === "confirmed") patch.status = "confirmed";
    if (drop.isMe && !keep.isMe) patch.isMe = true;
    if (drop.agentPrivate && !keep.agentPrivate) patch.agentPrivate = true;
    db.prepare("UPDATE people SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, dropId);
    updatePerson(db, keepId, patch);
  })();

  const noteIds = meetings.size === 0 ? [] : (db.prepare(
    `SELECT id FROM notes WHERE meeting_id IN (${[...meetings].map(() => "?").join(",")}) AND deleted_at IS NULL`,
  ).all(...meetings) as Row[]).map((r) => r.id as string);
  return { person: getPerson(db, keepId)!, meetingNoteIds: noteIds };
}
