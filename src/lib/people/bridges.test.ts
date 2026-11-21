import { describe, it, expect } from "vitest";
import type { PersonSummary } from "../../../shared/types/people-view";
import { buildBridges } from "./bridges";
import type { NetworkLink } from "./network";

const p = (id: string, isMe = false): PersonSummary => ({
  id, workspaceId: "w", name: id, aliases: [], emails: [], relationship: [], status: "confirmed", provenance: "explicit",
  isMe, agentPrivate: false, teams: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});
const link = (source: string, target: string, ended = false): NetworkLink => ({
  id: `${source}-${target}`, kind: "peer", source, target, directed: false, ended, derived: false, weight: 1,
});

describe("buildBridges", () => {
  const people = ["me", "ada", "pri", "sam", "joa", "eve"].map((id) => p(id, id === "me"));
  const links = [link("me", "ada"), link("ada", "pri"), link("ada", "sam"), link("sam", "joa")];

  it("finds who would be cut off if each person were gone, largest first", () => {
    const m = buildBridges(people, links);
    expect(m.dependencies.map((d) => [d.person.id, d.cutOff.map((x) => x.id)])).toEqual([
      ["ada", ["joa", "pri", "sam"]],
      ["sam", ["joa"]],
    ]);
  });
  it("lists people with no path to you, and draws them", () => {
    const m = buildBridges(people, links);
    expect(m.disconnected.map((x) => x.id)).toEqual(["eve"]);
    expect(m.nodeIds).toContain("eve");
  });
  it("is not a dependence when there is a second route, and ignores ended links", () => {
    const m = buildBridges(people, [...links, link("me", "sam")]);
    // Ada is still the only route to Priya; Sam is still the only route to João; but Ada no longer reaches Sam or João.
    expect(m.dependencies.map((d) => [d.person.id, d.cutOff.map((x) => x.id)])).toEqual([["ada", ["pri"]], ["sam", ["joa"]]]);
    const ended = buildBridges(people, [...links, link("me", "sam", true)]);
    expect(ended.dependencies.map((d) => d.person.id)).toEqual(["ada", "sam"]);
  });
  it("is empty without a me person", () => {
    expect(buildBridges(people.map((x) => ({ ...x, isMe: false })), links).dependencies).toEqual([]);
  });
});
