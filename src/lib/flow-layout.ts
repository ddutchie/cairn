/**
 * Two-phase dagre layout for Idea Flow.
 *
 * Phase 1: For each group, lay out its children using relative coordinates.
 *          Compute the bounding box of the laid-out children and resize the
 *          group to wrap them with padding.
 *
 * Phase 2: Lay out the groups + ungrouped nodes together as top-level items.
 *
 * React Flow stores relative coordinates for children (parentId set) and
 * absolute coordinates for root nodes. This function returns the same
 * convention — positions on returned nodes are ready to be passed straight
 * to React Flow and persisted to the DB.
 */
import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

export type LayoutDirection = "LR" | "TB";

const NODE_W = 220;
const NODE_H = 80;
const GROUP_PADDING = 48; // padding inside group (top accounts for label)
const GROUP_PADDING_TOP = 56;
const GROUP_GAP = 80;     // extra gap between groups in the outer pass

function makeGraph(direction: LayoutDirection) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 120, marginx: 40, marginy: 40 });
  return g;
}

export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction: LayoutDirection = "LR",
): Node[] {
  const groups    = nodes.filter((n) => n.type === "group");
  const ungrouped = nodes.filter((n) => n.type !== "group" && !n.parentId);
  const grouped   = nodes.filter((n) => n.type !== "group" && !!n.parentId);

  const updatedNodes = new Map<string, Node>();

  // ── Phase 1: layout children inside each group ──────────────────────────────
  const groupSizes = new Map<string, { width: number; height: number }>();

  for (const group of groups) {
    const children = grouped.filter((n) => n.parentId === group.id);
    if (children.length === 0) {
      // Empty group — keep its current size
      const w = (group.style?.width as number) ?? 320;
      const h = (group.style?.height as number) ?? 200;
      groupSizes.set(group.id, { width: w, height: h });
      updatedNodes.set(group.id, group);
      continue;
    }

    // Build a mini-graph for children only, using edges within this group
    const childIds = new Set(children.map((n) => n.id));
    const g = makeGraph(direction);
    for (const c of children) {
      g.setNode(c.id, { width: c.measured?.width ?? NODE_W, height: c.measured?.height ?? NODE_H });
    }
    for (const e of edges) {
      if (childIds.has(e.source) && childIds.has(e.target) && e.source !== e.target) {
        g.setEdge(e.source, e.target);
      }
    }
    dagre.layout(g);

    // Place children with offset for group padding
    let innerMaxX = 0, innerMaxY = 0;
    for (const c of children) {
      const pos = g.node(c.id);
      if (!pos) continue;
      const rx = pos.x - pos.width / 2 + GROUP_PADDING;
      const ry = pos.y - pos.height / 2 + GROUP_PADDING_TOP;
      innerMaxX = Math.max(innerMaxX, rx + pos.width);
      innerMaxY = Math.max(innerMaxY, ry + pos.height);
      updatedNodes.set(c.id, { ...c, position: { x: rx, y: ry } });
    }

    // Resize group to wrap children
    const gw = innerMaxX + GROUP_PADDING;
    const gh = innerMaxY + GROUP_PADDING;
    groupSizes.set(group.id, { width: gw, height: gh });
    updatedNodes.set(group.id, {
      ...group,
      style: { ...group.style, width: gw, height: gh },
    });
  }

  // ── Phase 2: layout groups + ungrouped nodes together ───────────────────────
  const topLevel = [...groups, ...ungrouped];
  if (topLevel.length > 0) {
    const g = makeGraph(direction);
    g.setGraph({ rankdir: direction, nodesep: GROUP_GAP, ranksep: GROUP_GAP + 40, marginx: 40, marginy: 40 });

    for (const n of topLevel) {
      const size = groupSizes.get(n.id);
      const w = size?.width ?? (n.measured?.width ?? NODE_W);
      const h = size?.height ?? (n.measured?.height ?? NODE_H);
      g.setNode(n.id, { width: w, height: h });
    }

    const topLevelIds = new Set(topLevel.map((n) => n.id));
    for (const e of edges) {
      if (topLevelIds.has(e.source) && topLevelIds.has(e.target) && e.source !== e.target) {
        g.setEdge(e.source, e.target);
      }
    }
    dagre.layout(g);

    for (const n of topLevel) {
      const pos = g.node(n.id);
      if (!pos) continue;
      const existing = updatedNodes.get(n.id) ?? n;
      updatedNodes.set(n.id, {
        ...existing,
        position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 },
      });
    }
  }

  // Return nodes in original order, merging updates
  return nodes.map((n) => updatedNodes.get(n.id) ?? n);
}
