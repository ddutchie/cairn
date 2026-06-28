/**
 * Unit tests for sidebar pure helpers (sidebar-utils.ts).
 *
 *  - buildShortcutMap: the ⌘3…⌘9 assignment with the >9 drop boundary — an
 *    off-by-one here breaks the whole shortcut row.
 *  - countOpenCardsByProject: single-pass aggregation excluding archived cards.
 *  - dueDateSeverity: overdue/soon/none bucketing (a fixed `now` is passed so
 *    the test is deterministic regardless of clock/timezone).
 */

import { describe, it, expect } from "vitest";
import {
  buildShortcutMap,
  countOpenCardsByProject,
  dueDateSeverity,
  dueDateDiffDays,
} from "./sidebar-utils";

describe("buildShortcutMap", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ view: `v${i}` }));

  it("assigns ⌘3, ⌘4, … starting at the default base", () => {
    const map = buildShortcutMap(items(3), 3, true);
    expect(map.get("v0")).toBe("⌘3");
    expect(map.get("v1")).toBe("⌘4");
    expect(map.get("v2")).toBe("⌘5");
  });

  it("drops shortcuts past ⌘9 (empty string)", () => {
    // base 3 + 7 items → ⌘3..⌘9, then the 8th would be ⌘10 → "".
    const map = buildShortcutMap(items(8), 3, true);
    expect(map.get("v6")).toBe("⌘9"); // index 6 → 9
    expect(map.get("v7")).toBe("");   // index 7 → 10 → dropped
  });

  it("respects a custom base", () => {
    const map = buildShortcutMap(items(2), 1, true);
    expect(map.get("v0")).toBe("⌘1");
    expect(map.get("v1")).toBe("⌘2");
  });

  it("uses Ctrl on non-macOS platforms", () => {
    const map = buildShortcutMap(items(2), 3, false);
    expect(map.get("v0")).toBe("Ctrl+3");
    expect(map.get("v1")).toBe("Ctrl+4");
  });

  it("returns an empty map for no items", () => {
    expect(buildShortcutMap([], 3, true).size).toBe(0);
  });
});

describe("countOpenCardsByProject", () => {
  it("counts non-archived cards per project", () => {
    const counts = countOpenCardsByProject([
      { projectId: "p1" },
      { projectId: "p1" },
      { projectId: "p2" },
    ]);
    expect(counts.get("p1")).toBe(2);
    expect(counts.get("p2")).toBe(1);
  });

  it("excludes archived cards", () => {
    const counts = countOpenCardsByProject([
      { projectId: "p1" },
      { projectId: "p1", archivedAt: "2026-01-01" },
    ]);
    expect(counts.get("p1")).toBe(1);
  });

  it("omits projects with only archived cards entirely", () => {
    const counts = countOpenCardsByProject([
      { projectId: "p1", archivedAt: "2026-01-01" },
    ]);
    expect(counts.has("p1")).toBe(false);
  });

  it("returns an empty map for no cards", () => {
    expect(countOpenCardsByProject([]).size).toBe(0);
  });
});

describe("dueDateSeverity", () => {
  const NOW = new Date("2026-06-15T12:00:00Z").getTime();
  const daysFromNow = (d: number) =>
    new Date(NOW + d * 24 * 60 * 60 * 1000).toISOString();

  it("returns 'danger' for a past due date", () => {
    expect(dueDateSeverity(daysFromNow(-1), NOW)).toBe("danger");
    expect(dueDateSeverity(daysFromNow(-30), NOW)).toBe("danger");
  });

  it("returns 'danger' for a due date earlier today (overdue, not warning)", () => {
    // A small negative diff used to round to -0 via Math.ceil and slip into the
    // 7-day "warning" branch — overdue items must always be "danger".
    expect(dueDateSeverity(daysFromNow(-0.1), NOW)).toBe("danger");
  });

  it("returns 'warning' for due today and within 7 days", () => {
    expect(dueDateSeverity(daysFromNow(0.1), NOW)).toBe("warning"); // later today
    expect(dueDateSeverity(daysFromNow(3), NOW)).toBe("warning");
    expect(dueDateSeverity(daysFromNow(7), NOW)).toBe("warning");
  });

  it("returns null for due dates more than 7 days away", () => {
    expect(dueDateSeverity(daysFromNow(8), NOW)).toBeNull();
    expect(dueDateSeverity(daysFromNow(60), NOW)).toBeNull();
  });
});

describe("dueDateDiffDays", () => {
  it("returns 0 for a deadline later the same calendar day (Due today)", () => {
    // Build `now` at local noon so a few hours later is still the same day in
    // the local timezone (the helper compares local calendar dates).
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
    const laterToday = new Date(2026, 5, 15, 18, 30, 0).toISOString();
    // Math.ceil of the ~6.5h fraction would round up to 1 ("Due in 1 day");
    // same-calendar-day detection must yield 0 → "Due today".
    expect(dueDateDiffDays(laterToday, now)).toBe(0);
  });

  it("returns whole days for future deadlines on later calendar days", () => {
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
    const tomorrow = new Date(2026, 5, 16, 12, 0, 0).toISOString();
    const inThree = new Date(2026, 5, 18, 12, 0, 0).toISOString();
    expect(dueDateDiffDays(tomorrow, now)).toBe(1);
    expect(dueDateDiffDays(inThree, now)).toBe(3);
  });
});
