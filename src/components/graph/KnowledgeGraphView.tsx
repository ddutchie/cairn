"use client";

import React, { useEffect, useCallback, useState } from "react";
import {
  GitBranch, Circle, RefreshCw, ChevronDown, LayoutGrid,
  Clock, Grid3x3, Table2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { filterGraphNodes, filterGraphEdges, nodeTypeColor, DEFAULT_GRAPH_FILTERS } from "@/store/slices/graph";
import type { GraphNode, GraphNodeType, GraphEdgeType, GraphLayoutMode } from "@/types";
import { GraphDetailPanel } from "./GraphDetailPanel";
import { ForceGraphCanvas } from "./ForceGraphCanvas";
import { RadialTreeCanvas } from "./RadialTreeCanvas";
import { TimelineCanvas } from "./TimelineCanvas";
import { MatrixCanvas } from "./MatrixCanvas";
import { TableCanvas } from "./TableCanvas";
import { Tooltip } from "@/components/ui/tooltip";

export function KnowledgeGraphView() {
  const {
    activeWorkspaceId,
    graphData,
    graphLoading,
    graphError,
    graphLayout,
    graphFilters,
    selectedGraphNodeId,
    projects,
    loadGraph,
    recomputeGraphRelationships,
    setGraphLayout,
    setGraphFilters,
    setSelectedGraphNode,
  } = useCairnStore();

  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  // Load graph on mount + when workspace changes
  useEffect(() => {
    if (activeWorkspaceId) loadGraph(activeWorkspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  const selectedNode = selectedGraphNodeId
    ? graphData.nodes.find((n) => n.id === selectedGraphNodeId) ?? null
    : null;

  // Apply filters
  const filteredNodes = filterGraphNodes(graphData.nodes, graphFilters);
  const nodeIdSet = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = filterGraphEdges(graphData.edges, graphFilters, nodeIdSet);
  const filteredGraph = { nodes: filteredNodes, edges: filteredEdges };

  const handleNodeClick = useCallback(
    (node: GraphNode) => setSelectedGraphNode(node.id),
    [setSelectedGraphNode]
  );
  const handleBackgroundClick = useCallback(
    () => setSelectedGraphNode(null),
    [setSelectedGraphNode]
  );

  async function handleRecompute() {
    if (!activeWorkspaceId) return;
    setRecomputing(true);
    await recomputeGraphRelationships(activeWorkspaceId);
    setRecomputing(false);
  }

  const ALL_NODE_TYPES: GraphNodeType[] = ["project", "note", "card", "tag"];
  const ALL_EDGE_TYPES: GraphEdgeType[] = [
    "note-note", "note-card", "tag-member", "project-member",
    "flow-ref", "flow-edge", "co-mention", "keyword", "assignee",
  ];

  function toggleNodeType(t: GraphNodeType) {
    const current = graphFilters.nodeTypes;
    const next = current.includes(t) ? current.filter((x) => x !== t) : [...current, t];
    setGraphFilters({ nodeTypes: next.length > 0 ? next : current });
  }

  function toggleEdgeType(t: GraphEdgeType) {
    const current = graphFilters.edgeTypes;
    const next = current.includes(t) ? current.filter((x) => x !== t) : [...current, t];
    setGraphFilters({ edgeTypes: next.length > 0 ? next : current });
  }

  function toggleProject(pid: string) {
    const current = graphFilters.projectIds;
    const next = current.includes(pid) ? current.filter((x) => x !== pid) : [...current, pid];
    setGraphFilters({ projectIds: next });
    if (activeWorkspaceId) loadGraph(activeWorkspaceId);
  }

  const workspaceProjects = projects.filter(
    (p) => !p.archivedAt
  );

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-[var(--background)]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0 flex-wrap">
        {/* Layout toggle */}
        <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden">
          {(
            [
              { key: "force"    as GraphLayoutMode, icon: <Circle size={12} />,   label: "Force",    tip: "Force-directed graph" },
              { key: "radial"   as GraphLayoutMode, icon: <GitBranch size={12} />, label: "Radial",   tip: "Radial hierarchy tree" },
              { key: "timeline" as GraphLayoutMode, icon: <Clock size={12} />,    label: "Timeline", tip: "Cards by due date" },
              { key: "matrix"   as GraphLayoutMode, icon: <Grid3x3 size={12} />,  label: "Matrix",   tip: "Tag co-occurrence heatmap" },
              { key: "table"    as GraphLayoutMode, icon: <Table2 size={12} />,   label: "Table",    tip: "Flat sortable table" },
            ] as { key: GraphLayoutMode; icon: React.ReactNode; label: string; tip: string }[]
          ).map(({ key, icon, label, tip }, idx, arr) => (
            <React.Fragment key={key}>
              {idx > 0 && <div className="w-px h-5 bg-[var(--border)]" />}
              <Tooltip content={tip}>
                <button
                  onClick={() => setGraphLayout(key)}
                  className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition-colors",
                    graphLayout === key
                      ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                      : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"
                  )}
                >
                  {icon}
                  {label}
                </button>
              </Tooltip>
            </React.Fragment>
          ))}
        </div>

        {/* Project filter */}
        <div className="relative">
          <button
            onClick={() => setProjectDropdownOpen((v) => !v)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <LayoutGrid size={12} />
            {graphFilters.projectIds.length === 0
              ? "All projects"
              : `${graphFilters.projectIds.length} project${graphFilters.projectIds.length > 1 ? "s" : ""}`}
            <ChevronDown size={11} />
          </button>
          {projectDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 w-52 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg z-20 py-1 max-h-64 overflow-y-auto">
              <button
                onClick={() => { setGraphFilters({ projectIds: [] }); setProjectDropdownOpen(false); if (activeWorkspaceId) loadGraph(activeWorkspaceId); }}
                className={cn(
                  "flex items-center w-full px-3 py-1.5 text-xs transition-colors",
                  graphFilters.projectIds.length === 0
                    ? "text-[var(--accent)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                )}
              >
                All projects
              </button>
              <div className="h-px bg-[var(--border)] my-1" />
              {workspaceProjects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => toggleProject(p.id)}
                  className={cn(
                    "flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors",
                    graphFilters.projectIds.includes(p.id)
                      ? "text-[var(--accent)] bg-[var(--accent-dim)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                  )}
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0 bg-[var(--accent)]" />
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Node type toggles — only relevant for graph modes */}
        {(graphLayout === "force" || graphLayout === "radial") && <div className="flex items-center gap-1">
          {ALL_NODE_TYPES.map((t) => (
            <Tooltip key={t} content={`Toggle ${t} nodes`}>
              <button
                onClick={() => toggleNodeType(t)}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded text-[11px] capitalize transition-colors border",
                  graphFilters.nodeTypes.includes(t)
                    ? "border-transparent"
                    : "border-[var(--border)] text-[var(--text-tertiary)] opacity-50"
                )}
                style={
                  graphFilters.nodeTypes.includes(t)
                    ? {
                        background: `color-mix(in srgb, ${nodeTypeColor(t)} 12%, transparent)`,
                        color: nodeTypeColor(t),
                        borderColor: `color-mix(in srgb, ${nodeTypeColor(t)} 30%, transparent)`,
                      }
                    : undefined
                }
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: nodeTypeColor(t) }}
                />
                {t}
              </button>
            </Tooltip>
          ))}
        </div>}

        {/* Separator */}
        {(graphLayout === "force" || graphLayout === "radial") && <div className="w-px h-5 bg-[var(--border)]" />}

        {/* Auto-relationship toggle */}
        <Tooltip content="Toggle auto-discovered relationships (co-mention, keyword, assignee)">
          <button
            onClick={() => {
              setGraphFilters({ includeAuto: !graphFilters.includeAuto });
              if (activeWorkspaceId) loadGraph(activeWorkspaceId);
            }}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs transition-colors",
              graphFilters.includeAuto
                ? "border-transparent bg-[var(--accent-dim)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--text-tertiary)]"
            )}
          >
            <GitBranch size={12} />
            Auto-links
          </button>
        </Tooltip>

        {/* Recompute */}
        <Tooltip content="Recompute auto-relationships">
          <button
            onClick={handleRecompute}
            disabled={recomputing}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border)] text-xs text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={recomputing ? "animate-spin" : ""} />
            Refresh
          </button>
        </Tooltip>

        {/* Stats */}
        <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">
          {graphLayout === "force" || graphLayout === "radial"
            ? `${filteredNodes.length} nodes · ${filteredEdges.length} edges`
            : `${filteredNodes.length} items`}
        </span>
      </div>

      {/* Canvas area + detail panel */}
      <div className="flex flex-1 min-h-0 overflow-hidden" onClick={() => setProjectDropdownOpen(false)}>
        {/* Main canvas */}
        <div className="flex flex-1 min-w-0 overflow-hidden relative">
          {graphLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--background)]/80 z-10">
              <span className="text-xs text-[var(--text-tertiary)]">Loading graph…</span>
            </div>
          )}

          {graphError && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xs text-[var(--danger)]">{graphError}</span>
            </div>
          )}

          {!graphLoading && !graphError && filteredNodes.length === 0 && (
            <EmptyState />
          )}

          {!graphError && filteredNodes.length > 0 && graphLayout === "force" && (
            <ForceGraphCanvas
              graph={filteredGraph}
              selectedNodeId={selectedGraphNodeId}
              onNodeClick={handleNodeClick}
              onBackgroundClick={handleBackgroundClick}
            />
          )}

          {!graphError && filteredNodes.length > 0 && graphLayout === "radial" && (
            <RadialTreeCanvas
              graph={filteredGraph}
              selectedNodeId={selectedGraphNodeId}
              onNodeClick={handleNodeClick}
              onBackgroundClick={handleBackgroundClick}
            />
          )}

          {!graphError && graphLayout === "timeline" && (
            <TimelineCanvas
              nodes={filteredNodes}
              selectedNodeId={selectedGraphNodeId}
              onNodeClick={handleNodeClick}
            />
          )}

          {!graphError && graphLayout === "matrix" && (
            <MatrixCanvas
              nodes={filteredNodes}
              selectedNodeId={selectedGraphNodeId}
              onNodeClick={handleNodeClick}
            />
          )}

          {!graphError && graphLayout === "table" && (
            <TableCanvas
              nodes={filteredNodes}
              selectedNodeId={selectedGraphNodeId}
              onNodeClick={handleNodeClick}
            />
          )}

          {/* Node type legend — only shown in graph modes */}
          {filteredNodes.length > 0 && (graphLayout === "force" || graphLayout === "radial") && (
            <div className="absolute bottom-4 left-4 flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--surface)]/90 border border-[var(--border)] backdrop-blur-sm">
              {ALL_NODE_TYPES.filter((t) => graphFilters.nodeTypes.includes(t)).map((t) => (
                <div key={t} className="flex items-center gap-1.5">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ background: nodeTypeColor(t) }}
                  />
                  <span className="text-[11px] capitalize text-[var(--text-tertiary)]">{t}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <GraphDetailPanel
            node={selectedNode}
            onClose={() => setSelectedGraphNode(null)}
          />
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 text-center p-8">
      <div className="w-16 h-16 rounded-full bg-[var(--surface-2)] flex items-center justify-center">
        <GitBranch size={28} className="text-[var(--text-tertiary)]" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">No connections yet</h3>
        <p className="text-xs text-[var(--text-tertiary)] max-w-xs">
          Link notes to tasks, tag your content, or draw connections in the Idea Flow canvas to see them here.
        </p>
      </div>
    </div>
  );
}
