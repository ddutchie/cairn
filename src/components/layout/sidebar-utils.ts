/**
 * Pure helpers for the sidebar, extracted from sidebar.tsx so the
 * keyboard-shortcut mapping, per-project open-card aggregation, and due-date
 * severity bucketing can be unit-tested without rendering the sidebar.
 */

/**
 * Map each visible nav view to its keyboard shortcut label (⌘3, ⌘4, …).
 *
 * Overview is ⌘1 and Notes is ⌘2, so views start at `base` (3). Shortcuts past
 * ⌘9 are dropped (empty string) since there's no single-digit key for them.
 *
 * The modifier symbol matches the platform: ⌘ on macOS, Ctrl elsewhere — the
 * page.tsx shortcut handler accepts both `metaKey` and `ctrlKey`, so the label
 * must reflect whichever the user actually presses.
 */
export function buildShortcutMap(
  visibleNavItems: Array<{ view: string }>,
  base = 3,
  isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform),
): Map<string, string> {
  const map = new Map<string, string>();
  const prefix = isMac ? "\u2318" : "Ctrl+";
  visibleNavItems.forEach((item, idx) => {
    const num = idx + base;
    map.set(item.view, num <= 9 ? `${prefix}${num}` : "");
  });
  return map;
}

/**
 * Count non-archived ("open") cards per project in a single pass — O(cards)
 * rather than O(projects × cards).
 */
export function countOpenCardsByProject(
  cards: Array<{ projectId: string; archivedAt?: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of cards) {
    if (c.archivedAt) continue;
    counts.set(c.projectId, (counts.get(c.projectId) ?? 0) + 1);
  }
  return counts;
}

export type DueDateSeverity = "danger" | "warning" | null;

/**
 * Bucket a due date relative to `now` into a severity:
 *  - "danger"  → overdue (in the past)
 *  - "warning" → due within the next 7 days (inclusive, including today)
 *  - null      → more than 7 days away
 *
 * Uses whole-day ceiling so "later today" still counts as 0 days (due today).
 */
export function dueDateSeverity(dueDate: string, now: number = Date.now()): DueDateSeverity {
  const due = new Date(dueDate).getTime();
  // Any timestamp strictly before now is overdue. Checking this first avoids
  // Math.ceil rounding a small negative diff (e.g. earlier today) up to -0,
  // which would otherwise slip through to the 7-day "warning" branch.
  if (due < now) return "danger";
  const diffDays = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
  if (diffDays <= 7) return "warning";
  return null;
}

/**
 * Whole-day countdown from `now` to a due date, used for the "Due in N days"
 * label. A deadline later *today* is 0 days away, but `Math.ceil` of a small
 * positive fraction rounds up to 1 ("Due in 1 day"); detect the same calendar
 * day first and return 0 before falling back to the ceiling calculation.
 */
export function dueDateDiffDays(dueDate: string, now: number = Date.now()): number {
  const due = new Date(dueDate);
  const nowDate = new Date(now);
  const sameCalendarDay =
    due.getFullYear() === nowDate.getFullYear() &&
    due.getMonth() === nowDate.getMonth() &&
    due.getDate() === nowDate.getDate();
  if (sameCalendarDay) return 0;
  return Math.ceil((due.getTime() - now) / (1000 * 60 * 60 * 24));
}
