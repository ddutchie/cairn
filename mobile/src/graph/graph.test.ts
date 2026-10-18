import { describe, it, expect } from "vitest";
import { buildHierarchy } from "@cairn/shared/ui/graph";
import type { GraphNode, GraphEdge, GraphNodeType } from "@/db/types";
import { filterGraph, ALL_NODE_TYPES } from "./filter";
import { createForceLayout, snapshotPositions, VISUALLY_SETTLED_ALPHA } from "./layout";
import { boundsOf, fitCamera, hitNode, screenToWorld, worldToScreen, zoomAt, MIN_ZOOM, MAX_ZOOM, centeredCamera } from "./camera";
import { hullPaths } from "./hulls";
import {
  buildRadialTree,
  restingGeom,
  targetArcs,
  computeArcs,
  hitRadial,
  arcPath,
  interpolateArcs,
  hasChildren,
} from "./radial";

const n = (id: string, type: GraphNodeType, title = id, projectId?: string): GraphNode => ({ id, type, title, projectId });
const e = (source: string, target: string, type: GraphEdge["type"] = "project-member"): GraphEdge => ({ source, target, type });

const graph = {
  nodes: [
    n("p1", "project", "Alpha"),
    n("p2", "project", "Beta"),
    n("a1", "note", "Apple pie", "p1"),
    n("a2", "note", "Apricot", "p1"),
    n("a3", "card", "Do thing", "p1"),
    n("b1", "note", "Banana", "p2"),
    n("b2", "note", "Berry", "p2"),
    n("t1", "tag", "fruit"),
  ],
  edges: [
    e("p1", "a1"), e("p1", "a2"), e("p1", "a3"), e("p2", "b1"), e("p2", "b2"),
    e("a1", "t1", "tag-member"), e("b1", "t1", "tag-member"),
  ],
};
const all = new Set(ALL_NODE_TYPES);

describe("filterGraph", () => {
  it("keeps everything with all types and no search", () => {
    const f = filterGraph(graph, all, "");
    expect(f.nodes).toHaveLength(8);
    expect(f.edges).toHaveLength(7);
  });
  it("drops edges whose endpoint type is filtered out", () => {
    const f = filterGraph(graph, new Set<GraphNodeType>(["project", "note"]), "");
    expect(f.nodes.some((x) => x.type === "tag" || x.type === "card")).toBe(false);
    expect(f.edges.every((x) => x.type !== "tag-member")).toBe(true);
  });
  it("search matches titles and keeps the parent project", () => {
    const f = filterGraph(graph, all, "banana");
    expect(f.nodes.map((x) => x.id).sort()).toEqual(["b1", "p2"]);
    expect(f.edges).toEqual([e("p2", "b1")]);
  });
  it("tag-name search works with the tag chip off", () => {
    const f = filterGraph(graph, new Set<GraphNodeType>(["project", "note", "card"]), "fruit");
    const ids = f.nodes.map((x) => x.id);
    expect(ids).toContain("a1");
    expect(ids).toContain("b1");
    expect(ids).not.toContain("t1");
  });
  it("search matches by tag name", () => {
    const f = filterGraph(graph, all, "FRUIT");
    const ids = f.nodes.map((x) => x.id);
    expect(ids).toContain("a1");
    expect(ids).toContain("b1");
    expect(ids).toContain("t1");
    expect(ids).not.toContain("a2");
  });
});

