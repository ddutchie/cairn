import { describe, it, expect } from "vitest";
import type { PersonSummary } from "../types/people-view";
import { NO_TEAM, groupByTeam, peopleUnder, teamForest } from "./teams";
import type { Team } from "../types/people";
import { buildZoneModel, formatDiff, groupZoneRows, overlapHours, sameZone, workSpans, zoneOffsetMinutes } from "./zones";

const p = (id: string, name: string, extra: Partial<PersonSummary> = {}): PersonSummary => ({
  id, workspaceId: "w", name, aliases: [], emails: [], relationship: [], status: "confirmed", provenance: "explicit",
  isMe: false, agentPrivate: false, teams: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra,
});

describe("groupByTeam", () => {
  it("groups ignoring case and spacing, largest first, no team last", () => {
    const g = groupByTeam([
      p("1", "A", { team: "Platform" }), p("2", "B", { team: " platform " }), p("3", "C", { team: "Data" }), p("4", "D"),
    ]);
    expect(g.map((x) => [x.team, x.people.length])).toEqual([["Platform", 2], ["Data", 1], [NO_TEAM, 1]]);
  });
  it("counts each relationship once per person and collects distinct zones", () => {
    const [g] = groupByTeam([
      p("1", "A", { team: "T", timezone: "Europe/London", relationship: [{ type: "peer", provenance: "explicit" }, { type: "mentor", provenance: "explicit" }] }),
      p("2", "B", { team: "T", timezone: "Europe/London", relationship: [{ type: "peer", provenance: "explicit" }] }),
    ]);
    expect(g.byRelationship).toEqual({ peer: 2, mentor: 1 });
    expect(g.timezones).toEqual(["Europe/London"]);
  });
});

describe("teamForest", () => {
  const t = (id: string, name: string, parentTeamId?: string): Team => ({
    id, workspaceId: "w", name, kind: "team", parentTeamId, links: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  });
  it("nests teams under their parent, keeps empty teams with details, and survives a loop", () => {
    const people = [p("1", "A", { team: "Sync" }), p("2", "B", { team: "Data" }), p("3", "C", { team: "Loose" })];
    const groups = groupByTeam(people, [t("pl", "Platform"), t("sy", "Sync", "pl"), t("da", "Data", "pl"), t("x", "X", "y"), t("y", "Y", "x")]);
    const forest = teamForest(groups);
    const platform = forest.find((n) => n.group.team === "Platform")!;
    expect(platform.children.map((c) => c.group.team).sort()).toEqual(["Data", "Sync"]);
    expect(platform.children[0].path).toEqual(["Platform"]);
    expect(peopleUnder(platform).map((x) => x.name).sort()).toEqual(["A", "B"]);
    expect(forest.map((n) => n.group.team)).toEqual(expect.arrayContaining(["Loose", "X", "Y"]));
  });
});

describe("zones", () => {
  const winter = new Date("2026-01-15T12:00:00Z");
  it("reads offsets, and returns null for an unknown zone", () => {
    expect(zoneOffsetMinutes("Europe/London", winter)).toBe(0);
    expect(zoneOffsetMinutes("America/New_York", winter)).toBe(-300);
    expect(zoneOffsetMinutes("Asia/Kolkata", winter)).toBe(330);
    expect(zoneOffsetMinutes("Not/AZone", winter)).toBeNull();
  });
  it("maps their working day into your hours, wrapping past midnight", () => {
    expect(workSpans(0)).toEqual([[9, 17]]);
    expect(workSpans(-300)).toEqual([[14, 22]]);
    expect(workSpans(-600)).toEqual([[19, 24], [0, 3]]);
    expect(workSpans(480)).toEqual([[1, 9]]);
  });
  it("counts shared working hours", () => {
    expect(overlapHours(0)).toBe(8);
    expect(overlapHours(-300)).toBe(3);
    expect(overlapHours(-600)).toBe(0);
  });
  it("builds rows from furthest behind to furthest ahead, and lists people without a usable zone", () => {
    const me = p("me", "Me", { isMe: true, timezone: "Europe/London" });
    const m = buildZoneModel([
      me, p("1", "Ny", { timezone: "America/New_York" }), p("2", "Blr", { timezone: "Asia/Kolkata" }),
      p("3", "Bad", { timezone: "Nope" }), p("4", "None"),
    ], me, winter);
    expect(m.rows.map((r) => [r.person.name, r.diffMinutes, r.localTime, r.atWork])).toEqual([
      ["Ny", -300, "07:00", false], ["Blr", 330, "17:30", false],
    ]);
    expect(m.unset.map((x) => x.name)).toEqual(["Bad", "None"]);
    expect(m.me).toEqual({ timezone: "Europe/London", fromProfile: true });
    expect(m.nowHour).toBe(12);
  });
  it("formats differences", () => {
    expect([0, 120, -330].map(formatDiff)).toEqual(["same time", "+2h", "-5h 30m"]);
  });

  it("keeps the minute exact (12:01 is not 12:00)", () => {
    const me = p("me", "Me", { isMe: true, timezone: "UTC" });
    for (const min of [1, 7, 16, 22, 31, 37, 46, 52]) {
      const at = new Date(Date.UTC(2026, 0, 15, 12, min));
      const m = buildZoneModel([me, p("1", "A", { timezone: "UTC" })], me, at);
      expect(m.rows[0].localTime).toBe(`12:${String(min).padStart(2, "0")}`);
    }
  });
});

