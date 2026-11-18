/**
 * People layer ↔ note files: the optional `attendees` / `date` frontmatter
 * on meeting notes (docs/plans/people-layer.md, "Meeting properties in
 * frontmatter").
 *
 * The database is the source of truth and syncs; the frontmatter mirrors it so
 * the .md file stays readable and portable (Obsidian's Properties panel shows
 * the `[[wikilink]]` attendees as links). These two keys are not Cairn-owned
 * (`CAIRN_FRONTMATTER_KEYS`), so every ordinary note save keeps them as they
 * are; this module only rewrites them when attendance changes, and reads them
 * back when an external editor changes the file.
 *
 * Everything here is a no-op while the `feature.people` flag is off, so an
 * Obsidian vault that already uses an `attendees` property is left alone until
 * the People layer launches.
 */

import fs from "node:fs";
import matter from "gray-matter";
import type Database from "better-sqlite3";
import { findNoteFilePath } from "./host-shared/notes-io";
import { isPeopleEnabled } from "./db/people-queries";
import { captureNoteMeeting, notesAffectedBy, renderMeetingFrontmatter, type CaptureResult, type MeetingFrontmatter } from "./db/people-capture";
import { parseAttendeeList, parseMeetingDate } from "../shared/people/parse";

/** The frontmatter keys this module reads and writes; `when` is accepted on read only. */
export const MEETING_FRONTMATTER_KEYS = ["attendees", "date"] as const;

interface FileMeetingProps {
  hasAttendees: boolean;
  attendees: unknown;
  date: unknown;
}

function readMeetingProps(filePath: string): FileMeetingProps | null {
  try {
    const { data } = matter(fs.readFileSync(filePath, "utf-8"));
    return {
      hasAttendees: Object.prototype.hasOwnProperty.call(data, "attendees"),
      attendees: data.attendees,
      date: data.date ?? data.when,
    };
  } catch {
    return null;
  }
}

/**
 * After a note file changed outside Cairn, apply its `attendees` / `date` to
 * the note's meeting (source `frontmatter`). Removing the `attendees` key
 * removes the attendees it had added; people added elsewhere stay. `date`
 * only counts when `attendees` is present, so journal notes that use `date`
 * never become meetings. Returns what changed, or null when nothing applied.
 */
export function capturePeopleFromFile(db: Database.Database, filePath: string, noteId: string): CaptureResult | null {
  if (!isPeopleEnabled(db)) return null;
  const props = readMeetingProps(filePath);
  if (!props) return null;
  if (!props.hasAttendees) {
    const hadFromFile = db.prepare(`
      SELECT 1 FROM notes n JOIN meeting_attendees a ON a.meeting_id = n.meeting_id AND a.deleted_at IS NULL
      WHERE n.id = ? AND a.source = 'frontmatter' LIMIT 1
    `).get(noteId);
    if (!hadFromFile) return null;
    return captureNoteMeeting(db, { noteId, attendees: [], source: "frontmatter", provenance: "explicit" });
  }
  // A YAML list, or one string like "Ana, Ben and Cal" that the parser splits.
  const list = Array.isArray(props.attendees) ? props.attendees : parseAttendeeList(props.attendees);
  return captureNoteMeeting(db, {
    noteId,
    attendees: list,
    date: parseMeetingDate(props.date),
    source: "frontmatter",
    provenance: "explicit",
  });
}

/**
 * Rewrite one file's `attendees` / `date` in place, keeping every other key and
 * the body exactly as they are. `null` removes `attendees` (the note is no
 * longer a meeting) and keeps `date`, which may predate the meeting. Returns
 * true when bytes were written.
 */