describe("createForceLayout", () => {
  it("settles and clusters members near their project", () => {
    const l = createForceLayout(graph);
    l.tick(300);
    expect(l.alpha()).toBeLessThan(VISUALLY_SETTLED_ALPHA);
    const byId = new Map(l.nodes.map((x) => [x.id, x]));
    const d = (a: string, b: string) => Math.hypot(byId.get(a)!.x - byId.get(b)!.x, byId.get(a)!.y - byId.get(b)!.y);
    expect(d("a1", "p1")).toBeLessThan(d("a1", "p2"));
    expect(d("b1", "p2")).toBeLessThan(d("b1", "p1"));
    for (const x of l.nodes) expect(Number.isFinite(x.x) && Number.isFinite(x.y)).toBe(true);
  });
  it("is deterministic", () => {
    const a = createForceLayout(graph);
    const b = createForceLayout(graph);
    a.tick(50);
    b.tick(50);
    expect(a.nodes.map((x) => [x.x, x.y])).toEqual(b.nodes.map((x) => [x.x, x.y]));
  });
  it("pins a node under the finger until released", () => {
    const l = createForceLayout(graph);
    l.tick(100);
    l.pin("a1", 500, -300);
    l.tick(30);
    const a1 = l.nodes.find((x) => x.id === "a1")!;
    expect(a1.x).toBe(500);
    expect(a1.y).toBe(-300);
    l.release("a1");
    l.tick(100);
    expect(Math.hypot(a1.x - 500, a1.y + 300)).toBeGreaterThan(10);
  });
  it("seeds from previous positions so adding a node does not re-scatter", () => {
    const first = createForceLayout(graph);
    first.tick(300);
    const snap = snapshotPositions(first.nodes);
    const grown = { nodes: [...graph.nodes, n("a4", "note", "New", "p1")], edges: [...graph.edges, e("p1", "a4")] };
    const second = createForceLayout(grown, snap);
    second.tick(1);
    for (const x of first.nodes) {
      const y = second.nodes.find((q) => q.id === x.id)!;
      expect(Math.hypot(x.x - y.x, x.y - y.y)).toBeLessThan(40);
    }
  });
  it("ignores edges to unknown nodes and supports swapping edges", () => {
    const l = createForceLayout({ nodes: graph.nodes, edges: [...graph.edges, e("p1", "ghost")] });
    expect(l.links).toHaveLength(7);
    l.setEdges([...graph.edges, e("a1", "b1", "semantic")]);
    expect(l.links).toHaveLength(8);
    expect(() => l.tick(5)).not.toThrow();
  });
});

describe("camera", () => {
  it("round-trips screen and world coordinates", () => {
    const c = { k: 2, tx: 30, ty: -10 };
    const w = screenToWorld(c, 100, 50);
    const s = worldToScreen(c, w.x, w.y);
    expect(s.x).toBeCloseTo(100);
    expect(s.y).toBeCloseTo(50);
  });
  it("zoomAt keeps the focal point fixed and clamps", () => {
    const c = centeredCamera(400, 800);
    const before = screenToWorld(c, 120, 300);
    const z = zoomAt(c, 3, 120, 300);
    const after = screenToWorld(z, 120, 300);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomAt(c, 100, 0, 0).k).toBe(MAX_ZOOM);
    expect(zoomAt(c, 0.0001, 0, 0).k).toBe(MIN_ZOOM);
  });
  it("fitCamera frames the bounds inside the viewport", () => {
    const b = boundsOf([{ x: -100, y: -50, r: 6 }, { x: 300, y: 150, r: 6 }])!;
    const cam = fitCamera(b, 400, 800);
    const tl = worldToScreen(cam, b.minX, b.minY);
    const br = worldToScreen(cam, b.maxX, b.maxY);
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(400);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.y).toBeLessThanOrEqual(800);
    expect((tl.x + br.x) / 2).toBeCloseTo(200);
  });
  it("fitCamera and centeredCamera keep content below floating controls", () => {
    const b = boundsOf([{ x: -100, y: -50, r: 6 }, { x: 300, y: 150, r: 6 }])!;
    const top = 120;
    const cam = fitCamera(b, 400, 800, 40, top);
    const tl = worldToScreen(cam, b.minX, b.minY);
    const br = worldToScreen(cam, b.maxX, b.maxY);
    expect(tl.y).toBeGreaterThanOrEqual(top);
    expect(br.y).toBeLessThanOrEqual(800);
    // centred in the visible area, not the whole canvas
    expect((tl.y + br.y) / 2).toBeCloseTo(top + (800 - top) / 2);
    expect(centeredCamera(400, 800, 1, top).ty).toBeCloseTo(top + (800 - top) / 2);
    expect(centeredCamera(400, 800).ty).toBe(400);
  });
  it("boundsOf ignores non-finite nodes and returns null when empty", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([{ x: NaN, y: 0, r: 5 }])).toBeNull();
  });
  it("hitNode enforces a minimum touch radius and picks the nearest", () => {
    const nodes = [{ x: 0, y: 0, r: 4 }, { x: 30, y: 0, r: 4 }];
    // 15pt away at k=1 is inside the 22pt touch radius
    expect(hitNode(nodes, 15, 0, 1)).not.toBeNull();
    expect(hitNode(nodes, 12, 0, 1)).toBe(nodes[0]);
    expect(hitNode(nodes, 18, 0, 1)).toBe(nodes[1]);
    expect(hitNode(nodes, 200, 200, 1)).toBeNull();
    // zoomed out the world radius grows so the on-screen target stays 22pt
    expect(hitNode(nodes, 40, 0, 0.5)).toBe(nodes[1]);
  });
});

