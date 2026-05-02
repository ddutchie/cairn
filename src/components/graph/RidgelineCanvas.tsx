"use client";

import React, { useMemo, useRef, useEffect, useState, useCallback } from "react";
import * as d3 from "d3";
import type { GraphNode } from "@/types";
import { HOUR_MS, DAY_MS, floorHour, floorDay, truncateName, CANVAS_PAD } from "./analyticsUtils";
import { useContainerDims, useScopedData, useFontScale } from "./analyticsHooks";
import { CanvasTooltip, CanvasEmptyState } from "./AnalyticsShared";

export type RidgelineMode = "ridgeline" | "overlay" | "iso";

interface Props {
  nodes: GraphNode[];
  onNodeClick: (node: GraphNode) => void;
  selectedNodeId: string | null;
  // Controlled from KGV toolbar
  mode: RidgelineMode;
  view: { start: number; end: number };
  onViewChange: (v: { start: number; end: number }) => void;
  applyZoom: (factor: number, pivotMs?: number) => void;
  // Called once when the data-driven default range is first known
  onDefaultView: (v: { start: number; end: number }) => void;
}

// Iso shear per row
const ISO_DX = 28;
const ISO_DY = 22;

// Overlay: vertical step between row baselines
const OVERLAY_STEP = 36;

const PAD_LEFT   = CANVAS_PAD.left;
const PAD_RIGHT  = CANVAS_PAD.right;
const PAD_TOP    = CANVAS_PAD.top;
const PAD_BOTTOM = CANVAS_PAD.bottom;



