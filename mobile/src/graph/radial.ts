import { hierarchy, partition, type HierarchyRectangularNode } from "d3-hierarchy";
import type { HierarchyNode } from "@cairn/shared/ui/graph";
import { easeCubicInOut } from "./camera";

export type RNode = HierarchyRectangularNode<HierarchyNode>;

export const INNER_R = 38;
export const INNER_R_FOCUSED = 120;
const TWO_PI = Math.PI * 2;

/** Partition the shared hierarchy into angular wedges (x: angle, y: depth). */
export function buildRadialTree(h: HierarchyNode): RNode {
  const root = hierarchy(h)
    .sum((d) => (d.children && d.children.length ? 0 : 1))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return partition<HierarchyNode>().size([TWO_PI, root.height + 1])(root);
}

export interface ArcState {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Ring geometry that animates alongside the wedges. */
export interface RingGeom {
  innerR: number;
  levels: number;
}

export const visibleLevels = (root: RNode, focus: RNode) => Math.max(1, root.height - focus.depth);

export const innerRadiusFor = (root: RNode, focus: RNode, maxR: number) =>
  focus === root ? INNER_R : Math.min(INNER_R_FOCUSED, maxR * 0.45);

export const restingGeom = (root: RNode, focus: RNode, maxR: number): RingGeom => ({
  innerR: innerRadiusFor(root, focus, maxR),
  levels: visibleLevels(root, focus),
});

/** Where `d` sits (in partition space) when `focus` fills the circle. */
export function targetArc(focus: RNode, d: RNode): ArcState {
  const span = (focus.x1 - focus.x0) || 1;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return {
    x0: clamp01((d.x0 - focus.x0) / span) * TWO_PI,
    x1: clamp01((d.x1 - focus.x0) / span) * TWO_PI,
    y0: Math.max(0, d.y0 - focus.depth - 1),
    y1: Math.max(0, d.y1 - focus.depth - 1),
  };
}

export function ringR(y: number, innerR: number, levels: number, maxR: number): number {
  const band = (maxR - innerR) / levels;
  return innerR + Math.min(y, levels) * band;
}

export interface DrawArc {
  node: RNode;
  x0: number;
  x1: number;
  r0: number;
  r1: number;
}

/** Wedges worth drawing for the current (possibly mid-animation) state. */
export function computeArcs(
  root: RNode,
  current: ReadonlyMap<RNode, ArcState>,
  focus: RNode,
  geom: RingGeom,
  maxR: number,
): DrawArc[] {
  const out: DrawArc[] = [];
  root.each((d) => {
    if (d === root) return;
    const a = current.get(d) ?? targetArc(focus, d);
    if (a.x1 - a.x0 < 0.002 || a.y1 <= 0) return;
    const r0 = ringR(a.y0, geom.innerR, geom.levels, maxR);
    const r1 = ringR(a.y1, geom.innerR, geom.levels, maxR) - 1.5;
    if (r1 <= r0) return;
    out.push({ node: d, x0: a.x0, x1: a.x1, r0, r1 });
  });
  return out;
}

/** Interpolate every wedge + ring geometry between two focus states. */
export function interpolateArcs(
  from: ReadonlyMap<RNode, ArcState>,
  to: ReadonlyMap<RNode, ArcState>,
  fromGeom: RingGeom,
  toGeom: RingGeom,
  t: number,
): { arcs: Map<RNode, ArcState>; geom: RingGeom } {
  const e = easeCubicInOut(t);
  const arcs = new Map<RNode, ArcState>();
  for (const [d, b] of to) {
    const a = from.get(d) ?? b;
    arcs.set(d, {
      x0: a.x0 + (b.x0 - a.x0) * e,
      x1: a.x1 + (b.x1 - a.x1) * e,
      y0: a.y0 + (b.y0 - a.y0) * e,
      y1: a.y1 + (b.y1 - a.y1) * e,
    });
  }
  return {
    arcs,
    geom: {
      innerR: fromGeom.innerR + (toGeom.innerR - fromGeom.innerR) * e,
      levels: fromGeom.levels + (toGeom.levels - fromGeom.levels) * e,
    },
  };
}

export function targetArcs(root: RNode, focus: RNode): Map<RNode, ArcState> {
  const m = new Map<RNode, ArcState>();
  root.each((d) => m.set(d, targetArc(focus, d)));
  return m;
}

/** Angles run clockwise from 12 o'clock (d3.arc convention). */
const point = (r: number, a: number) => `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;

/** SVG path of an annular sector centred on the origin. */
export function arcPath(x0: number, x1: number, r0: number, r1: number): string {
  if (x1 - x0 >= TWO_PI - 1e-4) {
    // A full ring can't be one arc segment; draw it as two halves.
    const mid = x0 + Math.PI;
    return `${arcPath(x0, mid, r0, r1)} ${arcPath(mid, x0 + TWO_PI, r0, r1)}`;
  }
  const large = x1 - x0 > Math.PI ? 1 : 0;
  const inner = r0 > 0.01
    ? `L ${point(r0, x1)} A ${r0} ${r0} 0 ${large} 0 ${point(r0, x0)}`
    : `L 0 0`;
  return `M ${point(r1, x0)} A ${r1} ${r1} 0 ${large} 1 ${point(r1, x1)} ${inner} Z`;
}

export type RadialHit =
  | { kind: "hub" }
  | { kind: "arc"; node: RNode };

/** Hit-test a point relative to the circle centre. */
export function hitRadial(arcs: readonly DrawArc[], hubR: number, x: number, y: number): RadialHit | null {
  const r = Math.hypot(x, y);
  if (r <= hubR) return { kind: "hub" };
  let a = Math.atan2(x, -y);
  if (a < 0) a += TWO_PI;
  for (let i = arcs.length - 1; i >= 0; i--) {
    const w = arcs[i];
    if (r >= w.r0 && r <= w.r1 && a >= w.x0 && a <= w.x1) return { kind: "arc", node: w.node };
  }
  return null;
}

export const hasChildren = (d: RNode) => !!(d.children && d.children.length);