describe("hullPaths", () => {
  it("builds a smoothed path for clusters of 3+ and skips smaller ones", () => {
    const m = new Map([
      ["big", [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 25, y: 40 }, { x: 25, y: 15 }]],
      ["small", [{ x: 0, y: 0 }, { x: 5, y: 5 }]],
    ]);
    const paths = hullPaths(m);
    expect(paths).toHaveLength(1);
    expect(paths[0].startsWith("M")).toBe(true);
  });
  it("skips collinear points that have no hull", () => {
    expect(hullPaths(new Map([["line", [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]]]))).toHaveLength(0);
  });
});

describe("radial", () => {
  const root = buildRadialTree(buildHierarchy({ nodes: graph.nodes }));
  const maxR = 200;

  it("lays out wedges that tile the circle at the root", () => {
    const arcs = computeArcs(root, targetArcs(root, root), root, restingGeom(root, root, maxR), maxR);
    const projects = arcs.filter((a) => a.node.depth === 1);
    expect(projects.length).toBeGreaterThanOrEqual(3); // Alpha, Beta, Tags
    const sum = projects.reduce((s, a) => s + (a.x1 - a.x0), 0);
    expect(sum).toBeCloseTo(Math.PI * 2, 5);
    for (const a of arcs) expect(a.r1).toBeGreaterThan(a.r0);
  });
  it("hit-tests the hub, wedges and empty space", () => {
    const geom = restingGeom(root, root, maxR);
    const arcs = computeArcs(root, targetArcs(root, root), root, geom, maxR);
    expect(hitRadial(arcs, geom.innerR - 3, 1, 1)).toEqual({ kind: "hub" });
    const w = arcs.find((a) => a.node.depth === 1)!;
    const mid = (w.x0 + w.x1) / 2;
    const r = (w.r0 + w.r1) / 2;
    const hit = hitRadial(arcs, geom.innerR - 3, r * Math.sin(mid), -r * Math.cos(mid));
    expect(hit?.kind).toBe("arc");
    expect(hitRadial(arcs, geom.innerR - 3, maxR * 2, 0)).toBeNull();
  });
  it("drilling into a project makes its children fill the circle", () => {
    const alpha = root.children!.find((c) => c.data.id === "p1")!;
    expect(hasChildren(alpha)).toBe(true);
    const arcs = computeArcs(root, targetArcs(root, alpha), alpha, restingGeom(root, alpha, maxR), maxR);
    const kids = arcs.filter((a) => a.node.parent === alpha);
    expect(kids).toHaveLength(3);
    expect(kids.reduce((s, a) => s + (a.x1 - a.x0), 0)).toBeCloseTo(Math.PI * 2, 5);
  });
  it("interpolation hits both endpoints", () => {
    const alpha = root.children!.find((c) => c.data.id === "p1")!;
    const from = targetArcs(root, root);
    const to = targetArcs(root, alpha);
    const g0 = restingGeom(root, root, maxR);
    const g1 = restingGeom(root, alpha, maxR);
    expect(interpolateArcs(from, to, g0, g1, 0).geom).toEqual(g0);
    expect(interpolateArcs(from, to, g0, g1, 1).geom.innerR).toBeCloseTo(g1.innerR);
    expect(interpolateArcs(from, to, g0, g1, 1).arcs.get(alpha)).toEqual(to.get(alpha));
  });
  it("arcPath closes, and splits a full ring", () => {
    expect(arcPath(0, 1, 10, 20)).toMatch(/^M .* Z$/);
    expect(arcPath(0, Math.PI * 2, 10, 20).match(/M /g)).toHaveLength(2);
    expect(arcPath(0, 1, 0, 20)).toContain("L 0 0");
  });
});