describe("zone rows: you and grouping", () => {
  const winter = new Date(Date.UTC(2026, 0, 15, 12, 0));
  const rel = (type: "direct_report" | "peer" | "manager" | "buddy") => [{ type, provenance: "explicit" as const }];
  const me = p("me", "Me", { isMe: true, timezone: "Europe/London" });
  const people = [
    me,
    p("a", "Ann", { timezone: "Europe/Paris", relationship: rel("peer"), lastMetAt: "2026-01-01T00:00:00Z" }),
    p("b", "Bob", { timezone: "America/New_York", relationship: rel("direct_report"), cadence: "weekly" }),
    p("c", "Cy", { timezone: "Asia/Kolkata", relationship: rel("peer"), cadence: "weekly", lastMetAt: "2025-06-01T00:00:00Z" }),
    p("d", "Di", { timezone: "Europe/Paris", relationship: rel("buddy"), team: "Sync" }),
    p("e", "Ed", { timezone: "Europe/Paris" }),
  ];
  const m = buildZoneModel(people, me, winter);

  it("gives you a row on the same strip, never among the others", () => {
    expect(m.meRow).toMatchObject({ diffMinutes: 0, localTime: "12:00", atWork: true, spans: [[9, 17]], overlap: 8 });
    expect(m.rows.some((r) => r.person.isMe)).toBe(false);
    expect(buildZoneModel([p("1", "A", { timezone: "UTC" })], null, winter).meRow).toBeNull();
  });
  it("closest: relationship groups in list order, cadence then recent meetings first, each person once", () => {
    const g = groupZoneRows(m.rows, "closest");
    expect(g.map((x) => [x.label, x.rows.map((r) => r.person.name)])).toEqual([
      ["Direct reports", ["Bob"]], ["Peers", ["Cy", "Ann"]], ["Other", ["Di", "Ed"]],
    ]);
  });
  it("zone: one group per zone, furthest behind you first", () => {
    const g = groupZoneRows(m.rows, "zone");
    expect(g.map((x) => [x.label, x.note])).toEqual([["New York", "-5h"], ["Paris", "+1h"], ["Kolkata", "+5h 30m"]]);
  });
  it("availability and team, and available-only drops anyone asleep", () => {
    expect(groupZoneRows(m.rows, "availability").map((x) => x.label)).toEqual(["Working now", "Early or late"]);
    expect(groupZoneRows(m.rows, "team").map((x) => x.label)).toEqual(["Sync", "No team"]);
    const night = buildZoneModel(people, me, new Date(Date.UTC(2026, 0, 15, 3, 0)));
    expect(groupZoneRows(night.rows, "zone", { availableOnly: true }).flatMap((x) => x.rows.map((r) => r.person.name))).toEqual(["Cy"]);
  });
});

describe("sameZone", () => {
  it("compares identity, not the offset at one moment", () => {
    expect(sameZone("Europe/Berlin", "Europe/Berlin")).toBe(true);
    expect(sameZone("Asia/Kolkata", "Asia/Calcutta")).toBe(true);
    // Same UTC offset in winter, different zones.
    expect(sameZone("Europe/Berlin", "Africa/Lagos")).toBe(false);
    expect(sameZone("Europe/Berlin", "Not/AZone")).toBe(false);
  });
});
