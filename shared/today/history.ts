import type { TodayBrief, TodayHistoryEntry, TodayMarks } from "./brief";

/** Saved briefs (and the versions refreshes replaced) older than this are deleted when a run starts. */
export const TODAY_KEEP_DAYS = 30;

/** One day on the history rail: its last brief, and the versions refreshes replaced that day (newest first). */
export interface TodayHistoryDay {
  date: string;
  latest: TodayHistoryEntry;
  versions: TodayHistoryEntry[];
}

/** Saved briefs grouped by day, newest day first. A day whose own file is gone still shows its newest version. */
export function groupTodayHistory(entries: readonly TodayHistoryEntry[]): TodayHistoryDay[] {
  const byDate = new Map<string, TodayHistoryEntry[]>();
  for (const e of entries) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  return [...byDate.entries()]
    .map(([date, list]) => {
      const sorted = [...list].sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
      const latest = sorted.find((e) => e.key === date) ?? sorted[0];
      return { date, latest, versions: sorted.filter((e) => e !== latest) };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** How an earlier brief's open items fared against the current one. Items are matched by id. */
export interface TodayComparison {
  /** Open then and still open now. */
  carried: Set<string>;
  /** Open then, and since gone from the brief or marked done. */
  resolved: Set<string>;
  /** Items in the current brief that the earlier one didn't have. */
  fresh: number;
}

export function compareTodayBriefs(
  past: TodayBrief, pastMarks: TodayMarks, current: TodayBrief | null, currentMarks: TodayMarks,
): TodayComparison {
  const items = (b: TodayBrief) => [...b.needYou, ...b.prepared].map((i) => i.id);
  const pastDone = new Set(pastMarks.done);
  const nowDone = new Set(currentMarks.done);
  const now = new Set(current ? items(current) : []);
  const before = new Set(items(past));
  const carried = new Set<string>();
  const resolved = new Set<string>();
  for (const id of before) {
    if (pastDone.has(id)) continue;
    if (now.has(id) && !nowDone.has(id)) carried.add(id);
    else resolved.add(id);
  }
  return { carried, resolved, fresh: [...now].filter((id) => !before.has(id)).length };
}
