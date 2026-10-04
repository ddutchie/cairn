/**
 * Delivery signals for the Overview and the weekly review: what shipped, and
 * what's at risk of slipping. Pure — callers pass already-read cards/columns in
 * a small normalized shape (desktop camelCase, mobile adapts at the call site).
 */

import { getDueDateStatus, parseIsoLocal } from "../format/date";
import type { ColumnType } from "../ui/constants";

export interface DeliveryColumn {
  id: string;
  name: string;
  type: ColumnType;
}

export interface DeliveryCard {
  id: string;
  columnId: string;
  title: string;
  priority?: string | null;
  dueDate?: string | null;
  updatedAt: string;
  completedAt?: string | null;
  archivedAt?: string | null;
  blockedByIds?: readonly string[];
}

export const DAY_MS = 86_400_000;

/**
 * Cards completed at or after `sinceMs` (archived ones included — archiving a
 * shipped card doesn't un-ship it), newest first.
 */
export function shippedSince<C extends DeliveryCard>(cards: readonly C[], sinceMs: number): C[] {
  return cards
    .filter((c) => c.completedAt && new Date(c.completedAt).getTime() >= sinceMs)
    .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime());
}

export type RiskReason = "overdue" | "blocked" | "stale";

export interface AtRiskCard<C extends DeliveryCard = DeliveryCard> {
  card: C;
  reasons: RiskReason[];
  /** Days since last update (for "stale"). */
  idleDays: number;
}

export interface AtRiskOptions {
  /** "Now" in ms, injectable for tests. */
  now?: number;
  /** In-progress / review cards untouched for this many days are stale. Default 7. */
  staleDays?: number;
  /** A blocked card only counts once it's due within this many days. Default 3. */
  blockedDueWithinDays?: number;
}

const RISK_ORDER: Record<RiskReason, number> = { overdue: 0, blocked: 1, stale: 2 };

/**
 * Open (not done, not archived) cards that need attention:
 * - **overdue** — due date in the past;
 * - **blocked** — due within `blockedDueWithinDays` while a blocker is still open;
 * - **stale** — sitting in an in-progress/review column with no update for `staleDays`.
 * Sorted by most severe reason, then soonest due date.
 */
export function atRiskCards<C extends DeliveryCard>(
  cards: readonly C[],
  columns: readonly DeliveryColumn[],
  opts: AtRiskOptions = {},
): AtRiskCard<C>[] {
  const now = opts.now ?? Date.now();
  const staleDays = opts.staleDays ?? 7;
  const blockedWithin = opts.blockedDueWithinDays ?? 3;
  const colType = new Map(columns.map((c) => [c.id, c.type]));
  const isOpen = (c: DeliveryCard) => !c.archivedAt && colType.get(c.columnId) !== "done";
  const openIds = new Set(cards.filter(isOpen).map((c) => c.id));

  const out: AtRiskCard<C>[] = [];
  for (const card of cards) {
    if (!isOpen(card)) continue;
    const reasons: RiskReason[] = [];
    if (card.dueDate && getDueDateStatus(card.dueDate) === "overdue") reasons.push("overdue");
    const hasOpenBlocker = (card.blockedByIds ?? []).some((id) => openIds.has(id));
    if (hasOpenBlocker && card.dueDate) {
      const dueMs = parseIsoLocal(card.dueDate).getTime();
      if (dueMs - now <= blockedWithin * DAY_MS) reasons.push("blocked");
    }
    const idleDays = Math.floor((now - new Date(card.updatedAt).getTime()) / DAY_MS);
    const type = colType.get(card.columnId);
    if ((type === "in_progress" || type === "review") && idleDays >= staleDays) reasons.push("stale");
    if (reasons.length > 0) out.push({ card, reasons, idleDays });
  }
  const dueKey = (c: DeliveryCard) => (c.dueDate ? parseIsoLocal(c.dueDate).getTime() : Number.POSITIVE_INFINITY);
  return out.sort(
    (a, b) => RISK_ORDER[a.reasons[0]] - RISK_ORDER[b.reasons[0]] || dueKey(a.card) - dueKey(b.card),
  );
}

/** Start of the local day `days` days ago, in ms (0 = today's midnight). */
export function startOfDayAgo(days: number, now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.getTime();
}
