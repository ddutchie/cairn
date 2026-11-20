/**
 * Pure layout for the people tree pictures: a tidy tree for the org chart
 * (people and teams) and the rounded elbows between cards. Deterministic, so
 * the picture doesn't reshuffle on every render. The network pictures use the
 * Knowledge Graph's force canvas instead.
 */

import * as d3 from "d3";
import type { OrgNode } from "./network";

export const ORG_CARD_W = 188;
export const ORG_CARD_H = 58;
const ORG_GAP_X = 18;
const ORG_GAP_Y = 44;

export interface TreeLayout<T> {
  nodes: { id: string; node: T; x: number; y: number; depth: number }[];
  links: { id: string; from: string; to: string }[];
  width: number;
  height: number;
}

/**
 * Top-down tidy tree for any forest. Positions are card top-left corners;
 * several roots sit side by side under an invisible parent.
 */
export function layoutTree<T>(
  roots: readonly T[],
  { id, children, cardW = ORG_CARD_W, cardH = ORG_CARD_H, pad = 24 }: {
    id: (n: T) => string; children: (n: T) => readonly T[]; cardW?: number; cardH?: number; pad?: number;
  },
): TreeLayout<T> {
  if (roots.length === 0) return { nodes: [], links: [], width: 2 * pad, height: 2 * pad };
  type Box = { item: T | null; kids: Box[] };
  const wrap = (n: T): Box => ({ item: n, kids: children(n).map(wrap) });
  const h = d3.hierarchy<Box>({ item: null, kids: roots.map(wrap) }, (b) => b.kids);
  // Siblings sit close; cousins get a little more room so subtrees read as groups.
  d3.tree<Box>().nodeSize([cardW + ORG_GAP_X, cardH + ORG_GAP_Y]).separation((a, b) => (a.parent === b.parent ? 1 : 1.15))(h);

  const real = h.descendants().filter((d) => d.depth > 0);
  const minX = Math.min(...real.map((d) => d.x!));
  const maxX = Math.max(...real.map((d) => d.x!));
  const maxDepth = Math.max(...real.map((d) => d.depth));
  const idOf = (d: d3.HierarchyNode<Box>) => id(d.data.item as T);
  return {
    nodes: real.map((d) => ({
      id: idOf(d), node: d.data.item as T,
      x: d.x! - minX + pad,
      y: (d.depth - 1) * (cardH + ORG_GAP_Y) + pad,
      depth: d.depth - 1,
    })),
    links: real
      .filter((d) => d.parent && d.parent.depth > 0)
      .map((d) => ({ id: `${idOf(d.parent!)}>${idOf(d)}`, from: idOf(d.parent!), to: idOf(d) })),
    width: maxX - minX + cardW + 2 * pad,
    height: maxDepth * (cardH + ORG_GAP_Y) + cardH + 2 * pad,
  };
}

export type OrgLayout = TreeLayout<OrgNode>;

/** The reporting forest as a tidy tree of person cards. */
export function layoutOrg(roots: readonly OrgNode[], pad = 24): OrgLayout {
  return layoutTree(roots, { id: (n) => n.person.id, children: (n) => n.children, pad });
}

/**
 * An elbow from the bottom of a parent card to the top of a child, with
 * rounded corners, so a tree reads as lines rather than a grid.
 */
export function elbowPath(x1: number, y1: number, x2: number, y2: number, r = 8): string {
  const midY = (y1 + y2) / 2;
  if (Math.abs(x2 - x1) < 1) return `M${x1},${y1} V${y2}`;
  const dir = x2 > x1 ? 1 : -1;
  const rr = Math.min(r, Math.abs(x2 - x1) / 2, (y2 - y1) / 2);
  return `M${x1},${y1} V${midY - rr} Q${x1},${midY} ${x1 + dir * rr},${midY} H${x2 - dir * rr} Q${x2},${midY} ${x2},${midY + rr} V${y2}`;
}
