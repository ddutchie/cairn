/**
 * Pure layout for the Insights people canvases (W7): a settled force layout
 * for the relationship canvas and a tidy tree for the org chart. Both are
 * deterministic (d3-force seeds its initial positions from the node index),
 * so the picture doesn't reshuffle on every render.
 */

import * as d3 from "d3";
import type { NetworkLink, OrgNode } from "./network";

export interface Point { x: number; y: number }

/**
 * Settle a force layout and return one point per id, inside `width` × `height`
 * minus `pad`. Runs synchronously: ticks scale down with node count so a few
 * hundred people stay well under a frame budget.
 */
export function layoutNetwork(
  ids: readonly string[],
  links: readonly NetworkLink[],
  width: number,
  height: number,
  pad = 36,
): Map<string, Point> {
  const out = new Map<string, Point>();
  if (ids.length === 0) return out;
  const w = Math.max(width, 2 * pad + 1);
  const h = Math.max(height, 2 * pad + 1);
  if (ids.length === 1) { out.set(ids[0], { x: w / 2, y: h / 2 }); return out; }

  type SimNode = d3.SimulationNodeDatum & { id: string };
  const nodes: SimNode[] = ids.map((id) => ({ id }));
  const index = new Set(ids);
  const simLinks = links
    .filter((l) => index.has(l.source) && index.has(l.target))
    .map((l) => ({ source: l.source, target: l.target, weight: l.weight, kind: l.kind }));

  const spacing = Math.max(28, Math.min(80, Math.sqrt((w * h) / ids.length) * 0.8));
  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink<SimNode, typeof simLinks[number]>(simLinks).id((d) => d.id)
      .distance((l) => (l.kind === "meeting" ? spacing * 1.4 : spacing))
      .strength((l) => (l.kind === "meeting" ? Math.min(0.5, 0.1 + l.weight * 0.05) : 0.7)))
    .force("charge", d3.forceManyBody().strength(-spacing * 2.2).distanceMax(spacing * 8))
    .force("collide", d3.forceCollide(14))
    .force("x", d3.forceX(w / 2).strength(0.06))
    .force("y", d3.forceY(h / 2).strength(0.06))
    .stop();

  const ticks = ids.length > 300 ? 120 : ids.length > 100 ? 200 : 300;
  for (let i = 0; i < ticks; i++) sim.tick();

  for (const n of nodes) {
    out.set(n.id, {
      x: Math.min(w - pad, Math.max(pad, n.x ?? w / 2)),
      y: Math.min(h - pad, Math.max(pad, n.y ?? h / 2)),
    });
  }
  return out;
}

export const ORG_CARD_W = 148;
export const ORG_CARD_H = 44;
const ORG_GAP_X = 20;
const ORG_GAP_Y = 36;

export interface OrgLayout {
  nodes: { id: string; node: OrgNode; x: number; y: number; depth: number }[];
  links: { id: string; from: string; to: string }[];
  width: number;
  height: number;
}

/**
 * Top-down tidy tree for a forest. Positions are card top-left corners.
 * Several roots sit side by side under an invisible parent.
 */
export function layoutOrg(roots: readonly OrgNode[], pad = 24): OrgLayout {
  if (roots.length === 0) return { nodes: [], links: [], width: 2 * pad, height: 2 * pad };
  const virtual: OrgNode = { person: null as never, children: [...roots], alsoReportsTo: [], cycleBroken: false };
  const h = d3.hierarchy(virtual, (n) => n.children);
  d3.tree<OrgNode>().nodeSize([ORG_CARD_W + ORG_GAP_X, ORG_CARD_H + ORG_GAP_Y]).separation(() => 1)(h);

  const real = h.descendants().filter((d) => d.depth > 0);
  const minX = Math.min(...real.map((d) => d.x!));
  const maxX = Math.max(...real.map((d) => d.x!));
  const maxDepth = Math.max(...real.map((d) => d.depth));
  const nodes = real.map((d) => ({
    id: d.data.person.id,
    node: d.data,
    x: d.x! - minX + pad,
    y: (d.depth - 1) * (ORG_CARD_H + ORG_GAP_Y) + pad,
    depth: d.depth - 1,
  }));
  const links = real
    .filter((d) => d.parent && d.parent.depth > 0)
    .map((d) => ({ id: `${d.parent!.data.person.id}>${d.data.person.id}`, from: d.parent!.data.person.id, to: d.data.person.id }));
  return {
    nodes,
    links,
    width: maxX - minX + ORG_CARD_W + 2 * pad,
    height: maxDepth * (ORG_CARD_H + ORG_GAP_Y) + ORG_CARD_H + 2 * pad,
  };
}
