"use client";

import React, { useCallback, useState, useMemo } from "react";
import {
  Clock, Grid3x3, Table2, Activity, Workflow, Crosshair, BarChart2,
  Search, Sparkles, Minus, Plus,
} from "lucide-react";
import { RefreshSpin } from "@/components/ui/spinner";
import { ProjectScopePicker } from "@/components/shared/ProjectScopePicker";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useLoadGraph } from "@/hooks/useLoadGraph";
import { filterGraphNodes, EMPTY_GRAPH } from "@/store/slices/graph";
import type { GraphNode, GraphNodeType } from "@/types";
import { ViewTabs } from "@/components/ui/view-tabs";
import { IconButton } from "@/components/ui/icon-button";
import { SegmentedControl } from "@/components/ui/segmented-control";

import { TimelineCanvas }  from "@/components/graph/TimelineCanvas";
import { MatrixCanvas }    from "@/components/graph/MatrixCanvas";
import { TableCanvas }     from "@/components/graph/TableCanvas";
import { RidgelineCanvas, RidgelineMode } from "@/components/graph/RidgelineCanvas";
import { SankeyCanvas }    from "@/components/graph/SankeyCanvas";
import { BeeswarmCanvas }  from "@/components/graph/BeeswarmCanvas";
import { BulletCanvas }    from "@/components/graph/BulletCanvas";
import { SemanticMapCanvas } from "@/components/graph/SemanticMapCanvas";
import { GraphDetailPanel } from "@/components/graph/GraphDetailPanel";
import { NodeTypeChip } from "@/components/graph/NodeTypeChip";

type InsightsLayout = "timeline" | "matrix" | "table" | "ridgeline" | "sankey" | "beeswarm" | "bullet" | "semantic-map";

const LAYOUTS: { key: InsightsLayout; icon: React.ReactNode; label: string; tip: string }[] = [
  { key: "ridgeline",    icon: <Activity  size={12} />, label: "Ridgeline",    tip: "Task activity over time"         },
  { key: "beeswarm",     icon: <Crosshair size={12} />, label: "Beeswarm",     tip: "Task due dates by project"       },
  { key: "bullet",       icon: <BarChart2 size={12} />, label: "Bullet",       tip: "Project health dashboard"        },
  { key: "sankey",       icon: <Workflow  size={12} />, label: "Sankey",       tip: "Task flow through pipeline"      },
  { key: "timeline",     icon: <Clock     size={12} />, label: "Timeline",     tip: "Cards by due date"               },
  { key: "matrix",       icon: <Grid3x3  size={12} />, label: "Matrix",       tip: "Tag co-occurrence heatmap"       },
  { key: "table",        icon: <Table2   size={12} />, label: "Table",        tip: "Flat sortable table"              },
  { key: "semantic-map", icon: <Sparkles size={12} />, label: "Semantic", tip: "Notes plotted by semantic similarity" },
];

const ALL_NODE_TYPES: GraphNodeType[] = ["project", "note", "card", "tag"];

