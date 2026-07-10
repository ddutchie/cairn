"use client";

import React, { useEffect, useCallback, useState, useMemo, useRef } from "react";
import {
  GitBranch, Circle, RefreshCw, ChevronDown, Search, SlidersHorizontal, Type, Network, Hexagon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useLoadGraph } from "@/hooks/useLoadGraph";
import { filterGraphNodes, filterGraphEdges, nodeTypeColor } from "@/store/slices/graph";
import type { GraphNode, GraphNodeType } from "@/types";
import { GraphDetailPanel } from "./GraphDetailPanel";
import { NodeTypeChip } from "./NodeTypeChip";
import { ForceGraphCanvas } from "./ForceGraphCanvas";
import { RadialTreeCanvas } from "./RadialTreeCanvas";
import { Tooltip } from "@/components/ui/tooltip";
import { ProjectScopePicker } from "@/components/shared/ProjectScopePicker";

const EDGE_LEGEND: Array<{ label: string; color: string; dash: boolean }> = [
  { label: "Linked",   color: "var(--accent)",  dash: false },
  { label: "Wikilink", color: "var(--accent)",  dash: false },
  { label: "Semantic", color: "var(--accent)",  dash: true  },
  { label: "Co-mention", color: "var(--border)", dash: true },
];

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
  } = useCairnStore(useShallow((s) => ({
    activeWorkspaceId:            s.activeWorkspaceId,
    graphData:                    s.graphData,
    graphLoading:                 s.graphLoading,
    graphError:                   s.graphError,
    graphLayout:                  s.graphLayout,
    graphFilters:                 s.graphFilters,
    selectedGraphNodeId:          s.selectedGraphNodeId,
    projects:                     s.projects,
    loadGraph:                    s.loadGraph,
    recomputeGraphRelationships:  s.recomputeGraphRelationships,
    setGraphLayout:               s.setGraphLayout,
    setGraphFilters:              s.setGraphFilters,
    setSelectedGraphNode:         s.setSelectedGraphNode,
  })));

  const [labelDropdownOpen, setLabelDropdownOpen] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeSeconds, setRecomputeSeconds] = useState(0);
  const [graphSearch, setGraphSearch] = useState("");
  const [labelMode, setLabelMode] = useState<"smart" | "all" | "minimal">(() => {
    if (typeof localStorage === "undefined") return "smart";
    return (localStorage.getItem("kg-label-mode") as "smart" | "all" | "minimal") || "smart";
  });
  const [spacing, setSpacing] = useState<number>(() => {
    if (typeof localStorage === "undefined") return 1.2;
    const v = parseFloat(localStorage.getItem("kg-spacing") || "1.2");
    return isFinite(v) ? v : 1.2;
  });
  const [semanticThreshold, setSemanticThreshold] = useState<number>(() => {
    if (typeof localStorage === "undefined") return 1.0;
    const v = parseFloat(localStorage.getItem("kg-semantic-threshold") || "1.0");
    return isFinite(v) ? v : 1.0;
  });
  const [showHulls, setShowHulls] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem("kg-hulls") !== "false";
  });

  // Persist graph prefs to localStorage
  useEffect(() => { localStorage.setItem("kg-label-mode", labelMode); }, [labelMode]);
  useEffect(() => { localStorage.setItem("kg-spacing", String(spacing)); }, [spacing]);
  useEffect(() => { localStorage.setItem("kg-semantic-threshold", String(semanticThreshold)); }, [semanticThreshold]);
  useEffect(() => { localStorage.setItem("kg-hulls", String(showHulls)); }, [showHulls]);

  // ⌘F / Ctrl+F — focus the graph search input
  const graphSearchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "f") {
        if (graphLayout !== "force" && graphLayout !== "radial") return;
        e.preventDefault();
        graphSearchRef.current?.focus();
        graphSearchRef.current?.select();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [graphLayout]);

  // Load graph on mount + when workspace changes
  useLoadGraph(activeWorkspaceId);

  // Clear graph search when leaving force/radial
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (graphLayout !== "force" && graphLayout !== "radial") setGraphSearch("");
  }, [graphLayout]);

  const selectedNode = selectedGraphNodeId
    ? graphData.nodes.find((n) => n.id === selectedGraphNodeId) ?? null
    : null;

  // Memoised — only recomputes when the raw graph data or filters change,
  // not when selectedGraphNodeId or other unrelated store state changes.
  const filteredGraph = useMemo(() => {
    const nodes = filterGraphNodes(graphData.nodes, graphFilters);
    const nodeIdSet = new Set(nodes.map((n) => n.id));
    const edges = filterGraphEdges(graphData.edges, graphFilters, nodeIdSet);
    return { nodes, edges };
  }, [graphData.nodes, graphData.edges, graphFilters]);

  // For force/radial: further filter by search query
  const searchedGraph = useMemo(() => {
    const q = graphSearch.trim().toLowerCase();
    if (!q || (graphLayout !== "force" && graphLayout !== "radial")) return filteredGraph;

    // Build a map of tag-member edges so we can find nodes by tag name
    const tagNameMap = new Map<string, string>();
    for (const n of graphData.nodes) {
      if (n.type === "tag") tagNameMap.set(n.id, n.title.toLowerCase());
    }
    // Pre-compute node → tag IDs map to avoid O(nodes × edges) scan
    const nodeTagIds = new Map<string, string[]>();
    for (const e of graphData.edges) {
      if (e.type !== "tag-member") continue;
      const arr = nodeTagIds.get(e.source);
      if (arr) arr.push(e.target);
      else nodeTagIds.set(e.source, [e.target]);
    }

    // First pass: nodes whose title, snippet, or tag name matches
    const matchingIds = new Set(
      filteredGraph.nodes
        .filter((n) => {
          if (n.title.toLowerCase().includes(q)) return true;
          if (n.meta?.snippet && n.meta.snippet.toLowerCase().includes(q)) return true;
          // Check if any tag attached to this node matches
          const tagIds = nodeTagIds.get(n.id) ?? [];
          if (tagIds.some((tid) => tagNameMap.get(tid)?.includes(q))) return true;
          return false;
        })
        .map((n) => n.id)
    );

    // Also match tag nodes themselves by name
    for (const n of filteredGraph.nodes) {
      if (n.type === "tag" && n.title.toLowerCase().includes(q)) {
        matchingIds.add(n.id);
      }
    }

    // Second pass: also include parent projects of any matching node,
    // so radial hierarchy builder always has a bucket for matched children,
    // and force graph keeps clusters anchored.
    const projectIdsToKeep = new Set<string>();
    for (const n of filteredGraph.nodes) {
      if (matchingIds.has(n.id) && n.projectId) {
        projectIdsToKeep.add(n.projectId);
      }
    }

    const nodes = filteredGraph.nodes.filter(
      (n) => matchingIds.has(n.id) || (n.type === "project" && projectIdsToKeep.has(n.id))
    );
    const nodeIdSet = new Set(nodes.map((n) => n.id));
    const edges = filteredGraph.edges.filter(
      (e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target)
    );
    return { nodes, edges };
  }, [filteredGraph, graphSearch, graphLayout, graphData.nodes, graphData.edges]);

  const filteredNodes = searchedGraph.nodes;
  const filteredEdges = searchedGraph.edges;

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
    setRecomputeSeconds(0);
    const timer = setInterval(() => setRecomputeSeconds((s) => s + 1), 1000);
    try {
      await recomputeGraphRelationships(activeWorkspaceId);
    } finally {
      clearInterval(timer);
      setRecomputing(false);
    }
  }

  const ALL_NODE_TYPES: GraphNodeType[] = ["project", "note", "card", "tag"];

  function toggleNodeType(t: GraphNodeType) {
    const current = graphFilters.nodeTypes;
    const next = current.includes(t) ? current.filter((x) => x !== t) : [...current, t];
    setGraphFilters({ nodeTypes: next.length > 0 ? next : current });
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
              { key: "force"  as const, icon: <Circle size={12} />,    label: "Force",  tip: "Force-directed graph" },
              { key: "radial" as const, icon: <GitBranch size={12} />, label: "Radial", tip: "Radial hierarchy tree"  },
            ] as { key: "force" | "radial"; icon: React.ReactNode; label: string; tip: string }[]
          ).map(({ key, icon, label, tip }, idx) => {
            const isActive = graphLayout === key;
            return (
              <React.Fragment key={key}>
                {idx > 0 && <div className="w-px h-5 bg-[var(--border)]" />}
                <Tooltip content={tip}>
                  <button
                    onClick={() => setGraphLayout(key as "force" | "radial")}
                  className={cn(
                    "flex items-center px-2.5 py-1.5 text-xs transition-colors",
                    isActive
                      ? "gap-1.5 bg-[var(--accent-dim)] text-[var(--accent)]"
                      : "gap-0 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"
                  )}
                  >
                    {icon}
                    <span
                      className={cn(
                        "overflow-hidden transition-all duration-200",
                        isActive ? "max-w-16 opacity-100" : "max-w-0 opacity-0"
                      )}
                    >
                      {label}
                    </span>
                  </button>
                </Tooltip>
              </React.Fragment>
            );
          })}
        </div>

        {/* Project filter */}
        <ProjectScopePicker
          projects={workspaceProjects}
          selectedIds={graphFilters.projectIds}
          onChange={(next) => {
            setGraphFilters({ projectIds: next });
            if (activeWorkspaceId) loadGraph(activeWorkspaceId);
          }}
        />

        {/* Label Mode dropdown — force only (sunburst drills in, no label modes) */}
        {graphLayout === "force" && (
          <div className="relative">
            <button
              onClick={() => { setLabelDropdownOpen((v) => !v); }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
            >
              <Type size={12} />
              <span className="capitalize">{labelMode} labels</span>
              <ChevronDown size={11} />
            </button>
            {labelDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 w-40 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg z-20 py-1">
                {(["smart", "all", "minimal"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => {
                      setLabelMode(mode);
                      setLabelDropdownOpen(false);
                    }}
                    className={cn(
                      "flex items-center justify-between w-full px-3 py-1.5 text-xs transition-colors capitalize",
                      labelMode === mode
                        ? "text-[var(--accent)] bg-[var(--accent-dim)] font-medium"
                        : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                    )}
                  >
                    <span>{mode}</span>
                    {labelMode === mode && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Spacing / Breathing room slider */}
        {(graphLayout === "force" || graphLayout === "radial") && (
          <div className="flex items-center gap-2 px-2.5 py-1 rounded-md border border-[var(--border)] bg-[var(--surface)]">
            <Tooltip content="Adjust graph spacing / breathing room">
              <div className="flex items-center gap-1.5 text-[var(--text-secondary)] cursor-help">
                <SlidersHorizontal size={11} className="text-[var(--text-tertiary)]" />
                <span className="text-[0.714rem] select-none font-medium whitespace-nowrap">Spacing</span>
              </div>
            </Tooltip>
            <input
              type="range"
              min="0.8"
              max="2.0"
              step="0.1"
              value={spacing}
              onChange={(e) => setSpacing(parseFloat(e.target.value))}
              className="w-16 h-1 rounded bg-[var(--border)] appearance-none cursor-pointer accent-[var(--accent)] focus:outline-none"
              style={{
                accentColor: "var(--accent)"
              }}
            />
            <span className="text-[0.643rem] text-[var(--text-tertiary)] min-w-[24px] text-right font-mono">
              {spacing.toFixed(1)}x
            </span>
          </div>
        )}

        {/* Semantic similarity threshold slider — force only (no cross-edges in sunburst) */}
        {graphLayout === "force" && (
          <div className="flex items-center gap-2 px-2.5 py-1 rounded-md border border-[var(--border)] bg-[var(--surface)]">
            <Tooltip content="Reveal semantic edges by similarity. 0 = all edges; 1.0 = hide (hard links only).">
              <div className="flex items-center gap-1.5 text-[var(--text-secondary)] cursor-help">
                <Network size={11} className="text-[var(--text-tertiary)]" />
                <span className="text-[0.714rem] select-none font-medium whitespace-nowrap">Semantic</span>
              </div>
            </Tooltip>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={semanticThreshold}
              onChange={(e) => setSemanticThreshold(parseFloat(e.target.value))}
              className="w-16 h-1 rounded bg-[var(--border)] appearance-none cursor-pointer"
              style={{ accentColor: "var(--accent)" }}
            />
            <span className="text-[0.643rem] text-[var(--text-tertiary)] min-w-[28px] text-right font-mono">
              {semanticThreshold >= 1 ? "off" : `≥${semanticThreshold.toFixed(2)}`}
            </span>
          </div>
        )}

        {/* Cluster hulls toggle — force mode only */}
        {graphLayout === "force" && (
          <Tooltip content="Outline each project's cluster with a hull">
            <button
              onClick={() => setShowHulls((v) => !v)}
              aria-pressed={showHulls}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs transition-colors",
                showHulls
                  ? "border-transparent bg-[var(--accent-dim)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-tertiary)]"
              )}
            >
              <Hexagon size={12} />
              Hulls
            </button>
          </Tooltip>
        )}

        {/* Search + type toggles — shown for force and radial */}
        {(graphLayout === "force" || graphLayout === "radial") && (
          <>
            {/* Search input */}
            <div className="relative flex items-center">
              <Search size={11} className="absolute left-2.5 text-[var(--text-tertiary)] pointer-events-none" />
              <input
                ref={graphSearchRef}
                type="text"
                value={graphSearch}
                onChange={(e) => setGraphSearch(e.target.value)}
                placeholder="Search…"
                className="pl-7 pr-3 py-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-xs text-[var(--text-primary)] placeholder-[var(--text-tertiary)] outline-none focus:border-[var(--accent)] transition-colors w-40"
              />
            </div>

            {/* Type toggles */}
            <div className="flex items-center gap-1">
              {ALL_NODE_TYPES.map((t) => (
                <NodeTypeChip
                  key={t}
                  type={t}
                  active={graphFilters.nodeTypes.includes(t)}
                  onClick={() => toggleNodeType(t)}
                  tooltip={`Toggle ${t}`}
                  dotSize={8}
                />
              ))}
            </div>

            <div className="w-px h-5 bg-[var(--border)]" />
          </>
        )}

        {/* Auto-relationship toggle — force only (sunburst shows hierarchy, not cross-edges) */}
        {graphLayout === "force" && (
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
        )}

        {/* Stats + Recompute — pinned to right */}
        <span className="ml-auto flex items-center gap-2 text-[0.786rem] text-[var(--text-tertiary)]">
          {`${filteredNodes.length} nodes · ${filteredEdges.filter((e) => e.type !== "semantic" || (e.weight ?? 1) >= semanticThreshold).length} edges`}
          <Tooltip content={recomputing ? `Recomputing… (${recomputeSeconds}s)` : "Recompute auto-relationships"}>
            <button
              onClick={handleRecompute}
              disabled={recomputing}
              className="flex items-center gap-1 px-1.5 py-1 rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} className={recomputing ? "animate-spin" : ""} />
              {recomputing && <span className="text-[0.714rem] tabular-nums">{recomputeSeconds}s</span>}
            </button>
          </Tooltip>
        </span>
      </div>

      {/* Canvas area + detail panel */}
      <div className="flex flex-1 min-h-0 overflow-hidden" onClick={() => { setLabelDropdownOpen(false); }}>
        {/* Main canvas */}
        <div className="flex flex-1 min-w-0 overflow-hidden relative">
          {graphLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--background)]/80 z-10">
              <span className="text-xs text-[var(--text-tertiary)]">Loading graph…</span>
            </div>
          )}

          {graphError && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--background)]/80 z-10">
              <div className="px-4 py-3 rounded-lg bg-[var(--surface)] border border-[var(--border)] shadow-lg">
                <span className="text-xs text-[var(--danger)]">{graphError}</span>
              </div>
            </div>
          )}

          {!graphLoading && !graphError && filteredNodes.length === 0 && (
            graphData.nodes.length === 0
              ? <EmptyState />
              : <FilteredEmptyState />
          )}

          {!graphError && filteredNodes.length > 0 && graphLayout === "force" && (
            <ForceGraphCanvas
              graph={searchedGraph}
              selectedNodeId={selectedGraphNodeId}
              onNodeClick={handleNodeClick}
              onBackgroundClick={handleBackgroundClick}
              labelMode={labelMode}
              spacing={spacing}
              semanticThreshold={semanticThreshold}
              showHulls={showHulls}
            />
          )}

          {!graphError && filteredNodes.length > 0 && graphLayout === "radial" && (
            <RadialTreeCanvas
              graph={searchedGraph}
              selectedNodeId={selectedGraphNodeId}
              onNodeClick={handleNodeClick}
              onBackgroundClick={handleBackgroundClick}
              labelMode={labelMode}
              spacing={spacing}
              semanticThreshold={semanticThreshold}
            />
          )}


          {/* Node type legend — only shown in graph modes */}
          {filteredNodes.length > 0 && (graphLayout === "force" || graphLayout === "radial") && (
            <div className="absolute bottom-4 left-4 flex flex-col gap-2">
              <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--surface)]/90 border border-[var(--border)] backdrop-blur-sm">
                {ALL_NODE_TYPES.filter((t) => graphFilters.nodeTypes.includes(t)).map((t) => (
                  <div key={t} className="flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ background: nodeTypeColor(t) }}
                    />
                    <span className="text-[0.786rem] capitalize text-[var(--text-tertiary)]">{t}</span>
                  </div>
                ))}
              </div>
              {/* Edge type legend — force only (sunburst has no cross-edges) */}
              {graphLayout === "force" && (
                <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-[var(--surface)]/90 border border-[var(--border)] backdrop-blur-sm">
                  {EDGE_LEGEND.map(({ label, color, dash }) => (
                    <div key={label} className="flex items-center gap-1.5">
                      {dash ? (
                        <svg width="16" height="4" className="flex-shrink-0">
                          <line x1="0" y1="2" x2="16" y2="2" stroke={color} strokeWidth="1.5" strokeDasharray="2,2" />
                        </svg>
                      ) : (
                        <svg width="16" height="4" className="flex-shrink-0">
                          <line x1="0" y1="2" x2="16" y2="2" stroke={color} strokeWidth="1.5" />
                        </svg>
                      )}
                      <span className="text-[0.786rem] text-[var(--text-tertiary)]">{label}</span>
                    </div>
                  ))}
                </div>
              )}
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

function FilteredEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 text-center p-8">
      <div className="w-16 h-16 rounded-full bg-[var(--surface-2)] flex items-center justify-center">
        <Search size={28} className="text-[var(--text-tertiary)]" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">No nodes match your filters</h3>
        <p className="text-xs text-[var(--text-tertiary)] max-w-xs">
          Try adjusting your search query, project filter, or node type toggles.
        </p>
      </div>
    </div>
  );
}
