import { describe, expect, it } from "vitest";
import { emptyBrief, upsertItems } from "./brief-edit";
import { EMPTY_TODAY_MARKS, type TodayHistoryEntry } from "./brief";
import { compareTodayBriefs, groupTodayHistory } from "./history";

const entry = (key: string, generatedAt: string): TodayHistoryEntry => ({
  key, date: key.slice(0, 10), generatedAt, headline: key, counts: { need: 0, prepared: 0, fyi: 0, events: 0, carried: 0 },
});

describe("groupTodayHistory", () => {
  it("makes one day per date with its replaced versions, newest first", () => {
    const days = groupTodayHistory([
      entry("2026-11-13", "2026-11-13T07:00:00Z"),
      entry("2026-11-16@070000", "2026-11-16T07:00:00Z"),
      entry("2026-11-16", "2026-11-16T09:14:00Z"),
      entry("2026-11-16@081200", "2026-11-16T08:12:00Z"),
      entry("2026-11-12@070000", "2026-11-12T07:00:00Z"),
    ]);
    expect(days.map((d) => [d.date, d.latest.key, d.versions.map((v) => v.key)])).toEqual([
      ["2026-11-16", "2026-11-16", ["2026-11-16@081200", "2026-11-16@070000"]],
      ["2026-11-13", "2026-11-13", []],
      ["2026-11-12", "2026-11-12@070000", []],
    ]);
  });
});

describe("compareTodayBriefs", () => {
  it("sorts the earlier brief's open items into carried and resolved, and counts what's new", () => {
    const t = new Date(2026, 10, 13, 7, 0);
    const past = emptyBrief(t);
    upsertItems(past, [
      { lane: "todo", id: "a", question: "Still open" },
      { lane: "todo", id: "b", question: "Gone since" },
      { lane: "todo", id: "c", question: "Done today" },
      { lane: "todo", id: "d", question: "Done back then" },
      { lane: "draft", id: "r1", title: "Reply", draft: "x" },
    ], t);
    const n = new Date(2026, 10, 16, 7, 0);
    const now = emptyBrief(n);
    upsertItems(now, [
      { lane: "todo", id: "a", question: "Still open" },
      { lane: "todo", id: "c", question: "Done today" },
      { lane: "todo", id: "e", question: "New" },
      { lane: "draft", id: "r1", title: "Reply", draft: "x" },
    ], n);
    const r = compareTodayBriefs(past, { ...EMPTY_TODAY_MARKS, done: ["d"] }, now, { ...EMPTY_TODAY_MARKS, done: ["c"] });
    expect([...r.carried].sort()).toEqual(["a", "r1"]);
    expect([...r.resolved].sort()).toEqual(["b", "c"]);
    expect(r.fresh).toBe(1);
  });
});
