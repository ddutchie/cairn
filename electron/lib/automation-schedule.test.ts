import { describe, it, expect } from "vitest";
import { parseSchedule, computeNextRun, MATCH_HORIZON_MS } from "./automation-schedule";

// A fixed instant (UTC) to make tests deterministic.
const T0 = new Date("2026-08-03T12:00:00Z");

describe("parseSchedule", () => {
  it("parses 'every N unit' durations", () => {
    expect(parseSchedule("every 30 minutes").intervalMs).toBe(30 * 60_000);
    expect(parseSchedule("every 2 hours").intervalMs).toBe(2 * 3_600_000);
    expect(parseSchedule("every 1 day").intervalMs).toBe(86_400_000);
    expect(parseSchedule("every 1 week").intervalMs).toBe(7 * 86_400_000);
    expect(parseSchedule("Every 15 minutes").kind).toBe("every");
  });

  it("rejects malformed 'every'", () => {
    expect(() => parseSchedule("every 5 fortnights")).toThrow();
    expect(() => parseSchedule("every -1 hours")).toThrow();
  });

  it("parses 'once <ISO>' and 'at <ISO>'", () => {
    const s = parseSchedule("once 2026-09-01T09:00:00");
    expect(s.kind).toBe("once");
    expect(s.atMs).toBe(new Date("2026-09-01T09:00:00").getTime());
    expect(parseSchedule("at 2026-09-01T09:00:00").kind).toBe("once");
    expect(() => parseSchedule("once not-a-date")).toThrow();
  });

  it("parses 5-field cron (with and without the 'cron' prefix)", () => {
    const bare = parseSchedule("*/15 * * * *");
    expect(bare.kind).toBe("cron");
    expect(bare.expr).toBe("*/15 * * * *");
    const prefixed = parseSchedule("cron 0 9 * * 1-5");
    expect(prefixed.kind).toBe("cron");
    expect(prefixed.expr).toBe("0 9 * * 1-5");
    expect(() => parseSchedule("cron 0 9 * *")).toThrow();
  });

  it("rejects garbage", () => {
    expect(() => parseSchedule("someday soon")).toThrow();
  });
});

describe("computeNextRun — every", () => {
  it("returns from + interval", () => {
    const s = parseSchedule("every 30 minutes");
    expect(computeNextRun(s, T0)!.getTime()).toBe(T0.getTime() + 30 * 60_000);
  });
});

describe("computeNextRun — once", () => {
  it("returns the fixed time when in the future", () => {
    const s = parseSchedule("once 2026-09-01T09:00:00Z");
    expect(computeNextRun(s, T0)!.toISOString()).toBe("2026-09-01T09:00:00.000Z");
  });

  it("returns null when in the past", () => {
    const s = parseSchedule("once 2020-01-01T00:00:00");
    expect(computeNextRun(s, T0)).toBeNull();
  });
});

describe("computeNextRun — cron", () => {
  it("fires every 15 minutes", () => {
    const s = parseSchedule("*/15 * * * *");
    const next = computeNextRun(s, new Date("2026-08-03T12:01:00Z"), "UTC");
    expect(next!.toISOString()).toBe("2026-08-03T12:15:00.000Z");
  });

  it("fires daily at 09:00 in the configured timezone", () => {
    const s = parseSchedule("0 9 * * *");
    // 2026-08-03T12:00Z == 07:00 in America/New_York (EDT, UTC-4) → next 09:00 EDT == 13:00Z
    const next = computeNextRun(s, T0, "America/New_York");
    expect(next!.toISOString()).toBe("2026-08-03T13:00:00.000Z");
  });

  it("fires weekdays only", () => {
    const s = parseSchedule("0 9 * * 1-5");
    // 2026-08-03 is a Monday, 12:00Z; next weekday 09:00 local is tomorrow.
    const next = computeNextRun(s, T0, "UTC");
    expect(next!.getUTCDay()).toBe(2); // Tuesday
    expect(next!.getUTCHours()).toBe(9);
  });

  it("returns null when the cron can never match within the horizon", () => {
    // 30 Feb never exists.
    const s = parseSchedule("0 0 30 2 *");
    expect(computeNextRun(s, T0, "UTC")).toBeNull();
  });

  it("is bounded by the search horizon (does not loop forever)", () => {
    const s = parseSchedule("0 0 30 2 *");
    const start = Date.now();
    computeNextRun(s, T0, "UTC");
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(MATCH_HORIZON_MS).toBe(366 * 86_400_000);
  });
});
