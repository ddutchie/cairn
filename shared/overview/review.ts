/**
 * Weekly review / daily brief — builds a markdown note from a project's board
 * and notes. Deterministic and offline (no LLM): the user (or the agent) can
 * expand on it afterwards. Pure; shared by the desktop Overview and MCP.
 */

import { formatDate, parseIsoLocal } from "../format/date";
import { PRIORITIES } from "../ui/constants";
import { atRiskCards, shippedSince, startOfDayAgo, type DeliveryCard, type DeliveryColumn } from "./delivery";

export interface ReviewNote {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  type?: string;
}

export interface ReviewInput<C extends DeliveryCard = DeliveryCard> {
  projectName: string;
  cards: readonly C[];
  columns: readonly DeliveryColumn[];
  notes: readonly ReviewNote[];
  /** Days covered, counting today (7 = weekly review, 1 = daily brief). */
  days: number;
  now?: number;
}

export interface ReviewResult {
  title: string;
  content: string;
}

/** Sort key: urgent first (PRIORITIES runs low → urgent); unknown sorts last. */
const rank = (p?: string | null) => {
  const i = PRIORITIES.indexOf((p ?? "medium") as (typeof PRIORITIES)[number]);
  return i === -1 ? PRIORITIES.length : PRIORITIES.length - 1 - i;
};

/** "Oct 2" (year added only when it differs from `nowYear`). */
function shortDate(iso: string, nowYear: number): string {
  const d = parseIsoLocal(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", ...(d.getFullYear() === nowYear ? {} : { year: "numeric" }) };
  return d.toLocaleDateString("en-US", opts);
}

/** Escape characters that would turn a title into markdown/wikilink syntax. */
const md = (s: string) => s.replace(/([[\]*_`])/g, "\\$1");

/**
 * Open cards that are ready to start: not done/archived, every blocker done,
 * ordered by priority then due date. `limit` caps the list.
 */
export function upNext<C extends DeliveryCard>(cards: readonly C[], columns: readonly DeliveryColumn[], limit = 5): C[] {
  const type = new Map(columns.map((c) => [c.id, c.type]));
  const open = cards.filter((c) => !c.archivedAt && type.get(c.columnId) !== "done");
  const openIds = new Set(open.map((c) => c.id));
  return open
    .filter((c) => !(c.blockedByIds ?? []).some((id) => openIds.has(id)))
    .filter((c) => type.get(c.columnId) !== "review")
    .sort((a, b) =>
      rank(a.priority) - rank(b.priority) ||
      (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
      a.title.localeCompare(b.title))
    .slice(0, limit);
}

export function buildReview<C extends DeliveryCard>(input: ReviewInput<C>): ReviewResult {
  const now = input.now ?? Date.now();
  const since = startOfDayAgo(Math.max(0, input.days - 1), now);
  const daily = input.days <= 1;
  const colName = new Map(input.columns.map((c) => [c.id, c.name]));
  const today = new Date(now).toISOString().slice(0, 10);
  const year = new Date(now).getFullYear();
  const sd = (iso: string) => shortDate(iso, year);
  const title = daily
    ? `Daily brief — ${formatDate(today)}`
    : `Weekly review — ${formatDate(new Date(since).toISOString().slice(0, 10))} to ${formatDate(today)}`;

  const shipped = shippedSince(input.cards, since);
  const risk = atRiskCards(input.cards, input.columns, { now });
  const next = upNext(input.cards, input.columns);
  const inTime = (iso: string) => new Date(iso).getTime() >= since;
  const created = input.cards.filter((c) => inTime((c as DeliveryCard & { createdAt?: string }).createdAt ?? c.updatedAt) && !c.archivedAt);
  const touchedNotes = input.notes
    .filter((n) => n.type !== "dashboard" && inTime(n.updatedAt))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const lines: string[] = [];
  lines.push(`Project: **${md(input.projectName)}** · generated ${formatDate(today)}`, "");
  lines.push(
    `> ${shipped.length} shipped · ${risk.length} at risk · ${created.length} new card${created.length === 1 ? "" : "s"} · ${touchedNotes.length} note${touchedNotes.length === 1 ? "" : "s"} touched`,
    "",
  );

  lines.push(daily ? "## Done today" : "## Shipped", "");
  if (shipped.length === 0) lines.push("_Nothing completed in this period._");
  for (const c of shipped) lines.push(`- [x] ${md(c.title)}${c.completedAt ? ` — ${sd(c.completedAt)}` : ""}`);
  lines.push("");

  lines.push("## At risk", "");
  if (risk.length === 0) lines.push("_Nothing overdue, blocked or stale._");
  for (const r of risk) {
    const why = r.reasons
      .map((k) => (k === "overdue" ? `overdue (due ${sd(r.card.dueDate!)})` : k === "blocked" ? `blocked, due ${sd(r.card.dueDate!)}` : `stale ${r.idleDays}d in ${colName.get(r.card.columnId) ?? "progress"}`))
      .join("; ");
    lines.push(`- ${md(r.card.title)} — ${why}`);
  }
  lines.push("");

  lines.push("## Up next", "");
  if (next.length === 0) lines.push("_No unblocked open cards._");
  for (const c of next) {
    const bits = [c.priority, colName.get(c.columnId), c.dueDate ? `due ${sd(c.dueDate)}` : null].filter(Boolean);
    lines.push(`- [ ] ${md(c.title)}${bits.length ? ` (${bits.join(", ")})` : ""}`);
  }
  lines.push("");

  if (touchedNotes.length > 0) {
    lines.push("## Notes touched", "");
    for (const n of touchedNotes.slice(0, 15)) lines.push(`- [[${n.title}]]`);
    if (touchedNotes.length > 15) lines.push(`- …and ${touchedNotes.length - 15} more`);
    lines.push("");
  }

  lines.push(daily ? "## Focus for today" : "## Reflections", "", "- ", "");
  return { title, content: lines.join("\n") };
}
