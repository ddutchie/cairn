/**
 * What Cairn knows about each project today, computed from the board, notes
 * and automation runs rather than asked of the model. Shown in Today's "Your
 * projects" and given to the run as context, so the model doesn't have to
 * search the board to find what's due.
 */

import type Database from "better-sqlite3";
import { localDate, type TodayFactCard, type TodayProjectFacts } from "../../shared/today/brief";
import { getCards, getColumns } from "../db/board-queries";
import { getNotesChangedSince } from "../db/notes-queries";
import { consecutiveFailedRuns, listAutomations } from "../db/automation-queries";
import { TODAY_COMMUNITY_ID } from "../../shared/today/brief";

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 5;
/** Cards listed per fact; the count beyond it is still right. */
const MAX_CARDS = 8;

export function projectFacts(
  db: Database.Database, workspaceId: string, projects: ReadonlyArray<{ id: string; name: string }>, now: Date = new Date(),
): TodayProjectFacts[] {
  const today = localDate(now);
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const automations = listAutomations(db, workspaceId).filter((a) => a.enabled && a.communityId !== TODAY_COMMUNITY_ID);
  return projects.map((p) => {
    const columns = getColumns(db, p.id);
    const typeOf = new Map(columns.map((c) => [c.id, c.type]));
    const open = getCards(db, { projectId: p.id }).filter((c) => !c.archivedAt && !c.completedAt && typeOf.get(c.columnId) !== "done");
    const card = (c: (typeof open)[number], extra: Partial<TodayFactCard> = {}): TodayFactCard => ({ id: c.id, title: c.title, ...extra });
    const due = (c: (typeof open)[number]) => (c.dueDate ? c.dueDate.slice(0, 10) : null);
    const dueToday = open.filter((c) => due(c) === today).map((c) => card(c, { dueDate: due(c)! }));
    const overdue = open.filter((c) => { const d = due(c); return !!d && d < today; })
      .sort((a, b) => (due(a)! < due(b)! ? -1 : 1)).map((c) => card(c, { dueDate: due(c)! }));
    const inReview = open.filter((c) => typeOf.get(c.columnId) === "review").map((c) => card(c));
    const stale = open
      .filter((c) => { const t = typeOf.get(c.columnId); return t === "in_progress" || t === "review"; })
      .map((c) => ({ c, days: Math.floor((now.getTime() - new Date(c.updatedAt).getTime()) / DAY_MS) }))
      .filter((x) => Number.isFinite(x.days) && x.days >= STALE_DAYS)
      .sort((a, b) => b.days - a.days)
      .map((x) => card(x.c, { days: x.days }));
    const failingAutomations = automations
      .filter((a) => a.projectId === p.id)
      .map((a) => ({ id: a.id, name: a.name, failures: consecutiveFailedRuns(db, a.id) }))
      .filter((a) => a.failures > 0);
    return {
      projectId: p.id, name: p.name,
      dueToday: dueToday.slice(0, MAX_CARDS), overdue: overdue.slice(0, MAX_CARDS),
      inReview: inReview.slice(0, MAX_CARDS), stale: stale.slice(0, MAX_CARDS),
      failingAutomations, notesChanged: getNotesChangedSince(db, p.id, since),
    };
  });
}

/** The facts as Markdown for the run's prompt. Ids are kept so the model can link items to cards. */
export function factsForPrompt(facts: readonly TodayProjectFacts[]): string {
  if (facts.length === 0) return "No projects are included.";
  const list = (label: string, cards: TodayFactCard[]) =>
    cards.length ? [`- ${label}: ${cards.map((c) => `"${c.title}" (card ${c.id}${c.dueDate ? `, due ${c.dueDate}` : ""}${c.days ? `, ${c.days}d unchanged` : ""})`).join("; ")}`] : [];
  return facts.map((f) => {
    const lines = [
      ...list("Due today", f.dueToday),
      ...list("Overdue", f.overdue),
      ...list("In review", f.inReview),
      ...list(`Stale (${STALE_DAYS}+ days)`, f.stale),
      ...(f.failingAutomations.length ? [`- Failing automations: ${f.failingAutomations.map((a) => `"${a.name}" (${a.failures} failed in a row)`).join("; ")}`] : []),
      ...(f.notesChanged.length ? [`- Notes changed since yesterday: ${f.notesChanged.map((n) => `"${n.title}"`).join("; ")}`] : []),
    ];
    return `### ${f.name} (projectId ${f.projectId})\n${lines.length ? lines.join("\n") : "- Nothing due, in review or stale."}`;
  }).join("\n\n");
}
