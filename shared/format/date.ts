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

export interface RelativeTimeOptions {
  /** Returned for a null/empty/unparseable timestamp. Default `""`. */
  fallback?: string;
  /** Append " ago" (or " away" for future times). Default true. */
  suffix?: boolean;
  /**
   * Label future timestamps as "5m away". Off by default: a slightly-future
   * time is usually clock skew between devices and reads better as "just now".
   */
  future?: boolean;
  /** At or beyond this many days, show an absolute date instead. Default 7. */
  absoluteAfterDays?: number;
}

/** Relative label: "just now" / "5m ago" / "3h ago" / "2d ago", then absolute. */
export function formatRelative(iso: string | null | undefined, opts: RelativeTimeOptions = {}): string {
  const { fallback = "", suffix = true, future = false, absoluteAfterDays = 7 } = opts;
  if (!iso) return fallback;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return fallback;
  let diff = Date.now() - t;
  const isFuture = diff < 0;
  if (isFuture && !future) diff = 0;
  const mins = Math.floor(Math.abs(diff) / 60000);
  if (mins < 1) return "just now";
  const tail = suffix ? (isFuture ? " away" : " ago") : "";
  if (mins < 60) return `${mins}m${tail}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h${tail}`;
  const days = Math.floor(hrs / 24);
  if (days < absoluteAfterDays) return `${days}d${tail}`;
  return formatDate(iso);
}

export type DueDateStatus = "overdue" | "today" | "upcoming" | "none";

/**
 * Returns "overdue" | "today" | "upcoming" | "none" for a due date string.
 * Compares calendar days (not timestamps) so due-today is correct regardless
 * of time of day. `now` defaults to the real clock; callers that take an
 * injected `now` (e.g. atRiskCards) must pass it through.
 */
export function getDueDateStatus(dueDate: string | null | undefined, now: number = Date.now()): DueDateStatus {
  if (!dueDate) return "none";
  // Compare LOCAL calendar days so "today" means the user's today regardless of
  // the time of day (see parseIsoLocal for the UTC-midnight shift a bare
  // yyyy-MM-dd would otherwise cause).
  const due = parseIsoLocal(dueDate);
  if (Number.isNaN(due.getTime())) return "none";
  const today = new Date(now);
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const diff = due.getTime() - today.getTime();
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "upcoming";
}

/**
 * Absolute "when": null→"never", unparseable→passthrough, else "Nov 15, 02:30 PM".
 * From ArchitectureView (agent file index timestamps).
 */
export function formatWhenAbsent(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/**
 * Relative "when": "now" / "5m away" / "3h ago" / "5d ago", else absolute date.
 * Invalid→"—". From the automation schedule-builder.
 */
export function formatWhenRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const hrs = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const future = diff >= 0;
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ${future ? "away" : "ago"}`;
  if (hrs < 24) return `${hrs}h ${future ? "away" : "ago"}`;
  if (days < 30) return `${days}d ${future ? "away" : "ago"}`;
  return new Date(iso).toLocaleDateString();
}
