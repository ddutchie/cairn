import { describe, it, expect } from "vitest";
import type { GraphEdge, GraphNode, KnowledgeGraph } from "@/types";
import { neighbourhoodGraph } from "./neighbourhood";

const node = (id: string, type: GraphNode["type"], projectId?: string): GraphNode =>
  ({ id, type, title: id, projectId, workspaceId: "ws" });
const edge = (source: string, target: string, type: string, weight?: number): GraphEdge =>
  ({ id: `${source}-${target}`, source, target, type, weight } as GraphEdge);

// a - b - c - d chain inside project P, plus tag T on a and x, and x in project Q.
const graph: KnowledgeGraph = {
  nodes: [
    node("P", "project"), node("Q", "project"), node("T", "tag"),
    node("a", "note", "P"), node("b", "note", "P"), node("c", "note", "P"), node("d", "note", "P"),
    node("x", "note", "Q"), node("s", "note", "Q"),
  ],
  edges: [
    edge("a", "P", "project-member"), edge("b", "P", "project-member"), edge("c", "P", "project-member"),
    edge("d", "P", "project-member"), edge("x", "Q", "project-member"), edge("s", "Q", "project-member"),
    edge("a", "b", "wikilink"), edge("b", "c", "co-mention"), edge("c", "d", "keyword"),
    edge("a", "T", "tag-member"), edge("x", "T", "tag-member"),
    edge("a", "s", "semantic", 0.6),
  ],
};
const ids = (g: KnowledgeGraph | null) => g!.nodes.map((n) => n.id).sort();

describe("neighbourhoodGraph", () => {
  it("walks the given number of hops without expanding through projects or tags", () => {
    expect(ids(neighbourhoodGraph(graph, "a", 1))).toEqual(["P", "T", "a", "b"]);
    expect(ids(neighbourhoodGraph(graph, "a", 2))).toEqual(["P", "T", "a", "b", "c"]);
    expect(ids(neighbourhoodGraph(graph, "a", 3))).toEqual(["P", "T", "a", "b", "c", "d"]);
  });

  it("expands a project or tag when it is the focus, keeping members' projects", () => {
    expect(ids(neighbourhoodGraph(graph, "T", 1))).toEqual(["P", "Q", "T", "a", "x"]);
  });

  it("follows semantic edges only at or above the threshold", () => {
    expect(ids(neighbourhoodGraph(graph, "a", 1, 0.5))).toContain("s");
    expect(ids(neighbourhoodGraph(graph, "a", 1, 0.7))).not.toContain("s");
  });

  it("keeps only edges between included nodes, and null for a missing focus", () => {
    const g = neighbourhoodGraph(graph, "d", 1)!;
    expect(g.edges.every((e) => ["P", "c", "d"].includes(e.source) && ["P", "c", "d"].includes(e.target))).toBe(true);
    expect(neighbourhoodGraph(graph, "nope", 2)).toBeNull();
  });
});
