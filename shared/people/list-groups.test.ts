import { describe, it, expect } from "vitest";
import type { PersonSummary } from "../types/people-view";
import { groupPeopleBy } from "./list-groups";

const p = (id: string, name: string, extra: Partial<PersonSummary> = {}): PersonSummary => ({
  id, workspaceId: "w", name, aliases: [], emails: [], relationship: [], status: "confirmed", provenance: "explicit",
  isMe: false, agentPrivate: false, teams: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra,
});
const now = new Date("2026-11-20T12:00:00Z");
const people = [
  p("1", "Ann", { team: "Sync", timezone: "Europe/Berlin", lastMetAt: "2026-11-18T10:00:00Z" }),
  p("2", "bo", { team: "sync", timezone: "Europe/Berlin", lastMetAt: "2026-10-30T10:00:00Z" }),
  p("3", "Cy", { location: "Lisbon, Portugal", relationship: [{ type: "peer", provenance: "explicit" }] }),
  p("4", "Émile"),
];

describe("groupPeopleBy", () => {
  it("team: one group per team ignoring case, no team last", () => {
    expect(groupPeopleBy(people, "team", { now }).map((g) => [g.label, g.people.length])).toEqual([["Sync", 2], ["No team", 2]]);
  });
  it("place: by zone with local time, then by location, unknown last", () => {
    const g = groupPeopleBy(people, "place", { now });
    expect(g.map((x) => x.label)).toEqual(["Berlin", "Lisbon", "Unknown"]);
    expect(g[0].note).toBe("13:00");
  });
  it("recency: in time order, never met last", () => {
    expect(groupPeopleBy(people, "recency", { now }).map((g) => g.label)).toEqual(["This week", "This month", "Not met yet"]);
  });
  it("name: by first letter, accents folded", () => {
    expect(groupPeopleBy(people, "name", { now }).map((g) => g.label)).toEqual(["A", "B", "C", "E"]);
  });
  it("pins you at the top in every grouping and leaves you out of the rest", () => {
    const withMe = [...people, p("me", "Zoe Me", { isMe: true, team: "Sync" })];
    for (const by of ["relationship", "team", "place", "recency", "name"] as const) {
      const g = groupPeopleBy(withMe, by, { now });
      expect(g[0]).toMatchObject({ key: "me", label: "You" });
      expect(g.slice(1).flatMap((x) => x.people.map((y) => y.id))).not.toContain("me");
    }
    expect(groupPeopleBy(withMe, "team", { now, query: "ann" })[0].key).not.toBe("me");
  });

  it("applies the relationship filter and the search", () => {
    expect(groupPeopleBy(people, "team", { now, only: "peer" }).flatMap((g) => g.people.map((x) => x.name))).toEqual(["Cy"]);
    expect(groupPeopleBy(people, "team", { now, query: "ann" }).flatMap((g) => g.people.map((x) => x.name))).toEqual(["Ann"]);
  });
});
