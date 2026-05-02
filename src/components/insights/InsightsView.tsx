"use client";

import React, { useCallback, useState, useMemo, useEffect } from "react";
import {
  Clock, Grid3x3, Table2, Activity, Workflow, Crosshair, BarChart2,
  LayoutGrid, ChevronDown, Search, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { filterGraphNodes } from "@/store/slices/graph";
import type { GraphNode, GraphNodeType } from "@/types";
import { Tooltip } from "@/components/ui/tooltip";

import { TimelineCanvas }  from "@/components/graph/TimelineCanvas";
import { MatrixCanvas }    from "@/components/graph/MatrixCanvas";
import { TableCanvas }     from "@/components/graph/TableCanvas";
import { RidgelineCanvas, RidgelineMode } from "@/components/graph/RidgelineCanvas";
import { SankeyCanvas }    from "@/components/graph/SankeyCanvas";
import { BeeswarmCanvas }  from "@/components/graph/BeeswarmCanvas";
import { BulletCanvas }    from "@/components/graph/BulletCanvas";
import { GraphDetailPanel } from "@/components/graph/GraphDetailPanel";

type InsightsLayout = "timeline" | "matrix" | "table" | "ridgeline" | "sankey" | "beeswarm" | "bullet";

const LAYOUTS: { key: InsightsLayout; icon: React.ReactNode; label: string; tip: string }[] = [
  { key: "ridgeline", icon: <Activity  size={12} />, label: "Ridgeline", tip: "Task activity over time"         },
  { key: "beeswarm",  icon: <Crosshair size={12} />, label: "Beeswarm",  tip: "Task due dates by project"       },
  { key: "bullet",    icon: <BarChart2 size={12} />, label: "Bullet",    tip: "Project health dashboard"        },
  { key: "sankey",    icon: <Workflow  size={12} />, label: "Sankey",    tip: "Task flow through pipeline"      },
  { key: "timeline",  icon: <Clock     size={12} />, label: "Timeline",  tip: "Cards by due date"              },
  { key: "matrix",    icon: <Grid3x3  size={12} />, label: "Matrix",    tip: "Tag co-occurrence heatmap"       },
  { key: "table",     icon: <Table2   size={12} />, label: "Table",     tip: "Flat sortable table"             },
];

const ALL_NODE_TYPES: GraphNodeType[] = ["project", "note", "card", "tag"];

export function InsightsView() {
  const {
    activeWorkspaceId,
    graphData,
    graphLoading,
    graphError,
    graphFilters,
    selectedGraphNodeId,
    projects,
    loadGraph,
    setGraphFilters,
    setSelectedGraphNode,
  } = useCairnStore();

  const [layout,    setLayout]    = useState<InsightsLayout>("ridgeline");
  const [projOpen,  setProjOpen]  = useState(false);
  const [tableSearch,     setTableSearch]     = useState("");
  const [tableTypeFilter, setTableTypeFilter] = useState<GraphNodeType[]>([]);

  // ── Ridgeline state ──────────────────────────────────────────────────────────
  const [ridgeMode, setRidgeMode] = useState<RidgelineMode>("ridgeline");
  const RIDGE_MIN = 6   * 3_600_000;
  const RIDGE_MAX = 730 * 86_400_000;
  const [ridgeDefaultView, setRidgeDefaultView] = useState<{ start: number; end: number } | null>(null);
  const [ridgeView, setRidgeView] = useState<{ start: number; end: number }>(() => {
    const now = Date.now();
    return { start: now - 7 * 86_400_000, end: now + 86_400_000 };
  });
  const ridgeApplyZoom = useCallback((factor: number, pivotMs?: number) => {
    setRidgeView((prev) => {
      const span     = prev.end - prev.start;
      const newSpan  = Math.max(RIDGE_MIN, Math.min(RIDGE_MAX, span * factor));
      const pivot    = pivotMs ?? (prev.start + span / 2);
      const ratio    = (pivot - prev.start) / span;
      const newStart = pivot - ratio * newSpan;
      return { start: newStart, end: newStart + newSpan };
    });
  }, []);
  const handleRidgeDefaultView = useCallback((v: { start: number; end: number }) => {
    setRidgeDefaultView(v);
    setRidgeView(v);
  }, []);
  const ridgeLogMin    = Math.log(RIDGE_MIN);
  const ridgeLogMax    = Math.log(RIDGE_MAX);
  const ridgeSpanMs    = ridgeView.end - ridgeView.start;
  const ridgeSliderVal = (Math.log(ridgeSpanMs) - ridgeLogMin) / (ridgeLogMax - ridgeLogMin);
  function handleRidgeSlider(e: React.ChangeEvent<HTMLInputElement>) {
    const t       = parseFloat(e.target.value);
    const newSpan = Math.exp(ridgeLogMin + t * (ridgeLogMax - ridgeLogMin));
    const center  = ridgeView.start + ridgeSpanMs / 2;
    setRidgeView({ start: center - newSpan / 2, end: center + newSpan / 2 });
  }

  // Load graph on mount + when workspace changes (mirrors KnowledgeGraphView)
  useEffect(() => {
    if (activeWorkspaceId) loadGraph(activeWorkspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  // ── Graph data ───────────────────────────────────────────────────────────────
  const allNodes: GraphNode[] = useMemo(
    () => graphData ? filterGraphNodes(graphData.nodes, graphFilters) : [],
    [graphData, graphFilters]);

  const selectedNode = useMemo(
    () => allNodes.find((n) => n.id === selectedGraphNodeId) ?? null,
    [allNodes, selectedGraphNodeId]);

  function handleNodeClick(node: GraphNode) { setSelectedGraphNode(node.id); }

  const workspaceProjects = projects.filter((p) => !p.archivedAt);

  function toggleProject(pid: string) {
    const current = graphFilters.projectIds;
    const next = current.includes(pid) ? current.filter((x) => x !== pid) : [...current, pid];
    setGraphFilters({ projectIds: next });
    if (activeWorkspaceId) loadGraph(activeWorkspaceId);
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-[var(--background)]">

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0 flex-wrap">

        {/* Layout toggle */}
        <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden">
          {LAYOUTS.map(({ key, icon, label, tip }, idx) => {
            const isActive = layout === key;
            return (
              <React.Fragment key={key}>
                {idx > 0 && <div className="w-px h-5 bg-[var(--border)]" />}
                <Tooltip content={tip}>
                  <button
                    onClick={() => setLayout(key)}
                    className={cn(
                      "flex items-center px-2.5 py-1.5 text-xs transition-colors",
                      isActive
                        ? "gap-1.5 bg-[var(--accent-dim)] text-[var(--accent)]"
                        : "gap-0 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"
                    )}
                  >
                    {icon}
                    <span className={cn("overflow-hidden transition-all duration-200", isActive ? "max-w-16 opacity-100" : "max-w-0 opacity-0")}>
                      {label}
                    </span>
                  </button>
                </Tooltip>
              </React.Fragment>
            );
          })}
        </div>

        {/* Project filter */}
        <div className="relative">
          <button
            onClick={() => setProjOpen((v) => !v)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <LayoutGrid size={12} />
            {graphFilters.projectIds.length === 0
              ? "All projects"
              : `${graphFilters.projectIds.length} project${graphFilters.projectIds.length > 1 ? "s" : ""}`}
            <ChevronDown size={11} />
          </button>
          {projOpen && (
            <div className="absolute top-full left-0 mt-1 w-52 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg z-20 py-1 max-h-64 overflow-y-auto">
              <button
                onClick={() => { setGraphFilters({ projectIds: [] }); setProjOpen(false); if (activeWorkspaceId) loadGraph(activeWorkspaceId); }}
                className={cn("flex items-center w-full px-3 py-1.5 text-xs transition-colors",
                  graphFilters.projectIds.length === 0 ? "text-[var(--accent)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]")}
              >
                All projects
              </button>
              <div className="h-px bg-[var(--border)] my-1" />
              {workspaceProjects.map((p) => (
                <button key={p.id} onClick={() => toggleProject(p.id)}
                  className={cn("flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors",
                    graphFilters.projectIds.includes(p.id)
                      ? "text-[var(--accent)] bg-[var(--accent-dim)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]")}
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0 bg-[var(--accent)]" />
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Table search + type filter */}
        {layout === "table" && (
          <>
            <div className="relative flex items-center">
              <Search size={11} className="absolute left-2.5 text-[var(--text-tertiary)] pointer-events-none" />
              <input
                type="text" value={tableSearch} onChange={(e) => setTableSearch(e.target.value)}
                placeholder="Search…"
                className="pl-7 pr-3 py-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-xs text-[var(--text-primary)] placeholder-[var(--text-tertiary)] outline-none focus:border-[var(--accent)] transition-colors w-40"
              />
            </div>
            <div className="flex items-center gap-1">
              {ALL_NODE_TYPES.map((t) => {
                const isActive = tableTypeFilter.includes(t);
                return (
                  <button key={t}
                    onClick={() => setTableTypeFilter((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])}
                    className={cn("px-2 py-1 rounded text-[0.786rem] capitalize transition-colors border",
                      isActive ? "border-transparent bg-[var(--accent-dim)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-tertiary)] opacity-50")}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
            <div className="w-px h-5 bg-[var(--border)]" />
          </>
        )}

        {/* Ridgeline controls */}
        {layout === "ridgeline" && (
          <>
            <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden">
              {(["ridgeline", "overlay", "iso"] as RidgelineMode[]).map((m, idx) => (
                <React.Fragment key={m}>
                  {idx > 0 && <div className="w-px h-5 bg-[var(--border)]" />}
                  <button onClick={() => setRidgeMode(m)}
                    className={cn("px-2.5 py-1.5 text-xs font-mono transition-colors",
                      ridgeMode === m ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]")}
                  >
                    {m === "ridgeline" ? "ridge" : m === "overlay" ? "flat" : "3d"}
                  </button>
                </React.Fragment>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => ridgeApplyZoom(1 / 1.08)}
                className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors text-sm leading-none">−</button>
              <input type="range" min={0} max={1} step={0.001} value={ridgeSliderVal}
                onChange={handleRidgeSlider}
                className="w-24 h-1 accent-[var(--accent)] cursor-pointer" />
              <button onClick={() => ridgeApplyZoom(1.08)}
                className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors text-sm leading-none">+</button>
            </div>
            <div className="w-px h-5 bg-[var(--border)]" />
          </>
        )}

        {/* Right: item count + reset/refresh */}
        <span className="ml-auto flex items-center gap-2 text-[0.786rem] text-[var(--text-tertiary)]">
          {allNodes.length} items
          <Tooltip content={layout === "ridgeline" ? "Reset view to data range" : "Reload data"}>
            <button
              onClick={layout === "ridgeline"
                ? () => { if (ridgeDefaultView) setRidgeView(ridgeDefaultView); }
                : () => { if (activeWorkspaceId) loadGraph(activeWorkspaceId); }}
              className="flex items-center gap-1 px-1.5 py-1 rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] transition-colors"
            >
              <RefreshCw size={11} className={graphLoading ? "animate-spin" : ""} />
            </button>
          </Tooltip>
        </span>
      </div>

      {/* Canvas + detail panel */}
      <div className="flex flex-1 min-h-0 overflow-hidden" onClick={() => setProjOpen(false)}>
        <div className="flex flex-1 min-w-0 overflow-hidden relative">

          {graphLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--background)]/80 z-10">
              <span className="text-xs text-[var(--text-tertiary)]">Loading…</span>
            </div>
          )}
          {graphError && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xs text-[var(--danger)]">{graphError}</span>
            </div>
          )}

          {layout === "timeline" && (
            <TimelineCanvas nodes={allNodes} selectedNodeId={selectedGraphNodeId} onNodeClick={handleNodeClick} />
          )}
          {layout === "matrix" && (
            <MatrixCanvas nodes={allNodes} selectedNodeId={selectedGraphNodeId} onNodeClick={handleNodeClick} />
          )}
          {layout === "table" && (
            <TableCanvas nodes={allNodes} selectedNodeId={selectedGraphNodeId} onNodeClick={handleNodeClick}
              search={tableSearch} typeFilter={tableTypeFilter} />
          )}
          {layout === "ridgeline" && (
            <RidgelineCanvas nodes={allNodes} selectedNodeId={selectedGraphNodeId} onNodeClick={handleNodeClick}
              mode={ridgeMode} view={ridgeView} onViewChange={setRidgeView}
              applyZoom={ridgeApplyZoom} onDefaultView={handleRidgeDefaultView} />
          )}
          {layout === "sankey" && (
            <SankeyCanvas nodes={allNodes} selectedNodeId={selectedGraphNodeId} onNodeClick={handleNodeClick} />
          )}
          {layout === "beeswarm" && (
            <BeeswarmCanvas nodes={allNodes} selectedNodeId={selectedGraphNodeId} onNodeClick={handleNodeClick} />
          )}
          {layout === "bullet" && (
            <BulletCanvas nodes={allNodes} selectedNodeId={selectedGraphNodeId} onNodeClick={handleNodeClick} />
          )}
        </div>

        {selectedNode && (
          <GraphDetailPanel node={selectedNode} onClose={() => setSelectedGraphNode(null)} />
        )}
      </div>
    </div>
  );
}