export function RidgelineCanvas({ nodes, onNodeClick, mode, view, onViewChange, applyZoom, onDefaultView }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fs = useFontScale();
  const svgRef       = useRef<SVGSVGElement>(null);
  const dims = useContainerDims(containerRef);
  const { activeProjects, scopedCardIds, cards } = useScopedData(nodes);

  const [hoveredRow,    setHoveredRow]    = useState<string | null>(null);
  const [hoveredBucket, setHoveredBucket] = useState<{
    projectId: string; bucketMs: number; tasks: typeof cards;
  } | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const dragRef = useRef<{ startX: number; startView: { start: number; end: number } } | null>(null);

  // ── Default view from data ──────────────────────────────────────────────────
  const defaultView = useMemo(() => {
    const ts: number[] = [];
    for (const card of cards) {
      if (!scopedCardIds.has(card.id)) continue;
      const s = card.dueDate || card.createdAt;
      if (s) ts.push(new Date(s).getTime());
    }
    if (ts.length === 0) {
      const now = Date.now();
      return { start: now - 7 * DAY_MS, end: now + DAY_MS };
    }
    const minTs = Math.min(...ts);
    const maxTs = Math.max(...ts);
    const span  = Math.max(maxTs - minTs, 2 * DAY_MS);
    const pad   = span * 0.15;
    return { start: minTs - pad, end: maxTs + pad };
  }, [cards, scopedCardIds]);

  // Emit the data-driven default up to KGV once cards are loaded
  const emittedRef = useRef(false);
  useEffect(() => {
    if (!emittedRef.current && cards.length > 0) {
      emittedRef.current = true;
      onDefaultView(defaultView);
    }
  }, [defaultView, cards.length, onDefaultView]);

  const viewSpanMs = view.end - view.start;

  // ── Bucket resolution ───────────────────────────────────────────────────────
  const bucketMs = useMemo(() => {
    if (viewSpanMs <= 3  * DAY_MS) return HOUR_MS;
    if (viewSpanMs <= 14 * DAY_MS) return 4 * HOUR_MS;
    if (viewSpanMs <= 60 * DAY_MS) return DAY_MS;
    return 7 * DAY_MS;
  }, [viewSpanMs]);

  const bucketStart = floorHour(view.start);
  const bucketEnd   = floorHour(view.end) + bucketMs;
  const numBuckets  = Math.ceil((bucketEnd - bucketStart) / bucketMs);

  // ── Row data ────────────────────────────────────────────────────────────────
  const rows = useMemo(() => {
    return activeProjects.map((project) => {
      const counts = new Array(numBuckets).fill(0);
      for (const card of cards) {
        if (!scopedCardIds.has(card.id)) continue;
        if (card.projectId !== project.id) continue;
        const s = card.dueDate || card.createdAt;
        if (!s) continue;
        const ts  = new Date(s).getTime();
        const idx = Math.floor((ts - bucketStart) / bucketMs);
        if (idx >= 0 && idx < numBuckets) counts[idx]++;
      }
      const rowMax = Math.max(1, ...counts);
      const pts = counts.map((c, i) => ({
        date:  new Date(bucketStart + i * bucketMs),
        value: c,
        norm:  c / rowMax,   // normalised 0–1 against this row's own max
      }));
      return { project, pts, rowMax, total: counts.reduce((a, b) => a + b, 0) };
    });
  }, [activeProjects, cards, scopedCardIds, numBuckets, bucketStart, bucketMs]);



  // ── Layout ──────────────────────────────────────────────────────────────────
  const isIso     = mode === "iso";
  const isOverlay = mode === "overlay";
  const numRows   = Math.max(rows.length, 1);

  const isoTotalDX = isIso ? ISO_DX * (numRows - 1) : 0;
  const isoTotalDY = isIso ? ISO_DY * (numRows - 1) : 0;

  const plotW = dims.width  - PAD_LEFT - PAD_RIGHT  - isoTotalDX;
  const plotH = dims.height - PAD_TOP  - PAD_BOTTOM - isoTotalDY;

  const rowSpacing = Math.floor(plotH / (numRows + 1));
  const peakH = (isOverlay || isIso)
    ? Math.min(plotH * 0.75, 280)
    : Math.min(rowSpacing * 0.9, plotH * 0.35);

  // ── D3 scales ───────────────────────────────────────────────────────────────
  const xScale = useMemo(() =>
    d3.scaleTime()
      .domain([new Date(bucketStart), new Date(bucketEnd)])
      .range([PAD_LEFT, PAD_LEFT + plotW]),
    [bucketStart, bucketEnd, plotW]);

  // ── Iso offset per row ──────────────────────────────────────────────────────
  function isoOffset(ri: number) {
    const depth = (numRows - 1) - ri;
    return { dx: ISO_DX * depth, dy: -(ISO_DY * depth) };
  }

  // ── Row baselines ───────────────────────────────────────────────────────────
  function rowBaseY(ri: number): number {
    if (mode === "ridgeline") return PAD_TOP + rowSpacing * (ri + 1);
    if (isIso) return PAD_TOP + isoTotalDY + plotH;
    const bottomY = PAD_TOP + plotH;
    return bottomY - ((numRows - 1) - ri) * OVERLAY_STEP;
  }

  // ── D3 path generators ──────────────────────────────────────────────────────
  // Each row gets its own scale so even a row with max=1 shows a full-height peak
  function makeGenerators(ri: number) {
    const baseY = rowBaseY(ri);
    const off   = isIso ? isoOffset(ri) : { dx: 0, dy: 0 };
    const by    = baseY + off.dy;

    type Pt = { date: Date; value: number; norm: number };

    const lineGen = d3.line<Pt>()
      .x((d) => xScale(d.date) + off.dx)
      .y((d) => by - d.norm * peakH)
      .curve(d3.curveLinear);

    const areaGen = d3.area<Pt>()
      .x((d) => xScale(d.date) + off.dx)
      .y0(by)
      .y1((d) => by - d.norm * peakH)
      .curve(d3.curveLinear);

    return { lineGen, areaGen, by };
  }

  // ── Ticks via d3.scaleTime ──────────────────────────────────────────────────
  const ticks = useMemo(() => {
    const scale = d3.scaleTime()
      .domain([new Date(view.start), new Date(view.end)])
      .range([PAD_LEFT, PAD_LEFT + plotW]);
    const count = Math.max(2, Math.floor(plotW / 100));
    return scale.ticks(count).map((d) => ({
      ms:    d.getTime(),
      x:     xScale(d),
      label: d3.timeFormat(bucketMs < DAY_MS ? "%b %d %H:%M" : "%b %d")(d),
    }));
  }, [view, plotW, xScale, bucketMs]);

  const todayX    = xScale(new Date(floorDay(Date.now())));
  const showToday = todayX >= PAD_LEFT && todayX <= PAD_LEFT + plotW;

  // ── Wheel zoom ──────────────────────────────────────────────────────────────
  const msFromX = useCallback(
    (px: number) => xScale.invert(px).getTime(),
    [xScale]);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pivot   = msFromX(e.clientX - rect.left);
    const notches = Math.max(-3, Math.min(3, e.deltaY / 40));
    applyZoom(Math.pow(1.08, notches), pivot);
  }, [msFromX, applyZoom]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  // ── Drag to pan ─────────────────────────────────────────────────────────────
  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startView: view };
  }

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current!.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;

    if (dragRef.current) {
      const dx  = e.clientX - dragRef.current.startX;
      const dMs = -(dx / plotW) * viewSpanMs;
      const sv  = dragRef.current.startView;
      onViewChange({ start: sv.start + dMs, end: sv.end + dMs });
    }

    // ── Hover detection ──────────────────────────────────────────────────────
    // Walk rows in reverse render order (front row first) so frontmost wins
    const hoverMs   = msFromX(mx);
    const bucketIdx = Math.round((hoverMs - bucketStart) / bucketMs);

    for (let ri = rows.length - 1; ri >= 0; ri--) {
      const baseY = rowBaseY(ri);
      const off   = isIso ? isoOffset(ri) : { dx: 0, dy: 0 };
      const by    = baseY + off.dy;

      // Hit zone: between baseline and peak for this row
      const topY    = by - peakH;
      const bottomY = by;

      if (my >= topY - 8 && my <= bottomY + 8) {
        if (bucketIdx >= 0 && bucketIdx < numBuckets) {
          const bucketTime = bucketStart + bucketIdx * bucketMs;
          const tasks = cards.filter((c) => {
            if (!scopedCardIds.has(c.id)) return false;
            if (c.projectId !== rows[ri].project.id) return false;
            const s = c.dueDate || c.createdAt;
            if (!s) return false;
            const ts = new Date(s).getTime();
            return ts >= bucketTime && ts < bucketTime + bucketMs;
          });
          setHoveredRow(rows[ri].project.id);
          setHoveredBucket({ projectId: rows[ri].project.id, bucketMs: bucketTime, tasks });
          setTooltipPos({ x: mx, y: my });
          return;
        }
      }
    }
    setHoveredRow(null);
    setHoveredBucket(null);
  }

  function handleMouseUp() { dragRef.current = null; }

  // ── Render order ────────────────────────────────────────────────────────────
  const renderOrder = rows.map((_, i) => i);

  const lineColor = "var(--text-primary)";
  const fillColor = "var(--background)";
  const tickColor = "var(--text-primary)";

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden select-none">
      <svg
        ref={svgRef}
        width={dims.width}
        height={dims.height}
        style={{ display: "block", cursor: dragRef.current ? "grabbing" : "grab" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { dragRef.current = null; setHoveredRow(null); setHoveredBucket(null); }}
      >
        {/* Tick grid */}
        {ticks.map(({ ms, x, label }) => (
          <g key={ms}>
            <line x1={x} y1={PAD_TOP - 6} x2={x} y2={dims.height - PAD_BOTTOM}
              stroke={tickColor} strokeOpacity={0.06} strokeWidth={1} />
            <text x={x} y={PAD_TOP - 10} textAnchor="middle"
              fill={tickColor} fillOpacity={0.3} fontSize={8 * fs}
              fontFamily="var(--font-mono)">
              {label}
            </text>
          </g>
        ))}

        {/* Today */}
        {showToday && (
          <>
            <line x1={todayX} y1={PAD_TOP - 4} x2={todayX} y2={dims.height - PAD_BOTTOM}
              stroke={tickColor} strokeOpacity={0.18} strokeWidth={1} strokeDasharray="3,3" />
            <text x={todayX} y={PAD_TOP - 10} textAnchor="middle"
              fill={tickColor} fillOpacity={0.35} fontSize={8 * fs}
              fontFamily="var(--font-mono)">TODAY</text>
          </>
        )}

        {/* Rows */}
        {renderOrder.map((ri) => {
          const row   = rows[ri];
          const isHov = hoveredRow === row.project.id;
          const { lineGen, areaGen, by } = makeGenerators(ri);
          const linePath = lineGen(row.pts) ?? "";
          const areaPath = areaGen(row.pts) ?? "";

          return (
            <g key={row.project.id}>
              {/* Occlusion fill — pointerEvents none so hover passes through */}
              <path d={areaPath} fill={fillColor} stroke="none" pointerEvents="none" />
              {/* Ridge line — also no pointer events; hover handled by SVG mousemove */}
              <path d={linePath} fill="none"
                stroke={lineColor}
                strokeWidth={isHov ? 1.5 : (isIso ? 0.6 : 0.8)}
                strokeOpacity={isHov ? 1 : (isIso ? 0.7 : 0.5)}
                pointerEvents="none"
              />
              {/* Invisible wide hover band at baseline for reliable hit testing */}
              <rect
                x={PAD_LEFT} y={by - peakH - 4}
                width={plotW} height={peakH + 8}
                fill="transparent"
                pointerEvents="all"
              />
              {/* Row label */}
              {!isIso && (
                <text
                  x={PAD_LEFT - 10} y={by + 1}
                  textAnchor="end" dominantBaseline="middle"
                  fill={lineColor} fillOpacity={isHov ? 0.9 : 0.35}
                  fontSize={9 * fs} fontFamily="var(--font-sans)"
                  fontWeight={isHov ? "600" : "400"}
                  pointerEvents="none"
                >
                  {truncateName(row.project.name)}
                </text>
              )}
            </g>
          );
        })}

        {/* Crosshair */}
        {hoveredBucket && (
          <line x1={tooltipPos.x} y1={PAD_TOP} x2={tooltipPos.x} y2={dims.height - PAD_BOTTOM}
            stroke={lineColor} strokeOpacity={0.12} strokeWidth={1} pointerEvents="none" />
        )}
      </svg>

      {/* Tooltip */}
      {hoveredBucket && hoveredBucket.tasks.length > 0 && (
        <CanvasTooltip x={tooltipPos.x} y={tooltipPos.y} containerW={dims.width}>
          <p className="text-[0.714rem] font-mono text-[var(--text-tertiary)] mb-1.5">
            {d3.timeFormat(bucketMs < DAY_MS ? "%b %d %H:%M" : "%b %d")(new Date(hoveredBucket.bucketMs))}
          </p>
          <div className="space-y-1">
            {hoveredBucket.tasks.slice(0, 6).map((card) => {
              const gn = nodes.find((n) => n.id === card.id);
              return (
                <button key={card.id}
                  className="flex items-center gap-1.5 w-full text-left hover:text-[var(--accent)] text-[var(--text-secondary)] transition-colors"
                  onPointerDown={(e) => { e.stopPropagation(); if (gn) onNodeClick(gn); }}>
                  <span className="w-1 h-1 rounded-full flex-shrink-0 bg-[var(--success)]" />
                  <span className="truncate">{card.title}</span>
                </button>
              );
            })}
            {hoveredBucket.tasks.length > 6 && (
              <p className="text-[var(--text-tertiary)] text-[0.714rem]">+{hoveredBucket.tasks.length - 6} more</p>
            )}
          </div>
        </CanvasTooltip>
      )}

      {rows.length === 0 && <CanvasEmptyState message="No tasks in this scope." />}
    </div>
  );
}
