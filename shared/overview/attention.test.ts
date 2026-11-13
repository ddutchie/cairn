import { describe, it, expect } from "vitest";
import { attentionItems } from "./attention";
import { DAY_MS, type DeliveryCard, type DeliveryColumn } from "./delivery";

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

describe("attentionItems", () => {
  it("orders overdue, then due today, then blocked or stale, with labelled reasons", () => {
    const cards: DeliveryCard[] = [
      { id: "stale", columnId: "prog", title: "Stale", updatedAt: iso(10) },
      { id: "today", columnId: "todo", title: "Today", updatedAt: iso(0), dueDate: due(0) },
      { id: "late1", columnId: "todo", title: "Late 1d", updatedAt: iso(0), dueDate: due(-1) },
      { id: "late3", columnId: "todo", title: "Late 3d", updatedAt: iso(0), dueDate: due(-3) },
      { id: "fine", columnId: "todo", title: "Fine", updatedAt: iso(0), dueDate: due(9) },
    ];
    const items = attentionItems(cards, cols, { now: NOW });
    expect(items.map((i) => i.card.id)).toEqual(["late3", "late1", "today", "stale"]);
    expect(items.map((i) => i.tags.map((t) => t.label))).toEqual([
      ["Overdue · 3d"], ["Overdue · 1d"], ["Due today"], ["Stale · 10d"],
    ]);
  });

  it("lists a card once with every reason", () => {
    const cards: DeliveryCard[] = [
      { id: "blocker", columnId: "todo", title: "Blocker", updatedAt: iso(0) },
      { id: "both", columnId: "prog", title: "Both", updatedAt: iso(8), dueDate: due(0), blockedByIds: ["blocker"] },
    ];
    const items = attentionItems(cards, cols, { now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0].tags.map((t) => t.tone)).toEqual(["today", "blocked", "stale"]);
  });

  it("ignores done and archived cards", () => {
    const cards: DeliveryCard[] = [
      { id: "doneToday", columnId: "done", title: "Done", updatedAt: iso(0), dueDate: due(0) },
      { id: "archToday", columnId: "todo", title: "Arch", updatedAt: iso(0), dueDate: due(0), archivedAt: iso(0) },
      { id: "doneLate", columnId: "done", title: "Late", updatedAt: iso(0), dueDate: due(-2) },
    ];
    expect(attentionItems(cards, cols, { now: NOW })).toEqual([]);
  });
});
