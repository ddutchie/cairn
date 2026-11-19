import { describe, it, expect } from "vitest";
import type { PersonEdge, PersonEdgeType, Relationship, RelationshipType } from "../../../shared/types/people";
import type { PersonSummary } from "../../../shared/types/people-view";
import { buildOrgChart, deriveLinks, filterLinks, findMe, pathTo, type LinkKind, type OrgNode } from "./network";
import { layoutNetwork, layoutOrg, ORG_CARD_W } from "./layout";

let n = 0;
const person = (name: string, extra: Partial<PersonSummary> & { rel?: RelationshipType[] } = {}): PersonSummary => {
  const { rel = [], ...rest } = extra;
  n++;
  return {
    id: name.toLowerCase(), workspaceId: "ws", name, aliases: [], emails: [],
    relationship: rel.map((type): Relationship => ({ type, provenance: "explicit" })),
    status: "confirmed", provenance: "explicit", isMe: false, agentPrivate: false,
    createdAt: `2026-01-${String(n).padStart(2, "0")}`, updatedAt: "x", ...rest,
  };
};
const edge = (source: string, target: string, type: PersonEdgeType = "manager_of", extra: Partial<PersonEdge> = {}): PersonEdge => ({
  id: `${source}-${type}-${target}`, workspaceId: "ws", sourceId: source, targetId: target, type,
  status: "confirmed", provenance: "explicit", createdAt: "x", updatedAt: "x", ...extra,
});
const names = (nodes: OrgNode[]): string[] => nodes.map((x) => x.person.name);

describe("deriveLinks", () => {
  it("maps stored edges, drops unknown people, and adds links from me's relationship chips", () => {
    const me = person("Me", { isMe: true });
    const ann = person("Ann", { rel: ["direct_report"] });
    const boss = person("Boss", { rel: ["manager"] });
    const pat = person("Pat", { rel: ["peer"] });
    const links = deriveLinks([me, ann, boss, pat], [edge("ann", "ghost"), edge("boss", "pat", "mentor_of")], []);
    const find = (id: string) => links.find((l) => l.id === id)!;
    expect(find("r:ann:direct_report")).toMatchObject({ kind: "reporting", source: "me", target: "ann", derived: true });
    expect(find("r:boss:manager")).toMatchObject({ kind: "reporting", source: "boss", target: "me" });
    expect(find("r:pat:peer")).toMatchObject({ kind: "peer", directed: false });
    expect(find("e:boss-mentor_of-pat")).toMatchObject({ kind: "mentor", derived: false });
    expect(links.some((l) => l.source === "ghost" || l.target === "ghost")).toBe(false);
  });

  it("prefers the stored edge over the same derived link", () => {
    const me = person("Me", { isMe: true });
    const ann = person("Ann", { rel: ["direct_report"] });
    const links = deriveLinks([me, ann], [edge("me", "ann")], []);
    expect(links.filter((l) => l.kind === "reporting")).toHaveLength(1);
    expect(links[0].derived).toBe(false);
  });

  it("lets a current chip stand when the stored edge has ended", () => {
    const me = person("Me", { isMe: true });
    const ann = person("Ann", { rel: ["direct_report"] });
    const links = deriveLinks([me, ann], [edge("me", "ann", "manager_of", { endedAt: "2026-01-01" })], []);
    expect(links.filter((l) => l.kind === "reporting" && !l.ended)).toHaveLength(1);
    expect(buildOrgChart([me, ann], links).roots[0].children.map((c) => c.person.name)).toEqual(["Ann"]);
  });

  it("derives nothing from chips when no one is me", () => {
    expect(deriveLinks([person("Ann", { rel: ["direct_report"] })], [], [])).toEqual([]);
  });

  it("adds co-attendance as weighted meeting links and filters by kind", () => {
    const links = deriveLinks([person("A"), person("B")], [edge("a", "b")], [{ a: "a", b: "b", meetings: 4 }]);
    expect(links.find((l) => l.kind === "meeting")).toMatchObject({ weight: 4, directed: false });
    const only = filterLinks(links, new Set<LinkKind>(["meeting"]));
    expect(only.map((l) => l.kind)).toEqual(["meeting"]);
  });

  it("keeps ended edges, marked", () => {
    const links = deriveLinks([person("A"), person("B")], [edge("a", "b", "manager_of", { endedAt: "2026-01-01" })], []);
    expect(links[0].ended).toBe(true);
  });

  it("picks the oldest me", () => {
    const a = person("A", { isMe: true });
    const b = person("B", { isMe: true });
    expect(findMe([b, a])?.id).toBe("a");
  });
});

