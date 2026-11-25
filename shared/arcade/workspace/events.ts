/**
 * What changed between two office snapshots. Pure: `diffOffice(prev, next)`
 * turns the difference into typed changes, and `groupChanges` folds a burst
 * (an agent importing forty cards) into a few per project so the office
 * animates once, not forty times.
 *
 * Who made a change is not in the data: notes the AI is writing are marked by
 * the host (`actor`), everything else is "unknown" until phase 3 adds the
 * agent's tool calls.
 */

import type { OfficeCard, OfficeData, OfficeProject, Zone } from "./data";

export type Actor = "agent" | "unknown";

export type OfficeChange =
  | { k: "task.added"; project: string; id: string }
  | { k: "task.moved"; project: string; id: string; from: Zone; to: Zone; column: string }
  | { k: "task.done"; project: string; id: string }
  | { k: "task.removed"; project: string; id: string }
  | { k: "task.updated"; project: string; id: string }
  | { k: "note.added"; project: string; id: string }
  | { k: "note.updated"; project: string; id: string }
  | { k: "note.removed"; project: string; id: string };

/** A batch of the same kind of change in one project. */
export interface Burst {
  project: string;
  kind: OfficeChange["k"];
  ids: string[];
  /** For moves: where they went, when they all went to the same column, else null. */
  column: string | null;
  zone: Zone | null;
}

/** More changes than this in one refresh is a bulk edit or a reload, and the office animates a sample. */
export const FLURRY = 24;

const cardKey = (c: OfficeCard) => `${c.title}|${c.priority}|${c.assignee ?? ""}|${c.overdue ? 1 : 0}|${c.dueToday ? 1 : 0}`;

/**
 * Changes from `prev` to `next`. No changes at all when either side is the
 * demo office, or when the two share no project (the workspace was switched).
 */
export function diffOffice(prev: OfficeData, next: OfficeData): OfficeChange[] {
  if (prev.demo || next.demo) return [];
  const before = new Map(prev.projects.map((p) => [p.id, p]));
  if (!next.projects.some((p) => before.has(p.id))) return [];

  const nextCards = new Map<string, { c: OfficeCard; p: OfficeProject }>();
  for (const p of next.projects) for (const c of p.cards) nextCards.set(c.id, { c, p });
  const prevCards = new Map<string, { c: OfficeCard; p: OfficeProject }>();
  for (const p of prev.projects) for (const c of p.cards) prevCards.set(c.id, { c, p });

  const out: OfficeChange[] = [];
  for (const p of next.projects) {
    const was = before.get(p.id);
    const colName = new Map(p.columns.map((c) => [c.id, c.name]));
    for (const c of p.cards) {
      const old = prevCards.get(c.id);
      if (!old || old.p.id !== p.id) {
        // A brand new project's cards are not news: it just appeared with them.
        if (was) out.push({ k: "task.added", project: p.id, id: c.id });
        continue;
      }
      if (old.c.columnId !== c.columnId) out.push({ k: "task.moved", project: p.id, id: c.id, from: old.c.zone, to: c.zone, column: colName.get(c.columnId) ?? c.zone.toUpperCase() });
      else if (cardKey(old.c) !== cardKey(c)) out.push({ k: "task.updated", project: p.id, id: c.id });
    }
    if (!was) continue;
    const prevNotes = new Map(was.notes.map((n) => [n.id, n]));
    for (const n of p.notes) {
      const old = prevNotes.get(n.id);
      if (!old) out.push({ k: "note.added", project: p.id, id: n.id });
      else if (old.rev !== undefined && n.rev !== undefined && old.rev !== n.rev) out.push({ k: "note.updated", project: p.id, id: n.id });
    }
    const nextNotes = new Set(p.notes.map((n) => n.id));
    for (const n of was.notes) if (!nextNotes.has(n.id)) out.push({ k: "note.removed", project: p.id, id: n.id });
  }
  // Cards that left a project's open cards: finished (the week's done count rose) or deleted.
  for (const was of prev.projects) {
    const now = next.projects.find((p) => p.id === was.id);
    if (!now) continue;
    const gone = was.cards.filter((c) => !nextCards.has(c.id));
    let finished = Math.max(0, now.doneThisWeek - was.doneThisWeek);
    for (const c of gone) out.push(finished-- > 0 ? { k: "task.done", project: was.id, id: c.id } : { k: "task.removed", project: was.id, id: c.id });
  }
  return out;
}

/** One burst per project and kind (and per target column for moves). */
export function groupChanges(changes: readonly OfficeChange[]): Burst[] {
  const map = new Map<string, Burst>();
  for (const c of changes) {
    const moveKey = c.k === "task.moved" ? `|${c.column}` : "";
    const key = `${c.project}|${c.k}${moveKey}`;
    let b = map.get(key);
    if (!b) {
      b = { project: c.project, kind: c.k, ids: [], column: c.k === "task.moved" ? c.column : null, zone: c.k === "task.moved" ? c.to : null };
      map.set(key, b);
    }
    b.ids.push(c.id);
  }
  return [...map.values()];
}

/** The text that floats over a desk for a burst. */
export function burstLabel(b: Burst): string {
  const n = b.ids.length;
  switch (b.kind) {
    case "task.added":
      return n === 1 ? "+ TASK" : `+ ${n} TASKS`;
    case "task.moved":
      return n === 1 ? `> ${b.column}` : `${n} > ${b.column}`;
    case "task.done":
      return n === 1 ? "DONE!" : `${n} DONE!`;
    case "task.removed":
      return n === 1 ? "- TASK" : `- ${n} TASKS`;
    case "task.updated":
      return n === 1 ? "EDITED" : `${n} EDITED`;
    case "note.added":
      return n === 1 ? "+ NOTE" : `+ ${n} NOTES`;
    case "note.updated":
      return n === 1 ? "NOTE EDITED" : `${n} NOTES EDITED`;
    case "note.removed":
      return n === 1 ? "- NOTE" : `- ${n} NOTES`;
  }
}
