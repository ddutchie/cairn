"use client";

import React, { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { ChevronLeft } from "lucide-react";
import * as d3 from "d3";
import type { GraphNode, KnowledgeGraph } from "@/types";
import { resolveCssVar, withAlpha } from "./analyticsUtils";
import { useFontScale, useThemeRepaint } from "./analyticsHooks";
import {
  buildHierarchy as sharedBuildHierarchy,
  sunburstTypeToken,
  type HierarchyNode,
} from "../../../shared/ui/graph";

interface Props {
  graph: KnowledgeGraph;
  selectedNodeId: string | null;
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
  // Kept for API compatibility with KnowledgeGraphView; the sunburst drills in
  // rather than showing every label / cross-edge, so labelMode and
  // semanticThreshold have no effect here.
  labelMode: "smart" | "all" | "minimal";
  spacing: number;
  semanticThreshold?: number;
}

type HNode = HierarchyNode;

function colorForType(type: string): string {
  const token = sunburstTypeToken(type as HNode["type"]);
  const cssVar = token === "textPrimary" ? "--text-primary"
    : token === "textSecondary" ? "--text-secondary"
    : token === "textTertiary" ? "--text-tertiary"
    : `--${token}`;
  return resolveCssVar(cssVar);
}

const INNER_R = 38;
// When drilled into a branch the leaves fill a single wide ring; pushing the
// inner edge out makes each wedge's inner arc wide enough to host a label.
const INNER_R_FOCUSED = 140;

type Arc = { x0: number; x1: number; y0: number; y1: number };
type PNode = d3.HierarchyRectangularNode<HNode>;

export function RadialTreeCanvas({ graph, selectedNodeId, onNodeClick, onBackgroundClick, spacing }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fs = useFontScale();

  const [dims, setDims] = useState({ width: 800, height: 600 });
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  // Breadcrumb label of the focused branch (null = at workspace root).
  const [focusLabel, setFocusLabel] = useState<string | null>(null);

  // Adjacency: nodeId → set of directly-connected nodeIds (both edge directions).
  // Used to highlight everything linked to the selected node — for a tag that's
  // its members (tag-member edges), for any other node it's its direct links.
  const adjacency = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    };
    for (const e of graph.edges) {
      link(e.source, e.target);
      link(e.target, e.source);
    }
    return adj;
  }, [graph.edges]);

  // The set of node IDs to spotlight: the selected node plus everything linked
  // to it. Empty/ null when nothing is selected (everything renders normally).
  const relatedIds = useMemo(() => {
    if (!selectedNodeId) return null;
    const set = new Set<string>([selectedNodeId]);
    const neighbours = adjacency.get(selectedNodeId);
    if (neighbours) for (const id of neighbours) set.add(id);
    return set;
  }, [selectedNodeId, adjacency]);

  // ── build partitioned hierarchy (rebuilds only when topology changes) ──
  const root = useMemo(() => {
    const r = d3.hierarchy(sharedBuildHierarchy(graph))
      // A node with no children (including an empty project: children === [])
      // still counts as 1 so it gets a visible, nonzero-width wedge.
      .sum((d) => (d.children && d.children.length ? 0 : 1))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    d3.partition<HNode>().size([2 * Math.PI, r.height + 1])(r);
    return r as PNode;
  }, [graph]);

  // Mutable render state the draw loop reads without re-creating itself.
  const focusRef = useRef<PNode>(root);
  const currentRef = useRef<Map<PNode, Arc>>(new Map());
  const hoveredRef = useRef<PNode | null>(null);
  const animRef = useRef<number>(0);
  const drawRef = useRef<() => void>(() => {});
  const geomRef = useRef({ cx: 400, cy: 300, maxR: 200 });
  // Animated ring geometry — interpolated by zoomTo so the inner radius and
  // ring count morph smoothly instead of snapping when the focus changes.
  const geomAnimRef = useRef({ innerR: INNER_R, levels: Math.max(1, root.height) });

  // Reset focus to root when the underlying graph changes.
  useEffect(() => {
    focusRef.current = root;
    currentRef.current = new Map();
    hoveredRef.current = null;
    geomAnimRef.current = { innerR: INNER_R, levels: Math.max(1, root.height) };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusLabel(null);
  }, [root]);

  // Map a node's absolute partition coords to coords relative to the focus.
  const targetArc = useCallback((d: PNode): Arc => {
    const focus = focusRef.current;
    const span = focus.x1 - focus.x0 || 1;
    const x0 = Math.max(0, Math.min(1, (d.x0 - focus.x0) / span)) * 2 * Math.PI;
    const x1 = Math.max(0, Math.min(1, (d.x1 - focus.x0) / span)) * 2 * Math.PI;
    // Focus's direct children occupy the innermost ring (y=0); the focus itself
    // lives in the central hub, so offset by focus.depth + 1.
    const y0 = Math.max(0, d.y0 - focus.depth - 1);
    const y1 = Math.max(0, d.y1 - focus.depth - 1);
    return { x0, x1, y0, y1 };
  }, []);

  // Equal-width rings, one per hierarchy level *below the current focus*. At the
  // workspace root that's 2 (projects + leaves); drilled into a project the
  // leaves are the only level, so they fill the whole radius as one wide ring.
  const visibleLevels = useCallback((focusNode: PNode): number => {
    return Math.max(1, root.height - focusNode.depth);
  }, [root]);

  // Inner radius of the first ring for a given focus. Expands when drilled below
  // the root so the single leaf ring's inner edge is wide enough to fit labels.
  const innerRadiusFor = useCallback((focusNode: PNode): number => {
    if (focusNode === root) return INNER_R;
    // Don't let the hub eat the whole disc on small canvases.
    return Math.min(INNER_R_FOCUSED, geomRef.current.maxR * 0.45);
  }, [root]);

  const ringR = useCallback((y: number): number => {
    const { maxR } = geomRef.current;
    const { innerR, levels } = geomAnimRef.current;
    const band = (maxR - innerR) / levels;
    return innerR + Math.min(y, levels) * band;
  }, []);

  // ── render ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { cx, cy } = geomRef.current;
    const focus = focusRef.current;
    const hovered = hoveredRef.current;

    const bg = resolveCssVar("--background");
    const accent = resolveCssVar("--accent");
    const accentFg = resolveCssVar("--accent-fg");
    const surface = resolveCssVar("--surface");
    const border = resolveCssVar("--border");
    const textPrimary = resolveCssVar("--text-primary");
    const textSecondary = resolveCssVar("--text-secondary");

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(cx, cy);

    // Arc of the selected wedge, captured so its accent ring can be re-stroked
    // on top after the loop (neighbouring wedges' bg separators would otherwise
    // paint over part of it).
    let selectedDraw: { r0: number; r1: number; x0: number; x1: number } | null = null;

    root.each((d) => {
      if (d === root) return;
      const a = currentRef.current.get(d) ?? targetArc(d);
      if (a.x1 - a.x0 < 0.002 || a.y1 <= 0) return;
      const r0 = ringR(a.y0);
      const r1 = ringR(a.y1) - 1.5;
      if (r1 <= r0) return;

      const col = colorForType(d.data.type);
      const isHover = d === hovered;
      // Spotlight: when a node is selected, the selection itself is the brightest
      // and is the ONLY wedge with an accent ring + glow; its connections stay
      // bright (plain separators); everything else dims so relationships pop.
      const hasSpotlight = !!relatedIds;
      const isSelected = hasSpotlight && d.data.id === selectedNodeId;
      const isConnected = hasSpotlight && !isSelected && relatedIds!.has(d.data.id);
      ctx.beginPath();
      ctx.arc(0, 0, r0, a.x0 - Math.PI / 2, a.x1 - Math.PI / 2);
      ctx.arc(0, 0, r1, a.x1 - Math.PI / 2, a.x0 - Math.PI / 2, true);
      ctx.closePath();
      // "Branch ring" = the focus's direct children that themselves have
      // children (projects / Tags). Leaves render dimmer with outward labels.
      const isBranch = d.depth === focus.depth + 1 && !!d.children && d.children.length > 0;
      let alpha = isHover ? 0.95 : isBranch ? 1 : 0.62;
      if (hasSpotlight) {
        alpha = isSelected ? 1 : isConnected ? (isBranch ? 1 : 0.82) : isBranch ? 0.14 : 0.08;
        if (isHover && (isSelected || isConnected)) alpha = 1;
      }
      // Glow halo behind the selected wedge so it reads as the focal point.
      if (isSelected) {
        ctx.save();
        ctx.shadowColor = accent;
        ctx.shadowBlur = 18;
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.restore();
      }
      // The selected wedge is filled with the accent colour (not its own muted
      // type colour) for a strong, high-contrast read against its connections.
      ctx.fillStyle = isSelected ? accent : withAlpha(col, alpha);
      ctx.fill();
      // Only the selected wedge gets the accent ring — that's its signature.
      // Connections use a plain bg separator like everything else.
      if (isSelected) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = accentFg;
        selectedDraw = { r0, r1, x0: a.x0, x1: a.x1 };
      } else {
        ctx.lineWidth = 1;
        ctx.strokeStyle = bg;
      }
      ctx.stroke();

      // ── label ──
      const ang = (a.x0 + a.x1) / 2;
      const arcSpan = a.x1 - a.x0;
      const ringDepth = r1 - r0;
      const fontPx = (isBranch ? 12 : 11) * fs;
      // Leaf labels read radially outward, so neighbours collide only where the
      // wedge is narrowest — at the inner edge. Require the wedge to clear the
      // font's cap height (~0.72×) there; this packs far more labels than a full
      // line-height gate while still avoiding overlap.
      const arcLenInner = arcSpan * r0;
      const fits = isBranch || arcLenInner >= fontPx * 0.72;
      if (fits && arcSpan > 0.012 && ringDepth > 12) {
        ctx.save();
        ctx.rotate(ang - Math.PI / 2);
        const flip = ang >= Math.PI;
        ctx.font = `${isBranch ? "600 " : ""}${fontPx}px ui-sans-serif, system-ui, sans-serif`;
        const dimLabel = hasSpotlight && !isConnected && !isSelected;
        // Selected wedge is filled with accent, so its label uses accent-fg for
        // legibility; branch labels sit on full-opacity colour (accent-fg too);
        // leaves on the muted fill use the primary text colour.
        ctx.fillStyle = isSelected
          ? accentFg
          : isBranch
            ? withAlpha(accentFg, dimLabel ? 0.25 : 1)
            : withAlpha(textPrimary, dimLabel ? 0.22 : 0.95);
        ctx.textBaseline = "middle";
        // Truncate to the radial depth available (text reads along the radius).
        const maxChars = Math.max(2, Math.floor((ringDepth - 8) / (fontPx * 0.58)));
        let label = d.data.title;
        if (label.length > maxChars) label = label.slice(0, maxChars - 1) + "…";
        if (isBranch) {
          // Centre project/branch labels in their (wide) ring.
          ctx.translate((r0 + r1) / 2, 0);
          if (flip) ctx.rotate(Math.PI);
          ctx.textAlign = "center";
          ctx.fillText(label, 0, 0);
        } else {
          // Leaf labels read outward from just past the inner edge so they never
          // overrun the hub. On the left half, flip and anchor from the outer edge.
          if (flip) {
            ctx.translate(r1 - 4, 0);
            ctx.rotate(Math.PI);
            ctx.textAlign = "start";
          } else {
            ctx.translate(r0 + 4, 0);
            ctx.textAlign = "start";
          }
          ctx.fillText(label, 0, 0);
        }
        ctx.restore();
      }
    });

    // Re-stroke the selected wedge's ring on top of its neighbours so the
    // contrast border around the accent fill stays crisp.
    if (selectedDraw) {
      const s = selectedDraw as { r0: number; r1: number; x0: number; x1: number };
      ctx.beginPath();
      ctx.arc(0, 0, s.r0, s.x0 - Math.PI / 2, s.x1 - Math.PI / 2);
      ctx.arc(0, 0, s.r1, s.x1 - Math.PI / 2, s.x0 - Math.PI / 2, true);
      ctx.closePath();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = accentFg;
      ctx.stroke();
    }

    // center hub: focus label + back affordance
    const hubR = geomAnimRef.current.innerR;
    ctx.beginPath();
    ctx.arc(0, 0, hubR - 3, 0, 7);
    ctx.fillStyle = withAlpha(surface, 0.95);
    ctx.fill();
    ctx.strokeStyle = focus === root ? border : withAlpha(accent, 0.5);
    ctx.lineWidth = focus === root ? 1 : 1.5;
    ctx.stroke();
    ctx.fillStyle = focus === root ? textSecondary : textPrimary;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (focus === root) {
      ctx.font = `600 ${10 * fs}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText("Workspace", 0, 0);
    } else {
      // Larger hub when drilled in — room for a fuller title + back hint.
      ctx.font = `600 ${14 * fs}px ui-sans-serif, system-ui, sans-serif`;
      const title = focus.data.title.length > 18 ? focus.data.title.slice(0, 17) + "…" : focus.data.title;
      ctx.fillText(title, 0, -10);
      ctx.font = `${10 * fs}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = withAlpha(accent, 0.9);
      ctx.fillText("← back", 0, 12);
    }
    ctx.restore();
  }, [root, targetArc, ringR, fs, relatedIds, selectedNodeId]);
  useEffect(() => { drawRef.current = draw; }, [draw]);

  // ── zoom-to-focus animation ──
  const zoomTo = useCallback((node: PNode) => {
    const fromInnerR = geomAnimRef.current.innerR;
    const fromLevels = geomAnimRef.current.levels;
    const toInnerR = innerRadiusFor(node);
    const toLevels = visibleLevels(node);

    focusRef.current = node;
    setFocusLabel(node === root ? null : node.data.title);
    const start = performance.now();
    const dur = 520;
    const from = new Map<PNode, Arc>();
    const to = new Map<PNode, Arc>();
    root.each((d) => {
      from.set(d, currentRef.current.get(d) ?? targetArc(d));
      to.set(d, targetArc(d));
    });
    cancelAnimationFrame(animRef.current);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const e = d3.easeCubicInOut(t);
      geomAnimRef.current = {
        innerR: fromInnerR + (toInnerR - fromInnerR) * e,
        levels: fromLevels + (toLevels - fromLevels) * e,
      };
      root.each((d) => {
        const a = from.get(d)!;
        const b = to.get(d)!;
        currentRef.current.set(d, {
          x0: a.x0 + (b.x0 - a.x0) * e,
          x1: a.x1 + (b.x1 - a.x1) * e,
          y0: a.y0 + (b.y0 - a.y0) * e,
          y1: a.y1 + (b.y1 - a.y1) * e,
        });
      });
      drawRef.current();
      if (t < 1) animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
  }, [root, targetArc, innerRadiusFor, visibleLevels]);

  // ── hit testing ──
  const HUB = "__hub__";
  const pick = useCallback((mx: number, my: number): PNode | typeof HUB | null => {
    const { cx, cy } = geomRef.current;
    const dx = mx - cx;
    const dy = my - cy;
    const r = Math.hypot(dx, dy);
    if (r < geomAnimRef.current.innerR) return HUB;
    let ang = Math.atan2(dy, dx) + Math.PI / 2;
    if (ang < 0) ang += 2 * Math.PI;
    let found: PNode | null = null;
    root.each((d) => {
      if (d === root || found) return;
      const a = currentRef.current.get(d) ?? targetArc(d);
      const r0 = ringR(a.y0);
      const r1 = ringR(a.y1);
      if (r >= r0 && r <= r1 && ang >= a.x0 && ang <= a.x1 && a.x1 - a.x0 > 0.002) found = d;
    });
    return found;
  }, [root, targetArc, ringR]);

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

  // ── canvas sizing (DPR-aware) + geometry + (re)seed arcs ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = dims.width * dpr;
    canvas.height = dims.height * dpr;
    canvas.style.width = dims.width + "px";
    canvas.style.height = dims.height + "px";
    geomRef.current = {
      cx: dims.width / 2,
      cy: dims.height / 2,
      maxR: (Math.min(dims.width, dims.height) / 2 - 20) * (spacing / 1.2),
    };
    // Resync the (non-animating) ring geometry to the current focus so a resize
    // while drilled in re-clamps the inner radius to the new canvas size.
    geomAnimRef.current = {
      innerR: innerRadiusFor(focusRef.current),
      levels: visibleLevels(focusRef.current),
    };
    // Seed any not-yet-animated nodes to their resting positions.
    root.each((d) => {
      if (!currentRef.current.has(d)) currentRef.current.set(d, targetArc(d));
    });
    draw();
  }, [dims, spacing, root, targetArc, draw, innerRadiusFor, visibleLevels]);

  // Redraw when theme/selection-driven colours change.
  useEffect(() => { draw(); }, [draw, selectedNodeId]);

  // Repaint after a theme change so the canvas picks up the new CSS-var colours.
  useThemeRepaint(drawRef);

  // ── pointer interaction ──
  const handleMouseMove = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const n = pick(mx, my);
    const hovered = n === HUB ? null : n;
    if (hovered !== hoveredRef.current) {
      hoveredRef.current = hovered;
      draw();
    }
    canvas.style.cursor = (n === HUB && focusRef.current !== root) ? "pointer" : hovered ? "pointer" : "default";
    if (hovered && hovered !== root) {
      const childCount = hovered.children?.length ?? 0;
      const sub = childCount ? `${hovered.data.type} · ${childCount} items` : hovered.data.type;
      setTooltip({ x: mx + 12, y: my + 12, text: `${hovered.data.title} · ${sub}` });
    } else {
      setTooltip(null);
    }
  }, [pick, draw, root]);

  const handleClick = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const n = pick(ev.clientX - rect.left, ev.clientY - rect.top);
    if (n === null) { onBackgroundClick(); return; }
    // Central hub → go up one level (and clear any spotlight selection).
    if (n === HUB) {
      onBackgroundClick();
      if (focusRef.current !== root) zoomTo(focusRef.current.parent ?? root);
      return;
    }
    // Surface selection (opens detail panel for real nodes).
    if (n.data.type !== "workspace" && n.data.type !== "branch") {
      const found = graph.nodes.find((g) => g.id === n.data.id);
      if (found) onNodeClick(found);
    }
    // A branch with children → drill in.
    if (n.children && n.children.length) zoomTo(n);
  }, [pick, zoomTo, root, graph.nodes, onNodeClick, onBackgroundClick]);

  return (
    <div
      ref={containerRef}
      className="flex-1 w-full h-full relative overflow-hidden"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => { hoveredRef.current = null; setTooltip(null); draw(); }}
      onClick={handleClick}
    >
      <canvas ref={canvasRef} className="block" />

      {tooltip && (
        <div
          className="pointer-events-none absolute z-20 px-3 py-1.5 rounded-md text-xs bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] shadow-lg max-w-[280px] break-words"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      )}

      {/* Breadcrumb / back affordance */}
      {focusLabel && (
        <div className="absolute top-4 left-4 z-20 flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onBackgroundClick(); zoomTo(root); }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs bg-[var(--accent-dim)] border border-transparent text-[var(--accent)] hover:bg-[var(--surface-2)] transition-colors shadow-sm"
          >
            <ChevronLeft size={13} />
            {focusLabel}
            <span className="text-[var(--text-tertiary)]">· show all</span>
          </button>
        </div>
      )}
    </div>
  );
}
