/**
 * Pure due-date predicates shared by desktop + mobile. Built on the canonical
 * `getDueDateStatus` so "overdue"/"today" semantics match the board, calendar,
 * and overview everywhere. Calendar-day comparison (not timestamps).
 */

import { getDueDateStatus, parseIsoLocal } from "../format/date";

/** A card is overdue when it has a due date strictly before today. */
export function isOverdue(dueDate: string | null | undefined): boolean {
  return getDueDateStatus(dueDate) === "overdue";
}

/** Due today (calendar day). */
export function isDueToday(dueDate: string | null | undefined): boolean {
  return getDueDateStatus(dueDate) === "today";
}

/**
 * Whether a due date falls within the next `days` calendar days, inclusive of
 * today and the end day. Overdue dates are NOT included (use isOverdue for
 * those). `days = 0` means "due today only".
 *
 * @param now injectable "today" for deterministic tests; defaults to new Date().
 */
export function isDueWithin(dueDate: string | null | undefined, days: number, now: Date = new Date()): boolean {
  if (!dueDate) return false;
  const due = parseIsoLocal(dueDate);
  if (Number.isNaN(due.getTime())) return false;
  due.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(today.getDate() + Math.max(0, days));
  return due.getTime() >= today.getTime() && due.getTime() <= end.getTime();
}
