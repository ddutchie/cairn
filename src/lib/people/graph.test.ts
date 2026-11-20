import { describe, it, expect } from "vitest";
import type { PersonSummary } from "../../../shared/types/people-view";
import { buildPeopleGraph, linkText, LINK_TOKEN } from "./graph";
import type { NetworkLink } from "./network";

const person = (id: string, name: string): PersonSummary => ({
  id, workspaceId: "ws", name, aliases: [], emails: [], relationship: [], status: "confirmed",
  provenance: "explicit", isMe: false, agentPrivate: false, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
});
const link = (over: Partial<NetworkLink> & Pick<NetworkLink, "id" | "kind" | "source" | "target">): NetworkLink => ({
  directed: false, ended: false, derived: false, weight: 1, ...over,
});

describe("buildPeopleGraph", () => {
  const people = [person("me", "Me"), person("a", "Ann"), person("b", "Bo")];

  it("makes person nodes and one edge per link, dropping links to unknown people", () => {
    const { graph } = buildPeopleGraph(people, [
      link({ id: "1", kind: "reporting", source: "me", target: "a" }),
      link({ id: "2", kind: "peer", source: "a", target: "zzz" }),
    ], "me", "ws");
    expect(graph.nodes.map((n) => [n.id, n.type, n.title])).toEqual([["me", "person", "Me"], ["a", "person", "Ann"], ["b", "person", "Bo"]]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ id: "1", source: "me", target: "a", type: "reports-to" });
  });

  it("styles me, former links and meeting weight", () => {
    const links = [
      link({ id: "1", kind: "mentor", source: "a", target: "b", ended: true }),
      link({ id: "2", kind: "meeting", source: "me", target: "a", weight: 3 }),
      link({ id: "3", kind: "reporting", source: "me", target: "b" }),
    ];
    const { graph, styling } = buildPeopleGraph(people, links, "me", "ws");
    const [former, meet, live] = graph.edges.map((e) => styling.edge!(e)!);
    expect(former).toMatchObject({ token: LINK_TOKEN.mentor, dash: true });
    expect(live).toMatchObject({ token: LINK_TOKEN.reporting, dash: false, opacity: 0.85 });
    expect(meet.dash).toBe(true);
    expect(meet.width).toBeCloseTo(0.8 + Math.log2(4) * 0.7);
    expect(styling.node!(graph.nodes[0])).toMatchObject({ token: "accent", label: true });
    expect(styling.node!(graph.nodes[1])).toBeUndefined();
  });

  it("describes an edge for the hover text", () => {
    expect(linkText(link({ id: "1", kind: "mentor", source: "a", target: "b", label: "coach", ended: true }), "Ann", "Bo"))
      .toBe("Ann – Bo: Mentor (coach), former");
    expect(linkText(link({ id: "2", kind: "meeting", source: "a", target: "b", weight: 1 }), "Ann", "Bo"))
      .toBe("Ann – Bo: Meetings together, 1 meeting");
    const { graph, styling } = buildPeopleGraph(people, [link({ id: "2", kind: "meeting", source: "a", target: "b", weight: 2 })], null, "ws");
    expect(styling.edgeText!(graph.edges[0])).toBe("Ann – Bo: Meetings together, 2 meetings");
  });

  it("says who manages, mentors or backs whom for a directed link", () => {
    const d = (kind: NetworkLink["kind"], extra: Partial<NetworkLink> = {}) => link({ id: "x", kind, source: "a", target: "b", directed: true, ...extra });
    expect(linkText(d("reporting"), "Ann", "Bo")).toBe("Ann manages Bo (Reporting line)");
    expect(linkText(d("mentor", { label: "coach", ended: true }), "Ann", "Bo")).toBe("Ann mentors Bo (Mentor, coach), former");
    expect(linkText(d("stakeholder"), "Ann", "Bo")).toBe("Ann is a stakeholder for Bo (Stakeholder)");
    expect(linkText(link({ id: "p", kind: "peer", source: "a", target: "b" }), "Ann", "Bo")).toBe("Ann – Bo: Peer");
  });

  it("pins the focus person to the centre", () => {
    const { graph, styling } = buildPeopleGraph(people, [], "me", "ws", "a");
    expect(styling.node!(graph.nodes[1])).toMatchObject({ pin: true, label: true });
    // With a focus, "me" is only labelled, not recoloured.
    expect(styling.node!(graph.nodes[0])).toEqual({ label: true });
    expect(styling.node!(graph.nodes[2])).toBeUndefined();
  });
});

