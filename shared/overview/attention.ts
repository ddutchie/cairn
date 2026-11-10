/**
 * The Overview's "needs attention" list: every open card that is overdue, due
 * today, blocked near its due date or stale, as one ordered list with labelled
 * reasons. Builds on atRiskCards (which has no "due today") so the Brief
 * Overview can show a single list instead of an attention queue and an
 * at-risk feed. Pure, like the rest of shared/overview.
 */

import { getDueDateStatus, parseIsoLocal } from "../format/date";
import { atRiskCards, DAY_MS, type AtRiskOptions, type DeliveryCard, type DeliveryColumn } from "./delivery";

export type AttentionTone = "overdue" | "today" | "blocked" | "stale";

export interface AttentionTag {
  tone: AttentionTone;
  label: string;
}

export interface AttentionItem<C extends DeliveryCard = DeliveryCard> {
  card: C;
  /** Most severe first; never empty. */
  tags: AttentionTag[];
}

/** Whole local days between `dueDate` and today (positive = overdue). */
function daysOverdue(dueDate: string, now: number): number {
  const due = parseIsoLocal(dueDate);
  const today = new Date(now);
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - due.getTime()) / DAY_MS);
}

/**
 * Open cards needing attention: overdue first (oldest due date first), then
 * due today, then blocked or stale. A card appears once, carrying every reason.
 */
export function attentionItems<C extends DeliveryCard>(
  cards: readonly C[],
  columns: readonly DeliveryColumn[],
  opts: AtRiskOptions = {},
): AttentionItem<C>[] {
  const now = opts.now ?? Date.now();
  const risk = atRiskCards(cards, columns, { ...opts, now });
  const riskById = new Map(risk.map((r) => [r.card.id, r]));
  const doneIds = new Set(columns.filter((c) => c.type === "done").map((c) => c.id));

  const tagsFor = (card: C, dueToday: boolean): AttentionTag[] => {
    const r = riskById.get(card.id);
    const tags: AttentionTag[] = [];
    if (r?.reasons.includes("overdue")) tags.push({ tone: "overdue", label: `Overdue · ${daysOverdue(card.dueDate!, now)}d` });
    if (dueToday) tags.push({ tone: "today", label: "Due today" });
    if (r?.reasons.includes("blocked")) tags.push({ tone: "blocked", label: "Blocked" });
    if (r?.reasons.includes("stale")) tags.push({ tone: "stale", label: `Stale · ${r.idleDays}d` });
    return tags;
  };

  const overdue = risk.filter((r) => r.reasons[0] === "overdue").map((r) => r.card);
  const today = cards.filter(
    (c) => !c.archivedAt && !doneIds.has(c.columnId) && getDueDateStatus(c.dueDate, now) === "today",
  );
  const todayIds = new Set(today.map((c) => c.id));
  const rest = risk.filter((r) => r.reasons[0] !== "overdue" && !todayIds.has(r.card.id)).map((r) => r.card);

  return [...overdue, ...today, ...rest].map((card) => ({ card, tags: tagsFor(card, todayIds.has(card.id)) }));
}
