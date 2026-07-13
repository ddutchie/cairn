"use client";

/**
 * ArchitectureGraphCanvas — a directed file-dependency graph for the codebase
 * index, rendered on a <canvas> via d3-force (the same proven pattern as the
 * Knowledge Graph's ForceGraphCanvas, but purpose-built for code: file nodes
 * sized by symbol count, directed call/reference edges drawn with arrowheads).
 *
 * Data comes from agent:codebaseGraph (file→file edges aggregated from the
 * symbol call graph). Clicking a node selects a file; the parent decides what
 * to do (show its symbols in the side panel). Self-contained: no store slice.
 */

import { useRef, useEffect, useCallback, useMemo, useState } from "react";
import * as d3 from "d3";
import { useContainerDims, useFontScale, useThemeRepaint } from "../graph/analyticsHooks";
import { resolveCssVar, withAlpha } from "../graph/analyticsUtils";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";

export interface ArchGraphNode {
  id: string;
  file_path: string;
  root_path: string;
  symbol_count: number;
}
export interface ArchGraphEdge {
  source: string;
  target: string;
  weight: number;
}

interface Props {
  nodes: ArchGraphNode[];
  edges: ArchGraphEdge[];
  root: string;
  selectedId: string | null;
  onSelect: (node: ArchGraphNode | null) => void;
  /** When set, render only this file + its direct neighbours (spotlight mode). */
  focusId?: string | null;
}

type SimNode = d3.SimulationNodeDatum & {
  id: string;
  label: string;
  symbolCount: number;
  degree: number;
};
type SimLink = d3.SimulationLinkDatum<SimNode> & { weight: number };

function relPath(filePath: string, root: string): string {
  if (root && filePath.startsWith(root)) {
    return filePath.slice(root.length).replace(/^[/\\]/, "") || filePath;
  }
  return filePath;
}
function baseName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}
/** Node radius grows (sub-linearly) with symbol count. */
function radiusFor(symbolCount: number): number {
  return 5 + Math.sqrt(symbolCount) * 2.2;
}

