"use client";

import React, { useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { sankey, sankeyLinkHorizontal, SankeyNode, SankeyLink } from "d3-sankey";
import { X } from "lucide-react";
import type { GraphNode } from "@/types";
import { PRIORITY_COLOR, truncateName } from "./analyticsUtils";
import { useContainerDims, useScopedData, useFontScale } from "./analyticsHooks";
import { CanvasEmptyState } from "./AnalyticsShared";

interface Props {
  nodes: GraphNode[];
  onNodeClick: (node: GraphNode) => void;
  selectedNodeId: string | null;
}

const COLUMNS: { key: string; label: string }[] = [
  { key: "backlog",     label: "Backlog" },
  { key: "todo",        label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "review",      label: "Review" },
  { key: "done",        label: "Done" },
];

const PAD     = { top: 40, right: 120, bottom: 40, left: 160 };
const PANEL_W = 280;

type SNode = SankeyNode<{ id: string; label: string; group: "column" | "project" }, object>;
type SLink = SankeyLink<{ id: string; label: string; group: "column" | "project" }, object>;

export function SankeyCanvas({ nodes, onNodeClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fs = useFontScale();
  const dims = useContainerDims(containerRef);
  const { activeProjects, scopedProjectIds, scopedCardIds, cards, columns } = useScopedData(nodes);

  const [hovered,     setHovered]     = useState<string | null>(null);
  const [selectedCol, setSelectedCol] = useState<string | null>(null);

  const { sankeyNodes, sankeyLinks } = useMemo(() => {
    const sNodes: { id: string; label: string; group: "column" | "project" }[] = [
      ...activeProjects.map((p) => ({ id: `project:${p.id}`, label: p.name, group: "project" as const })),
      ...COLUMNS.map((c) => ({ id: `col:${c.key}`, label: c.label, group: "column" as const })),
    ];
    const linkMap = new Map<string, number>();
    for (const card of cards) {
      if (!scopedCardIds.has(card.id)) continue;
      if (!scopedProjectIds.has(card.projectId)) continue;
      const col    = columns.find((c) => c.id === card.columnId);
      // Archived cards count as "done" in the flow diagram
      const colKey = card.archivedAt ? "done" : (col?.type ?? "backlog");
      const key    = `project:${card.projectId}→col:${colKey}`;
      linkMap.set(key, (linkMap.get(key) ?? 0) + 1);
    }
    const sLinks = Array.from(linkMap.entries())
      .map(([key, value]) => { const [source, target] = key.split("→"); return { source, target, value }; })
      .filter((l) => l.value > 0);
    return { sankeyNodes: sNodes, sankeyLinks: sLinks };
  }, [activeProjects, cards, columns, scopedCardIds, scopedProjectIds]);

  const panelOpen = selectedCol !== null;
  const svgW = panelOpen ? dims.width - PANEL_W : dims.width;

  const layout = useMemo(() => {
    if (sankeyNodes.length === 0 || sankeyLinks.length === 0) return null;
    const w = svgW - PAD.left - PAD.right;
    const h = dims.height - PAD.top - PAD.bottom;
    const gen = sankey<{ id: string; label: string; group: "column" | "project" }, object>()
      .nodeId((d) => d.id).nodeWidth(18).nodePadding(14).extent([[0, 0], [w, h]]);
    return gen({ nodes: sankeyNodes.map((d) => ({ ...d })), links: sankeyLinks.map((d) => ({ ...d })) });
  }, [sankeyNodes, sankeyLinks, svgW, dims.height]);

  const panelTasks = useMemo(() => {
    if (!selectedCol) return [];
    return cards.filter((c) => {
      if (!scopedCardIds.has(c.id)) return false;
      if (c.archivedAt) return selectedCol === "done";
      const col = columns.find((col) => col.id === c.columnId);
      return col?.type === selectedCol;
    }).sort((a, b) => {
      const po: Record<string, number> = { urgent: 3, high: 2, medium: 1, low: 0 };
      return (po[b.priority] ?? 0) - (po[a.priority] ?? 0) || a.title.localeCompare(b.title);
    });
  }, [selectedCol, cards, columns, scopedCardIds]);

  const panelLabel  = COLUMNS.find((c) => c.key === selectedCol)?.label ?? "";
  const lineColor   = "var(--text-primary)";

  if (!layout || layout.nodes.length === 0) {
    return (
      <div ref={containerRef} className="flex-1 relative">
        <CanvasEmptyState message="No task data to show." />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden select-none flex">
      <svg width={svgW} height={dims.height} style={{ display: "block", overflow: "visible", flexShrink: 0 }}>
        <g transform={`translate(${PAD.left},${PAD.top})`}>

          {/* Links */}
          {layout.links.map((link, i) => {
            const l        = link as SLink;
            const sourceId = (l.source as SNode).id;
            const targetId = (l.target as SNode).id;
            const colKey   = targetId.replace("col:", "");
            const isHov    = hovered === sourceId || hovered === targetId;
            const isSel    = selectedCol === colKey;
            return (
              <path key={i} d={sankeyLinkHorizontal()(l as never) ?? ""}
                fill="none" stroke={lineColor}
                strokeWidth={Math.max(1, l.width ?? 1)}
                strokeOpacity={isSel ? 0.4 : isHov ? 0.3 : 0.1}
                onMouseEnter={() => setHovered(sourceId)}
                onMouseLeave={() => setHovered(null)}
                style={{ transition: "stroke-opacity 0.15s" }}
              />
            );
          })}

          {/* Nodes */}
          {layout.nodes.map((node) => {
            const n         = node as SNode;
            const x0 = n.x0 ?? 0, x1 = n.x1 ?? 0;
            const y0 = n.y0 ?? 0, y1 = n.y1 ?? 0;
            const w  = x1 - x0, h = y1 - y0;
            const isProject = n.group === "project";
            const colKey    = n.id.replace("col:", "");
            const isHov     = hovered === n.id;
            const isSel     = !isProject && selectedCol === colKey;
            return (
              <g key={n.id}
                onMouseEnter={() => setHovered(n.id)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: "pointer" }}
                onClick={() => {
                  if (isProject) {
                    const gn = nodes.find((nd) => nd.id === n.id.replace("project:", ""));
                    if (gn) onNodeClick(gn);
                  } else {
                    setSelectedCol((prev) => prev === colKey ? null : colKey);
                  }
                }}
              >
                <rect x={x0} y={y0} width={w} height={Math.max(h, 2)}
                  fill={lineColor} fillOpacity={isSel ? 0.7 : isHov ? 0.8 : (isProject ? 0.5 : 0.25)}
                  rx={3} style={{ transition: "fill-opacity 0.15s" }} />
                {h > 6 && (
                  <text x={isProject ? x0 - 8 : x1 + 8} y={y0 + h / 2}
                    textAnchor={isProject ? "end" : "start"} dominantBaseline="middle"
                    fill={lineColor} fillOpacity={isSel ? 1 : isHov ? 0.9 : 0.45}
                    fontSize={9 * fs} fontFamily="var(--font-sans)" fontWeight={isSel ? "600" : "400"}>
                    {truncateName(n.label, 22)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Column task panel */}
      {panelOpen && (
        <div className="flex flex-col border-l border-[var(--border)] bg-[var(--surface)] overflow-hidden"
          style={{ width: PANEL_W, flexShrink: 0 }}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
            <div>
              <p className="text-xs font-semibold text-[var(--text-primary)]">{panelLabel}</p>
              <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-0.5">
                {panelTasks.length} task{panelTasks.length !== 1 ? "s" : ""}
              </p>
            </div>
            <button className="w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
              onClick={() => setSelectedCol(null)}>
              <X size={12} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            {panelTasks.length === 0
              ? <p className="text-[0.786rem] text-[var(--text-tertiary)] px-4 py-6 text-center">No tasks here.</p>
              : panelTasks.map((card) => {
                  const proj = activeProjects.find((p) => p.id === card.projectId);
                  const gn   = nodes.find((n) => n.id === card.id);
                  return (
                    <button key={card.id}
                      className="w-full text-left px-4 py-2.5 hover:bg-[var(--surface-2)] transition-colors group"
                      onClick={() => { if (gn) onNodeClick(gn); }}>
                      <div className="flex items-start gap-2">
                        <span className="mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ background: PRIORITY_COLOR[card.priority] }} />
                        <div className="min-w-0">
                          <p className="text-[0.786rem] text-[var(--text-primary)] truncate leading-snug group-hover:text-[var(--accent)]">
                            {card.title}
                          </p>
                          <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-0.5 truncate">
                            {proj?.name ?? "—"}
                            {card.dueDate && <> · due {d3.timeFormat("%b %d")(new Date(card.dueDate))}</>}
                          </p>
                        </div>
                      </div>
                    </button>
                  );
                })}
          </div>
        </div>
      )}
    </div>
  );
}
