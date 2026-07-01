"use client";

import React, { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import * as d3 from "d3";
import type { GraphNode, KnowledgeGraph } from "@/types";
import { resolveCssVar, withAlpha } from "./analyticsUtils";
import { useFontScale, useThemeRepaint } from "./analyticsHooks";
import { Tooltip } from "@/components/ui/tooltip";

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

function hexForType(type: GraphNode["type"]): string {
  const map: Record<string, string> = {
    project: resolveCssVar("--accent"),
    note:    resolveCssVar("--info"),
    card:    resolveCssVar("--success"),
    tag:     resolveCssVar("--warning"),
  };
  return map[type] ?? "#888";
}

function edgeColor(edgeType: string): { color: string; opacity: number; dash: boolean } {
  switch (edgeType) {
    case "note-note":      return { color: resolveCssVar("--info"),    opacity: 0.6, dash: false };
    case "note-card":      return { color: resolveCssVar("--success"), opacity: 0.6, dash: false };
    case "tag-member":     return { color: resolveCssVar("--warning"), opacity: 0.5, dash: false };
    case "project-member": return { color: resolveCssVar("--accent"),  opacity: 0.35, dash: false };
    case "flow-edge":      return { color: resolveCssVar("--accent"),  opacity: 0.8, dash: false };
    case "flow-ref":       return { color: resolveCssVar("--accent"),  opacity: 0.5, dash: true  };
    case "co-mention":     return { color: resolveCssVar("--border"),  opacity: 0.5, dash: true  };
    case "keyword":        return { color: resolveCssVar("--border"),  opacity: 0.4, dash: true  };
    case "assignee":       return { color: resolveCssVar("--border"),  opacity: 0.4, dash: true  };
    case "wikilink":       return { color: resolveCssVar("--accent"),  opacity: 0.75, dash: false };
    case "semantic":       return { color: resolveCssVar("--accent"),  opacity: 0.5, dash: true  };
    default:               return { color: resolveCssVar("--border"),  opacity: 0.4, dash: false };
  }
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

const radiusOf = (n: SimNode) => (n.nodeType === "project" ? 9 : n.nodeType === "tag" ? 4.5 : 6);

const ZOOM_BTN_CLASS =
  "w-7 h-7 flex items-center justify-center rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors shadow-sm";export function ForceGraphCanvas({
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

  const [dims, setDims] = useState({ width: 800, height: 600 });
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
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);

  // ── fit-to-view (stable; reads live state from refs) ──
  const zoomFit = useCallback((animate = true) => {
    const canvas = canvasRef.current, zoom = zoomRef.current;
    if (!canvas || !zoom) return;
    const nodes = nodesRef.current.filter((n) => n.x != null && n.y != null);
    if (!nodes.length) return;
    const { width, height } = dimsRef.current;
    const xs = nodes.map((n) => n.x!), ys = nodes.map((n) => n.y!);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
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
  const nodeFingerprint = graph.nodes
    .map((n) => `${n.id}:${n.type}:${n.projectId ?? ""}:${n.title}`)
    .join(",");
  const edgeFingerprint = visibleEdges
    .map((e) => `${e.source}-${e.target}:${e.type}:${e.weight ?? 1}`)
    .join(",");

  // ── resize observer ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) setDims({ width: e.contentRect.width, height: e.contentRect.height });
    });
    ro.observe(el);
    setDims({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

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
      const R = 230 * propsRef.current.spacing;
      return { x: Math.cos(ang) * R, y: Math.sin(ang) * R };
    };

    const chargeFor = (n: SimNode) => {
      const deg = degree.get(n.id) ?? 0;
      if (deg === 0) return -20;
      return (n.nodeType === "project" ? -260 : -130) * propsRef.current.spacing;
    };
    const linkDist = (l: SimLink) => {
      let b = 42;
      if (l.edgeType === "project-member") b = 64;
      if (l.edgeType === "tag-member") b = 54;
      return b * propsRef.current.spacing;
    };
    const anchorStrength = (n: SimNode) =>
      n.nodeType === "project" ? 0.25 : n.projectId ? 0.14 : 0.03;

    const sim = d3.forceSimulation<SimNode>(nodes)
      .force("charge", d3.forceManyBody<SimNode>().strength(chargeFor))
      .force("link", d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(linkDist).strength(0.35))
      .force("collide", d3.forceCollide<SimNode>().radius((n) => (radiusOf(n) + 12) * propsRef.current.spacing).iterations(2))
      .force("x", d3.forceX<SimNode>((n) => clusterAnchor(n)?.x ?? 0).strength(anchorStrength))
      .force("y", d3.forceY<SimNode>((n) => clusterAnchor(n)?.y ?? 0).strength(anchorStrength))
      .alphaDecay(0.025)
      .velocityDecay(0.4)
      .on("tick", () => {
        // Until the user takes control (or the first animated fit completes),
        // keep the whole graph framed instantly each tick so it never sits
        // stranded in a corner while positions are still settling.
        if (!userInteractedRef.current && !didInitialFitRef.current) {
          zoomFit(false);
        }
        drawRef.current();
      });

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
    (sim.force("collide") as d3.ForceCollide<SimNode>)?.radius((n) => (radiusOf(n) + 12) * spacing);
    (sim.force("x") as d3.ForceX<SimNode>)?.x((n) => c.clusterAnchor(n)?.x ?? 0);
    (sim.force("y") as d3.ForceY<SimNode>)?.y((n) => c.clusterAnchor(n)?.y ?? 0);
    sim.alpha(0.5).restart();
  }, [spacing]);

  // ── the draw routine ──
  const draw = useCallback(() => {
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

    // Fully reset the transform and clear the ENTIRE backing store (in device
    // pixels) before painting. Clearing in CSS-pixel space after applying the
    // DPR transform can leave a strip unpainted, causing the smear/half-render.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const bg = resolveCssVar("--background");
    const accent = resolveCssVar("--accent");

    // ── cluster hulls ──
    if (hulls) {
      const projects = nodes.filter((n) => n.nodeType === "project");
      for (const p of projects) {
        const members = nodes.filter((n) => n.projectId === p.id && n.x != null && n.y != null);
        const pts: [number, number][] = members.map((m) => [m.x!, m.y!]);
        if (p.x != null && p.y != null) pts.push([p.x, p.y]);
        if (pts.length < 3) continue;
        const hull = d3.polygonHull(pts);
        if (!hull) continue;
        const cx = d3.mean(hull, (d) => d[0]) ?? 0;
        const cy = d3.mean(hull, (d) => d[1]) ?? 0;
        const pad = 22;
        const expanded = hull.map(([x, y]) => {
          const dx = x - cx, dy = y - cy, m = Math.hypot(dx, dy) || 1;
          return [x + (dx / m) * pad, y + (dy / m) * pad] as [number, number];
        });
        ctx.beginPath();
        const curve = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.6)).context(ctx);
        curve(expanded);
        ctx.fillStyle = withAlpha(accent, 0.05);
        ctx.strokeStyle = withAlpha(accent, 0.18);
        ctx.lineWidth = 1.2 / t.k;
        ctx.fill();
        ctx.stroke();
      }
    }

    // ── edges ──
    for (const l of links) {
      const s = l.source as SimNode, tg = l.target as SimNode;
      if (s.x == null || s.y == null || tg.x == null || tg.y == null) continue;
      const st = edgeColor(l.edgeType);
      let op = st.opacity;
      let w = l.edgeType === "wikilink" ? 1.6 : 1;
      if (l.edgeType === "semantic" && l.weight < 1) w = 0.5 + l.weight;
      if (sel) {
        const on = connected && connected.has(s.id) && connected.has(tg.id);
        op = on ? Math.max(op, 0.9) : op * 0.1;
        if (on) w *= 1.4;
      }
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(tg.x, tg.y);
      ctx.strokeStyle = withAlpha(st.color, op);
      ctx.lineWidth = w / t.k;
      ctx.setLineDash(st.dash ? [3 / t.k, 3 / t.k] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // ── nodes ──
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const r = radiusOf(n);
      const col = hexForType(n.nodeType);
      const isSel = n.id === sel;
      const isHov = n.id === hovered;
      const dim = !!sel && connected != null && !connected.has(n.id);

      if (isSel || isHov) {
        const g = ctx.createRadialGradient(n.x, n.y, r, n.x, n.y, r + 14);
        g.addColorStop(0, withAlpha(col, 0.35));
        g.addColorStop(1, withAlpha(col, 0));
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 14, 0, 2 * Math.PI);
        ctx.fillStyle = g;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = isSel ? col : withAlpha(col, dim ? 0.22 : 0.92);
      ctx.fill();
      if (isSel || isHov) {
        ctx.lineWidth = 1.6 / t.k;
        ctx.strokeStyle = col;
        ctx.stroke();
      }

      // labels
      const isProject = n.nodeType === "project";
      let showLabel = false;
      if (isProject || isSel || isHov) showLabel = true;
      else if (lm === "all") showLabel = t.k >= 0.7;
      else if (lm === "smart") showLabel = t.k >= 1.5;

      if (showLabel) {
        const isHighlight = isSel || isHov;
        const screenPx = (isProject ? 12 : 10) * fs;
        const fontSize = screenPx / t.k;
        const maxLen = isHighlight ? 60 : isProject ? 26 : 18;
        const text = n.title.length > maxLen ? n.title.slice(0, maxLen - 1) + "…" : n.title;
        ctx.font = `${(isProject || isHighlight) ? "600 " : ""}${fontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.lineJoin = "round";
        ctx.lineWidth = 4 / t.k;
        ctx.strokeStyle = bg;
        ctx.strokeText(text, n.x, n.y + r + 4 / t.k);
        ctx.fillStyle = isHighlight && !isProject
          ? accent
          : dim
            ? withAlpha(resolveCssVar("--text-tertiary"), 0.5)
            : resolveCssVar(isProject ? "--text-primary" : "--text-secondary");
        ctx.fillText(text, n.x, n.y + r + 4 / t.k);
      }
    }

    ctx.restore();
  }, [fs]);
  useEffect(() => { drawRef.current = draw; }, [draw]);

  // ── canvas sizing (DPR-aware) + initial centering ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = dims.width * dpr;
    canvas.height = dims.height * dpr;
    canvas.style.width = dims.width + "px";
    canvas.style.height = dims.height + "px";
    draw();
  }, [dims, draw]);

  // redraw whenever selection / threshold / hull-toggle / label-mode changes
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
      .on("zoom", (ev) => { transformRef.current = ev.transform; draw(); })
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
  const pick = useCallback((mx: number, my: number): SimNode | null => {
    const t = transformRef.current;
    const x = (mx - t.x) / t.k;
    const y = (my - t.y) / t.k;
    let best: SimNode | null = null;
    let bd = Infinity;
    for (const n of nodesRef.current) {
      if (n.x == null || n.y == null) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      const r = radiusOf(n) + 6;
      if (d < r && d < bd) { bd = d; best = n; }
    }
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

    if (prevHover !== hoveredNodeRef.current) draw();
  }, [pick, pickEdge, graph.edges, hoveredEdgeText, draw]);

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
      onMouseLeave={() => { hoveredNodeRef.current = null; setHoveredEdgeText(null); draw(); }}
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