export function ArchitectureGraphCanvas({ nodes: allNodes, edges: allEdges, root, selectedId, onSelect, focusId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dims = useContainerDims(containerRef);
  const fs = useFontScale();

  // Spotlight mode: restrict to the focus node + its direct neighbours so the
  // graph is always legible ("what touches this file?") instead of a hairball.
  const { nodes, edges } = useMemo(() => {
    if (!focusId) return { nodes: allNodes, edges: allEdges };
    const keep = new Set<string>([focusId]);
    for (const e of allEdges) {
      if (e.source === focusId) keep.add(e.target);
      if (e.target === focusId) keep.add(e.source);
    }
    return {
      nodes: allNodes.filter((n) => keep.has(n.id)),
      edges: allEdges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
  }, [allNodes, allEdges, focusId]);

  const [hoverLabel, setHoverLabel] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
  const hoveredRef = useRef<string | null>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const drawRef = useRef<() => void>(() => {});
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const dimsRef = useRef(dims);
  // eslint-disable-next-line react-hooks/refs -- keep latest value for ref-only consumers (render loop / fit)
  dimsRef.current = dims;
  const userInteractedRef = useRef(false);
  const selectedRef = useRef(selectedId);
  // eslint-disable-next-line react-hooks/refs -- keep latest value for ref-only consumers (render loop)
  selectedRef.current = selectedId;

  // Highlight the selected node + its direct neighbours.
  const connectedIds = useMemo(() => {
    if (!selectedId) return null;
    const ids = new Set<string>([selectedId]);
    for (const e of edges) {
      if (e.source === selectedId) ids.add(e.target);
      if (e.target === selectedId) ids.add(e.source);
    }
    return ids;
  }, [selectedId, edges]);
  const connectedRef = useRef(connectedIds);
  // eslint-disable-next-line react-hooks/refs -- keep latest value for ref-only consumers (render loop)
  connectedRef.current = connectedIds;

  const nodeFingerprint = useMemo(() => nodes.map((n) => n.id).join("|"), [nodes]);
  const edgeFingerprint = useMemo(
    () => edges.map((e) => `${e.source}>${e.target}`).join("|"),
    [edges],
  );

  // ── fit-to-view ──
  const zoomFit = useCallback((animate = true) => {
    const canvas = canvasRef.current, zoom = zoomRef.current;
    if (!canvas || !zoom) return;
    const ns = nodesRef.current.filter((n) => n.x != null && n.y != null);
    if (!ns.length) return;
    const { width, height } = dimsRef.current;
    const xs = ns.map((n) => n.x!), ys = ns.map((n) => n.y!);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const gw = maxX - minX || 1, gh = maxY - minY || 1;
    const pad = 50;
    const k = Math.max(0.1, Math.min(3, Math.min((width - pad * 2) / gw, (height - pad * 2) / gh)));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const tr = d3.zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-cx, -cy);
    const sel = d3.select<HTMLCanvasElement, unknown>(canvas);
    if (animate) sel.transition().duration(400).call(zoom.transform, tr);
    else sel.call(zoom.transform, tr);
  }, []);

  // ── build simulation ──
  useEffect(() => {
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const simNodes: SimNode[] = nodes.map((n) => ({
      id: n.id,
      label: baseName(n.file_path),
      symbolCount: n.symbol_count,
      degree: degree.get(n.id) ?? 0,
    }));
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const simLinks: SimLink[] = edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, weight: e.weight }));

    nodesRef.current = simNodes;
    linksRef.current = simLinks;

    const sim = d3.forceSimulation<SimNode>(simNodes)
      .force("charge", d3.forceManyBody<SimNode>().strength((n) => -120 - n.degree * 20))
      .force("link", d3.forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance(90).strength(0.4))
      .force("collide", d3.forceCollide<SimNode>().radius((n) => radiusFor(n.symbolCount) + 6).iterations(2))
      .force("center", d3.forceCenter(0, 0))
      .force("x", d3.forceX(0).strength(0.04))
      .force("y", d3.forceY(0).strength(0.04))
      .alphaDecay(0.03)
      .on("tick", () => {
        if (!userInteractedRef.current) zoomFit(false);
        drawRef.current();
      });
    simRef.current = sim;
    sim.on("end", () => { if (!userInteractedRef.current) zoomFit(true); });
    return () => { sim.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeFingerprint, edgeFingerprint]);

  // ── draw ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const t = transformRef.current;
    const sel = selectedRef.current;
    const connected = connectedRef.current;
    const hovered = hoveredRef.current;
    const ns = nodesRef.current;
    const ls = linksRef.current;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const accent = resolveCssVar("--accent");
    const edgeCol = resolveCssVar("--text-tertiary");
    const textCol = resolveCssVar("--text-secondary");

    // ── directed edges (with arrowheads) ──
    for (const l of ls) {
      const s = l.source as SimNode, tg = l.target as SimNode;
      if (s.x == null || s.y == null || tg.x == null || tg.y == null) continue;
      const on = sel ? (connected?.has(s.id) && connected?.has(tg.id)) : false;
      const dim = sel && !on;
      const op = dim ? 0.06 : on ? 0.7 : 0.28;
      const rTarget = radiusFor(tg.symbolCount);
      // shorten the line so the arrow sits at the node edge
      const dx = tg.x - s.x, dy = tg.y - s.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist, uy = dy / dist;
      const ex = tg.x - ux * (rTarget + 2), ey = tg.y - uy * (rTarget + 2);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = withAlpha(on ? accent : edgeCol, op);
      ctx.lineWidth = (on ? 1.6 : 1) / t.k;
      ctx.stroke();
      // arrowhead
      const ah = 5 / t.k;
      const ang = Math.atan2(uy, ux);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - ah * Math.cos(ang - 0.4), ey - ah * Math.sin(ang - 0.4));
      ctx.lineTo(ex - ah * Math.cos(ang + 0.4), ey - ah * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fillStyle = withAlpha(on ? accent : edgeCol, op);
      ctx.fill();
    }

    // ── nodes ──
    for (const n of ns) {
      if (n.x == null || n.y == null) continue;
      const r = radiusFor(n.symbolCount);
      const isSel = n.id === sel;
      const isHov = n.id === hovered;
      const dim = !!sel && connected != null && !connected.has(n.id);

      if (isSel || isHov) {
        const g = ctx.createRadialGradient(n.x, n.y, r, n.x, n.y, r + 12);
        g.addColorStop(0, withAlpha(accent, 0.35));
        g.addColorStop(1, withAlpha(accent, 0));
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 12, 0, 2 * Math.PI);
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = isSel ? accent : withAlpha(accent, dim ? 0.2 : 0.78);
      ctx.fill();
      if (isSel || isHov) {
        ctx.lineWidth = 1.6 / t.k;
        ctx.strokeStyle = accent;
        ctx.stroke();
      }

      // label: only when zoomed in enough, hovered, or selected (avoid clutter)
      if (t.k > 1.1 || isSel || isHov) {
        ctx.font = `${11 * fs}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = withAlpha(textCol, dim ? 0.3 : 1);
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(n.label, n.x, n.y + r + 2);
      }
    }
    ctx.restore();
  }, [fs]);
  useEffect(() => { drawRef.current = draw; }, [draw]);

  // ── canvas sizing (DPR-aware) ──
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

  useEffect(() => { draw(); }, [selectedId, draw]);
  useThemeRepaint(drawRef);

  // ── zoom & pan ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const selection = d3.select<HTMLCanvasElement, unknown>(canvas);
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.1, 5])
      .on("zoom", (ev) => { transformRef.current = ev.transform; draw(); })
      .on("start", (ev) => { if (ev.sourceEvent) userInteractedRef.current = true; });
    zoomRef.current = zoom;
    selection.call(zoom);
    const init = d3.zoomIdentity.translate(dims.width / 2, dims.height / 2).scale(0.85);
    selection.call(zoom.transform, init);
    transformRef.current = init;
    return () => { selection.on(".zoom", null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── hit testing ──
  const pick = useCallback((mx: number, my: number): SimNode | null => {
    const t = transformRef.current;
    const x = (mx - t.x) / t.k, y = (my - t.y) / t.k;
    let best: SimNode | null = null;
    let bd = Infinity;
    for (const n of nodesRef.current) {
      if (n.x == null || n.y == null) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      const r = radiusFor(n.symbolCount) + 5;
      if (d < r && d < bd) { bd = d; best = n; }
    }
    return best;
  }, []);

  const handleMouseMove = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const node = pick(mx, my);
    const prev = hoveredRef.current;
    hoveredRef.current = node ? node.id : null;
    canvas.style.cursor = node ? "pointer" : "grab";
    if (node) {
      setHoverLabel(relPath(nodes.find((n) => n.id === node.id)?.file_path ?? node.label, root));
      setTooltipPos({ x: mx + 12, y: my + 12 });
    } else if (hoverLabel) {
      setHoverLabel(null);
    }
    if (prev !== hoveredRef.current) draw();
  }, [pick, nodes, root, hoverLabel, draw]);

  const handleClick = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const node = pick(ev.clientX - rect.left, ev.clientY - rect.top);
    if (node) {
      const found = nodes.find((n) => n.id === node.id);
      onSelect(found ?? null);
    } else {
      onSelect(null);
    }
  }, [pick, nodes, onSelect]);

  const zoomBy = useCallback((factor: number) => {
    const canvas = canvasRef.current, zoom = zoomRef.current;
    if (!canvas || !zoom) return;
    userInteractedRef.current = true;
    d3.select<HTMLCanvasElement, unknown>(canvas).transition().duration(200).call(zoom.scaleBy, factor);
  }, []);

  const ZOOM_BTN =
    "w-7 h-7 flex items-center justify-center rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors shadow-sm";

  return (
    <div ref={containerRef} className="relative flex-1 min-h-0 overflow-hidden">
      <div
        className="absolute inset-0"
        onMouseMove={handleMouseMove}
        onClick={handleClick}
        onMouseLeave={() => { hoveredRef.current = null; setHoverLabel(null); draw(); }}
      >
        <canvas ref={canvasRef} className="block" />
      </div>

      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--text-tertiary)] pointer-events-none">
          No symbol relationships to graph yet.
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1.5">
        <button className={ZOOM_BTN} onClick={() => zoomBy(1.3)} title="Zoom in" aria-label="Zoom in">
          <ZoomIn size={14} />
        </button>
        <button className={ZOOM_BTN} onClick={() => zoomBy(1 / 1.3)} title="Zoom out" aria-label="Zoom out">
          <ZoomOut size={14} />
        </button>
        <button className={ZOOM_BTN} onClick={() => { userInteractedRef.current = false; zoomFit(true); }} title="Fit to view" aria-label="Fit to view">
          <Maximize2 size={14} />
        </button>
      </div>

      {/* Hover tooltip */}
      {hoverLabel && (
        <div
          className="absolute pointer-events-none px-2 py-1 rounded-md text-[0.7rem] font-mono bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)] shadow-md max-w-xs truncate"
          style={{ left: tooltipPos.x, top: tooltipPos.y }}
        >
          {hoverLabel}
        </div>
      )}
    </div>
  );
}
