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
