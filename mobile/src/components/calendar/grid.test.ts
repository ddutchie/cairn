import { describe, it, expect } from "vitest";
import { dayKey, dueDayKey, buildMonthGrid, buildWeekGrid, formatDayLabel } from "./grid";

describe("dayKey", () => {
  it("formats a local Y-M-D with zero padding", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(dayKey(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("dueDayKey", () => {
  it("passes a bare yyyy-MM-dd through unchanged (no UTC shift)", () => {
    expect(dueDayKey("2026-07-07")).toBe("2026-07-07");
  });
  it("parses a full ISO timestamp to its LOCAL day", () => {
    // Construct an ISO string for local noon so the local day is unambiguous.
    const iso = new Date(2026, 6, 7, 12, 0, 0).toISOString();
    expect(dueDayKey(iso)).toBe("2026-07-07");
  });
  it("returns empty string for an unparseable value", () => {
    expect(dueDayKey("not-a-date")).toBe("");
  });
});

describe("buildMonthGrid", () => {
  const todayKey = "2026-07-15";
  const grid = buildMonthGrid(new Date(2026, 6, 1), todayKey); // July 2026

  it("always produces 42 cells (6 weeks)", () => {
    expect(grid).toHaveLength(42);
  });

  it("starts on the Sunday on/before the 1st", () => {
    // July 1 2026 is a Wednesday → grid starts Sunday June 28.
    expect(grid[0].key).toBe("2026-06-28");
    expect(grid[0].date.getDay()).toBe(0);
    expect(grid[0].inMonth).toBe(false);
  });

  it("marks in-month days and flags today", () => {
    const first = grid.find((c) => c.key === "2026-07-01")!;
    expect(first.inMonth).toBe(true);
    const today = grid.find((c) => c.key === todayKey)!;
    expect(today.isToday).toBe(true);
    expect(grid.filter((c) => c.isToday)).toHaveLength(1);
  });

  it("keeps trailing adjacent-month days out of month", () => {
    const last = grid[grid.length - 1];
    expect(last.date.getMonth()).not.toBe(6); // spills into August
    expect(last.inMonth).toBe(false);
  });
});

describe("buildWeekGrid", () => {
  const week = buildWeekGrid(new Date(2026, 6, 15), "2026-07-15"); // Wed Jul 15

  it("produces 7 Sunday-start cells all in-month", () => {
    expect(week).toHaveLength(7);
    expect(week[0].date.getDay()).toBe(0);
    expect(week.every((c) => c.inMonth)).toBe(true);
  });

  it("contains the anchor day and flags today", () => {
    const anchorCell = week.find((c) => c.key === "2026-07-15")!;
    expect(anchorCell).toBeDefined();
    expect(anchorCell.isToday).toBe(true);
  });
});

describe("formatDayLabel", () => {
  it("formats a valid key with weekday", () => {
    expect(formatDayLabel("2026-07-06")).toBe("Monday, July 6");
  });
  it("returns the raw key when it can't parse", () => {
    expect(formatDayLabel("garbage")).toBe("garbage");
  });
});
