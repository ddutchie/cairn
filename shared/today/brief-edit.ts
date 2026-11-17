/**
 * Edits the Today run makes to the brief through its tools (`today_upsert`,
 * `today_remove`, `today_finish`; see `electron/lib/today-tools.ts`). Every
 * item goes through the normalisers in `./brief`, and each lane keeps an id
 * once, so calling upsert again with the same id updates the item in place.
 * Pure: importable from main and tests.
 */

import {
  TODAY_BRIEF_VERSION, byEventStart, fallbackHeadline, firstSentences, localDate, normalizeEvent, normalizeFyi,
  normalizeNeed, normalizePrepared, normalizeSource, pruneDraftLinks, summaryLede,
  type TodayBrief, type TodayMarks,
} from "./brief";

export const TODAY_LANES = ["decision", "todo", "draft", "fyi", "event"] as const;
export type TodayLane = (typeof TODAY_LANES)[number];

/** Most items a lane keeps; the brief is read in under a minute. */
export const TODAY_LANE_LIMITS = { needYou: 6, prepared: 5, fyi: 8, events: 20 } as const;

export function emptyBrief(now: Date): TodayBrief {
  return {
    version: TODAY_BRIEF_VERSION, status: "gathering", generatedAt: now.toISOString(), date: localDate(now),
    headline: "", lede: "", events: [], needYou: [], prepared: [], fyi: [], sources: [],
  };
}

/**
 * The brief a run starts from.
 *   - A refresh later the same day keeps the items already there (their ids,
 *     and so what the user already finished or dismissed); the run updates or
 *     removes them.
 *   - A new day carries over what was still open on the last brief: the
 *     decisions, to-dos and drafts not marked done, each with `since` (the day
 *     it first showed up) and the user's edits to drafts. The run checks each
 *     against its source and removes what was handled. Meetings, FYI and
 *     sources start empty.
 */
export function startRefresh(previous: TodayBrief | null, marks: TodayMarks | null, now: Date): TodayBrief {
  if (!previous) return emptyBrief(now);
  if (previous.date === localDate(now)) {
    return { ...structuredClone(previous), status: "gathering", generatedAt: now.toISOString(), sources: [] };
  }
  const done = new Set(marks?.done ?? []);
  const edits = marks?.edits ?? {};
  const fresh = emptyBrief(now);
  fresh.needYou = previous.needYou
    .filter((n) => !done.has(n.id))
    .map((n) => ({ ...structuredClone(n), since: n.since ?? previous.date }));
  fresh.prepared = previous.prepared
    .filter((p) => !done.has(p.id))
    .map((p) => ({ ...structuredClone(p), draft: edits[p.id] ?? p.draft, since: p.since ?? previous.date }));
  return fresh;
}

/** Where an id sits now, so an update keeps when it first showed up. */
function sinceOf(brief: TodayBrief, id: string): string | undefined {
  return brief.needYou.find((n) => n.id === id)?.since ?? brief.prepared.find((p) => p.id === id)?.since;
}

function withoutId(brief: TodayBrief, id: string): void {
  brief.needYou = brief.needYou.filter((n) => n.id !== id);
  brief.prepared = brief.prepared.filter((p) => p.id !== id);
  brief.fyi = brief.fyi.filter((f) => f.id !== id);
  brief.events = brief.events.filter((e) => e.id !== id);
}

type Lists = Pick<TodayBrief, "needYou" | "prepared" | "fyi" | "events">;

/**
 * Put `item` in `lane`, replacing the one with its id wherever it sits. A full lane rejects it
 * before anything moves, so the item it would have replaced stays where it was.
 */
function place<K extends keyof Lists>(brief: TodayBrief, lane: K, item: Lists[K][number], limit: number): string | null {
  const list = brief[lane] as Array<{ id: string }>;
  const at = list.findIndex((x) => x.id === item.id);
  if (at >= 0) { withoutIdElsewhere(brief, lane, item.id); (brief[lane] as Array<{ id: string }>)[at] = item; return "updated"; }
  if (list.length >= limit) return null;
  withoutId(brief, item.id);
  (brief[lane] as Array<{ id: string }>).push(item);
  return "added";
}

function withoutIdElsewhere(brief: TodayBrief, keep: keyof Lists, id: string): void {
  if (keep !== "needYou") brief.needYou = brief.needYou.filter((x) => x.id !== id);
  if (keep !== "prepared") brief.prepared = brief.prepared.filter((x) => x.id !== id);
  if (keep !== "fyi") brief.fyi = brief.fyi.filter((x) => x.id !== id);
  if (keep !== "events") brief.events = brief.events.filter((x) => x.id !== id);
}

