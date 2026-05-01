"use client";

import React, { useRef, useEffect, useCallback, useState } from "react";
import type { GraphNode, GraphEdge, KnowledgeGraph } from "@/types";
import { nodeTypeColor } from "@/store/slices/graph";

// react-force-graph-2d is a CommonJS module with no TS types bundled.
// We import it dynamically to avoid SSR issues in Next.js.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ForceGraph2DInstance = any;

interface Props {
  graph: KnowledgeGraph;
  selectedNodeId: string | null;
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
}

// Resolve a CSS variable value at runtime (canvas API can't use var(--x))
function resolveCssVar(varName: string): string {
  if (typeof document === "undefined") return "#888";
  return getComputedStyle(document.documentElement)
    .getPropertyValue(varName.replace(/^var\((.+)\)$/, "$1"))
    .trim();
}

function hexForType(type: GraphNode["type"]): string {
  const map: Record<string, string> = {
    project: resolveCssVar("--accent"),
    note:    resolveCssVar("--info"),
    card:    resolveCssVar("--success"),
    tag:     resolveCssVar("--warning"),
  };
  return map[type] ?? "#888";
}

export function ForceGraphCanvas({ graph, selectedNodeId, onNodeClick, onBackgroundClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraph2DInstance>(null);
  const [ForceGraph2D, setForceGraph2D] = useState<ForceGraph2DInstance>(null);
  const [dims, setDims] = useState({ width: 800, height: 600 });

  // Lazy-load the heavy library
  useEffect(() => {
    import("react-force-graph-2d").then((mod) => {
      setForceGraph2D(() => mod.default);
    });
  }, []);

  // Track container dimensions
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

  const handleNodeClick = useCallback(
    (node: { id?: string }) => {
      const found = graph.nodes.find((n) => n.id === node.id);
      if (found) onNodeClick(found);
    },
    [graph.nodes, onNodeClick]
  );

  // Build force-graph data: clone to avoid mutating original
  const fgData = {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      name: n.title,
      nodeType: n.type,
      val: n.type === "project" ? 3 : n.type === "tag" ? 1.5 : 2,
    })),
    links: graph.edges.map((e) => ({
      source: e.source,
      target: e.target,
      edgeType: e.type,
      weight: e.weight ?? 1,
    })),
  };

  if (!ForceGraph2D) {
    return (
      <div ref={containerRef} className="flex-1 flex items-center justify-center">
        <span className="text-xs text-[var(--text-tertiary)]">Loading graph…</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-hidden">
      <ForceGraph2D
        ref={fgRef}
        width={dims.width}
        height={dims.height}
        graphData={fgData}
        nodeId="id"
        nodeLabel="name"
        nodeVal="val"
        nodeColor={(node: { id?: string; nodeType?: string }) => {
          const base = hexForType((node.nodeType ?? "note") as GraphNode["type"]);
          if (node.id === selectedNodeId) return base;
          return base + "cc"; // slight transparency for non-selected
        }}
        nodeRelSize={5}
        linkColor={(link: { edgeType?: string; weight?: number }) => {
          const isAuto = ["co-mention", "keyword", "assignee"].includes(link.edgeType ?? "");
          const base = resolveCssVar("--border");
          return isAuto ? base + "88" : base + "cc";
        }}
        linkWidth={(link: { edgeType?: string }) =>
          link.edgeType === "flow-edge" ? 2 : 1
        }
        linkDirectionalArrowLength={(link: { edgeType?: string }) =>
          link.edgeType === "flow-edge" ? 4 : 0
        }
        linkDirectionalArrowRelPos={1}
        onNodeClick={handleNodeClick}
        onBackgroundClick={onBackgroundClick}
        nodeCanvasObject={(
          node: { id?: string; name?: string; nodeType?: string; x?: number; y?: number },
          ctx: CanvasRenderingContext2D,
          globalScale: number
        ) => {
          const label = node.name ?? "";
          const isSelected = node.id === selectedNodeId;
          const radius = node.nodeType === "project" ? 7 : node.nodeType === "tag" ? 4 : 5.5;
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          const color = hexForType((node.nodeType ?? "note") as GraphNode["type"]);

          // Draw node circle
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, 2 * Math.PI);
          ctx.fillStyle = isSelected ? color : color + "bb";
          ctx.fill();

          if (isSelected) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 2 / globalScale;
            ctx.stroke();
          }

          // Draw label when zoomed in enough
          if (globalScale >= 1.2) {
            const fontSize = Math.min(12, 10 / globalScale);
            ctx.font = `${fontSize}px sans-serif`;
            ctx.fillStyle = resolveCssVar("--text-secondary");
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(label.length > 20 ? label.slice(0, 18) + "…" : label, x, y + radius + 2 / globalScale);
          }
        }}
        nodeCanvasObjectMode={() => "replace"}
        cooldownTicks={120}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
      />
    </div>
  );
}
