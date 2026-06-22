"use client";

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import { RefreshCw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GraphNode } from "@/types";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { truncateName } from "./analyticsUtils";
import { useContainerDims, useScopedData, useFontScale, useRelativePointer } from "./analyticsHooks";
import { CanvasTooltip } from "./AnalyticsShared";

interface Props {
  nodes: GraphNode[];
  onNodeClick: (node: GraphNode) => void;
  selectedNodeId: string | null;
}

interface ProjectionRow {
  noteId: string;
  dimX: number;
  dimY: number;
  projStale: number;
  embeddedAt: string;
  model: string;
}

const PAD = { top: 24, right: 24, bottom: 24, left: 24 };
const DOT_R = 4;
const HOVER_R = 6;

// Project colour palette via CSS variable cycle (uses --accent variants)
const PROJECT_COLORS = [
  "var(--accent)",
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "var(--danger)",
  "var(--text-secondary)",
];

interface PlottedNote {
  id: string;
  title: string;
  projectId: string | undefined;
  projectName: string;
  color: string;
  x: number;
  y: number;
  model: string;
  embeddedAt: string;
}

export function SemanticMapCanvas({ nodes, onNodeClick, selectedNodeId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fs = useFontScale();
  const dims = useContainerDims(containerRef);
  const relativePointer = useRelativePointer(containerRef);
  const { activeProjects } = useScopedData(nodes);
  const { notes, activeWorkspaceId } = useCairnStore(useShallow((s) => ({
    notes: s.notes,
    activeWorkspaceId: s.activeWorkspaceId,
  })));

  const [projections, setProjections] = useState<ProjectionRow[]>([]);
  const [anyStale, setAnyStale] = useState(false);
  const [projectionModel, setProjectionModel] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeProgress, setRecomputeProgress] = useState<{ done: number; total: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; note: PlottedNote } | null>(null);
  const [dragging, setDragging] = useState(false);
  const isDragging = useRef(false);
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  // Filter activeProjects to those in the current scope (nodes are already filtered).
  const scopedProjectList = useMemo(() => {
    const ids = new Set(nodes.filter((n) => n.type === "project").map((n) => n.id));
    return activeProjects.filter((p) => ids.has(p.id));
  }, [nodes, activeProjects]);

  const projectColorMap = useMemo(() => {
    const m = new Map<string, string>();
    scopedProjectList.forEach((p, i) => {
      m.set(p.id, PROJECT_COLORS[i % PROJECT_COLORS.length]);
    });
    return m;
  }, [scopedProjectList]);

  // Reload projections whenever scope or workspace changes
  const reloadProjections = useCallback(async () => {
    if (!activeWorkspaceId) return;
    const e = window.electron?.embeddings;
    if (!e?.projections) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await e.projections(activeWorkspaceId);
      setProjections(result.rows);
      setAnyStale(result.anyStale);
      setProjectionModel(result.model);
    } catch {
      setProjections([]);
      setAnyStale(false);
    } finally {
      setLoading(false);
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reloadProjections();
  }, [reloadProjections]);

  // Subscribe to recompute progress broadcasts
  useEffect(() => {
    const off = window.electron?.runtime?.embeddings?.onProgress((ev) => {
      if (ev.modelId || ev.status === "downloading") return;
      if (ev.status === "progress" && typeof ev.loaded === "number" && typeof ev.total === "number") {
        setRecomputeProgress({ done: ev.loaded, total: ev.total });
      } else if (ev.status === "done" || ev.status === "installed") {
        setRecomputeProgress(null);
        void reloadProjections();
      } else if (ev.status === "duplicate") {
        // already in progress — ignore
      } else if (ev.status === "error") {
        setRecomputeProgress(null);
      }
    });
    return () => { off?.(); };
  }, [reloadProjections]);

  // Build the plotted-note array by joining projections with note metadata.
  // Also apply the project scope filter from `nodes`.
  const plotted: PlottedNote[] = useMemo(() => {
    if (projections.length === 0) return [];
    const scopedNoteIds = new Set(nodes.filter((n) => n.type === "note").map((n) => n.id));
    const scopedProjectIds = new Set(nodes.filter((n) => n.type === "project").map((n) => n.id));
    const out: PlottedNote[] = [];
    for (const p of projections) {
      if (scopedNoteIds.size > 0 && !scopedNoteIds.has(p.noteId)) continue;
      const note = notes.find((n) => n.id === p.noteId && !n.archivedAt);
      if (!note) continue;
      if (scopedProjectIds.size > 0 && !scopedProjectIds.has(note.projectId)) continue;
      const project = scopedProjectList.find((pr) => pr.id === note.projectId);
      out.push({
        id: p.noteId,
        title: truncateName(note.title, 28),
        projectId: note.projectId,
        projectName: project?.name ?? "",
        color: projectColorMap.get(note.projectId ?? "") ?? "var(--text-tertiary)",
        x: p.dimX,
        y: p.dimY,
        model: p.model,
        embeddedAt: p.embeddedAt,
      });
    }
    return out;
  }, [projections, notes, nodes, scopedProjectList, projectColorMap]);

  // X/Y scales — domain from data, range from container. Zoom/pan applied via SVG transform.
  const xScale = useMemo(() => {
    if (plotted.length === 0) return d3.scaleLinear().domain([-1, 1]).range([PAD.left, dims.width - PAD.right]);
    const xs = plotted.map((p) => p.x);
    const [min, max] = d3.extent(xs) as [number, number];
    const span = Math.max(max - min, 1e-6);
    const pad = span * 0.08;
    return d3.scaleLinear().domain([min - pad, max + pad]).range([PAD.left, dims.width - PAD.right]);
  }, [plotted, dims.width]);

  const yScale = useMemo(() => {
    if (plotted.length === 0) return d3.scaleLinear().domain([-1, 1]).range([PAD.top, dims.height - PAD.bottom]);
    const ys = plotted.map((p) => p.y);
    const [min, max] = d3.extent(ys) as [number, number];
    const span = Math.max(max - min, 1e-6);
    const pad = span * 0.08;
    return d3.scaleLinear().domain([min - pad, max + pad]).range([PAD.top, dims.height - PAD.bottom]);
  }, [plotted, dims.height]);

  // Panning via drag
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    isDragging.current = true;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, [pan]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current || !dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    isDragging.current = false;
    setDragging(false);
    dragStart.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom((z) => Math.max(0.3, Math.min(5, z * delta)));
  }, []);

  function handleRecompute() {
    const e = window.electron?.embeddings;
    if (!e?.recomputeProjections || !activeWorkspaceId) return;
    setRecomputing(true);
    setRecomputeProgress({ done: 0, total: 0 });
    e.recomputeProjections(activeWorkspaceId)
      .then(() => reloadProjections())
      .catch(() => { /* error shown via progress event */ })
      .finally(() => {
        setRecomputing(false);
        setRecomputeProgress(null);
      });
  }

  // ── Empty states ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div ref={containerRef} className="flex-1 relative overflow-hidden flex items-center justify-center">
        <span className="text-xs text-[var(--text-tertiary)]">Loading projections…</span>
      </div>
    );
  }

  if (plotted.length === 0) {
    return (
      <div ref={containerRef} className="flex-1 relative overflow-hidden flex items-center justify-center bg-[var(--background)]">
        <div className="text-center max-w-sm px-6">
          <Sparkles className="w-8 h-8 text-[var(--accent)] mx-auto mb-3 opacity-60" />
          <p className="text-sm font-medium text-[var(--text-secondary)] mb-1">
            {projections.length === 0 ? "No semantic projections yet" : "No notes in this scope"}
          </p>
          <p className="text-xs text-[var(--text-tertiary)] leading-relaxed mb-4">
            {projections.length === 0
              ? anyStale
                ? "Existing embeddings need to be projected to 2D. This runs UMAP locally — no model downloads, no network calls."
                : "Enable embeddings in Settings, index your notes, then compute UMAP projections to see them plotted by semantic similarity."
              : "Try widening the project filter or reindexing notes for the selected projects."}
          </p>
          {projections.length === 0 && (anyStale || activeWorkspaceId) && (
            <button
              type="button"
              onClick={handleRecompute}
              disabled={recomputing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--surface)] text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              <RefreshCw size={12} className={cn(recomputing && "animate-spin")} />
              {anyStale ? "Recompute projections" : "Compute projections"}
            </button>
          )}
          {recomputeProgress && (
            <div className="mt-4 space-y-1 text-left">
              <div className="flex justify-between text-[0.65rem] text-[var(--text-tertiary)]">
                <span>Running UMAP…</span>
                <span className="font-mono">
                  {recomputeProgress.done}/{recomputeProgress.total}
                  {recomputeProgress.total > 0
                    ? ` · ${Math.round((recomputeProgress.done / recomputeProgress.total) * 100)}%`
                    : ""}
                </span>
              </div>
              <div className="w-full h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--accent)] rounded-full transition-all duration-300"
                  style={{
                    width: `${recomputeProgress.total > 0
                      ? Math.round((recomputeProgress.done / recomputeProgress.total) * 100)
                      : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const lineColor = "var(--text-primary)";

  return (
    <div
      ref={containerRef}
      className="flex-1 relative overflow-hidden select-none"
      style={{ cursor: dragging ? "grabbing" : "grab" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onWheel={handleWheel}
    >
      <svg width={dims.width} height={dims.height} style={{ display: "block" }}>
        <defs>
          <radialGradient id="sem-gradient-bg" cx="50%" cy="50%" r="70%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.04} />
            <stop offset="100%" stopColor="var(--background)" stopOpacity={0} />
          </radialGradient>
        </defs>
        <rect x={0} y={0} width={dims.width} height={dims.height} fill="url(#sem-gradient-bg)" />

        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {/* Axes hints */}
          <line
            x1={xScale.range()[0]} y1={yScale(0)} x2={xScale.range()[1]} y2={yScale(0)}
            stroke={lineColor} strokeOpacity={0.06} strokeWidth={1}
          />
          <line
            x1={xScale(0)} y1={yScale.range()[0]} x2={xScale(0)} y2={yScale.range()[1]}
            stroke={lineColor} strokeOpacity={0.06} strokeWidth={1}
          />

          {/* Points */}
          {plotted.map((p) => {
            const cx = xScale(p.x);
            const cy = yScale(p.y);
            const isSelected = p.id === selectedNodeId;
            const isHovered = p.id === hoveredId;
            const r = isSelected ? HOVER_R + 1 : isHovered ? HOVER_R : DOT_R;
            return (
              <g key={p.id}>
                <circle
                  cx={cx} cy={cy} r={r}
                  fill={p.color}
                  fillOpacity={isSelected ? 1 : 0.7}
                  stroke={isSelected ? "var(--background)" : "none"}
                  strokeWidth={isSelected ? 1.5 : 0}
                  style={{ cursor: "pointer", transition: "r 120ms ease-out" }}
                  onMouseEnter={(e) => {
                    setHoveredId(p.id);
                    const rel = relativePointer(e);
                    setTooltip({ x: rel.x, y: rel.y, note: p });
                  }}
                  onMouseMove={(e) => {
                    const rel = relativePointer(e);
                    setTooltip((t) => (t ? { ...t, x: rel.x, y: rel.y } : t));
                  }}
                  onMouseLeave={() => {
                    setHoveredId(null);
                    setTooltip(null);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const node = nodes.find((n) => n.id === p.id);
                    if (node) onNodeClick(node);
                  }}
                />
              </g>
            );
          })}
        </g>

        {/* Project legend */}
        {scopedProjectList.length > 1 && (
          <g transform={`translate(${PAD.left}, ${dims.height - PAD.bottom - 12})`}>
            {scopedProjectList.map((p, i) => {
              const color = PROJECT_COLORS[i % PROJECT_COLORS.length];
              return (
                <g key={p.id} transform={`translate(${i * 130}, 0)`}>
                  <circle cx={6} cy={0} r={4} fill={color} />
                  <text x={16} y={3} fill={lineColor} fillOpacity={0.5} fontSize={8 * fs} fontFamily="var(--font-mono)">
                    {truncateName(p.name, 18)}
                  </text>
                </g>
              );
            })}
          </g>
        )}

        {/* Stale banner */}
        {anyStale && (
          <g transform={`translate(${dims.width / 2}, ${PAD.top + 4})`}>
            <rect x={-90} y={-12} width={180} height={22} rx={11} fill="var(--warning)" fillOpacity={0.12} stroke="var(--warning)" strokeOpacity={0.4} />
            <text x={0} y={3} textAnchor="middle" fill="var(--warning)" fontSize={9 * fs} fontFamily="var(--font-mono)">
              stale — recompute to refresh
            </text>
          </g>
        )}
      </svg>

      {/* Zoom controls */}
      <div className="absolute top-3 right-3 flex items-center gap-1 bg-[var(--surface)] border border-[var(--border)] rounded-md p-0.5">
        <button
          onClick={() => setZoom((z) => Math.max(0.3, z / 1.2))}
          className="w-7 h-7 flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] rounded"
        >−</button>
        <span className="text-[0.65rem] text-[var(--text-tertiary)] font-mono w-9 text-center">{Math.round(zoom * 100)}%</span>
        <button
          onClick={() => setZoom((z) => Math.min(5, z * 1.2))}
          className="w-7 h-7 flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] rounded"
        >+</button>
        <button
          onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
          className="w-7 h-7 flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] rounded text-[0.7rem]"
          title="Reset view"
        >⟲</button>
        <button
          onClick={handleRecompute}
          disabled={recomputing}
          title="Recompute projections (UMAP)"
          className="w-7 h-7 flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--surface-2)] rounded disabled:opacity-50"
        >
          <RefreshCw size={12} className={cn(recomputing && "animate-spin")} />
        </button>
      </div>

      {/* Header — model + count */}
      <div className="absolute top-3 left-3 text-[0.65rem] text-[var(--text-tertiary)] font-mono pointer-events-none">
        {plotted.length} notes · model: {projectionModel || "—"}
      </div>

      {recomputeProgress && (
        <div className="absolute bottom-3 left-3 right-3 max-w-md mx-auto bg-[var(--surface)] border border-[var(--border)] rounded-md p-2 space-y-1">
          <div className="flex justify-between text-[0.65rem] text-[var(--text-tertiary)]">
            <span>Recomputing UMAP projections…</span>
            <span className="font-mono">
              {recomputeProgress.done}/{recomputeProgress.total}
              {recomputeProgress.total > 0
                ? ` · ${Math.round((recomputeProgress.done / recomputeProgress.total) * 100)}%`
                : ""}
            </span>
          </div>
          <div className="w-full h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--accent)] rounded-full transition-all duration-300"
              style={{
                width: `${recomputeProgress.total > 0
                  ? Math.round((recomputeProgress.done / recomputeProgress.total) * 100)
                  : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {tooltip && (
        <CanvasTooltip x={tooltip.x} y={tooltip.y} containerW={dims.width}>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: tooltip.note.color }} />
            <span className="text-[0.786rem] font-medium text-[var(--text-primary)]">{tooltip.note.title}</span>
          </div>
          {tooltip.note.projectName && (
            <p className="text-[0.7rem] text-[var(--text-tertiary)] mt-0.5">in {tooltip.note.projectName}</p>
          )}
          <p className="text-[0.65rem] text-[var(--text-tertiary)] font-mono mt-1 opacity-70">
            {tooltip.note.model}
          </p>
        </CanvasTooltip>
      )}
    </div>
  );
}