export function writeMeetingFrontmatter(filePath: string, fm: MeetingFrontmatter | null): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }
  const parsed = matter(raw);
  const data: Record<string, unknown> = { ...parsed.data };
  if (fm) {
    data.attendees = fm.attendees;
    // Keep a user's richer value when it means the same moment (e.g. a Date the YAML parser made).
    if (parseMeetingDate(data.date ?? data.when) !== parseMeetingDate(fm.date)) data.date = fm.date;
  } else {
    if (!("attendees" in data)) return false;
    delete data.attendees;
  }
  const next = matter.stringify(parsed.content, data);
  if (next === raw) return false;
  fs.writeFileSync(filePath, next, "utf-8");
  return true;
}

/** What a refresh did: notes rewritten, and notes it couldn't write (retry later). */
export interface RefreshResult {
  written: string[];
  failed: string[];
}

/**
 * Bring the frontmatter of these notes in line with their meetings (after an
 * attendee change in the app, from an agent, or from sync). A note with no
 * meeting is left alone, even when its file lists attendees: Cairn may never
 * have read them (written while People was off), so it must not delete them;
 * flows that unlink a meeting on purpose call `writeMeetingFrontmatter(path, null)`.
 * `beforeWrite` lets the caller mark the write as Cairn's own (the file
 * watcher's `suppressNextChange`).
 */
export function refreshMeetingFrontmatter(
  db: Database.Database,
  workspacePath: string,
  noteIds: readonly string[],
  beforeWrite?: (noteId: string) => void,
): RefreshResult {
  const result: RefreshResult = { written: [], failed: [] };
  if (!isPeopleEnabled(db) || noteIds.length === 0) return result;
  const lookup = db.prepare(`
    SELECT n.id, p.name AS project_name FROM notes n
    JOIN projects p ON p.id = n.project_id
    WHERE n.id = ? AND n.deleted_at IS NULL
  `);
  for (const noteId of new Set(noteIds)) {
    try {
      const note = lookup.get(noteId) as { id: string; project_name: string } | undefined;
      if (!note) continue;
      const filePath = findNoteFilePath(workspacePath, note.project_name, note.id);
      if (!filePath) continue;
      const existing = readMeetingProps(filePath);
      const fm = renderMeetingFrontmatter(db, noteId, existing?.attendees);
      if (!fm) continue;
      if (existing?.hasAttendees && sameList(existing.attendees, fm.attendees)
        && parseMeetingDate(existing.date) === parseMeetingDate(fm.date)) continue;
      beforeWrite?.(noteId);
      if (writeMeetingFrontmatter(filePath, fm)) result.written.push(noteId);
    } catch (err) {
      console.error(`[people] couldn't update frontmatter for note ${noteId}:`, err);
      result.failed.push(noteId);
    }
  }
  return result;
}

function sameList(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The notes whose meeting frontmatter may be stale after these synced row
 * changes: notes that changed (their meeting link may have), notes of meetings
 * that changed or gained/lost an attendee, and notes of meetings a renamed
 * person attended. Empty while the People layer is off.
 */
export function meetingNotesForSync(
  db: Database.Database,
  applied: readonly { entity: string; entity_id: string }[],
): string[] {
  if (!isPeopleEnabled(db)) return [];
  const noteIds: string[] = [];
  const meetingIds: string[] = [];
  const personIds: string[] = [];
  const attendeeMeeting = db.prepare("SELECT meeting_id FROM meeting_attendees WHERE id = ?");
  for (const a of applied) {
    if (a.entity === "notes") noteIds.push(a.entity_id);
    else if (a.entity === "meetings") meetingIds.push(a.entity_id);
    else if (a.entity === "people") personIds.push(a.entity_id);
    else if (a.entity === "meeting_attendees") {
      // Attendee ids embed the meeting id, but meeting ids can contain `:`, so read the row.
      const row = attendeeMeeting.get(a.entity_id) as { meeting_id: string } | undefined;
      if (row) meetingIds.push(row.meeting_id);
    }
  }
  if (noteIds.length + meetingIds.length + personIds.length === 0) return [];
  return notesAffectedBy(db, { noteIds, meetingIds, personIds });
}
