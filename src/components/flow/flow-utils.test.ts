/**
 * Unit tests for computeGroupAssignments — the Idea Flow geometric containment
 * logic that decides which group (if any) a node belongs to after a drag.
 *
 * This is the trickiest pure logic in the flow feature: absolute-position
 * accumulation through parent chains, smallest-enclosing-group selection by the
 * node's CENTER point, and coordinate conversion (parent-relative on entry,
 * absolute on exit). It only emits CHANGES, never no-op reassignments.
 */

import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { computeGroupAssignments } from "./flow-utils";

// ── Fixtures ────────────────────────────────────────────────────────────────
function node(
  id: string,
  x: number,
  y: number,
  opts: Partial<{ type: string; parentId: string; w: number; h: number; gw: number; gh: number }> = {},
): Node {
  const n: Node = {
    id,
    position: { x, y },
    data: {},
    type: opts.type,
    parentId: opts.parentId,
  } as Node;
  if (opts.w != null || opts.h != null) {
    n.measured = { width: opts.w ?? 220, height: opts.h ?? 80 };
  }
  if (opts.gw != null || opts.gh != null) {
    n.style = { width: opts.gw ?? 320, height: opts.gh ?? 200 };
  }
  return n;
}

const group = (id: string, x: number, y: number, gw: number, gh: number, parentId?: string): Node =>
  node(id, x, y, { type: "group", gw, gh, parentId });

describe("computeGroupAssignments", () => {
  it("returns no changes when there are no groups", () => {
    const nodes = [node("a", 10, 10, { w: 100, h: 100 })];
    expect(computeGroupAssignments(nodes)).toEqual([]);
  });

  it("assigns an unparented node whose center falls inside a group (relative coords)", () => {
    // Group at (0,0) 320x200. Node at (100,50), 100x100 → center (150,100) inside.
    const nodes = [group("g1", 0, 0, 320, 200), node("a", 100, 50, { w: 100, h: 100 })];
    const changes = computeGroupAssignments(nodes);
    expect(changes).toEqual([
      // entry coords are parent-relative: abs(100,50) - groupAbs(0,0)
      { nodeId: "a", parentId: "g1", x: 100, y: 50 },
    ]);
  });

  it("does not reassign a node already correctly parented (no-op suppressed)", () => {
    // Node already a child of g1 and still inside it → no change emitted.
    const nodes = [
      group("g1", 0, 0, 320, 200),
      node("a", 100, 50, { w: 100, h: 100, parentId: "g1" }),
    ];
    expect(computeGroupAssignments(nodes)).toEqual([]);
  });

  it("removes a node from its group when its center leaves (absolute coords)", () => {
    // Child positioned (relative) far outside the 320x200 group → exits to root.
    const nodes = [
      group("g1", 0, 0, 320, 200),
      node("a", 500, 500, { w: 100, h: 100, parentId: "g1" }),
    ];
    const changes = computeGroupAssignments(nodes);
    // Exit coords are absolute: groupAbs(0,0) + rel(500,500) = (500,500).
    expect(changes).toEqual([{ nodeId: "a", parentId: null, x: 500, y: 500 }]);
  });

  it("picks the SMALLEST-area group when nested groups both contain the center", () => {
    // Big group 400x400 at (0,0); small group 100x100 at (50,50). Node center
    // (100,100) is inside both → smaller wins.
    const nodes = [
      group("big", 0, 0, 400, 400),
      group("small", 50, 50, 100, 100),
      node("a", 80, 80, { w: 40, h: 40 }), // center (100,100)
    ];
    const changes = computeGroupAssignments(nodes);
    const a = changes.find((c) => c.nodeId === "a");
    expect(a?.parentId).toBe("small");
  });

  it("uses default node dimensions (220x80) when measured is absent", () => {
    // Group 320x200 at (0,0). Node at (0,0) with default 220x80 → center (110,40) inside.
    const nodes = [group("g1", 0, 0, 320, 200), node("a", 0, 0)];
    const changes = computeGroupAssignments(nodes);
    expect(changes).toEqual([{ nodeId: "a", parentId: "g1", x: 0, y: 0 }]);
  });

  it("ignores group nodes themselves as assignment candidates", () => {
    const nodes = [group("g1", 0, 0, 320, 200), group("g2", 10, 10, 50, 50)];
    // No non-group nodes → nothing to assign.
    expect(computeGroupAssignments(nodes)).toEqual([]);
  });

  it("accumulates absolute position through a parent chain", () => {
    // g1 at (100,100); child node parented to g1 at relative (10,10) → abs (110,110),
    // center with default 220x80 = (220,150). g1 is 320x200 → inside, already parented.
    const nodes = [
      group("g1", 100, 100, 320, 200),
      node("a", 10, 10, { parentId: "g1" }),
    ];
    expect(computeGroupAssignments(nodes)).toEqual([]);
  });
});
