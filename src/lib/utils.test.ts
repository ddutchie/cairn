/**
 * Unit tests for pure date/formatting helpers in src/lib/utils.ts.
 * These use fake timers to pin "now" so the relative/boundary math is
 * deterministic.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { formatRelative, getDueDateStatus } from "./utils";

const NOW = new Date("2026-06-15T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelative", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("returns 'just now' for under a minute", () => {
    expect(formatRelative(ago(30 * SEC))).toBe("just now");
    expect(formatRelative(ago(59 * SEC))).toBe("just now");
  });

  it("returns minutes for 1–59 minutes", () => {
    expect(formatRelative(ago(1 * MIN))).toBe("1m ago");
    expect(formatRelative(ago(59 * MIN))).toBe("59m ago");
  });

  it("returns hours for 1–23 hours", () => {
    expect(formatRelative(ago(1 * HOUR))).toBe("1h ago");
    expect(formatRelative(ago(23 * HOUR))).toBe("23h ago");
  });

  it("returns days for 1–6 days", () => {
    expect(formatRelative(ago(1 * DAY))).toBe("1d ago");
    expect(formatRelative(ago(6 * DAY))).toBe("6d ago");
  });

  it("falls back to an absolute date at 7+ days", () => {
    // At/after 7 days it delegates to formatDate (an absolute "Mon D, YYYY").
    const result = formatRelative(ago(7 * DAY));
    expect(result).not.toMatch(/ago|just now/);
    expect(result).toContain("2026");
  });
});

describe("getDueDateStatus", () => {
  // getDueDateStatus compares LOCAL calendar days (it normalises to local
  // midnight). Build inputs from a local-day offset so the test is independent
  // of the machine timezone.
  const localDay = (offsetDays: number): string => {
    const d = new Date(NOW);
    d.setHours(12, 0, 0, 0); // midday avoids DST edge ambiguity
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString();
  };

  it("returns 'none' for null/undefined/empty", () => {
    expect(getDueDateStatus(null)).toBe("none");
    expect(getDueDateStatus(undefined)).toBe("none");
    expect(getDueDateStatus("")).toBe("none");
  });

  it("returns 'today' for the current calendar day regardless of time", () => {
    // Same local day, different times → still today (day-level compare).
    const startOfToday = new Date(NOW); startOfToday.setHours(0, 5, 0, 0);
    const endOfToday = new Date(NOW); endOfToday.setHours(23, 55, 0, 0);
    expect(getDueDateStatus(startOfToday.toISOString())).toBe("today");
    expect(getDueDateStatus(endOfToday.toISOString())).toBe("today");
  });

  it("returns 'overdue' for a past calendar day", () => {
    expect(getDueDateStatus(localDay(-1))).toBe("overdue");
    expect(getDueDateStatus(localDay(-30))).toBe("overdue");
  });

  it("returns 'upcoming' for a future calendar day", () => {
    expect(getDueDateStatus(localDay(1))).toBe("upcoming");
    expect(getDueDateStatus(localDay(200))).toBe("upcoming");
  });
});