export function InsightsView() {
  const {
    activeWorkspaceId,
    graphData,
    graphStale,
    graphLoading,
    graphError,
    graphFilters,
    selectedGraphNodeId,
    projects,
    loadGraph,
    setGraphFilters,
    setSelectedGraphNode,
  } = useCairnStore(useShallow((s) => ({
    activeWorkspaceId:   s.activeWorkspaceId,
    // Another workspace's graph (mid-switch) is shown as empty → loading state.
    graphData:           s.graphWorkspaceId === s.activeWorkspaceId ? s.graphData : EMPTY_GRAPH,
    graphStale:          s.graphWorkspaceId !== s.activeWorkspaceId,
    graphLoading:        s.graphLoading,
    graphError:          s.graphError,
    graphFilters:        s.graphFilters,
    selectedGraphNodeId: s.selectedGraphNodeId,
    projects:            s.projects,
    loadGraph:           s.loadGraph,
    setGraphFilters:     s.setGraphFilters,
    setSelectedGraphNode: s.setSelectedGraphNode,
  })));

  const [layout,    setLayout]    = useState<InsightsLayout>("ridgeline");
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
      // RIDGE_MIN / RIDGE_MAX are module-level constants — not reactive
      const newSpan  = Math.max(RIDGE_MIN, Math.min(RIDGE_MAX, span * factor));
      const pivot    = pivotMs ?? (prev.start + span / 2);
      const ratio    = (pivot - prev.start) / span;
      const newStart = pivot - ratio * newSpan;
      return { start: newStart, end: newStart + newSpan };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  useLoadGraph(activeWorkspaceId);

  // ── Graph data ───────────────────────────────────────────────────────────────
  const allNodes: GraphNode[] = useMemo(
    () => graphData ? filterGraphNodes(graphData.nodes, graphFilters) : [],
    [graphData, graphFilters]);

  const selectedNode = useMemo(
    () => allNodes.find((n) => n.id === selectedGraphNodeId) ?? null,
    [allNodes, selectedGraphNodeId]);

  const handleNodeClick = useCallback((node: GraphNode) => setSelectedGraphNode(node.id), [setSelectedGraphNode]);

  const workspaceProjects = useMemo(() => projects.filter((p) => !p.archivedAt), [projects]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-[var(--background)]">

      {/* Canvas tabs — every canvas labelled; count + reload on the right */}
      <ViewTabs
        ariaLabel="Insights canvases"
        tabs={LAYOUTS.map(({ key, icon, label, tip }) => ({ value: key, label, icon, title: tip }))}
        value={layout}
        onChange={setLayout}
      >
        <span className="text-xs text-[var(--text-tertiary)] tabular-nums">{allNodes.length} items</span>
        <IconButton
          size="sm"
          label={layout === "ridgeline" ? "Reset view to data range" : "Reload data"}
          onClick={layout === "ridgeline"
            ? () => { if (ridgeDefaultView) setRidgeView(ridgeDefaultView); }
            : () => { if (activeWorkspaceId) loadGraph(activeWorkspaceId); }}
        >
          <RefreshSpin size={12} spinning={graphLoading} />
        </IconButton>
      </ViewTabs>

      {/* Controls for the current canvas */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0 flex-wrap">

        {/* Project filter */}
        <ProjectScopePicker
          projects={workspaceProjects}
          selectedIds={graphFilters.projectIds}
          onChange={(next) => {
            setGraphFilters({ projectIds: next });
            if (activeWorkspaceId) loadGraph(activeWorkspaceId);
          }}
        />

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
              {ALL_NODE_TYPES.map((t) => (
                <NodeTypeChip
                  key={t}
                  type={t}
                  active={tableTypeFilter.includes(t)}
                  onClick={() => setTableTypeFilter((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])}
                />
              ))}
            </div>
            <div className="w-px h-5 bg-[var(--border)]" />
          </>
        )}

        {/* Ridgeline controls */}
        {layout === "ridgeline" && (
          <>
            <SegmentedControl
              ariaLabel="Ridgeline style"
              value={ridgeMode}
              onChange={setRidgeMode}
              options={[
                { value: "ridgeline", label: "Ridges" },
                { value: "overlay", label: "Overlaid" },
                { value: "iso", label: "3D" },
              ]}
            />
            <div className="flex items-center gap-1">
              <span className="mr-1 text-xs text-[var(--text-tertiary)]">Time range</span>
              <IconButton size="sm" label="Zoom in (shorter range)" onClick={() => ridgeApplyZoom(1 / 1.08)}>
                <Minus size={12} />
              </IconButton>
              <input type="range" min={0} max={1} step={0.001} value={ridgeSliderVal}
                onChange={handleRidgeSlider}
                aria-label="Time range shown"
                className="w-24 h-1 accent-[var(--accent)] cursor-pointer" />
              <IconButton size="sm" label="Zoom out (longer range)" onClick={() => ridgeApplyZoom(1.08)}>
                <Plus size={12} />
              </IconButton>
            </div>
          </>
        )}

      </div>

      {/* Canvas + detail panel */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex flex-1 min-w-0 overflow-hidden relative">

          {/* Blocking overlay only for the first load — later reloads keep the
              current canvases on screen (the toolbar spinner shows progress). */}
          {(graphLoading || graphStale) && !graphError && graphData.nodes.length === 0 && (
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
          {layout === "semantic-map" && (
            <SemanticMapCanvas nodes={allNodes} selectedNodeId={selectedGraphNodeId} onNodeClick={handleNodeClick} />
          )}
        </div>

        {selectedNode && (
          <GraphDetailPanel node={selectedNode} onClose={() => setSelectedGraphNode(null)} />
        )}
      </div>
    </div>
  );
}
