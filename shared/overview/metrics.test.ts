import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeProjectMetrics, type MetricsInput } from "./metrics";

const cols = [
  { id: "todo", name: "Todo", type: "todo" as const },
  { id: "prog", name: "In Progress", type: "in_progress" as const },
  { id: "done", name: "Done", type: "done" as const },
];

function iso(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString();
}

/** Bare yyyy-MM-dd due date offset from today (local calendar). */
function dueDate(daysFromNow: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + daysFromNow);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const base: MetricsInput = {
  columns: cols,
  cards: [
    { id: "c1", columnId: "todo", title: "A", priority: "high", dueDate: dueDate(-1), updatedAt: iso(0) },
    { id: "c2", columnId: "prog", title: "B", priority: "urgent", dueDate: dueDate(2), updatedAt: iso(-1) },
    { id: "c3", columnId: "done", title: "C", priority: "low", dueDate: null, updatedAt: iso(-2) },
    { id: "c4", columnId: "todo", title: "D", priority: "medium", dueDate: dueDate(30), updatedAt: iso(-3) },
  ],
  notes: [
    { id: "n1", title: "Pinned", isPinned: true, updatedAt: iso(0), tagIds: [] },
    { id: "n2", title: "Recent", isPinned: false, updatedAt: iso(-1), tagIds: [] },
  ],
};

describe("computeProjectMetrics", () => {
  it("computes completion rate from done / all cards", () => {
    const m = computeProjectMetrics(base);
    // 1 done of 4 total → 25%
    expect(m.completionRate).toBe(25);
    expect(m.doneCards.map((c) => c.id)).toEqual(["c3"]);
    expect(m.openCards.map((c) => c.id).sort()).toEqual(["c1", "c2", "c4"]);
  });

  it("returns 0 completion when there are no cards", () => {
    expect(computeProjectMetrics({ ...base, cards: [] }).completionRate).toBe(0);
  });

  it("sorts columns by canonical type order", () => {
    const shuffled = { ...base, columns: [cols[2], cols[0], cols[1]] };
    expect(computeProjectMetrics(shuffled).columns.map((c) => c.type)).toEqual(["todo", "in_progress", "done"]);
  });

  it("includes only OPEN dated cards due within 7 days, soonest first", () => {
    const m = computeProjectMetrics(base);
    // c1 (-1d, open) and c2 (+2d, open) qualify; c4 (+30d) is too far; c3 is done/undated.
    expect(m.dueCards.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("counts overdue among due cards", () => {
    expect(computeProjectMetrics(base).overdueCount).toBe(1);
  });

  it("counts open cards by priority (excludes done)", () => {
    const m = computeProjectMetrics(base);
    expect(m.priorityCounts).toEqual({ urgent: 1, high: 1, medium: 1, low: 0 });
    expect(m.hasAnyCategorised).toBe(true);
  });

  it("splits pinned (max 4) and recent non-pinned (max 5) notes", () => {
    const m = computeProjectMetrics(base);
    expect(m.pinnedNotes.map((n) => n.id)).toEqual(["n1"]);
    expect(m.recentNotes.map((n) => n.id)).toEqual(["n2"]);
    expect(m.totalNotes).toBe(2);
  });

  it("caps pinned at 4 and recent at 5", () => {
    const many: MetricsInput = {
      columns: cols,
      cards: [],
      notes: [
        ...Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, title: `P${i}`, isPinned: true, updatedAt: iso(-i), tagIds: [] })),
        ...Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, title: `R${i}`, isPinned: false, updatedAt: iso(-i), tagIds: [] })),
      ],
    };
    const m = computeProjectMetrics(many);
    expect(m.pinnedNotes).toHaveLength(4);
    expect(m.recentNotes).toHaveLength(5);
  });

  it("merges notes + cards into activity, newest first, capped at 20, grouped by day", () => {
    const m = computeProjectMetrics(base);
    const flat = m.activityByDay.flatMap((g) => g.items);
    expect(flat).toHaveLength(6); // 2 notes + 4 cards
    // Newest (n1 + c1 at iso(0)) come first.
    expect(flat[0].updatedAt >= flat[flat.length - 1].updatedAt).toBe(true);
    // Card activity carries the column name as subtitle.
    const cardItem = flat.find((i) => i.id === "c2");
    expect(cardItem?.subtitle).toBe("In Progress");
  });

  it("labels the most-recent group Today", () => {
    const m = computeProjectMetrics(base);
    expect(m.activityByDay[0].label).toBe("Today");
  });

  describe("day grouping labels", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("groups by Today / Yesterday", () => {
      const now = new Date("2026-06-15T12:00:00");
      vi.setSystemTime(now);
      const m = computeProjectMetrics({
        columns: cols,
        cards: [],
        notes: [
          { id: "a", title: "today", isPinned: false, updatedAt: "2026-06-15T09:00:00", tagIds: [] },
          { id: "b", title: "yday", isPinned: false, updatedAt: "2026-06-14T09:00:00", tagIds: [] },
        ],
      });
      expect(m.activityByDay.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
    });
  });
});
