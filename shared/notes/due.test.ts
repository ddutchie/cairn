import { describe, it, expect } from "vitest";
import { isOverdue, isDueToday, isDueWithin } from "./due";

/** yyyy-MM-dd for a date `offset` days from today (local). */
function dayOffset(offset: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("isOverdue", () => {
  it("true for a past date, false for today/future/none", () => {
    expect(isOverdue(dayOffset(-1))).toBe(true);
    expect(isOverdue(dayOffset(0))).toBe(false);
    expect(isOverdue(dayOffset(3))).toBe(false);
    expect(isOverdue(null)).toBe(false);
    expect(isOverdue(undefined)).toBe(false);
  });
});

describe("isDueToday", () => {
  it("true only for today", () => {
    expect(isDueToday(dayOffset(0))).toBe(true);
    expect(isDueToday(dayOffset(-1))).toBe(false);
    expect(isDueToday(dayOffset(1))).toBe(false);
  });
});

describe("isDueWithin", () => {
  const NOW = new Date(2026, 6, 15); // 2026-07-15 (month 0-based)

  it("includes today and the end of the window, excludes beyond", () => {
    expect(isDueWithin("2026-07-15", 7, NOW)).toBe(true);  // today
    expect(isDueWithin("2026-07-22", 7, NOW)).toBe(true);  // exactly +7
    expect(isDueWithin("2026-07-23", 7, NOW)).toBe(false); // +8
  });

  it("excludes overdue dates", () => {
    expect(isDueWithin("2026-07-14", 7, NOW)).toBe(false);
  });

  it("days=0 means due today only", () => {
    expect(isDueWithin("2026-07-15", 0, NOW)).toBe(true);
    expect(isDueWithin("2026-07-16", 0, NOW)).toBe(false);
  });

  it("false for null/invalid", () => {
    expect(isDueWithin(null, 7, NOW)).toBe(false);
    expect(isDueWithin("not-a-date", 7, NOW)).toBe(false);
  });
});
