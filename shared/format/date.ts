/**
 * Shared date/time formatters — pure functions, no React or platform deps, so
 * desktop and mobile render dates identically.
 *
 * Extracted from desktop src/lib/utils.ts so both apps share one source of
 * truth. The behaviour is byte-for-byte the same as the desktop originals
 * (which now re-export from here).
 */

/** Absolute date: "Jan 5, 2026". */
export function formatDate(iso: string): string {
  return parseIsoLocal(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Parse an ISO string to a Date. A bare `yyyy-MM-dd` (as stored for due dates)
 * is parsed as a LOCAL calendar date rather than UTC midnight — otherwise
 * `new Date("2026-07-07")` is UTC midnight, which renders/compares as the
 * previous day in any negative-offset timezone (e.g. shows "July 6" for a date
 * set to July 7). Full datetime strings are parsed normally.
 */
export function parseIsoLocal(iso: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(iso);
}

/** Local calendar-day index — DST-safe (uses UTC math on the LOCAL y/m/d). */
function localDayNumber(d: Date): number {
  // Date.UTC on the local calendar fields gives exact 24h-spaced values, so the
  // difference of two of these is an exact whole-day count even across DST.
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

/**
 * Compact list-oriented date: "Today" / "Yesterday" / "3d ago" for the last
 * week, an absolute "Jan 5" otherwise. Future dates fall back to "Jan 5".
 * Used by session/agent lists where a terse relative label reads better than
 * the absolute {@link formatDate}.
 */
export function formatDateCompact(iso: string): string {
  const d = parseIsoLocal(iso);
  if (Number.isNaN(d.getTime())) return "Invalid date";

  // Compare LOCAL calendar days (DST-safe) so "Today"/"Yesterday" match the
  // user's wall clock.
  const diffDays = localDayNumber(new Date()) - localDayNumber(d);
  if (diffDays < 0) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Relative label: "just now" / "5m ago" / "3h ago" / "2d ago", then absolute. */
export function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

export type DueDateStatus = "overdue" | "today" | "upcoming" | "none";

/**
 * Returns "overdue" | "today" | "upcoming" | "none" for a due date string.
 * Compares calendar days (not timestamps) so due-today is correct regardless
 * of time of day.
 */
export function getDueDateStatus(dueDate: string | null | undefined): DueDateStatus {
  if (!dueDate) return "none";
  // Compare LOCAL calendar days so "today" means the user's today regardless of
  // the time of day (see parseIsoLocal for the UTC-midnight shift a bare
  // yyyy-MM-dd would otherwise cause).
  const due = parseIsoLocal(dueDate);
  if (Number.isNaN(due.getTime())) return "none";
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const diff = due.getTime() - today.getTime();
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "upcoming";
}
