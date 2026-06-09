"use client";

import React, { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import * as d3 from "d3";
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
  labelMode: "smart" | "all" | "minimal";
  spacing: number;
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
    case "wikilink":       return { color: resolveCssVar("--accent"),  opacity: 0.75, dash: false };
    default:               return { color: resolveCssVar("--border"),  opacity: 0.4, dash: false };
  }
}

function toAlpha(hex: string, opacity: number): string {
  const a = Math.round(opacity * 255).toString(16).padStart(2, "0");
  return hex.replace(/^#/, "#") + a;
}

export function ForceGraphCanvas({ graph, selectedNodeId, onNodeClick, onBackgroundClick, labelMode, spacing }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraph2DInstance>(null);
  const [ForceGraph2D, setForceGraph2D] = useState<ForceGraph2DInstance>(null);
  const fs = useFontScale();
  const [dims, setDims] = useState({ width: 800, height: 600 });
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // Compute node degrees to dynamically scale individual node repulsion (charge force)
  const nodeDegrees = useMemo(() => {
    const degrees: Record<string, number> = {};
    for (const link of graph.edges) {
      degrees[link.source] = (degrees[link.source] ?? 0) + 1;
      degrees[link.target] = (degrees[link.target] ?? 0) + 1;
    }
    return degrees;
  }, [graph.edges]);

  useEffect(() => {
    import("react-force-graph-2d").then((mod) => setForceGraph2D(() => mod.default));
  }, []);

  // Dynamically update D3 forces on spacing changes
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    // Use dynamic repulsion charge per node (unlinked/low-degree nodes get very little repulsion)
           fg.d3Force("charge")?.strength((node: { id?: string; nodeType?: string }) => {
             const degree = nodeDegrees[node.id ?? ""] ?? 0;
      if (degree === 0) return -15; // float unlinked nodes close to center without blasting them off
      if (degree === 1) return -40 * spacing;
      const isProject = node.nodeType === "project";
      const baseCharge = isProject ? -150 : -100;
      return baseCharge * spacing;
    });

    if (ForceGraph2D) {
      fg.d3Force("collide", d3.forceCollide().radius((node: { nodeType?: string }) => {
        const isProject = node.nodeType === "project";
        const radius = isProject ? 7 : node.nodeType === "tag" ? 4 : 5.5;
        return (radius + 15) * spacing;
      }).iterations(2));
    }

    fg.d3Force("link")?.distance((link: { edgeType?: string }) => {
      let baseDist = 35;
      if (link.edgeType === "project-member") baseDist = 70;
      if (link.edgeType === "tag-member")     baseDist = 50;
      return baseDist * spacing;
    });

    // Centering gravity forces to prevent drifting of unlinked nodes
    fg.d3Force("x", d3.forceX(0).strength(0.06 * (spacing >= 1 ? spacing : 1)));
    fg.d3Force("y", d3.forceY(0).strength(0.06 * (spacing >= 1 ? spacing : 1)));

    fg.d3ReheatSimulation();
  }, [spacing, ForceGraph2D, nodeDegrees]);

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
        linkWidth={(link: { edgeType?: string; weight?: number }) => {
          if (link.edgeType === "flow-edge") return 2;
          if (link.edgeType === "wikilink") return 2;
          // Weight-based thickness for auto-discovered edges (0–1 range)
          if (link.weight != null && link.weight < 1) return 0.5 + link.weight * 1.0;
          return 1;
        }}
        linkLineDash={(link: { edgeType?: string }) =>
          edgeColor(link.edgeType ?? "").dash ? [3, 3] : null
        }
        linkDirectionalArrowLength={(link: { edgeType?: string }) =>
          link.edgeType === "flow-edge" || link.edgeType === "wikilink" ? 4 : 0
        }
        linkDirectionalArrowRelPos={1}
        onNodeClick={handleNodeClick}
        onBackgroundClick={onBackgroundClick}
        onNodeHover={(node: { id?: string } | null) => {
          setHoveredNodeId(node ? node.id ?? null : null);
          if (containerRef.current) {
            containerRef.current.style.cursor = node ? "pointer" : "default";
          }
        }}
        nodeCanvasObject={(
          node: { id?: string; name?: string; nodeType?: string; x?: number; y?: number },
          ctx: CanvasRenderingContext2D,
          globalScale: number
        ) => {
          const label = node.name ?? "";
          const isSelected = node.id === selectedNodeId;
          const isHovered = node.id === hoveredNodeId;
          const isProject = node.nodeType === "project";
          const radius = isProject ? 7 : node.nodeType === "tag" ? 4 : 5.5;
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          const color = hexForType((node.nodeType ?? "note") as GraphNode["type"]);

          // Glow for selected or hovered node
          if (isSelected || isHovered) {
            const glowOpacity = isSelected ? 0.08 : 0.04;
            for (let i = 3; i >= 1; i--) {
              ctx.beginPath();
              ctx.arc(x, y, radius + i * 3, 0, 2 * Math.PI);
              ctx.fillStyle = color + Math.round((glowOpacity / i) * 255).toString(16).padStart(2, "0");
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

          // Smart label density rendering
          let showLabel = false;
          if (isProject || isSelected || isHovered) {
            showLabel = true;
          } else if (labelMode === "all") {
            showLabel = globalScale >= 0.7;
          } else if (labelMode === "smart") {
            showLabel = globalScale >= 1.4;
          }

          if (showLabel) {
            const isHighlight = isSelected || isHovered;
            const screenPx = (isProject ? 11.5 : 10) * fs;
            const fontSize = screenPx / globalScale;
            const maxLen = isProject ? 24 : 18;
            const text = label.length > maxLen ? label.slice(0, maxLen - 1) + "…" : label;

            ctx.font = `${(isProject || isHighlight) ? "600 " : ""}${fontSize}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";

            // Halo outline behind text for premium legibility over links and nodes
            ctx.strokeStyle = resolveCssVar("--background");
            ctx.lineWidth = 4 / globalScale;
            ctx.lineJoin = "round";
            ctx.strokeText(text, x, y + radius + 4 / globalScale);

            // Text fill color
            if (isHighlight && !isProject) {
              ctx.fillStyle = resolveCssVar("--accent");
            } else {
              ctx.fillStyle = resolveCssVar(isProject ? "--text-primary" : "--text-secondary");
            }
            
            ctx.fillText(text, x, y + radius + 4 / globalScale);
          }
        }}
        nodeCanvasObjectMode={() => "replace"}
        cooldownTicks={150}
        d3AlphaDecay={0.03}
        d3VelocityDecay={0.4}
        onEngineStart={() => {
          const fg = fgRef.current;
          if (!fg) return;
    fg.d3Force("charge")?.strength((node: { id?: string; nodeType?: string }) => {
            const degree = nodeDegrees[node.id] ?? 0;
            if (degree === 0) return -15;
            if (degree === 1) return -40 * spacing;
            const isProject = node.nodeType === "project";
            const baseCharge = isProject ? -150 : -100;
            return baseCharge * spacing;
          });
           fg.d3Force("collide", d3.forceCollide().radius((node: { nodeType?: string }) => {
             const isProject = node.nodeType === "project";
            const radius = isProject ? 7 : node.nodeType === "tag" ? 4 : 5.5;
            return (radius + 15) * spacing;
          }).iterations(2));
          fg.d3Force("link")?.distance((link: { edgeType?: string }) => {
            let baseDist = 35;
            if (link.edgeType === "project-member") baseDist = 70;
            if (link.edgeType === "tag-member")     baseDist = 50;
            return baseDist * spacing;
          });
          fg.d3Force("x", d3.forceX(0).strength(0.06 * (spacing >= 1 ? spacing : 1)));
          fg.d3Force("y", d3.forceY(0).strength(0.06 * (spacing >= 1 ? spacing : 1)));
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
