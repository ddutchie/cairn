/**
 * Deterministic ids for People layer rows that represent a fact about a pair
 * (who attended which meeting, which note mentions whom, how two people relate)
 * or an outside record (a calendar event).
 *
 * The synced tables can't carry UNIQUE indexes (sync replays rows by id), so
 * two devices adding the same fact at the same time would otherwise create two
 * rows with random ids, and every timeline would list the meeting twice. With
 * the id derived from the natural key, both devices write the SAME row and the
 * sync engine's last-writer-wins converges on one. Re-adding a fact that was
 * removed revives that row instead of creating another.
 *
 * `:` never appears in generated ids (nanoid's alphabet is A-Za-z0-9_-), so the
 * parts can't run into each other. Pure: used by desktop and (later) mobile.
 */

import type { PersonEdgeType } from "../types/people";

export function attendeeRowId(meetingId: string, personId: string): string {
  return `att:${meetingId}:${personId}`;
}

export function mentionRowId(noteId: string, personId: string): string {
  return `men:${noteId}:${personId}`;
}

/** `partner` is symmetric, so its two ends are ordered; other types keep direction. */
export function edgeRowId(type: PersonEdgeType, sourceId: string, targetId: string): string {
  const [a, b] = type === "partner" && targetId < sourceId ? [targetId, sourceId] : [sourceId, targetId];
  return `edg:${type}:${a}:${b}`;
}

/** One meeting per calendar event per workspace, however many devices run Today. */
export function calendarMeetingId(workspaceId: string, externalId: string): string {
  return `cal:${workspaceId}:${externalId}`;
}

/**
 * A stub person created for a name or email nobody matched: one per workspace
 * per folded name (or email), so the same unknown attendee seen on two devices
 * becomes one suggestion, not two. `fold` is `foldName` for names.
 */
export function stubPersonId(workspaceId: string, key: string): string {
  return `stub:${workspaceId}:${key}`;
}

/**
 * The meeting a note became (attendees added to a plain note): one per note per
 * workspace, on every device. The workspace is part of the id because a note
 * can move to another workspace (`mergeProject`), and its meeting can't follow.
 */
export function noteMeetingId(workspaceId: string, noteId: string): string {
  return `nmt:${workspaceId}:${noteId}`;
}

/**
 * `note_action_items.line_key`: a stable hash of one checklist line. The box
 * state is left out ("- [x]" and "- [ ]" give the same key) so ticking an item
 * keeps its key; editing the text makes a new one. Two 32-bit FNV-1a passes
 * (different seeds) → 16 hex chars. Unique per note only (the table's key is
 * `(note_id, line_key)`); callers suffix duplicates of one line.
 */
export function actionItemLineKey(rawLine: string): string {
  const s = rawLine.trim().replace(/^([-*+]\s+)\[[ xX]\]/, "$1[ ]").replace(/\s+/g, " ");
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(a) + hex(b);
}

/**
 * The person made for a persona note by the migration: one per note per
 * workspace, so two devices (or a re-run) that migrate the same note write the
 * same row instead of two people. The workspace is part of the id for the same
 * reason as `noteMeetingId`.
 */
export function migratedPersonId(workspaceId: string, noteId: string): string {
  return `mig:${workspaceId}:${noteId}`;
}

/**
 * A team, from the workspace and the folded name it was first made with, so
 * two devices that each make "Sync" before they sync make one row. The id is
 * kept through renames; a later team that folds to a name whose id is taken
 * by a renamed one gets the next free `~2`, `~3`… (`createTeam`).
 */
export function teamRowId(workspaceId: string, foldedName: string, n = 1): string {
  return n > 1 ? `team:${workspaceId}:${foldedName}~${n}` : `team:${workspaceId}:${foldedName}`;
}

/** One person on one team: a second stint reuses the row. */
export function membershipRowId(teamId: string, personId: string): string {
  return `tm:${teamId}:${personId}`;
}
