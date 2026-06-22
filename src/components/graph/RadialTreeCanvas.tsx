"use client";

import React, { useRef, useEffect, useCallback, useState } from "react";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import * as d3Hierarchy from "d3-hierarchy";
import * as d3Zoom from "d3-zoom";
import * as d3Selection from "d3-selection";
import type { GraphNode, GraphEdge, KnowledgeGraph } from "@/types";
import { resolveCssVar as resolveVar } from "./analyticsUtils";
import { useFontScale } from "./analyticsHooks";

interface Props {
  graph: KnowledgeGraph;
  selectedNodeId: string | null;
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
  labelMode: "smart" | "all" | "minimal";
  spacing: number;
  semanticThreshold?: number;
}

type HNode = { id: string; title: string; type: string; children?: HNode[] };

function buildHierarchy(graph: KnowledgeGraph) {
  const projects = graph.nodes.filter((n) => n.type === "project");
  const byProject = new Map<string, HNode>();

  for (const p of projects) {
    byProject.set(p.id, { id: p.id, title: p.title, type: "project", children: [] });
  }

  for (const n of graph.nodes) {
    if (n.type !== "note" && n.type !== "card") continue;
    const parent = n.projectId ? byProject.get(n.projectId) : null;
    const child: HNode = { id: n.id, title: n.title, type: n.type };
    if (parent) parent.children!.push(child);
  }

  const tagNodes = graph.nodes.filter((n) => n.type === "tag");
  const tagEdges = graph.edges.filter((e) => e.type === "tag-member");
  for (const tag of tagNodes) {
    const memberIds = new Set(tagEdges.filter((e) => e.target === tag.id).map((e) => e.source));
    const projectsUsingTag = new Set<string>();
    for (const node of graph.nodes) {
      if (memberIds.has(node.id) && node.projectId) projectsUsingTag.add(node.projectId);
    }
    for (const pid of projectsUsingTag) {
      const proj = byProject.get(pid);
      if (proj) proj.children!.push({ id: `${tag.id}:${pid}`, title: tag.title, type: "tag" });
    }
  }

  return {
    id: "__workspace__",
    title: "Workspace",
    type: "workspace",
    children: [...byProject.values()],
  } as HNode;
}

function colorForType(type: string): string {
  switch (type) {
    case "project":   return resolveVar("--accent");
    case "note":      return resolveVar("--info");
    case "card":      return resolveVar("--success");
    case "tag":       return resolveVar("--warning");
    case "workspace": return resolveVar("--text-secondary");
    default:          return resolveVar("--text-tertiary");
  }
}

// Edge colour for cross-edges
function crossEdgeColor(type: string): string {
  switch (type) {
    case "note-note":  return resolveVar("--info");
    case "note-card":  return resolveVar("--success");
    case "flow-edge":  return resolveVar("--accent");
    case "flow-ref":   return resolveVar("--accent");
    case "semantic":   return resolveVar("--accent");
    default:           return resolveVar("--accent");
  }
}

