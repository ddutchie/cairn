"use client";

import React, { useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { SimulationNodeDatum } from "d3";
import type { GraphNode } from "@/types";
import { PRIORITY_COLOR, truncateName, CANVAS_PAD } from "./analyticsUtils";
import { useContainerDims, useScopedData } from "./analyticsHooks";
import { CanvasEmptyState, CanvasTooltip, SvgTimeAxis } from "./AnalyticsShared";
import { DAY_MS } from "./analyticsUtils";

interface Props {
  nodes: GraphNode[];
  onNodeClick: (node: GraphNode) => void;
  selectedNodeId: string | null;
}

const DOT_R: Record<string, number> = { low: 4, medium: 5, high: 6, urgent: 7 };
const PAD = { ...CANVAS_PAD, bottom: 48 };
const LANE_PAD = 12;

export function BeeswarmCanvas({ nodes, onNodeClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dims = useContainerDims(containerRef);
  const { activeProjects, scopedCardIds, cards } = useScopedData(nodes);

  const [hoveredId, setHoveredId] = useState<string | null>(null);

  type DatedCard = typeof cards[number] & { date: Date; isDue: boolean };
  type SimNode   = DatedCard & SimulationNodeDatum & { sx: number; sy: number; r: number };

  const [tooltip, setTooltip] = useState<{ x: number; y: number; card: DatedCard } | null>(null);

  const datedCards = useMemo(() => {
    return cards
      .filter((c) => scopedCardIds.has(c.id) && !c.archivedAt)
      .map((c) => ({ ...c, date: new Date(c.dueDate ?? c.createdAt), isDue: !!c.dueDate }))
      .filter((c) => !isNaN(c.date.getTime()));
  }, [cards, scopedCardIds]);

  const plotW = dims.width  - PAD.left - PAD.right;
  const plotH = dims.height - PAD.top  - PAD.bottom;
  const numLanes = Math.max(activeProjects.length, 1);
  const laneH    = plotH / numLanes;

  const xScale = useMemo(() => {
    if (datedCards.length === 0)
      return d3.scaleTime().domain([new Date(), new Date()]).range([PAD.left, PAD.left + plotW]);
    const dates = datedCards.map((c) => c.date);
    const [min, max] = d3.extent(dates) as [Date, Date];
    const span = Math.max(max.getTime() - min.getTime(), 2 * DAY_MS);
    const pad  = span * 0.1;
    return d3.scaleTime()
      .domain([new Date(min.getTime() - pad), new Date(max.getTime() + pad)])
      .range([PAD.left, PAD.left + plotW])
      .nice();
  }, [datedCards, plotW]);

  const simNodes = useMemo(() => {
    if (datedCards.length === 0) return [];
    const all: SimNode[] = [];
    activeProjects.forEach((proj, li) => {
      const laneCenterY = PAD.top + laneH * li + laneH / 2;
      const projCards = datedCards.filter((c) => c.projectId === proj.id);
      const simData: SimNode[] = projCards.map((c) => ({
        ...c, sx: xScale(c.date), sy: laneCenterY,
        r: DOT_R[c.priority] ?? 5, x: xScale(c.date), y: laneCenterY,
      }));
      d3.forceSimulation<SimNode>(simData)
        .force("x", d3.forceX<SimNode>((d) => d.sx).strength(1))
        .force("y", d3.forceY<SimNode>(laneCenterY).strength(0.3))
        .force("collide", d3.forceCollide<SimNode>((d) => d.r + 1.5))
        .stop().tick(120);
      const laneMin = PAD.top + laneH * li + LANE_PAD;
      const laneMax = PAD.top + laneH * (li + 1) - LANE_PAD;
      simData.forEach((d) => {
        d.sx = d.x ?? d.sx;
        d.sy = Math.max(laneMin + d.r, Math.min(laneMax - d.r, d.y ?? d.sy));
      });
      all.push(...simData);
    });
    return all;
  }, [datedCards, activeProjects, laneH, xScale]);

  const lineColor = "var(--text-primary)";

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden select-none">
      <svg width={dims.width} height={dims.height} style={{ display: "block" }}>

        {/* Lane separators */}
        {activeProjects.map((_, li) => {
          if (li === activeProjects.length - 1) return null;
          const y = PAD.top + laneH * (li + 1);
          return <line key={li} x1={PAD.left} y1={y} x2={PAD.left + plotW} y2={y}
            stroke={lineColor} strokeOpacity={0.06} strokeWidth={1} />;
        })}

        {/* Time axis + today */}
        <SvgTimeAxis
          xScale={xScale} plotW={plotW} plotH={plotH}
          padLeft={PAD.left} padTop={PAD.top} padBottom={PAD.bottom}
          bucketMs={DAY_MS} svgHeight={dims.height}
        />

        {/* Lane labels */}
        {activeProjects.map((proj, li) => (
          <text key={proj.id}
            x={PAD.left - 10} y={PAD.top + laneH * li + laneH / 2}
            textAnchor="end" dominantBaseline="middle"
            fill={lineColor} fillOpacity={0.4} fontSize={9} fontFamily="var(--font-sans)">
            {truncateName(proj.name)}
          </text>
        ))}

        {/* Dots */}
        {simNodes.map((c) => {
          const isHov  = hoveredId === c.id;
          const color  = PRIORITY_COLOR[c.priority] ?? lineColor;
          const gn     = nodes.find((n) => n.id === c.id);
          return (
            <circle key={c.id} cx={c.sx} cy={c.sy} r={c.r}
              fill={color} fillOpacity={isHov ? 0.95 : (c.isDue ? 0.7 : 0.4)}
              stroke={color} strokeWidth={isHov ? 1.5 : 0} strokeOpacity={0.9}
              style={{ cursor: "pointer", transition: "fill-opacity 0.1s" }}
              onMouseEnter={(e) => {
                setHoveredId(c.id);
                const rect = containerRef.current!.getBoundingClientRect();
                setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, card: c });
              }}
              onMouseLeave={() => { setHoveredId(null); setTooltip(null); }}
              onClick={() => { if (gn) onNodeClick(gn); }}
            />
          );
        })}

        {/* Bottom axis line */}
        <line x1={PAD.left} y1={PAD.top + plotH} x2={PAD.left + plotW} y2={PAD.top + plotH}
          stroke={lineColor} strokeOpacity={0.1} strokeWidth={1} />
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <CanvasTooltip x={tooltip.x} y={tooltip.y} containerW={dims.width}>
          <p className="font-medium text-[var(--text-primary)] truncate mb-1">{tooltip.card.title}</p>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: PRIORITY_COLOR[tooltip.card.priority] }} />
            <span className="text-[var(--text-tertiary)] capitalize">{tooltip.card.priority}</span>
            <span className="text-[var(--text-tertiary)]">·</span>
            <span className="text-[var(--text-tertiary)]">
              {tooltip.card.isDue ? "due" : "created"} {d3.timeFormat("%b %d")(tooltip.card.date)}
            </span>
          </div>
        </CanvasTooltip>
      )}

      {/* Priority legend */}
      <div className="absolute top-3 right-4 flex items-center gap-3">
        {Object.entries(PRIORITY_COLOR).map(([p, color]) => (
          <div key={p} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ background: color }} />
            <span className="text-[9px] font-mono capitalize text-[var(--text-tertiary)]">{p}</span>
          </div>
        ))}
        <span className="text-[9px] font-mono text-[var(--text-tertiary)] ml-1 opacity-50">
          size = priority · solid = due date set
        </span>
      </div>

      {simNodes.length === 0 && <CanvasEmptyState message="No tasks to show." />}
    </div>
  );
}
