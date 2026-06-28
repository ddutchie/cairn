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
 */
export function buildShortcutMap(
  visibleNavItems: Array<{ view: string }>,
  base = 3,
): Map<string, string> {
  const map = new Map<string, string>();
  visibleNavItems.forEach((item, idx) => {
    const num = idx + base;
    map.set(item.view, num <= 9 ? `\u2318${num}` : "");
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
  const diffDays = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "danger";
  if (diffDays <= 7) return "warning";
  return null;
}