export function RadialTreeCanvas({ graph, selectedNodeId, onNodeClick, onBackgroundClick, labelMode, spacing, semanticThreshold = 1 }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<d3Zoom.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const fs = useFontScale();
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const labelModeRef = useRef(labelMode);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const hoveredNodeIdRef = useRef(hoveredNodeId);

  // Synchronise state values to refs on every render to ensure zoom callback has access
  // without triggering a full Zoom re-initialisation which would reset zoom/pan coordinates.
  useEffect(() => {
    labelModeRef.current = labelMode;
    selectedNodeIdRef.current = selectedNodeId;
    hoveredNodeIdRef.current = hoveredNodeId;
  });

  const renderTree = useCallback(() => {
    const svg = svgRef.current;
    const g = gRef.current;
    if (!svg || !g) return;

    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 600;
    // Scale radial tree radius with spacing (where 1.2 is default)
    const radius = (Math.min(width, height) / 2 - 100) * (spacing / 1.2);

    d3Selection.select(g).selectAll("*").remove();

    const hierarchyData = buildHierarchy(graph);
    const root = d3Hierarchy.hierarchy(hierarchyData);

    const tree = d3Hierarchy.tree<typeof hierarchyData>()
      .size([2 * Math.PI, radius])
      .separation((a, b) => (a.parent === b.parent ? 1 : 2) / a.depth);

    tree(root);

    const gSel = d3Selection.select(g);

    // Build node map for cross-edge lookups
    const treeNodeMap = new Map<string, d3Hierarchy.HierarchyPointNode<typeof hierarchyData>>();
    root.each((d) => {
      const id = (d.data as { id: string }).id;
      const baseId = id.includes(":") ? id.split(":")[0] : id;
      treeNodeMap.set(baseId, d as d3Hierarchy.HierarchyPointNode<typeof hierarchyData>);
    });

    function polar2cart(angle: number, r: number): [number, number] {
      return [r * Math.cos(angle - Math.PI / 2), r * Math.sin(angle - Math.PI / 2)];
    }

    function showEdgeTooltip(event: MouseEvent, edge: GraphEdge) {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const srcName = nodeTitleMap.get(edge.source) ?? edge.source;
      const tgtName = nodeTitleMap.get(edge.target) ?? edge.target;
      const left = edge.sourceSectionTitle ? `${srcName} › ${edge.sourceSectionTitle}` : srcName;
      const right = edge.targetSectionTitle ? `${tgtName} › ${edge.targetSectionTitle}` : tgtName;
      const pct = ((edge.weight ?? 1) * 100).toFixed(0);
      setTooltip({
        x: event.clientX - rect.left + 12,
        y: event.clientY - rect.top + 12,
        text: `${left} ↔ ${right} · ${pct}%`,
      });
    }

    // Cross-edge chords — more visible, coloured by type
    const crossEdges = graph.edges.filter(
      (e) => !["project-member", "tag-member"].includes(e.type)
        && (e.type !== "semantic" || (e.weight ?? 1) >= semanticThreshold)
    );

    // Prioritise semantic and wikilink edges so they render on top
    crossEdges.sort((a, b) => {
      const rank = (t: string) => t === "semantic" ? 0 : t === "wikilink" ? 1 : 2;
      return rank(a.type) - rank(b.type);
    });

    const nodeTitleMap = new Map(graph.nodes.map((n) => [n.id, n.title] as const));

    // Build set of connected node IDs for highlight/dim
    const selId = selectedNodeId;
    const connectedIds = selId ? new Set<string>() : null;
    if (connectedIds && selId) {
      connectedIds.add(selId);
      for (const e of crossEdges) {
        if (e.source === selId) connectedIds.add(e.target);
        if (e.target === selId) connectedIds.add(e.source);
      }
    }

    for (const edge of crossEdges) {
      const sn = treeNodeMap.get(edge.source) as d3Hierarchy.HierarchyPointNode<HNode> | undefined;
      const tn = treeNodeMap.get(edge.target) as d3Hierarchy.HierarchyPointNode<HNode> | undefined;
      if (!sn || !tn) continue;
      const [x1, y1] = polar2cart(sn.x, sn.y);
      const [x2, y2] = polar2cart(tn.x, tn.y);
      const color = crossEdgeColor(edge.type);
      const isConnected = selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId);
      const isSemantic = edge.type === "semantic";
      let opacity = isSemantic ? 0.5 : ["co-mention", "keyword", "assignee"].includes(edge.type) ? 0.1 : 0.2;
      let width = isSemantic ? 1.2 : 0.75;
      if (selectedNodeId) {
        if (isConnected) {
          opacity = 0.85;
          width = 2;
        } else {
          opacity = opacity * 0.12;
        }
      }

      gSel.append("line")
        .attr("x1", x1).attr("y1", y1)
        .attr("x2", x2).attr("y2", y2)
        .attr("stroke", color)
        .attr("stroke-width", width)
        .attr("stroke-opacity", opacity)
        .attr("stroke-dasharray", "3,4")
        .style("cursor", edge.type === "semantic" ? "pointer" : "default")
        .on("click", function(event: MouseEvent) {
          if (edge.type !== "semantic") return;
          event.stopPropagation();
          const found = graph.nodes.find((n) => n.id === edge.target);
          if (found) onNodeClick(found);
        })
        .on("mouseenter", function(event: MouseEvent) {
          if (edge.type !== "semantic") return;
          d3Selection.select(this).attr("stroke-opacity", 1).attr("stroke-width", 3);
          showEdgeTooltip(event, edge);
        })
        .on("mousemove", function(event: MouseEvent) {
          if (edge.type !== "semantic") return;
          showEdgeTooltip(event, edge);
        })
        .on("mouseleave", function() {
          if (edge.type !== "semantic") return;
          d3Selection.select(this).attr("stroke-opacity", opacity).attr("stroke-width", width);
          setTooltip(null);
        });
    }

    // Radial link path
    function radialLinkPath(link: d3Hierarchy.HierarchyPointLink<HNode>): string {
      const s = link.source as d3Hierarchy.HierarchyPointNode<HNode>;
      const t = link.target as d3Hierarchy.HierarchyPointNode<HNode>;
      const [sx, sy] = polar2cart(s.x, s.y);
      const [tx, ty] = polar2cart(t.x, t.y);
      return `M${sx},${sy}C${sx * 0.5},${sy * 0.5} ${tx * 0.5},${ty * 0.5} ${tx},${ty}`;
    }

    // Tree links
    gSel.selectAll(".link")
      .data(root.links())
      .join("path")
      .attr("class", "link")
      .attr("fill", "none")
      .attr("stroke", resolveVar("--border"))
      .attr("stroke-opacity", selectedNodeId ? 0.1 : 0.5)
      .attr("stroke-width", 1)
      .attr("d", (d) => radialLinkPath(d as d3Hierarchy.HierarchyPointLink<HNode>));

    // Nodes
    const nodeGroups = gSel.selectAll(".node")
      .data(root.descendants())
      .join("g")
      .attr("class", "node")
      .attr("transform", (d) => {
        const pd = d as d3Hierarchy.HierarchyPointNode<HNode>;
        const [x, y] = polar2cart(pd.x, pd.y);
        return `translate(${x},${y})`;
      })
      .style("cursor", "pointer")
      .on("click", (event: MouseEvent, d) => {
        event.stopPropagation();
        const nodeId = (d.data as { id: string }).id;
        const baseId = nodeId.includes(":") ? nodeId.split(":")[0] : nodeId;
        const found = graph.nodes.find((n) => n.id === baseId);
        if (found) onNodeClick(found);
      })
      .on("mouseenter", (event: MouseEvent, d) => {
        const nodeId = (d.data as { id: string }).id;
        const baseId = nodeId.includes(":") ? nodeId.split(":")[0] : nodeId;
        setHoveredNodeId(baseId);
        setTooltip(null);
      })
      .on("mouseleave", () => {
        setHoveredNodeId(null);
      });

    // Workspace root: distinctive hollow ring
    nodeGroups.each(function(d) {
      const type = (d.data as { type: string }).type;
      const nodeId = (d.data as { id: string }).id;
      const baseId = nodeId.includes(":") ? nodeId.split(":")[0] : nodeId;
      const isSelected = baseId === selectedNodeId;
      const isDimmed = !!selectedNodeId && !connectedIds?.has(baseId);
      const color = colorForType(type);
      const sel = d3Selection.select(this);

      if (type === "workspace") {
        // Outer ring
        sel.append("circle")
          .attr("r", 14)
          .attr("fill", "none")
          .attr("stroke", color)
          .attr("stroke-width", 2)
          .attr("stroke-opacity", 0.6);
        // Inner fill
        sel.append("circle")
          .attr("r", 8)
          .attr("fill", color)
          .attr("fill-opacity", 0.15);
        // Centre dot
        sel.append("circle")
          .attr("r", 3)
          .attr("fill", color)
          .attr("fill-opacity", 0.7);
      } else {
        const radius = type === "project" ? 7 : type === "tag" ? 3.5 : 4.5;
        const isHovered = baseId === hoveredNodeId;
        // Highlight sibling tag nodes sharing the same baseId
        const isTagSibling = nodeId !== baseId && (baseId === selectedNodeId || baseId === hoveredNodeId);

        // Glow for selected, hovered, or tag siblings
        if (isSelected || isHovered || isTagSibling) {
          const glowOpacity = isSelected ? 0.15 : isTagSibling ? 0.06 : 0.08;
          sel.append("circle")
            .attr("r", radius + 6)
            .attr("fill", color)
            .attr("fill-opacity", glowOpacity);
          sel.append("circle")
            .attr("r", radius + 3)
            .attr("fill", color)
            .attr("fill-opacity", glowOpacity * 1.3);
        }

        sel.append("circle")
          .attr("r", radius)
          .attr("fill", (isSelected || isHovered) ? color : color + (isDimmed ? "30" : "aa"))
          .attr("stroke", (isSelected || isHovered) ? color : "none")
          .attr("stroke-width", (isSelected || isHovered) ? 2 : 0);

        // Larger invisible hit zone for small nodes
        sel.append("circle")
          .attr("r", Math.max(radius, 8))
          .attr("fill", "transparent");
      }
    });

    // Bring hovered/selected nodes to front (painted last = on top)
    // Also highlight sibling tag nodes sharing the same baseId
    nodeGroups.each(function(d) {
      const nodeId = (d.data as { id: string }).id;
      const baseId = nodeId.includes(":") ? nodeId.split(":")[0] : nodeId;
      const isHighlighted = baseId === selectedNodeId || baseId === hoveredNodeId;
      const isTagSibling = nodeId.includes(":") && (
        baseId === selectedNodeId || baseId === hoveredNodeId
      );
      if (isHighlighted || isTagSibling) {
        const el = this as SVGGElement;
        const parent = el.parentNode;
        if (parent) parent.appendChild(el);
      }
    });

    // Labels
    nodeGroups.append("text")
      .attr("dy", "0.31em")
      .attr("x", (d) => {
        const pd = d as d3Hierarchy.HierarchyPointNode<HNode>;
        const type = (d.data as { type: string }).type;
        if (type === "workspace") return 0;
        return pd.x < Math.PI ? 10 : -10;
      })
      .attr("y", (d) => {
        const type = (d.data as { type: string }).type;
        return type === "workspace" ? 22 : 0;
      })
      .attr("text-anchor", (d) => {
        const pd = d as d3Hierarchy.HierarchyPointNode<HNode>;
        const type = (d.data as { type: string }).type;
        if (type === "workspace") return "middle";
        return pd.x < Math.PI ? "start" : "end";
      })
      .style("font-size", (d) => {
        const type = (d.data as { type: string }).type;
        const nodeId = (d.data as { id: string }).id;
        const baseId = nodeId.includes(":") ? nodeId.split(":")[0] : nodeId;
        const isHighlight = baseId === selectedNodeId || baseId === hoveredNodeId;

        if (type === "workspace") return `${11 * fs}px`;
        if (type === "project") return `${10.5 * fs}px`;
        return `${(isHighlight ? 9.5 : 9) * fs}px`;
      })
      .style("font-weight", (d) => {
        const type = (d.data as { type: string }).type;
        const nodeId = (d.data as { id: string }).id;
        const baseId = nodeId.includes(":") ? nodeId.split(":")[0] : nodeId;
        const isHighlight = baseId === selectedNodeId || baseId === hoveredNodeId;

        return (type === "project" || isHighlight) ? "600" : "400";
      })
      .style("fill", (d) => {
        const type = (d.data as { type: string }).type;
        const nodeId = (d.data as { id: string }).id;
        const baseId = nodeId.includes(":") ? nodeId.split(":")[0] : nodeId;
        const isHighlight = baseId === selectedNodeId || baseId === hoveredNodeId;

        if (isHighlight && type !== "project" && type !== "workspace") {
          return resolveVar("--accent");
        }
        return type === "project"
          ? resolveVar("--text-primary")
          : type === "workspace"
          ? resolveVar("--text-secondary")
          : resolveVar("--text-tertiary");
      })
      .style("stroke", resolveVar("--background"))
      .style("stroke-width", "3.5px")
      .style("stroke-linejoin", "round")
      .style("paint-order", "stroke fill")
      .style("font-family", "ui-sans-serif, system-ui, sans-serif")
      .style("pointer-events", "none")
      .style("opacity", (d) => {
        const type = (d.data as { type: string }).type;
        const nodeId = (d.data as { id: string }).id;
        const baseId = nodeId.includes(":") ? nodeId.split(":")[0] : nodeId;
        const isHighlight = baseId === selectedNodeId || baseId === hoveredNodeId;

        if (type === "workspace" || type === "project" || isHighlight) return 1;
        if (labelMode === "minimal") return 0;
        if (labelMode === "smart") {
          const svg = svgRef.current;
          let currentK = 1.0;
          if (svg) {
              try {
                currentK = d3Zoom.zoomTransform(svg).k;
              } catch (_e) {}
            }
            return currentK >= 1.3 ? 1 : 0;
          }
        return 1;
      })
      .text((d) => {
        const title = (d.data as { title: string }).title;
        const type = (d.data as { type: string }).type;
        const nodeId = (d.data as { id: string }).id;
        const baseId = nodeId.includes(":") ? nodeId.split(":")[0] : nodeId;
        const isHighlight = baseId === selectedNodeId || baseId === hoveredNodeId;
        const maxLen = isHighlight ? 60 : type === "project" ? 28 : 22;
        return title.length > maxLen ? title.slice(0, maxLen - 1) + "…" : title;
      });

  }, [graph, selectedNodeId, hoveredNodeId, labelMode, spacing, onNodeClick, fs, semanticThreshold]);

  useEffect(() => { renderTree(); }, [renderTree]);

  useEffect(() => {
    const svg = svgRef.current;
    const g = gRef.current;
    if (!svg || !g) return;

    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 600;

    const zoom = d3Zoom.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 5])
      .on("zoom", (event) => {
        const transform = event.transform;
        d3Selection.select(g).attr("transform", transform);
        // Dynamically adjust label visibility based on zoom scale k at 60 FPS
         d3Selection.select(g).selectAll("text")
           .style("opacity", (d: unknown) => {
             const node = d as d3Hierarchy.HierarchyNode<HNode>;
             if (!node.data) return 1;
             const type = (node.data as { type: string }).type;
             const nodeId = (node.data as { id: string }).id;
             const baseId = nodeId.includes(":") ? nodeId.split(":")[0] : nodeId;
             const isHighlight = baseId === selectedNodeIdRef.current || baseId === hoveredNodeIdRef.current;


            if (type === "workspace" || type === "project" || isHighlight) return 1;
            if (labelModeRef.current === "minimal") return 0;
            if (labelModeRef.current === "smart") {
              return transform.k >= 1.3 ? 1 : 0;
            }
            return 1;
          });
      });

    const svgSel = d3Selection.select(svg);
    svgSel.call(zoom);
    svgSel.call(zoom.transform, d3Zoom.zoomIdentity.translate(width / 2, height / 2));
    svgSel.on("click.bg", () => { onBackgroundClick(); setTooltip(null); });

    zoomRef.current = zoom;

    return () => {
      svgSel.on(".zoom", null);
      svgSel.on("click.bg", null);
    };
  }, [onBackgroundClick]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const ro = new ResizeObserver(() => renderTree());
    ro.observe(svg);
    return () => ro.disconnect();
  }, [renderTree]);

  return (
    <div ref={containerRef} className="flex-1 w-full h-full relative" onMouseLeave={() => setTooltip(null)}>
      <svg ref={svgRef} className="flex-1 w-full h-full" style={{ background: "transparent" }}>
        <g ref={gRef} />
      </svg>
      {tooltip && (
        <div
          className="pointer-events-none absolute z-20 px-3 py-1.5 rounded-md text-xs bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] shadow-lg max-w-[280px] break-words"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-1">
        <button
          onClick={() => zoomRef.current?.scaleBy(d3Selection.select(svgRef.current) as never, 1.4)}
          title="Zoom in"
          className="w-7 h-7 flex items-center justify-center rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors shadow-sm"
        >
          <ZoomIn size={13} />
        </button>
        <button
          onClick={() => zoomRef.current?.scaleBy(d3Selection.select(svgRef.current) as never, 1 / 1.4)}
          title="Zoom out"
          className="w-7 h-7 flex items-center justify-center rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors shadow-sm"
        >
          <ZoomOut size={13} />
        </button>
        <button
          onClick={() => {
            if (!zoomRef.current || !svgRef.current) return;
            const w = svgRef.current.clientWidth || 800;
            const h = svgRef.current.clientHeight || 600;
            d3Selection.select(svgRef.current).call(zoomRef.current.transform, d3Zoom.zoomIdentity.translate(w / 2, h / 2));
          }}
          title="Fit"
          className="w-7 h-7 flex items-center justify-center rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors shadow-sm"
        >
          <Maximize2 size={13} />
        </button>
      </div>
    </div>
  );
}
