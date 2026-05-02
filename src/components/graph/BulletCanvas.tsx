"use client";

import React, { useMemo, useRef, useState } from "react";
import type { GraphNode } from "@/types";
import { PRIORITY_COLOR, truncateName } from "./analyticsUtils";
import { useContainerDims, useScopedData, useFontScale } from "./analyticsHooks";
import { CanvasEmptyState } from "./AnalyticsShared";

interface Props {
  nodes: GraphNode[];
  onNodeClick: (node: GraphNode) => void;
  selectedNodeId: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  active: "Active", on_hold: "On Hold", completed: "Completed", archived: "Archived",
};
const DONE_COLUMNS    = new Set(["done"]);
const IN_PROG_COLUMNS = new Set(["in_progress", "review"]);

const PAD   = { top: 32, right: 48, bottom: 32, left: 200 };
const ROW_H = 72;
const BAR_H = 16;

export function BulletCanvas({ nodes, onNodeClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fs = useFontScale();
  const dims = useContainerDims(containerRef);
  const { activeProjects, scopedCardIds, cards, columns } = useScopedData(nodes);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const now = Date.now();

  const projectStats = useMemo(() => {
    return activeProjects.map((proj) => {
      const projCards  = cards.filter((c) => scopedCardIds.has(c.id) && c.projectId === proj.id && !c.archivedAt);
      const total      = projCards.length;
      const doneCount  = projCards.filter((c) => { const col = columns.find((x) => x.id === c.columnId); return col && DONE_COLUMNS.has(col.type); }).length;
      const inProgCount = projCards.filter((c) => { const col = columns.find((x) => x.id === c.columnId); return col && IN_PROG_COLUMNS.has(col.type); }).length;
      const pct        = total > 0 ? doneCount / total : 0;
      const inProgPct  = total > 0 ? inProgCount / total : 0;
      const startMs    = new Date(proj.createdAt).getTime();
      const endMs      = proj.dueDate ? new Date(proj.dueDate).getTime() : now + 30 * 86_400_000;
      const span       = Math.max(endMs - startMs, 1);
      const elapsed    = Math.min(1, Math.max(0, (now - startMs) / span));
      const hasDue     = !!proj.dueDate;
      const isOverdue  = hasDue && now > endMs;
      const timeLeft   = (endMs - now) / span;
      return { proj, total, doneCount, pct, inProgPct, elapsed, hasDue, isOverdue, timeLeft };
    });
  }, [activeProjects, cards, columns, scopedCardIds, now]);

  const plotW  = dims.width - PAD.left - PAD.right;
  const totalH = PAD.top + PAD.bottom + projectStats.length * ROW_H;
  const svgH   = Math.max(dims.height, totalH);
  const lineColor = "var(--text-primary)";

  return (
    <div ref={containerRef} className="flex-1 relative overflow-auto select-none">
      <svg width={dims.width} height={svgH} style={{ display: "block" }}>

        {projectStats.map((stat, i) => {
          const { proj, total, doneCount, pct, inProgPct, elapsed, hasDue, isOverdue, timeLeft } = stat;
          const rowY     = PAD.top + i * ROW_H;
          const barY     = rowY + (ROW_H - BAR_H) / 2;
          const isHov    = hoveredId === proj.id;
          const gn       = nodes.find((n) => n.id === proj.id);
          const priColor = PRIORITY_COLOR[proj.priority] ?? lineColor;

          return (
            <g key={proj.id} style={{ cursor: "pointer" }}
              onMouseEnter={() => setHoveredId(proj.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => { if (gn) onNodeClick(gn); }}
            >
              {isHov && <rect x={0} y={rowY} width={dims.width} height={ROW_H} fill={lineColor} fillOpacity={0.03} />}

              <text x={PAD.left - 14} y={barY + BAR_H / 2}
                textAnchor="end" dominantBaseline="middle"
                fill={lineColor} fillOpacity={isHov ? 0.9 : 0.6}
                fontSize={11 * fs} fontFamily="var(--font-sans)" fontWeight={isHov ? "600" : "400"}>
                {truncateName(proj.name, 22)}
              </text>
              <circle cx={PAD.left - 6} cy={barY + BAR_H / 2} r={3} fill={priColor} fillOpacity={0.8} />

              {/* Urgency bands */}
              <rect x={PAD.left} y={barY} width={plotW * 0.6} height={BAR_H} fill={lineColor} fillOpacity={0.04} rx={2} />
              <rect x={PAD.left + plotW * 0.6} y={barY} width={plotW * 0.2} height={BAR_H} fill="var(--warning)" fillOpacity={0.06} />
              <rect x={PAD.left + plotW * 0.8} y={barY} width={plotW * 0.2} height={BAR_H} fill="var(--danger)" fillOpacity={0.06} rx={2} />

              {/* Track */}
              <rect x={PAD.left} y={barY} width={plotW} height={BAR_H} fill="none" stroke={lineColor} strokeOpacity={0.1} strokeWidth={1} rx={2} />

              {/* In-progress */}
              {inProgPct > 0 && (
                <rect x={PAD.left} y={barY - 2} width={Math.max(0, plotW * (pct + inProgPct))} height={BAR_H + 4} fill={lineColor} fillOpacity={0.1} rx={2} />
              )}

              {/* Done bar */}
              <rect x={PAD.left} y={barY} width={Math.max(0, plotW * pct)} height={BAR_H} fill={lineColor} fillOpacity={isHov ? 0.55 : 0.35} rx={2} />

              {/* Today tick */}
              {hasDue && (
                <line x1={PAD.left + plotW * elapsed} y1={barY - 5} x2={PAD.left + plotW * elapsed} y2={barY + BAR_H + 5}
                  stroke={isOverdue ? "var(--danger)" : lineColor} strokeOpacity={0.7} strokeWidth={1.5} />
              )}

              <text x={PAD.left + plotW + 10} y={barY + BAR_H / 2} dominantBaseline="middle"
                fill={lineColor} fillOpacity={0.4} fontSize={9 * fs} fontFamily="var(--font-mono)">
                {Math.round(pct * 100)}%
              </text>
              <text x={PAD.left} y={barY + BAR_H + 10} fill={lineColor} fillOpacity={0.3} fontSize={8 * fs} fontFamily="var(--font-mono)">
                {doneCount}/{total} done
                {hasDue && ` · ${isOverdue ? "overdue" : `${Math.round(timeLeft * 100)}% time left`}`}
                {` · ${STATUS_LABEL[proj.status] ?? proj.status}`}
              </text>
            </g>
          );
        })}

        {/* X axis */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <text key={t} x={PAD.left + plotW * t} y={PAD.top + projectStats.length * ROW_H + 16}
            textAnchor="middle" fill={lineColor} fillOpacity={0.2} fontSize={8 * fs} fontFamily="var(--font-mono)">
            {Math.round(t * 100)}%
          </text>
        ))}
        <text x={PAD.left + plotW / 2} y={PAD.top + projectStats.length * ROW_H + 28}
          textAnchor="middle" fill={lineColor} fillOpacity={0.15} fontSize={7 * fs} fontFamily="var(--font-mono)">
          % tasks complete
        </text>
      </svg>

      {/* Legend */}
      <div className="absolute top-3 right-4 flex items-center gap-3 text-[0.643rem] font-mono text-[var(--text-tertiary)]">
        <span className="flex items-center gap-1">
          <span className="inline-block w-6 h-2 rounded" style={{ background: "var(--text-primary)", opacity: 0.35 }} /> done
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-6 h-3 rounded" style={{ background: "var(--text-primary)", opacity: 0.1 }} /> in progress
        </span>
        <span className="flex items-center gap-1 opacity-70">
          <span className="inline-block w-0.5 h-4" style={{ background: "var(--text-primary)" }} /> today
        </span>
      </div>

      {activeProjects.length === 0 && <CanvasEmptyState message="No projects to show." />}
    </div>
  );
}
