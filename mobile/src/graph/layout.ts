import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceX,
  forceY,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import {
  nodeRadius,
  chargeStrength,
  linkDistance,
  collideRadius,
  anchorStrength,
  CLUSTER_RADIUS,
  LINK_STRENGTH,
  COLLIDE_ITERATIONS,
  ALPHA_DECAY,
  VELOCITY_DECAY,
} from "@cairn/shared/ui/graph";
import type { GraphData } from "./filter";
import type { GraphNode, GraphEdge } from "@/db/types";

export interface SimNode extends SimulationNodeDatum {
  id: string;
  node: GraphNode;
  r: number;
  x: number;
  y: number;
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
  edge: GraphEdge;
  source: SimNode;
  target: SimNode;
}

/** Alpha below which the layout looks settled (the slow tail is imperceptible). */
export const VISUALLY_SETTLED_ALPHA = 0.15;

/** Deterministic [-1, 1) jitter from a string, so new nodes don't stack. */
function hash01(s: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 20000) / 10000 - 1;
}

/** Cluster anchor for a node: its project's slot on the cluster ring. */
function anchorFor(projectIds: Map<string, number>, node: GraphNode): { x: number; y: number } {
  const pid = node.type === "project" ? node.id : node.projectId;
  if (!pid || !projectIds.has(pid)) return { x: 0, y: 0 };
  const i = projectIds.get(pid)!;
  const ang = (i / Math.max(1, projectIds.size)) * 2 * Math.PI;
  return { x: Math.cos(ang) * CLUSTER_RADIUS, y: Math.sin(ang) * CLUSTER_RADIUS };
}

export interface ForceLayout {
  nodes: SimNode[];
  links: SimLink[];
  alpha(): number;
  /** Advance the simulation; returns the alpha afterwards. */
  tick(n?: number): number;
  /** True once alpha has decayed to its resting minimum. */
  done(): boolean;
  /** Fix a node under the finger (world coords) and keep the sim warm. */
  pin(id: string, x: number, y: number): void;
  release(id: string): void;
  /** Point each sim node at its refreshed GraphNode (same ids), so renames and project moves show. */
  setNodeData(nodes: readonly GraphNode[]): void;
  /** Re-seed the link force (e.g. semantic edges toggled) and nudge the sim. */
  setEdges(edges: GraphEdge[]): void;
  stop(): void;
}

/**
 * Framework-free d3-force layout using the shared strengths so mobile settles
 * into the same shape as desktop. Positions are centred on the origin; the
 * camera decides where that lands on screen. `previous` carries positions from
 * an earlier layout so adding or removing a node doesn't re-scatter the graph.
 */
export function createForceLayout(
  graph: GraphData,
  previous?: ReadonlyMap<string, { x: number; y: number }>,
): ForceLayout {
  const projectIds = new Map<string, number>();
  for (const n of graph.nodes) if (n.type === "project") projectIds.set(n.id, projectIds.size);

  const byId = new Map<string, SimNode>();
  const nodes: SimNode[] = graph.nodes.map((node) => {
    const seed = previous?.get(node.id);
    const a = anchorFor(projectIds, node);
    const sn: SimNode = {
      id: node.id,
      node,
      r: nodeRadius(node.type),
      x: seed ? seed.x : a.x + hash01(node.id, 1) * 60,
      y: seed ? seed.y : a.y + hash01(node.id, 2) * 60,
    };
    byId.set(node.id, sn);
    return sn;
  });

  const toLinks = (edges: GraphEdge[]): SimLink[] => {
    const out: SimLink[] = [];
    for (const edge of edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (source && target) out.push({ edge, source, target });
    }
    return out;
  };
  let links = toLinks(graph.edges);

  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source.id, (degree.get(l.source.id) ?? 0) + 1);
    degree.set(l.target.id, (degree.get(l.target.id) ?? 0) + 1);
  }
  const hasProject = (n: SimNode) => n.node.type === "project" || !!n.node.projectId;

  const linkForce = forceLink<SimNode, SimLink>(links)
    .id((d) => d.id)
    .distance((l) => linkDistance(l.edge.type))
    .strength(LINK_STRENGTH);

  const sim: Simulation<SimNode, SimLink> = forceSimulation<SimNode>(nodes)
    .force("link", linkForce)
    .force("charge", forceManyBody<SimNode>().strength((d) => chargeStrength(d.node.type, degree.get(d.id) ?? 0)))
    .force("x", forceX<SimNode>((d) => anchorFor(projectIds, d.node).x).strength((d) => anchorStrength(d.node.type, hasProject(d))))
    .force("y", forceY<SimNode>((d) => anchorFor(projectIds, d.node).y).strength((d) => anchorStrength(d.node.type, hasProject(d))))
    .force("collide", forceCollide<SimNode>().radius((d) => collideRadius(d.node.type)).iterations(COLLIDE_ITERATIONS))
    .alphaDecay(ALPHA_DECAY)
    .velocityDecay(VELOCITY_DECAY)
    .stop(); // we drive ticks ourselves, one frame at a time

  const layout: ForceLayout = {
    nodes,
    get links() {
      return links;
    },
    alpha: () => sim.alpha(),
    tick(n = 1) {
      sim.tick(n);
      return sim.alpha();
    },
    done: () => sim.alpha() <= sim.alphaMin(),
    pin(id, x, y) {
      const n = byId.get(id);
      if (!n) return;
      n.fx = x;
      n.fy = y;
      if (sim.alpha() < 0.3) sim.alpha(0.3);
    },
    release(id) {
      const n = byId.get(id);
      if (!n) return;
      n.fx = null;
      n.fy = null;
    },
    setNodeData(next) {
      for (const g of next) {
        const sn = byId.get(g.id);
        if (sn) sn.node = g;
      }
    },
    setEdges(edges) {
      links = toLinks(edges);
      linkForce.links(links);
      sim.alpha(0.3);
    },
    stop() {
      sim.stop();
    },
  };
  return layout;
}

/** Positions to carry into the next layout. */
export function snapshotPositions(nodes: readonly SimNode[]): Map<string, { x: number; y: number }> {
  return new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
}