/** One line per item: what happened to it, so the model can fix a rejected one. */
export function upsertItems(brief: TodayBrief, items: ReadonlyArray<Record<string, unknown>>, now: Date): string[] {
  const results = items.map((raw, i) => {
    const lane = typeof raw.lane === "string" ? raw.lane : "";
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
    const label = id || `item ${i + 1}`;
    if (!(TODAY_LANES as readonly string[]).includes(lane)) return `${label}: skipped, lane must be one of ${TODAY_LANES.join(", ")}.`;
    if (!id && lane !== "event") return `${label}: skipped, give it an id built from its source (for example "slack-C123-1712") so a later refresh updates it.`;
    let result: string | null;
    switch (lane as TodayLane) {
      case "decision":
      case "todo": {
        const n = normalizeNeed({ ...raw, kind: lane }, id);
        if (!n) return `${label}: skipped, a ${lane} needs a "question".`;
        if (lane === "decision" && (n.kind === "todo" || n.choices.length < 2)) return `${label}: skipped, a decision needs 2 or 3 "choices".`;
        n.since ??= sinceOf(brief, n.id);
        result = place(brief, "needYou", n, TODAY_LANE_LIMITS.needYou);
        break;
      }
      case "draft": {
        const p = normalizePrepared(raw, id);
        if (!p) return `${label}: skipped, a draft needs a "title" and the "draft" text.`;
        p.since ??= sinceOf(brief, p.id);
        result = place(brief, "prepared", p, TODAY_LANE_LIMITS.prepared);
        break;
      }
      case "fyi": {
        const f = normalizeFyi(raw, id);
        if (!f) return `${label}: skipped, an fyi needs a "title".`;
        result = place(brief, "fyi", f, TODAY_LANE_LIMITS.fyi);
        break;
      }
      case "event": {
        const e = normalizeEvent(raw);
        if (!e) return `${label}: skipped, an event needs a "title" and a "start" as HH:MM.`;
        result = place(brief, "events", e, TODAY_LANE_LIMITS.events);
        brief.events.sort(byEventStart);
        break;
      }
    }
    return result ? `${label}: ${result}.` : `${label}: skipped, the ${lane} lane is full. Remove a weaker item first.`;
  });
  brief.generatedAt = now.toISOString();
  return results;
}

export function removeItems(brief: TodayBrief, ids: readonly string[], now: Date): string[] {
  const results = ids.map((id) => {
    const before = brief.needYou.length + brief.prepared.length + brief.fyi.length + brief.events.length;
    withoutId(brief, id);
    const after = brief.needYou.length + brief.prepared.length + brief.fyi.length + brief.events.length;
    return before === after ? `${id}: not found.` : `${id}: removed.`;
  });
  brief.generatedAt = now.toISOString();
  return results;
}

/** Close the brief: the header lines, which sources were read, and status "ready". */
export function finishBrief(brief: TodayBrief, o: Record<string, unknown>, now: Date): TodayBrief {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  pruneDraftLinks(brief);
  const focus = str(o.focusId);
  brief.focusId = (brief.needYou.find((n) => n.id === focus) ?? brief.needYou[0])?.id;
  brief.headline = str(o.headline) ?? fallbackHeadline(brief.needYou, brief.focusId);
  brief.lede = firstSentences(str(o.lede) ?? summaryLede(brief.needYou.length, brief.prepared.length), 2, 40);
  if (Array.isArray(o.sources)) {
    brief.sources = o.sources
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .flatMap((x) => normalizeSource(x) ?? []);
  }
  brief.gap = str(o.gap);
  brief.status = "ready";
  brief.generatedAt = now.toISOString();
  return brief;
}

/** A compact view of the brief for `today_read`: ids and the fields a model needs to decide what to update. */
export function briefOutline(brief: TodayBrief): Record<string, unknown> {
  return {
    date: brief.date,
    status: brief.status,
    needYou: brief.needYou.map((n) => ({
      id: n.id, lane: n.kind, question: n.title, source: n.source, url: n.url, projectId: n.projectId,
      choices: n.choices.map((c) => c.label + (c.draftId ? ` → ${c.draftId}` : "")),
      ...(n.since ? { carriedSince: n.since } : {}),
    })),
    drafts: brief.prepared.map((p) => ({
      id: p.id, title: p.title, target: p.target, projectId: p.projectId, ...(p.since ? { carriedSince: p.since } : {}),
    })),
    fyi: brief.fyi.map((f) => ({ id: f.id, title: f.title, tone: f.tone, projectId: f.projectId })),
    events: brief.events.map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end })),
  };
}
