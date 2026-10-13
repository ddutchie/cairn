import { describe, it, expect } from "vitest";
import { calendarStatus } from "./project-status";

describe("calendarStatus", () => {
  // 2026-10-13 is a Tuesday: its Sunday-start week is Oct 11 - Oct 17.
  const dated = [
    { due_date: "2026-10-11", is_done: 0 }, // overdue, this week
    { due_date: "2026-10-13", is_done: 0 }, // today
    { due_date: "2026-10-17", is_done: 0 }, // end of week
    { due_date: "2026-10-18", is_done: 0 }, // next week, same month
    { due_date: "2026-11-02", is_done: 0 }, // next month
    { due_date: "2026-10-14", is_done: 1 }, // done: ignored
  ];
  it("counts today / week / month / overdue", () => {
    expect(calendarStatus(dated, 3, "2026-10-13")).toEqual({ today: 1, week: 3, month: 4, overdue: 1, unscheduled: 3 });
  });
  it("handles a week that spans months", () => {
    // 2026-10-31 (Sat): week is Oct 25 - Oct 31; 2026-11-01 is the next week.
    const s = calendarStatus([{ due_date: "2026-11-01", is_done: 0 }, { due_date: "2026-10-26", is_done: 0 }], 0, "2026-10-31");
    expect(s.week).toBe(1);
    expect(s.month).toBe(1);
  });
});