describe("buildOrgChart", () => {
  const chart = (people: PersonSummary[], edges: PersonEdge[]) => buildOrgChart(people, deriveLinks(people, edges, []));

  it("builds a tree with siblings sorted by name, and lists people outside any reporting line", () => {
    const people = ["Ceo", "Zed", "Amy", "Solo"].map((x) => person(x));
    const org = chart(people, [edge("ceo", "zed"), edge("ceo", "amy")]);
    expect(names(org.roots)).toEqual(["Ceo"]);
    expect(names(org.roots[0].children)).toEqual(["Amy", "Zed"]);
    expect(org.unplaced.map((p) => p.name)).toEqual(["Solo"]);
  });

  it("handles several roots, biggest tree first", () => {
    const people = ["A", "A1", "B", "B1", "B2"].map((x) => person(x));
    const org = chart(people, [edge("a", "a1"), edge("b", "b1"), edge("b", "b2")]);
    expect(names(org.roots)).toEqual(["B", "A"]);
  });

  it("anchors on me: me leads the roots, and derived chips place reports and manager", () => {
    const me = person("Me", { isMe: true });
    const r = person("Report", { rel: ["direct_report"] });
    const org = chart([me, r, person("Other")], []);
    expect(names(org.roots)).toEqual(["Me"]);
    expect(names(org.roots[0].children)).toEqual(["Report"]);
    expect(org.unplaced.map((p) => p.name)).toEqual(["Other"]);
    const withBoss = chart([me, person("Boss", { rel: ["manager"] })], []);
    expect(names(withBoss.roots)).toEqual(["Boss"]);
    expect(pathTo(withBoss.roots, "me")).toEqual(["boss", "me"]);
  });

  it("shows me alone when nothing links to them", () => {
    const org = chart([person("Me", { isMe: true })], []);
    expect(names(org.roots)).toEqual(["Me"]);
  });

  it("ignores ended manager edges", () => {
    const people = [person("A"), person("B")];
    const org = chart(people, [edge("a", "b", "manager_of", { endedAt: "2026-01-01" })]);
    expect(org.roots).toEqual([]);
    expect(org.unplaced).toHaveLength(2);
  });

  it("keeps the earliest manager and notes the others", () => {
    const people = ["A", "B", "C"].map((x) => person(x));
    const org = chart(people, [edge("a", "c"), edge("b", "c")]);
    const c = org.roots.flatMap((r) => r.children).find((x) => x.person.id === "c")!;
    expect(c.alsoReportsTo).toEqual(["b"]);
    expect(names(org.roots)).toEqual(["A", "B"]);
  });

  it("cuts a cycle at its first member by name and keeps everyone in the chart", () => {
    const people = ["Bo", "Al", "Cy"].map((x) => person(x));
    const org = chart(people, [edge("bo", "al"), edge("al", "cy"), edge("cy", "bo")]);
    expect(org.cyclesBroken).toBe(1);
    expect(names(org.roots)).toEqual(["Al"]);
    expect(org.roots[0].cycleBroken).toBe(true);
    const all: string[] = [];
    const walk = (x: OrgNode) => { all.push(x.person.id); x.children.forEach(walk); };
    org.roots.forEach(walk);
    expect(all.sort()).toEqual(["al", "bo", "cy"]);
  });

  it("a self-contained cycle beside a healthy tree doesn't affect the tree", () => {
    const people = ["Ceo", "Rep", "X", "Y"].map((x) => person(x));
    const org = chart(people, [edge("ceo", "rep"), edge("x", "y"), edge("y", "x")]);
    expect(org.cyclesBroken).toBe(1);
    expect(org.roots).toHaveLength(2);
  });
});

describe("layoutNetwork", () => {
  const ids = Array.from({ length: 60 }, (_, i) => `p${i}`);
  const links = ids.slice(1).map((id, i) => ({
    id: `l${i}`, kind: "reporting" as const, source: ids[Math.floor(i / 3)], target: id,
    directed: true, ended: false, derived: false, weight: 1,
  }));

  it("places everyone inside the box, deterministically", () => {
    const a = layoutNetwork(ids, links, 800, 600);
    const b = layoutNetwork(ids, links, 800, 600);
    expect(a.size).toBe(60);
    for (const [id, p] of a) {
      expect(p.x).toBeGreaterThanOrEqual(36); expect(p.x).toBeLessThanOrEqual(764);
      expect(p.y).toBeGreaterThanOrEqual(36); expect(p.y).toBeLessThanOrEqual(564);
      expect(b.get(id)).toEqual(p);
    }
  });

  it("handles none, one and a tiny box", () => {
    expect(layoutNetwork([], [], 100, 100).size).toBe(0);
    expect(layoutNetwork(["a"], [], 100, 100).get("a")).toEqual({ x: 50, y: 50 });
    expect(layoutNetwork(["a", "b"], [], 0, 0).size).toBe(2);
  });

  it("copes with several hundred people quickly", () => {
    const many = Array.from({ length: 400 }, (_, i) => `q${i}`);
    const t = performance.now();
    layoutNetwork(many, [], 1200, 800);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("layoutOrg", () => {
  it("lays out a forest without overlapping cards on a row", () => {
    const people = ["A", "A1", "A2", "B", "B1"].map((x) => person(x));
    const org = buildOrgChart(people, deriveLinks(people, [edge("a", "a1"), edge("a", "a2"), edge("b", "b1")], []));
    const lay = layoutOrg(org.roots);
    expect(lay.nodes).toHaveLength(5);
    expect(lay.links).toHaveLength(3);
    const rows = new Map<number, number[]>();
    for (const x of lay.nodes) rows.set(x.depth, [...(rows.get(x.depth) ?? []), x.x]);
    for (const xs of rows.values()) {
      xs.sort((p, q) => p - q);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(ORG_CARD_W);
    }
    for (const x of lay.nodes) expect(x.x + ORG_CARD_W).toBeLessThanOrEqual(lay.width);
  });

  it("is empty-safe", () => {
    expect(layoutOrg([]).nodes).toEqual([]);
  });
});
