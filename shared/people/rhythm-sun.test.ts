import { describe, it, expect } from "vitest";
import type { PersonSummary } from "../types/people-view";
import { ZONE_COORDS } from "./zone-coords";
import { buildRhythm } from "./rhythm";
import { sunAt, sunElevation } from "./sun";

const p = (id: string, extra: Partial<PersonSummary> = {}): PersonSummary => ({
  id, workspaceId: "w", name: id, aliases: [], emails: [], relationship: [], status: "confirmed", provenance: "explicit",
  isMe: false, agentPrivate: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra,
});
const now = new Date("2026-11-20T12:00:00Z");
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const ahead = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString();

describe("buildRhythm", () => {
  it("classifies by cadence, sorts the most overdue first, and lists people without a cadence", () => {
    const m = buildRhythm([
      p("a", { cadence: "weekly", lastMetAt: ago(9) }),
      p("b", { cadence: "weekly", lastMetAt: ago(6) }),
      p("c", { cadence: "monthly", lastMetAt: ago(3) }),
      p("d", { cadence: "weekly" }),
      p("e"),
      p("me", { isMe: true, cadence: "weekly" }),
      p("s", { cadence: "weekly", status: "suggested" }),
    ], now);
    expect(m.rows.map((r) => [r.person.id, r.state])).toEqual([["d", "never"], ["a", "overdue"], ["b", "soon"], ["c", "ok"]]);
    expect(m.rows[1].daysOver).toBe(2);
    expect(m.noCadence.map((x) => x.id)).toEqual(["e"]);
    expect(m.counts).toEqual({ overdue: 1, soon: 1, ok: 1, never: 1 });
  });
  it("counts a meeting booked in time as on track, but not one booked too late", () => {
    const m = buildRhythm([
      p("in-time", { cadence: "weekly", lastMetAt: ago(6), nextMeetingAt: ahead(1) }),
      p("too-late", { cadence: "weekly", lastMetAt: ago(8), nextMeetingAt: ahead(3) }),
    ], now);
    const state = Object.fromEntries(m.rows.map((r) => [r.person.id, r.state]));
    expect(state).toEqual({ "in-time": "ok", "too-late": "overdue" });
  });
});

describe("sun", () => {
  it("has the sun near the subsolar point of the equinox noon", () => {
    const s = sunAt(new Date("2026-03-20T12:00:00Z"));
    expect(Math.abs(s.lat)).toBeLessThan(1);
    expect(Math.abs(s.lon)).toBeLessThan(6);
  });
  it("puts the sun high at local noon and below the horizon at local midnight", () => {
    const s = sunAt(new Date("2026-06-21T12:00:00Z"));
    expect(sunElevation(s, 51.5, -0.1)).toBeGreaterThan(55);
    expect(sunElevation(s, -51.5, 179.9)).toBeLessThan(-20);
  });
});

describe("zone coordinates", () => {
  it("knows the common zones and their old names", () => {
    expect(ZONE_COORDS["Europe/London"]![0]).toBeCloseTo(51.5, 0);
    expect(ZONE_COORDS["Asia/Calcutta"]).toEqual(ZONE_COORDS["Asia/Kolkata"]);
    expect(ZONE_COORDS["Nope/Zone"]).toBeUndefined();
  });
});
