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
} from "./sidebar-utils";

describe("buildShortcutMap", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ view: `v${i}` }));

  it("assigns ⌘3, ⌘4, … starting at the default base", () => {
    const map = buildShortcutMap(items(3));
    expect(map.get("v0")).toBe("⌘3");
    expect(map.get("v1")).toBe("⌘4");
    expect(map.get("v2")).toBe("⌘5");
  });

  it("drops shortcuts past ⌘9 (empty string)", () => {
    // base 3 + 7 items → ⌘3..⌘9, then the 8th would be ⌘10 → "".
    const map = buildShortcutMap(items(8));
    expect(map.get("v6")).toBe("⌘9"); // index 6 → 9
    expect(map.get("v7")).toBe("");   // index 7 → 10 → dropped
  });

  it("respects a custom base", () => {
    const map = buildShortcutMap(items(2), 1);
    expect(map.get("v0")).toBe("⌘1");
    expect(map.get("v1")).toBe("⌘2");
  });

  it("returns an empty map for no items", () => {
    expect(buildShortcutMap([]).size).toBe(0);
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
