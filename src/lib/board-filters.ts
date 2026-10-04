/**
 * Board filter model — what the toolbar chips/menus edit and what saved views
 * persist. Pure, so the matching rules are unit-tested independently of the
 * board component.
 */

import { getDueDateStatus, parseIsoLocal } from "@/lib/utils";
import type { Priority, TaskCard } from "@/types";

export type DueFilter = "any" | "overdue" | "week" | "none";

export interface BoardFilter {
  priorities: Priority[];
  text: string;
  /** Exact assignee name; `UNASSIGNED` matches cards with no assignee. null = any. */
  assignee: string | null;
  /** Card must carry at least one of these tags. Empty = any. */
  tagIds: string[];
  due: DueFilter;
  /** Only cards with at least one blocker that is still open. */
  blockedOnly: boolean;
}

export const UNASSIGNED = "\u0000unassigned";

export const EMPTY_BOARD_FILTER: BoardFilter = {
  priorities: [],
  text: "",
  assignee: null,
  tagIds: [],
  due: "any",
  blockedOnly: false,
};

export interface BoardView {
  id: string;
  name: string;
  filter: BoardFilter;
}

/** True when any criterion narrows the board. */
export function isFilterActive(f: BoardFilter): boolean {
  return (
    f.priorities.length > 0 || f.text.trim() !== "" || f.assignee !== null ||
    f.tagIds.length > 0 || f.due !== "any" || f.blockedOnly
  );
}

/** Number of criteria set (search text excluded) — for the "Filters · 2" badge. */
export function activeCriteriaCount(f: BoardFilter): number {
  return (f.assignee !== null ? 1 : 0) + (f.tagIds.length > 0 ? 1 : 0) + (f.due !== "any" ? 1 : 0) + (f.blockedOnly ? 1 : 0);
}

/**
 * Does `card` pass every active criterion? `openCardIds` is the set of card ids
 * that are still open (not done/archived), used to decide whether a blocker
 * still blocks. `now` is injectable for tests.
 */
export function cardMatchesFilter(
  card: TaskCard,
  f: BoardFilter,
  openCardIds: ReadonlySet<string>,
  now: number = Date.now(),
): boolean {
  if (f.priorities.length > 0 && !f.priorities.includes(card.priority)) return false;
  if (f.assignee !== null) {
    const a = card.assignee?.trim() || null;
    if (f.assignee === UNASSIGNED ? a !== null : a !== f.assignee) return false;
  }
  if (f.tagIds.length > 0 && !card.tagIds.some((t) => f.tagIds.includes(t))) return false;
  if (f.due !== "any") {
    if (f.due === "none") {
      if (card.dueDate) return false;
    } else if (!card.dueDate) {
      return false;
    } else if (f.due === "overdue") {
      if (getDueDateStatus(card.dueDate) !== "overdue") return false;
    } else {
      // Today through the next 7 days; overdue cards have their own option.
      const dueMs = parseIsoLocal(card.dueDate).getTime();
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      if (dueMs < today.getTime() || dueMs - now > 7 * 86_400_000) return false;
    }
  }
  if (f.blockedOnly && !card.blockedByIds.some((id) => openCardIds.has(id))) return false;
  const q = f.text.trim().toLowerCase();
  if (q) return card.title.toLowerCase().includes(q) || (card.description ?? "").toLowerCase().includes(q);
  return true;
}

/** Distinct, sorted assignee names across `cards` (blank names ignored). */
export function assigneesOf(cards: readonly TaskCard[]): string[] {
  return [...new Set(cards.map((c) => c.assignee?.trim()).filter((a): a is string => !!a))].sort((a, b) =>
    a.localeCompare(b),
  );
}
