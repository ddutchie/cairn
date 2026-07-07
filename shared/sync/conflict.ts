/**
 * Conflict-copy helpers — pure string logic shared by desktop and mobile.
 *
 * When two devices edit the same note body offline, the sync engine keeps the
 * losing side as a "conflict copy": a cloned note row whose id is
 *   `<originalId>_conflict_<deviceId>_<base36ts>`
 * and whose title gets a ` (conflicted copy — <deviceId>)` suffix
 * (see engine.ts makeConflictCopy). These helpers let any UI recognise such a
 * row, recover the original id, and produce a clean display title — without
 * duplicating the regex in every renderer.
 */

/**
 * Matches the id suffix the engine appends: `_conflict_<deviceId>_<ts>`.
 * The deviceId itself may contain underscores (e.g. `mobile_5rrpiqng…`), and
 * the trailing `<ts>` is `Date.now().toString(36)` (lowercase alphanumeric, no
 * underscore). So capture the device greedily up to the FINAL `_<base36ts>`.
 */
const CONFLICT_ID_RE = /^(.+)_conflict_(.+)_([0-9a-z]+)$/;

/** The human-readable title suffix, e.g. " (conflicted copy — mobile_abc)". */
const CONFLICT_TITLE_RE = /\s*\(conflicted copy — (.+)\)\s*$/;

export interface ConflictInfo {
  /** Whether this row is a conflict copy. */
  isConflict: boolean;
  /** The id of the note this is a conflicted copy of (null if not a conflict). */
  originalId: string | null;
  /** The device that produced the copy (null if unknown). */
  deviceId: string | null;
}

/** Inspect a note id (and optional title) to determine conflict-copy status. */
export function inspectConflict(id: string, title?: string | null): ConflictInfo {
  const m = CONFLICT_ID_RE.exec(id);
  if (m) return { isConflict: true, originalId: m[1], deviceId: m[2] };
  // Fall back to the title marker if the id scheme ever changes.
  if (title && CONFLICT_TITLE_RE.test(title)) {
    const dm = CONFLICT_TITLE_RE.exec(title);
    return { isConflict: true, originalId: null, deviceId: dm?.[1] ?? null };
  }
  return { isConflict: false, originalId: null, deviceId: null };
}

/** True if the given id/title identifies a conflict copy. */
export function isConflictCopy(id: string, title?: string | null): boolean {
  return inspectConflict(id, title).isConflict;
}

/** Strip the " (conflicted copy — …)" suffix for a clean display title. */
export function cleanConflictTitle(title: string): string {
  return title.replace(CONFLICT_TITLE_RE, "").trim();
}
