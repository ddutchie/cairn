import { describe, it, expect } from "vitest";
import { buildReview, upNext } from "./review";
import { DAY_MS, type DeliveryCard, type DeliveryColumn } from "./delivery";

const NOW = new Date(2026, 9, 4, 12).getTime();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY_MS).toISOString();
const cols: DeliveryColumn[] = [
  { id: "todo", name: "Todo", type: "todo" },
  { id: "rev", name: "Review", type: "review" },
  { id: "done", name: "Done", type: "done" },
];
const cards: (DeliveryCard & { createdAt: string })[] = [
  { id: "s", columnId: "done", title: "Ship [beta]", updatedAt: iso(1), createdAt: iso(20), completedAt: iso(1) },
  { id: "old", columnId: "done", title: "Old", updatedAt: iso(30), createdAt: iso(40), completedAt: iso(30) },
  { id: "late", columnId: "todo", title: "Late", priority: "low", updatedAt: iso(2), createdAt: iso(2), dueDate: "2026-10-01" },
  { id: "urgent", columnId: "todo", title: "Urgent", priority: "urgent", updatedAt: iso(0), createdAt: iso(10) },
  { id: "blocked", columnId: "todo", title: "Blocked", priority: "urgent", updatedAt: iso(0), createdAt: iso(10), blockedByIds: ["urgent"] },
  { id: "inrev", columnId: "rev", title: "In review", priority: "high", updatedAt: iso(0), createdAt: iso(10) },
];

describe("upNext", () => {
  it("lists unblocked open non-review cards by priority", () => {
    expect(upNext(cards, cols).map((c) => c.id)).toEqual(["urgent", "late"]);
  });
});

describe("buildReview", () => {
  it("builds a weekly review note", () => {
    const { title, content } = buildReview({
      projectName: "Cairn",
      cards, columns: cols, days: 7, now: NOW,
      notes: [
        { id: "n1", title: "Spec", updatedAt: iso(1), createdAt: iso(9) },
        { id: "n2", title: "Ancient", updatedAt: iso(30), createdAt: iso(30) },
        { id: "d", title: "Dash", updatedAt: iso(0), createdAt: iso(0), type: "dashboard" },
      ],
    });
    expect(title).toBe("Weekly review — Sep 28, 2026 to Oct 4, 2026");
    expect(content).toContain("> 1 shipped · 1 at risk · 1 new card · 1 note touched");
    expect(content).toContain("- [x] Ship \\[beta\\] — ");
    expect(content).not.toContain("Old");
    expect(content).toContain("- Late — overdue (due 2026-10-01)");
    expect(content).toContain("- [ ] Urgent (urgent, Todo)");
    expect(content).toContain("- [[Spec]]");
    expect(content).not.toContain("Ancient");
    expect(content).toContain("## Reflections");
  });

  it("titles a one-day range as a daily brief", () => {
    const { title, content } = buildReview({ projectName: "P", cards: [], columns: cols, notes: [], days: 1, now: NOW });
    expect(title).toBe("Daily brief — Oct 4, 2026");
    expect(content).toContain("## Done today");
    expect(content).toContain("## Focus for today");
  });
});
