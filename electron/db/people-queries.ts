/**
 * Cairn — People layer queries, desktop side. The portable part (people,
 * edges, meetings, attendees with per-source claims, mentions, card owners)
 * lives in `shared/people/queries.ts` so mobile runs the same code; this file
 * re-exports it and adds what only the desktop has: the `app_kv` flag and the
 * lifecycle code that touches device-local tables (`note_action_items`,
 * `person_profile_cache`). Plan: docs/plans/people-layer.md.
 *
 * Governance: NEVER construct a Database here — these run on the
 * already-constructed handle passed in by the caller.
 */

import type Database from "better-sqlite3";
import { ts } from "../../shared/people/clock";
import { deleteMeeting, getPerson, updatePerson } from "../../shared/people/queries";

export * from "../../shared/people/queries";

type Db = Database.Database;

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
  // A meeting this note made (`nmt:`) goes with its last note; calendar and manual meetings stay.
  const own = db.prepare("SELECT meeting_id FROM notes WHERE id = ?").get(noteId) as { meeting_id: string | null } | undefined;
  if (own?.meeting_id?.startsWith("nmt:")) {
    const others = db.prepare("SELECT 1 FROM notes WHERE meeting_id = ? AND id != ? AND deleted_at IS NULL LIMIT 1").get(own.meeting_id, noteId);
    if (!others) deleteMeeting(db, own.meeting_id);
  }
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

