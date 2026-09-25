"use client";

import React, { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import * as d3 from "d3";
import type { GraphNode, KnowledgeGraph } from "@/types";
import { createCssVarReader, createAlphaCache, tokenToCssVar } from "./analyticsUtils";
import { useFontScale, useThemeRepaint, useContainerDims } from "./analyticsHooks";
import { Tooltip } from "@/components/ui/tooltip";
import {
  nodeTypeToken,
  nodeRadius,
  edgeStyle as sharedEdgeStyle,
  chargeStrength,
  linkDistance,
  collideRadius,
  anchorStrength as sharedAnchorStrength,
  CLUSTER_RADIUS,
  LINK_STRENGTH,
  COLLIDE_ITERATIONS,
  ALPHA_DECAY,
  VELOCITY_DECAY,
  shouldShowLabel,
  labelScreenPx,
  labelMaxLen,
  type ThemeToken,
} from "../../../shared/ui/graph";

interface Props {
  graph: KnowledgeGraph;
  selectedNodeId: string | null;
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
  labelMode: "smart" | "all" | "minimal";
  spacing: number;
  semanticThreshold?: number;
  /** Draw convex-hull outlines around each project cluster. */
  showHulls?: boolean;
}

// ── colour helpers ──────────────────────────────────────────────────────────
// Colours are resolved through a per-frame `createCssVarReader()` — never a raw
// getComputedStyle per node/edge, which dominated frame time on large graphs.

type VarReader = (varName: string) => string;

/** Resolve a shared graph theme token to a concrete CSS-var colour. */
function tokenColor(read: VarReader, token: ThemeToken): string {
  return read(tokenToCssVar(token));
}

// ── simulation node/link shapes ──────────────────────────────────────────────

type SimNode = d3.SimulationNodeDatum & {
  id: string;
  title: string;
  nodeType: GraphNode["type"];
  projectId?: string;
};
type SimLink = d3.SimulationLinkDatum<SimNode> & {
  edgeType: string;
  weight: number;
};

/** Hull outline in world coords, cached until node positions next change. */
type HullCache = { version: number; nodes: SimNode[]; hulls: [number, number][][] };

/** Compute padded convex hulls for every project cluster in a single pass. */
function computeHulls(nodes: SimNode[]): [number, number][][] {
  const byProject = new Map<string, [number, number][]>();
  for (const n of nodes) {
    if (n.x == null || n.y == null) continue;
    const key = n.nodeType === "project" ? n.id : n.projectId;
    if (!key) continue;
    let pts = byProject.get(key);
    if (!pts) byProject.set(key, (pts = []));
    pts.push([n.x, n.y]);
  }
  const projectIds = new Set(nodes.filter((n) => n.nodeType === "project").map((n) => n.id));
  const out: [number, number][][] = [];
  for (const [pid, pts] of byProject) {
    if (!projectIds.has(pid) || pts.length < 3) continue;
    const hull = d3.polygonHull(pts);
    if (!hull) continue;
    let cx = 0, cy = 0;
    for (const [x, y] of hull) { cx += x; cy += y; }
    cx /= hull.length; cy /= hull.length;
    const pad = 22;
    out.push(hull.map(([x, y]) => {
      const dx = x - cx, dy = y - cy, m = Math.hypot(dx, dy) || 1;
      return [x + (dx / m) * pad, y + (dy / m) * pad] as [number, number];
    }));
  }
  return out;
}

const radiusOf = (n: SimNode) => nodeRadius(n.nodeType);
const NODE_TYPES = ["project", "note", "card", "tag"] as const;
/** Largest label font size (screen px, before font scale). */
const LABEL_MAX_SCREEN_PX = Math.max(...NODE_TYPES.map((t) => labelScreenPx(t)));
/** Conservative widest label (screen px, before font scale): longest allowed text × ~0.62em per char. */
const LABEL_MAX_SCREEN_W = Math.max(...NODE_TYPES.map((t) => labelMaxLen(t, true) * labelScreenPx(t) * 0.62));
/** Largest hit radius any node can have (biggest node radius + 6px slop). */
const PICK_REACH = Math.max(nodeRadius("project"), nodeRadius("note"), nodeRadius("card"), nodeRadius("tag")) + 6;

const ZOOM_BTN_CLASS =
  "w-7 h-7 flex items-center justify-center rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors shadow-sm";

function ForceGraphCanvasImpl({
  graph,
  selectedNodeId,
  onNodeClick,
  onBackgroundClick,
  labelMode,
  spacing,
  semanticThreshold = 1,
  showHulls = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fs = useFontScale();

  const dims = useContainerDims(containerRef);
  const dimsRef = useRef(dims);
  // eslint-disable-next-line react-hooks/refs -- keep latest value for ref-only consumers (render loop / fit)
  dimsRef.current = dims;
  const [hoveredEdgeText, setHoveredEdgeText] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  // True until the first real fit-to-view has run, so we don't show a stale
  // top-left framing while the simulation is still settling.
  const didInitialFitRef = useRef(false);
  // Set once the user pans/zooms, so auto-fit stops fighting their navigation.
  const userInteractedRef = useRef(false);

  // Mutable refs the render loop reads without re-instantiating the simulation
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
  const hoveredNodeRef = useRef<string | null>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const drawRef = useRef<() => void>(() => {});
  // rAF handle for the coalesced repaint (sim ticks, zoom events and hover all
  // request a frame; at most one paint happens per animation frame).
  const frameRef = useRef(0);
  // Bumped on every simulation tick; lets the hull cache skip recomputation
  // while the layout is at rest (pan/zoom/hover repaints).
  const posVersionRef = useRef(0);
  const hullCacheRef = useRef<HullCache | null>(null);

  // Coalesce repaint requests (sim ticks, zoom events, hover) into ≤1 paint per
  // animation frame — d3's zoom and timer can each fire several times a frame.
  const scheduleDraw = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      drawRef.current();
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);

  // ── fit-to-view (stable; reads live state from refs) ──
  const zoomFit = useCallback((animate = true) => {
    const canvas = canvasRef.current, zoom = zoomRef.current;
    if (!canvas || !zoom) return;
    const nodes = nodesRef.current.filter((n) => n.x != null && n.y != null);
    if (!nodes.length) return;
    const { width, height } = dimsRef.current;
    // Plain loop — spreading thousands of coords into Math.min/max is slow and
    // can overflow the call stack on very large graphs.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x! < minX) minX = n.x!;
      if (n.x! > maxX) maxX = n.x!;
      if (n.y! < minY) minY = n.y!;
      if (n.y! > maxY) maxY = n.y!;
    }
    const gw = maxX - minX || 1, gh = maxY - minY || 1;
    const pad = 60;
    const k = Math.max(0.2, Math.min(4, Math.min(
      (width - pad * 2) / gw,
      (height - pad * 2) / gh,
    )));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const tr = d3.zoomIdentity
      .translate(width / 2, height / 2)
      .scale(k)
      .translate(-cx, -cy);
    const sel = d3.select<HTMLCanvasElement, unknown>(canvas);
    if (animate) sel.transition().duration(400).call(zoom.transform, tr);
    else sel.call(zoom.transform, tr);
  }, []);

  // Keep latest prop values available to the render loop without re-creating it
  const propsRef = useRef({ selectedNodeId, labelMode, spacing, semanticThreshold, showHulls });
  // eslint-disable-next-line react-hooks/refs -- keep latest value for ref-only consumers (render loop / fit)
  propsRef.current = { selectedNodeId, labelMode, spacing, semanticThreshold, showHulls };

  // ── visible edges (semantic threshold) + degree map ──
  const visibleEdges = useMemo(
    () => graph.edges.filter((e) => e.type !== "semantic" || (e.weight ?? 1) >= semanticThreshold),
    [graph.edges, semanticThreshold],
  );

  const connectedNodeIds = useMemo(() => {
    if (!selectedNodeId) return null;
    const ids = new Set<string>([selectedNodeId]);
    for (const e of visibleEdges) {
      if (e.source === selectedNodeId) ids.add(e.target);
      if (e.target === selectedNodeId) ids.add(e.source);
    }
    return ids;
  }, [selectedNodeId, visibleEdges]);
  const connectedRef = useRef(connectedNodeIds);
  // eslint-disable-next-line react-hooks/refs -- keep latest value for ref-only consumers (render loop / fit)
  connectedRef.current = connectedNodeIds;

  // Stable fingerprints so the simulation only rebuilds when something it
  // copies into the sim nodes/links actually changes. Includes every field the
  // rebuild effect reads (node: id/type/projectId/title; link:
  // endpoints/type/weight) so renamed nodes, retyped/recoloured edges, etc.
  // refresh instead of showing stale data.
  // Memoised: these are O(nodes/edges) string builds and the component
  // re-renders on every edge-tooltip mouse move.
  const nodeFingerprint = useMemo(() => graph.nodes
    .map((n) => `${n.id}:${n.type}:${n.projectId ?? ""}:${n.title}`)
    .join(","), [graph.nodes]);
  const edgeFingerprint = useMemo(() => visibleEdges
    .map((e) => `${e.source}-${e.target}:${e.type}:${e.weight ?? 1}`)
    .join(","), [visibleEdges]);

  // ── build / rebuild simulation when topology changes ──
  useEffect(() => {
    // Preserve positions of nodes that still exist across rebuilds
    const prevPos = new Map(nodesRef.current.map((n) => [n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }]));

    const nodes: SimNode[] = graph.nodes.map((n) => {
      const p = prevPos.get(n.id);
      return {
        id: n.id,
        title: n.title ?? "",
        nodeType: n.type,
        projectId: n.projectId,
        x: p?.x, y: p?.y, vx: p?.vx, vy: p?.vy,
      };
    });
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = visibleEdges
      .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, edgeType: e.type, weight: e.weight ?? 1 }));

    nodesRef.current = nodes;
    linksRef.current = links;
    hullCacheRef.current = null;

    // degree map — must exist before sim construction (forces read it on first tick)
    const degree = new Map<string, number>();
    for (const l of links) {
      const s = typeof l.source === "object" ? (l.source as SimNode).id : (l.source as string);
      const t = typeof l.target === "object" ? (l.target as SimNode).id : (l.target as string);
      degree.set(s, (degree.get(s) ?? 0) + 1);
      degree.set(t, (degree.get(t) ?? 0) + 1);
    }

    // project cluster anchors (radial arrangement of project regions)
    const projects = nodes.filter((n) => n.nodeType === "project");
    const projIndex = new Map(projects.map((p, i) => [p.id, i]));
    const clusterAnchor = (n: SimNode): { x: number; y: number } | null => {
      const pid = n.projectId;
      if (!pid || !projIndex.has(pid)) return null;
      const i = projIndex.get(pid)!;
      const k = Math.max(1, projects.length);
      const ang = (i / k) * 2 * Math.PI;
      const R = CLUSTER_RADIUS * propsRef.current.spacing;
      return { x: Math.cos(ang) * R, y: Math.sin(ang) * R };
    };

    const chargeFor = (n: SimNode) =>
      chargeStrength(n.nodeType, degree.get(n.id) ?? 0, propsRef.current.spacing);
    const linkDist = (l: SimLink) => linkDistance(l.edgeType, propsRef.current.spacing);
    const anchorStrength = (n: SimNode) =>
      sharedAnchorStrength(n.nodeType, !!n.projectId);

    const sim = d3.forceSimulation<SimNode>(nodes)
      .force("charge", d3.forceManyBody<SimNode>().strength(chargeFor))
      .force("link", d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(linkDist).strength(LINK_STRENGTH))
      .force("collide", d3.forceCollide<SimNode>().radius((n) => collideRadius(n.nodeType, propsRef.current.spacing)).iterations(COLLIDE_ITERATIONS))
      .force("x", d3.forceX<SimNode>((n) => clusterAnchor(n)?.x ?? 0).strength(anchorStrength))
      .force("y", d3.forceY<SimNode>((n) => clusterAnchor(n)?.y ?? 0).strength(anchorStrength))
      .alphaDecay(ALPHA_DECAY)
      .velocityDecay(VELOCITY_DECAY)
      .on("tick", () => {
        // Until the user takes control (or the first animated fit completes),
        // keep the whole graph framed instantly each tick so it never sits
        // stranded in a corner while positions are still settling.
        if (!userInteractedRef.current && !didInitialFitRef.current) {
          zoomFit(false);
        }
        posVersionRef.current++;
        scheduleDraw();
      });

    // Incremental change (most nodes kept their positions, e.g. a note was added
    // or a link drawn): re-heat gently so the existing layout settles in place
    // instead of re-running the full ~270-tick explosion on every edit.
    let kept = 0;
    for (const n of nodes) if (n.x != null) kept++;
    if (nodes.length > 0 && kept / nodes.length >= 0.9) sim.alpha(0.3);

    simRef.current = sim;
    // expose anchor/cluster fns to the spacing-update effect via the sim object
    (sim as unknown as { _cairn: unknown })._cairn = { chargeFor, linkDist, clusterAnchor, anchorStrength, projects };

    // final animated fit once settled
    sim.on("end", () => {
      if (!userInteractedRef.current) zoomFit(true);
      didInitialFitRef.current = true;
    });

    return () => { sim.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeFingerprint, edgeFingerprint]);

  // ── react to spacing changes without rebuilding the sim ──
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const c = (sim as unknown as { _cairn?: {
      chargeFor: (n: SimNode) => number;
      linkDist: (l: SimLink) => number;
      anchorStrength: (n: SimNode) => number;
      clusterAnchor: (n: SimNode) => { x: number; y: number } | null;
    } })._cairn;
    if (!c) return;
    (sim.force("charge") as d3.ForceManyBody<SimNode>)?.strength(c.chargeFor);
    (sim.force("link") as d3.ForceLink<SimNode, SimLink>)?.distance(c.linkDist);
    (sim.force("collide") as d3.ForceCollide<SimNode>)?.radius((n) => collideRadius(n.nodeType, spacing));
    (sim.force("x") as d3.ForceX<SimNode>)?.x((n) => c.clusterAnchor(n)?.x ?? 0);
    (sim.force("y") as d3.ForceY<SimNode>)?.y((n) => c.clusterAnchor(n)?.y ?? 0);
    sim.alpha(0.5).restart();
  }, [spacing]);

  // ── the draw routine ──
  const draw = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const t = transformRef.current;
    const { selectedNodeId: sel, labelMode: lm, showHulls: hulls } = propsRef.current;
    const connected = connectedRef.current;
    const hovered = hoveredNodeRef.current;
    const nodes = nodesRef.current;
    const links = linksRef.current;
    const { width, height } = dimsRef.current;

    // One style read per frame (see createCssVarReader), memoised alpha strings.
    const read = createCssVarReader();
    const alpha = createAlphaCache();

    // Fully reset the transform and clear the ENTIRE backing store (in device
    // pixels) before painting. Clearing in CSS-pixel space after applying the
    // DPR transform can leave a strip unpainted, causing the smear/half-render.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const bg = read("--background");
    const accent = read("--accent");
    const typeColor = (type: GraphNode["type"]) => tokenColor(read, nodeTypeToken(type));

    // Visible world-space rect (+ margin for glows/labels) — everything outside
    // it is culled so zoomed-in frames only pay for what's on screen.
    const margin = 40 / t.k + 20;
    const vx0 = -t.x / t.k - margin, vx1 = (width - t.x) / t.k + margin;
    const vy0 = -t.y / t.k - margin, vy1 = (height - t.y) / t.k + margin;
    const inView = (x: number, y: number) => x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1;
    // Labels hang below their node and can be much wider than it, so a label
    // can still be on screen while its node centre is culled. Give labels their
    // own bounds: half the widest possible label sideways, and the label's
    // height above the top edge (a node just above the viewport shows its text).
    const labelHalfW = (LABEL_MAX_SCREEN_W * fs) / 2 / t.k;
    const labelH = (LABEL_MAX_SCREEN_PX * fs + 4) / t.k + 12;
    const inLabelView = (x: number, y: number) =>
      x >= vx0 - labelHalfW && x <= vx1 + labelHalfW && y >= vy0 - labelH && y <= vy1;

    // ── cluster hulls (recomputed only when positions changed) ──
    if (hulls) {
      let cache = hullCacheRef.current;
      if (!cache || cache.version !== posVersionRef.current || cache.nodes !== nodes) {
        cache = { version: posVersionRef.current, nodes, hulls: computeHulls(nodes) };
        hullCacheRef.current = cache;
      }
      const curve = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.6)).context(ctx);
      ctx.fillStyle = alpha(accent, 0.05);
      ctx.strokeStyle = alpha(accent, 0.18);
      ctx.lineWidth = 1.2 / t.k;
      for (const hull of cache.hulls) {
        ctx.beginPath();
        curve(hull);
        ctx.fill();
        ctx.stroke();
      }
    }

    // ── edges — batched into one path per distinct stroke style ──
    type EdgeBatch = { stroke: string; width: number; dash: boolean; coords: number[] };
    const batches = new Map<string, EdgeBatch>();
    for (const l of links) {
      const s = l.source as SimNode, tg = l.target as SimNode;
      if (s.x == null || s.y == null || tg.x == null || tg.y == null) continue;
      // Cull segments whose bounding box misses the viewport entirely.
      if ((s.x < vx0 && tg.x < vx0) || (s.x > vx1 && tg.x > vx1) ||
          (s.y < vy0 && tg.y < vy0) || (s.y > vy1 && tg.y > vy1)) continue;
      const st = sharedEdgeStyle(l.edgeType);
      let op = st.opacity;
      let w = l.edgeType === "wikilink" ? 1.6 : 1;
      if (l.edgeType === "semantic" && l.weight < 1) w = 0.5 + l.weight;
      if (sel) {
        const on = connected && connected.has(s.id) && connected.has(tg.id);
        op = on ? Math.max(op, 0.9) : op * 0.1;
        if (on) w *= 1.4;
      }
      const stroke = alpha(tokenColor(read, st.token), op);
      const key = `${stroke}|${w}|${st.dash ? 1 : 0}`;
      let b = batches.get(key);
      if (!b) batches.set(key, (b = { stroke, width: w, dash: st.dash, coords: [] }));
      b.coords.push(s.x, s.y, tg.x, tg.y);
    }
    const dashPattern = [3 / t.k, 3 / t.k];
    for (const b of batches.values()) {
      ctx.beginPath();
      const c = b.coords;
      for (let i = 0; i < c.length; i += 4) {
        ctx.moveTo(c[i], c[i + 1]);
        ctx.lineTo(c[i + 2], c[i + 3]);
      }
      ctx.strokeStyle = b.stroke;
      ctx.lineWidth = b.width / t.k;
      ctx.setLineDash(b.dash ? dashPattern : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // ── nodes — plain circles batched by fill; highlighted ones drawn after ──
    const fills = new Map<string, SimNode[]>();
    const highlighted: SimNode[] = [];
    const labelCandidates: SimNode[] = [];
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      if (inLabelView(n.x, n.y)) labelCandidates.push(n);
      if (!inView(n.x, n.y)) continue;
      if (n.id === sel || n.id === hovered) { highlighted.push(n); continue; }
      const dim = !!sel && connected != null && !connected.has(n.id);
      const fill = alpha(typeColor(n.nodeType), dim ? 0.22 : 0.92);
      let arr = fills.get(fill);
      if (!arr) fills.set(fill, (arr = []));
      arr.push(n);
    }
    for (const [fill, arr] of fills) {
      ctx.beginPath();
      for (const n of arr) {
        const r = radiusOf(n);
        ctx.moveTo(n.x! + r, n.y!);
        ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI);
      }
      ctx.fillStyle = fill;
      ctx.fill();
    }
    for (const n of highlighted) {
      const r = radiusOf(n);
      const col = typeColor(n.nodeType);
      const isSel = n.id === sel;
      const dim = !isSel && !!sel && connected != null && !connected.has(n.id);
      const g = ctx.createRadialGradient(n.x!, n.y!, r, n.x!, n.y!, r + 14);
      g.addColorStop(0, alpha(col, 0.35));
      g.addColorStop(1, alpha(col, 0));
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, r + 14, 0, 2 * Math.PI);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI);
      ctx.fillStyle = isSel ? col : alpha(col, dim ? 0.22 : 0.92);
      ctx.fill();
      ctx.lineWidth = 1.6 / t.k;
      ctx.strokeStyle = col;
      ctx.stroke();
    }

    // ── labels (on top of every node so they're never covered) ──
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = 4 / t.k;
    ctx.strokeStyle = bg;
    let lastFont = "";
    for (const n of labelCandidates) {
      const isSel = n.id === sel;
      const isHov = n.id === hovered;
      const showLabel = shouldShowLabel({
        type: n.nodeType,
        isSelected: isSel,
        isHovered: isHov,
        labelMode: lm,
        zoom: t.k,
      });
      if (!showLabel) continue;
      const isProject = n.nodeType === "project";
      const isHighlight = isSel || isHov;
      const dim = !!sel && connected != null && !connected.has(n.id);
      const r = radiusOf(n);
      const fontSize = (labelScreenPx(n.nodeType) * fs) / t.k;
      const maxLen = labelMaxLen(n.nodeType, isHighlight);
      const text = n.title.length > maxLen ? n.title.slice(0, maxLen - 1) + "…" : n.title;
      const font = `${(isProject || isHighlight) ? "600 " : ""}${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      if (font !== lastFont) { ctx.font = font; lastFont = font; }
      ctx.strokeText(text, n.x!, n.y! + r + 4 / t.k);
      ctx.fillStyle = isHighlight && !isProject
        ? accent
        : dim
          ? alpha(read("--text-tertiary"), 0.5)
          : read(isProject ? "--text-primary" : "--text-secondary");
      ctx.fillText(text, n.x!, n.y! + r + 4 / t.k);
    }

    ctx.restore();
  }, [fs]);
  useEffect(() => { drawRef.current = draw; }, [draw]);


  // ── canvas sizing (DPR-aware) ──
  // Only touches the backing store when the size actually changes: assigning
  // canvas.width/height clears and reallocates it, which reads as a flash.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(dims.width * dpr), h = Math.round(dims.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = dims.width + "px";
      canvas.style.height = dims.height + "px";
    }
    drawRef.current();
  }, [dims]);

  // redraw whenever selection / threshold / hull-toggle / label-mode / font scale changes
  useEffect(() => { draw(); }, [selectedNodeId, semanticThreshold, showHulls, labelMode, draw]);

  // Repaint after a theme change so the canvas picks up the new CSS-var colours.
  useThemeRepaint(drawRef);

  // ── zoom & pan ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const selection = d3.select<HTMLCanvasElement, unknown>(canvas);
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.2, 6])
      .on("zoom", (ev) => { transformRef.current = ev.transform; scheduleDraw(); })
      .on("start", (ev) => {
        // A pointer/wheel-driven zoom means the user has taken control; stop
        // auto-fitting on subsequent simulation ticks.
        if (ev.sourceEvent) userInteractedRef.current = true;
      });
    zoomRef.current = zoom;
    selection.call(zoom);
    // initial centering (instant) — fit happens once positions settle
    const init = d3.zoomIdentity.translate(dims.width / 2, dims.height / 2).scale(0.85);
    selection.call(zoom.transform, init);
    transformRef.current = init;
    return () => { selection.on(".zoom", null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── hit testing for hover + click ──
  // Spatial index for hit testing, rebuilt only when positions changed (at most
  // once per sim tick) instead of scanning every node on every mouse move.
  const pickIndexRef = useRef<{ version: number; nodes: SimNode[]; tree: d3.Quadtree<SimNode> } | null>(null);
  const pick = useCallback((mx: number, my: number): SimNode | null => {
    const t = transformRef.current;
    const x = (mx - t.x) / t.k;
    const y = (my - t.y) / t.k;
    const nodes = nodesRef.current;
    let index = pickIndexRef.current;
    if (!index || index.version !== posVersionRef.current || index.nodes !== nodes) {
      const tree = d3.quadtree<SimNode>()
        .x((n) => n.x!)
        .y((n) => n.y!)
        .addAll(nodes.filter((n) => n.x != null && n.y != null));
      index = { version: posVersionRef.current, nodes, tree };
      pickIndexRef.current = index;
    }
    // Same rule as before (nearest node whose centre is within its radius + 6),
    // but only nodes inside the largest possible hit radius are examined.
    const reach = PICK_REACH;
    let best: SimNode | null = null;
    let bd = Infinity;
    index.tree.visit((quad, x0, y0, x1, y1) => {
      if (!quad.length) {
        let leaf: d3.QuadtreeLeaf<SimNode> | undefined = quad as d3.QuadtreeLeaf<SimNode>;
        do {
          const n = leaf.data;
          const d = Math.hypot(n.x! - x, n.y! - y);
          if (d < radiusOf(n) + 6 && d < bd) { bd = d; best = n; }
          leaf = leaf.next;
        } while (leaf);
      }
      return x0 > x + reach || x1 < x - reach || y0 > y + reach || y1 < y - reach;
    });
    return best;
  }, []);

  // pick the nearest semantic edge for tooltip
  const pickEdge = useCallback((mx: number, my: number): SimLink | null => {
    const t = transformRef.current;
    const x = (mx - t.x) / t.k;
    const y = (my - t.y) / t.k;
    let best: SimLink | null = null;
    let bd = 6 / t.k;
    for (const l of linksRef.current) {
      if (l.edgeType !== "semantic") continue;
      const s = l.source as SimNode, e = l.target as SimNode;
      if (s.x == null || e.x == null) continue;
      // distance point→segment
      const dx = e.x! - s.x!, dy = e.y! - s.y!;
      const len2 = dx * dx + dy * dy || 1;
      let tt = ((x - s.x!) * dx + (y - s.y!) * dy) / len2;
      tt = Math.max(0, Math.min(1, tt));
      const px = s.x! + tt * dx, py = s.y! + tt * dy;
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }, []);

  const handleMouseMove = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const node = pick(mx, my);
    const prevHover = hoveredNodeRef.current;
    hoveredNodeRef.current = node ? node.id : null;
    canvas.style.cursor = node ? "pointer" : "grab";

    if (!node) {
      const edge = pickEdge(mx, my);
      if (edge) {
        const s = edge.source as SimNode, tg = edge.target as SimNode;
        const orig = graph.edges.find((e) =>
          (e.source === s.id && e.target === tg.id) || (e.source === tg.id && e.target === s.id),
        );
        const left = orig?.sourceSectionTitle ? `${s.title} › ${orig.sourceSectionTitle}` : s.title;
        const right = orig?.targetSectionTitle ? `${tg.title} › ${orig.targetSectionTitle}` : tg.title;
        setHoveredEdgeText(`${left} ↔ ${right} · ${((edge.weight ?? 1) * 100).toFixed(0)}%`);
        setTooltipPos({ x: mx + 12, y: my + 12 });
      } else if (hoveredEdgeText) {
        setHoveredEdgeText(null);
      }
    } else if (hoveredEdgeText) {
      setHoveredEdgeText(null);
    }

    if (prevHover !== hoveredNodeRef.current) scheduleDraw();
  }, [pick, pickEdge, graph.edges, hoveredEdgeText, scheduleDraw]);

  const handleClick = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const node = pick(ev.clientX - rect.left, ev.clientY - rect.top);
    if (node) {
      const found = graph.nodes.find((n) => n.id === node.id);
      if (found) onNodeClick(found);
    } else {
      onBackgroundClick();
      setHoveredEdgeText(null);
    }
  }, [pick, graph.nodes, onNodeClick, onBackgroundClick]);

  // ── zoom controls ──
  const zoomBy = useCallback((factor: number) => {
    const canvas = canvasRef.current, zoom = zoomRef.current;
    if (!canvas || !zoom) return;
    // A toolbar zoom is a deliberate user action — flag it so the settling
    // simulation's auto-fit doesn't override it (the D3 source-event handler
    // can't see programmatic transitions).
    userInteractedRef.current = true;
    d3.select<HTMLCanvasElement, unknown>(canvas).transition().duration(300).call(zoom.scaleBy, factor);
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-hidden relative"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => { hoveredNodeRef.current = null; setHoveredEdgeText(null); scheduleDraw(); }}
      onClick={handleClick}
    >
      <canvas ref={canvasRef} className="block" />

      {hoveredEdgeText && (
        <div
          className="pointer-events-none absolute z-20 px-3 py-1.5 rounded-md text-xs bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] shadow-lg max-w-[280px] break-words"
          style={{ left: tooltipPos.x, top: tooltipPos.y }}
        >
          {hoveredEdgeText}
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-1">
        <Tooltip content="Zoom in" side="left">
          <button
            onClick={(e) => { e.stopPropagation(); zoomBy(1.4); }}
            aria-label="Zoom in"
            className={ZOOM_BTN_CLASS}
          >
            <ZoomIn size={13} />
          </button>
        </Tooltip>
        <Tooltip content="Zoom out" side="left">
          <button
            onClick={(e) => { e.stopPropagation(); zoomBy(1 / 1.4); }}
            aria-label="Zoom out"
            className={ZOOM_BTN_CLASS}
          >
            <ZoomOut size={13} />
          </button>
        </Tooltip>
        <Tooltip content="Fit all" side="left">
          <button
            onClick={(e) => { e.stopPropagation(); zoomFit(true); }}
            aria-label="Fit all"
            className={ZOOM_BTN_CLASS}
          >
            <Maximize2 size={13} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

// Memoised: KnowledgeGraphView re-renders on unrelated toolbar/store state;
// all props are memoised upstream, so this skips those renders entirely.
export const ForceGraphCanvas = React.memo(ForceGraphCanvasImpl);
