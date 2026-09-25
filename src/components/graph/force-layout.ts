/**
 * Force layout engine for the Knowledge Graph.
 *
 * Runs the d3-force simulation away from the canvas: normally inside
 * `force-layout.worker.ts`, or on the main thread when a Worker can't be
 * created (tests, a blocked worker URL). Either way the canvas only receives
 * positions and draws, so a large graph settling no longer competes with
 * typing, scrolling and panel updates.
 *
 * Positions go out as a flat Float32Array (x0, y0, x1, y1, …) in the order of
 * `LayoutInit.nodes`, transferred rather than copied when posted from the
 * worker.
 */

import * as d3 from "d3";
import {
  chargeStrength,
  linkDistance,
  collideRadius,
  anchorStrength,
  CLUSTER_RADIUS,
  LINK_STRENGTH,
  COLLIDE_ITERATIONS,
  ALPHA_DECAY,
  VELOCITY_DECAY,
  type GraphNodeType,
} from "../../../shared/ui/graph";

export interface LayoutNode {
  id: string;
  nodeType: GraphNodeType;
  projectId?: string;
  /** Seed position (kept from the previous layout); omitted for new nodes. */
  x?: number;
  y?: number;
}

export interface LayoutLink {
  /** Index into `LayoutInit.nodes`. */
  source: number;
  target: number;
  edgeType: string;
}

export interface LayoutInit {
  /** Increments per rebuild so late messages from an older layout are dropped. */
  gen: number;
  nodes: LayoutNode[];
  links: LayoutLink[];
  spacing: number;
}

export type LayoutRequest =
  | { type: "init"; init: LayoutInit }
  | { type: "spacing"; spacing: number }
  | { type: "stop" };

export type LayoutResponse =
  | { type: "tick"; gen: number; positions: Float32Array }
  | { type: "end"; gen: number };

type SimNode = d3.SimulationNodeDatum & LayoutNode;
type SimLink = d3.SimulationLinkDatum<SimNode> & { edgeType: string };

/** Share of nodes that must keep a seeded position for a gentle re-heat. */
const KEEP_RATIO = 0.9;
/** Frame budget (ms) for ticks between two position posts. */
const FRAME_MS = 16;
const TICK_BUDGET_MS = 8;
/** Upper bound on ticks per post, so small graphs still visibly settle. */
const MAX_TICKS_PER_FRAME = 3;

export interface ForceLayout {
  setSpacing(spacing: number): void;
  stop(): void;
}

/**
 * Build and run a simulation. `onTick` gets a fresh positions array per frame
 * (the caller may transfer it); `onEnd` fires once the layout has settled.
 */
export function runForceLayout(
  init: LayoutInit,
  onTick: (positions: Float32Array) => void,
  onEnd: () => void,
): ForceLayout {
  let spacing = init.spacing;
  const nodes: SimNode[] = init.nodes.map((n) => ({ ...n }));
  const links: SimLink[] = init.links.map((l) => ({ source: l.source, target: l.target, edgeType: l.edgeType }));

  const degree = new Uint32Array(nodes.length);
  for (const l of init.links) { degree[l.source]++; degree[l.target]++; }
  const indexOf = new Map(nodes.map((n, i) => [n, i]));

  // Radial arrangement of project regions.
  const projectIndex = new Map<string, number>();
  for (const n of nodes) if (n.nodeType === "project") projectIndex.set(n.id, projectIndex.size);
  const anchor = (n: SimNode, axis: "x" | "y"): number => {
    const i = n.projectId != null ? projectIndex.get(n.projectId) : undefined;
    if (i == null) return 0;
    const ang = (i / Math.max(1, projectIndex.size)) * 2 * Math.PI;
    const r = CLUSTER_RADIUS * spacing;
    return axis === "x" ? Math.cos(ang) * r : Math.sin(ang) * r;
  };
  const strength = (n: SimNode) => anchorStrength(n.nodeType, !!n.projectId);

  const sim = d3.forceSimulation<SimNode>(nodes)
    .force("charge", d3.forceManyBody<SimNode>())
    .force("link", d3.forceLink<SimNode, SimLink>(links).strength(LINK_STRENGTH))
    .force("collide", d3.forceCollide<SimNode>().iterations(COLLIDE_ITERATIONS))
    .force("x", d3.forceX<SimNode>().strength(strength))
    .force("y", d3.forceY<SimNode>().strength(strength))
    .alphaDecay(ALPHA_DECAY)
    .velocityDecay(VELOCITY_DECAY)
    .stop();

  const applySpacing = () => {
    (sim.force("charge") as d3.ForceManyBody<SimNode>)
      .strength((n) => chargeStrength(n.nodeType, degree[indexOf.get(n)!], spacing));
    (sim.force("link") as d3.ForceLink<SimNode, SimLink>)
      .distance((l) => linkDistance(l.edgeType, spacing));
    (sim.force("collide") as d3.ForceCollide<SimNode>)
      .radius((n) => collideRadius(n.nodeType, spacing));
    (sim.force("x") as d3.ForceX<SimNode>).x((n) => anchor(n, "x"));
    (sim.force("y") as d3.ForceY<SimNode>).y((n) => anchor(n, "y"));
  };
  applySpacing();

  // Incremental change (most nodes kept their positions, e.g. a note was added,
  // a link drawn, or the view reopened): re-heat gently so the existing layout
  // settles in place instead of re-running the full ~270-tick explosion.
  let kept = 0;
  for (const n of init.nodes) if (n.x != null && n.y != null) kept++;
  if (nodes.length > 0 && kept / nodes.length >= KEEP_RATIO) sim.alpha(0.3);

  const emit = () => {
    const out = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      out[i * 2] = nodes[i].x!;
      out[i * 2 + 1] = nodes[i].y!;
    }
    onTick(out);
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const step = () => {
    timer = null;
    if (stopped) return;
    const start = Date.now();
    let ticks = 0;
    do {
      sim.tick();
      ticks++;
    } while (ticks < MAX_TICKS_PER_FRAME && sim.alpha() >= sim.alphaMin() && Date.now() - start < TICK_BUDGET_MS);
    emit();
    if (sim.alpha() < sim.alphaMin()) { onEnd(); return; }
    timer = setTimeout(step, Math.max(0, FRAME_MS - (Date.now() - start)));
  };
  // First frame goes out immediately so the canvas has positions to draw.
  step();

  return {
    setSpacing(next) {
      if (stopped) return;
      spacing = next;
      applySpacing();
      sim.alpha(0.5);
      if (timer == null) timer = setTimeout(step, 0);
    },
    stop() {
      stopped = true;
      if (timer != null) clearTimeout(timer);
      timer = null;
    },
  };
}
