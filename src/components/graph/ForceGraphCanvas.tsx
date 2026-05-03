"use client";

import React, { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import type { GraphNode, KnowledgeGraph } from "@/types";
import { resolveCssVar } from "./graphUtils";
import { useFontScale } from "./analyticsHooks";

// react-force-graph-2d is a CommonJS module with no TS types bundled.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ForceGraph2DInstance = any;

interface Props {
  graph: KnowledgeGraph;
  selectedNodeId: string | null;
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
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

// Edge colour by relationship type
function edgeColor(edgeType: string): { color: string; opacity: number; dash: boolean } {
  switch (edgeType) {
    case "note-note":      return { color: resolveCssVar("--info"),    opacity: 0.6, dash: false };
    case "note-card":      return { color: resolveCssVar("--success"), opacity: 0.6, dash: false };
    case "tag-member":     return { color: resolveCssVar("--warning"), opacity: 0.5, dash: false };
    case "project-member": return { color: resolveCssVar("--accent"),  opacity: 0.4, dash: false };
    case "flow-edge":      return { color: resolveCssVar("--accent"),  opacity: 0.8, dash: false };
    case "flow-ref":       return { color: resolveCssVar("--accent"),  opacity: 0.5, dash: true  };
    case "co-mention":     return { color: resolveCssVar("--border"),  opacity: 0.5, dash: true  };
    case "keyword":        return { color: resolveCssVar("--border"),  opacity: 0.4, dash: true  };
    case "assignee":       return { color: resolveCssVar("--border"),  opacity: 0.4, dash: true  };
    default:               return { color: resolveCssVar("--border"),  opacity: 0.4, dash: false };
  }
}

function toAlpha(hex: string, opacity: number): string {
  const a = Math.round(opacity * 255).toString(16).padStart(2, "0");
  return hex.replace(/^#/, "#") + a;
}

export function ForceGraphCanvas({ graph, selectedNodeId, onNodeClick, onBackgroundClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraph2DInstance>(null);
  const [ForceGraph2D, setForceGraph2D] = useState<ForceGraph2DInstance>(null);
  const fs = useFontScale();
  const [dims, setDims] = useState({ width: 800, height: 600 });

  useEffect(() => {
    import("react-force-graph-2d").then((mod) => setForceGraph2D(() => mod.default));
  }, []);

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

  // Key on stable fingerprints of node/edge IDs — not object identity.
  // This means selectedNodeId changes (which cause re-renders) never invalidate
  // the memo and never hand a new graphData object to the library → no re-simulation.
  const nodeFingerprint = graph.nodes.map((n) => n.id).join(",");
  const edgeFingerprint = graph.edges.map((e) => `${e.source}-${e.target}`).join(",");
  const fgData = useMemo(() => ({
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [nodeFingerprint, edgeFingerprint]);

  function zoomBy(factor: number) {
    fgRef.current?.zoom(fgRef.current.zoom() * factor, 300);
  }
  function zoomFit() {
    fgRef.current?.zoomToFit(400, 40);
  }

  if (!ForceGraph2D) {
    return (
      <div ref={containerRef} className="flex-1 flex items-center justify-center">
        <span className="text-xs text-[var(--text-tertiary)]">Loading graph…</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-hidden relative">
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
          return node.id === selectedNodeId ? base : base + "bb";
        }}
        nodeRelSize={5}
        linkColor={(link: { edgeType?: string }) => {
          const { color, opacity } = edgeColor(link.edgeType ?? "");
          return toAlpha(color, opacity);
        }}
        linkWidth={(link: { edgeType?: string }) =>
          link.edgeType === "flow-edge" ? 2 : 1
        }
        linkLineDash={(link: { edgeType?: string }) =>
          edgeColor(link.edgeType ?? "").dash ? [3, 3] : null
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
          const isProject = node.nodeType === "project";
          const radius = isProject ? 7 : node.nodeType === "tag" ? 4 : 5.5;
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          const color = hexForType((node.nodeType ?? "note") as GraphNode["type"]);

          // Glow for selected node
          if (isSelected) {
            for (let i = 3; i >= 1; i--) {
              ctx.beginPath();
              ctx.arc(x, y, radius + i * 3, 0, 2 * Math.PI);
              ctx.fillStyle = color + Math.round((0.08 / i) * 255).toString(16).padStart(2, "0");
              ctx.fill();
            }
          }

          // Node circle
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, 2 * Math.PI);
          ctx.fillStyle = isSelected ? color : color + "bb";
          ctx.fill();

          if (isSelected) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 2 / globalScale;
            ctx.stroke();
          }

          // Labels: always for projects, zoom-gated for others
          // Font size is fixed in screen space (11px for projects, 10px for others)
          // — divide by globalScale so canvas scaling doesn't affect perceived size
          const showLabel = isProject || globalScale >= 1.2;
          if (showLabel) {
            const screenPx = (isProject ? 11 : 10) * fs;
            const fontSize = screenPx / globalScale;
            ctx.font = `${isProject ? "600 " : ""}${fontSize}px ui-sans-serif, system-ui, sans-serif`;
            ctx.fillStyle = resolveCssVar(isProject ? "--text-primary" : "--text-secondary");
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            const maxLen = isProject ? 24 : 18;
            const text = label.length > maxLen ? label.slice(0, maxLen - 1) + "…" : label;
            ctx.fillText(text, x, y + radius + 3 / globalScale);
          }
        }}
        nodeCanvasObjectMode={() => "replace"}
        cooldownTicks={150}
        d3AlphaDecay={0.03}
        d3VelocityDecay={0.4}
        onEngineStart={() => {
          const fg = fgRef.current;
          if (!fg) return;
          fg.d3Force("charge")?.strength(-120);
          fg.d3Force("link")?.distance((link: { edgeType?: string }) => {
            if (link.edgeType === "project-member") return 70;
            if (link.edgeType === "tag-member")     return 50;
            return 35;
          });
        }}
        onEngineStop={() => fgRef.current?.zoomToFit(400, 40)}
      />

      {/* Zoom controls */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-1">
        {/* eslint-disable-next-line react-hooks/refs */}
        {[
          { icon: <ZoomIn size={13} />, action: () => zoomBy(1.4), tip: "Zoom in" },
          { icon: <ZoomOut size={13} />, action: () => zoomBy(1 / 1.4), tip: "Zoom out" },
          { icon: <Maximize2 size={13} />, action: zoomFit, tip: "Fit" },
        ].map(({ icon, action, tip }) => (
          <button
            key={tip}
            onClick={action}
            title={tip}
            className="w-7 h-7 flex items-center justify-center rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors shadow-sm"
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  );
}
