/**
 * Unit tests for calendar pure helpers (calendar-utils.ts).
 *
 *  - buildMonthGrid: always 42 cells, correct leading/trailing padding and
 *    inMonth/isToday flags (a fixed `today` keeps it deterministic).
 *  - buildWeekGrid: 7 Sunday-start cells.
 *  - bucketByDate: overdue / today+future / unscheduled split, with every dated
 *    card (past included) kept in byDate, and done cards omitted from overdue.
 */

import { describe, it, expect } from "vitest";
import {
  buildMonthGrid,
  buildWeekGrid,
  bucketByDate,
  toDateKey,
  shiftMonth,
  shiftWeek,
} from "./calendar-utils";
import type { TaskCard } from "@/types";

function card(id: string, dueDate?: string, columnId = "c"): TaskCard {
  return {
    id,
    columnId,
    projectId: "p",
    workspaceId: "w",
    title: id,
    tagIds: [],
    priority: "medium",
    dueDate,
    linkedNoteIds: [],
    blockedByIds: [],
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 0,
  };
}

// June 2026: June 1 is a Monday. Use noon to avoid any DST edge.
const TODAY = new Date(2026, 5, 15, 12, 0, 0); // 2026-06-15

describe("buildMonthGrid", () => {
  const grid = buildMonthGrid(TODAY, TODAY);

  it("always produces 42 cells (6 weeks)", () => {
    expect(grid).toHaveLength(42);
  });

  it("starts on the Sunday on/before the 1st", () => {
    // June 1 2026 is Monday → grid starts on Sunday May 31.
    expect(grid[0].key).toBe("2026-05-31");
    expect(grid[0].inMonth).toBe(false);
  });

  it("flags in-month vs out-of-month days", () => {
    const june1 = grid.find((c) => c.key === "2026-06-01")!;
    expect(june1.inMonth).toBe(true);
    expect(grid[0].inMonth).toBe(false); // May 31
    const last = grid[grid.length - 1];
    expect(last.inMonth).toBe(false); // trailing July day
  });

  it("marks exactly one cell as today", () => {
    const todays = grid.filter((c) => c.isToday);
    expect(todays).toHaveLength(1);
    expect(todays[0].key).toBe("2026-06-15");
  });
});

describe("buildWeekGrid", () => {
  const week = buildWeekGrid(TODAY, TODAY);

  it("produces 7 Sunday-start cells", () => {
    expect(week).toHaveLength(7);
    // Week containing Mon 2026-06-15 starts Sun 2026-06-14.
    expect(week[0].key).toBe("2026-06-14");
    expect(week[6].key).toBe("2026-06-20");
  });

  it("all cells are inMonth and one is today", () => {
    expect(week.every((c) => c.inMonth)).toBe(true);
    expect(week.filter((c) => c.isToday)).toHaveLength(1);
  });
});

describe("bucketByDate", () => {
  it("splits overdue, scheduled, and unscheduled — keeping past cards in byDate", () => {
    const cards = [
      card("past", "2026-06-10"),
      card("today", "2026-06-15"),
      card("future", "2026-06-20"),
      card("none"),
    ];
    const { byDate, unscheduled, overdue } = bucketByDate(cards, TODAY);

    expect(overdue.map((c) => c.id)).toEqual(["past"]);
    expect(unscheduled.map((c) => c.id)).toEqual(["none"]);
    expect(byDate.get("2026-06-15")?.map((c) => c.id)).toEqual(["today"]);
    expect(byDate.get("2026-06-20")?.map((c) => c.id)).toEqual(["future"]);
    // A past-due card ALSO stays in byDate so its (visible) past cell isn't empty.
    expect(byDate.get("2026-06-10")?.map((c) => c.id)).toEqual(["past"]);
  });

  it("groups multiple cards on the same day", () => {
    const { byDate } = bucketByDate(
      [card("a", "2026-06-20"), card("b", "2026-06-20")],
      TODAY,
    );
    expect(byDate.get("2026-06-20")?.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("omits done-column cards from the overdue tray (but keeps their day chip)", () => {
    const cards = [
      card("open-past", "2026-06-10", "todo"),
      card("done-past", "2026-06-11", "done"),
    ];
    const isDone = (c: TaskCard) => c.columnId === "done";
    const { byDate, overdue } = bucketByDate(cards, TODAY, isDone);

    // Only the open past card is overdue; the done one is not.
    expect(overdue.map((c) => c.id)).toEqual(["open-past"]);
    // Both still appear in their day cell.
    expect(byDate.get("2026-06-10")?.map((c) => c.id)).toEqual(["open-past"]);
    expect(byDate.get("2026-06-11")?.map((c) => c.id)).toEqual(["done-past"]);
  });
});

describe("shift helpers + toDateKey", () => {
  it("shiftMonth / shiftWeek step in both directions", () => {
    expect(toDateKey(shiftMonth(TODAY, 1))).toBe("2026-07-15");
    expect(toDateKey(shiftMonth(TODAY, -1))).toBe("2026-05-15");
    expect(toDateKey(shiftWeek(TODAY, 1))).toBe("2026-06-22");
    expect(toDateKey(shiftWeek(TODAY, -1))).toBe("2026-06-08");
  });
});
