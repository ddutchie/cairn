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
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** UTC calendar-day index (days since epoch) for a Date — DST-safe day math. */
function utcDayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000);
}

/**
 * Compact list-oriented date: "Today" / "Yesterday" / "3d ago" for the last
 * week, an absolute "Jan 5" otherwise. Future dates fall back to "Jan 5".
 * Used by session/agent lists where a terse relative label reads better than
 * the absolute {@link formatDate}.
 */
export function formatDateCompact(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Invalid date";

  // Compare UTC calendar days so day math isn't skewed by DST transitions.
  const diffDays = utcDayNumber(new Date()) - utcDayNumber(d);
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
  // yyyy-MM-dd is parsed by `new Date` as UTC midnight; comparing UTC calendar
  // days keeps due-today correct regardless of the device's timezone.
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return "none";
  const diff = utcDayNumber(due) - utcDayNumber(new Date());
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "upcoming";
}
