"use client";

import React, { useRef, useEffect, useCallback } from "react";
import * as d3Hierarchy from "d3-hierarchy";
import * as d3Zoom from "d3-zoom";
import * as d3Selection from "d3-selection";
import type { GraphNode, KnowledgeGraph } from "@/types";
import { resolveCssVar as resolveVar } from "./graphUtils";

interface Props {
  graph: KnowledgeGraph;
  selectedNodeId: string | null;
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
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
    default:           return resolveVar("--accent");
  }
}

export function RadialTreeCanvas({ graph, selectedNodeId, onNodeClick, onBackgroundClick }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);

  const renderTree = useCallback(() => {
    const svg = svgRef.current;
    const g = gRef.current;
    if (!svg || !g) return;

    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 600;
    const radius = Math.min(width, height) / 2 - 100;

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

    // Cross-edge chords — more visible, coloured by type
    const crossEdges = graph.edges.filter(
      (e) => !["project-member", "tag-member"].includes(e.type)
    );
    for (const edge of crossEdges.slice(0, 120)) {
      const sn = treeNodeMap.get(edge.source) as d3Hierarchy.HierarchyPointNode<HNode> | undefined;
      const tn = treeNodeMap.get(edge.target) as d3Hierarchy.HierarchyPointNode<HNode> | undefined;
      if (!sn || !tn) continue;
      const [x1, y1] = polar2cart(sn.x, sn.y);
      const [x2, y2] = polar2cart(tn.x, tn.y);
      const color = crossEdgeColor(edge.type);
      const isAuto = ["co-mention", "keyword", "assignee"].includes(edge.type);

      gSel.append("line")
        .attr("x1", x1).attr("y1", y1)
        .attr("x2", x2).attr("y2", y2)
        .attr("stroke", color)
        .attr("stroke-width", 0.75)
        .attr("stroke-opacity", isAuto ? 0.1 : 0.2)
        .attr("stroke-dasharray", "3,4");
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
      .attr("stroke-opacity", 0.5)
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
      });

    // Workspace root: distinctive hollow ring
    nodeGroups.each(function(d) {
      const type = (d.data as { type: string }).type;
      const nodeId = (d.data as { id: string }).id;
      const baseId = nodeId.includes(":") ? nodeId.split(":")[0] : nodeId;
      const isSelected = baseId === selectedNodeId;
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

        // Glow for selected
        if (isSelected) {
          sel.append("circle")
            .attr("r", radius + 6)
            .attr("fill", color)
            .attr("fill-opacity", 0.15);
          sel.append("circle")
            .attr("r", radius + 3)
            .attr("fill", color)
            .attr("fill-opacity", 0.2);
        }

        sel.append("circle")
          .attr("r", radius)
          .attr("fill", isSelected ? color : color + "aa")
          .attr("stroke", isSelected ? color : "none")
          .attr("stroke-width", isSelected ? 2 : 0);

        // Larger invisible hit zone for small nodes
        sel.append("circle")
          .attr("r", Math.max(radius, 8))
          .attr("fill", "transparent");
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
        return type === "workspace" ? "11px" : type === "project" ? "10.5px" : "9px";
      })
      .style("font-weight", (d) => {
        const type = (d.data as { type: string }).type;
        return type === "project" ? "600" : "400";
      })
      .style("fill", (d) => {
        const type = (d.data as { type: string }).type;
        return type === "project"
          ? resolveVar("--text-primary")
          : type === "workspace"
          ? resolveVar("--text-secondary")
          : resolveVar("--text-tertiary");
      })
      .style("font-family", "ui-sans-serif, system-ui, sans-serif")
      .style("pointer-events", "none")
      .text((d) => {
        const title = (d.data as { title: string }).title;
        const type = (d.data as { type: string }).type;
        const maxLen = type === "project" ? 28 : 22;
        return title.length > maxLen ? title.slice(0, maxLen - 1) + "…" : title;
      });

  }, [graph, selectedNodeId, onNodeClick]);

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
        d3Selection.select(g).attr("transform", event.transform);
      });

    const svgSel = d3Selection.select(svg);
    svgSel.call(zoom);
    svgSel.call(zoom.transform, d3Zoom.zoomIdentity.translate(width / 2, height / 2));
    svgSel.on("click.bg", onBackgroundClick);

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
    <svg ref={svgRef} className="flex-1 w-full h-full" style={{ background: "transparent" }}>
      <g ref={gRef} />
    </svg>
  );
}
