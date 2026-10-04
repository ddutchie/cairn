import { describe, it, expect } from "vitest";
import { shippedSince, atRiskCards, startOfDayAgo, DAY_MS, type DeliveryCard, type DeliveryColumn } from "./delivery";

const NOW = new Date(2026, 9, 4, 12, 0, 0).getTime(); // Oct 4 2026, local noon
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY_MS).toISOString();
const due = (daysFromNow: number) => {
  const d = new Date(NOW + daysFromNow * DAY_MS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const cols: DeliveryColumn[] = [
  { id: "todo", name: "Todo", type: "todo" },
  { id: "prog", name: "Doing", type: "in_progress" },
  { id: "done", name: "Done", type: "done" },
];

describe("shippedSince", () => {
  it("keeps cards completed in the window (incl. archived), newest first", () => {
    const cards: DeliveryCard[] = [
      { id: "a", columnId: "done", title: "A", updatedAt: iso(1), completedAt: iso(1) },
      { id: "b", columnId: "done", title: "B", updatedAt: iso(9), completedAt: iso(9) },
      { id: "c", columnId: "done", title: "C", updatedAt: iso(0), completedAt: iso(0), archivedAt: iso(0) },
      { id: "d", columnId: "todo", title: "D", updatedAt: iso(0) },
    ];
    expect(shippedSince(cards, NOW - 7 * DAY_MS).map((c) => c.id)).toEqual(["c", "a"]);
  });
});

describe("atRiskCards", () => {
  it("flags overdue, blocked-and-due-soon, and stale in-progress cards", () => {
    const cards: DeliveryCard[] = [
      { id: "late", columnId: "todo", title: "Late", updatedAt: iso(0), dueDate: due(-2) },
      { id: "blocker", columnId: "todo", title: "Blocker", updatedAt: iso(0) },
      { id: "blocked", columnId: "todo", title: "Blocked", updatedAt: iso(0), dueDate: due(2), blockedByIds: ["blocker"] },
      { id: "blockedLater", columnId: "todo", title: "Later", updatedAt: iso(0), dueDate: due(20), blockedByIds: ["blocker"] },
      { id: "stale", columnId: "prog", title: "Stale", updatedAt: iso(10) },
      { id: "fresh", columnId: "prog", title: "Fresh", updatedAt: iso(1) },
      { id: "doneLate", columnId: "done", title: "Done", updatedAt: iso(0), dueDate: due(-5) },
      { id: "archivedLate", columnId: "todo", title: "Arch", updatedAt: iso(0), dueDate: due(-5), archivedAt: iso(0) },
    ];
    const out = atRiskCards(cards, cols, { now: NOW });
    expect(out.map((r) => [r.card.id, r.reasons])).toEqual([
      ["late", ["overdue"]],
      ["blocked", ["blocked"]],
      ["stale", ["stale"]],
    ]);
    expect(out[2].idleDays).toBe(10);
  });

  it("ignores blockers that are already done", () => {
    const cards: DeliveryCard[] = [
      { id: "b", columnId: "done", title: "B", updatedAt: iso(0) },
      { id: "x", columnId: "todo", title: "X", updatedAt: iso(0), dueDate: due(1), blockedByIds: ["b"] },
    ];
    expect(atRiskCards(cards, cols, { now: NOW })).toEqual([]);
  });
});

describe("startOfDayAgo", () => {
  it("returns local midnight N days back", () => {
    const d = new Date(startOfDayAgo(6, NOW));
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([28, 0, 0]);
  });
});
