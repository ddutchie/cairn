"use client";

/**
 * DependencyMatrix — a Design-Structure-Matrix (DSM) view of the file
 * dependency graph. Rows and columns are files ordered by path (so files in the
 * same directory form contiguous blocks along the diagonal); a shaded cell at
 * (row i, col j) means file i references file j, darker = more references.
 *
 * Why a matrix instead of a force graph: it never becomes a hairball, scales to
 * thousands of files, and makes structure legible — directory clusters appear
 * as blocks on the diagonal, and dependency *cycles* show up as symmetric
 * off-diagonal marks (i→j AND j→i). Standard tool for architecture (Structure101
 * / NDepend style).
 *
 * Canvas-rendered for performance; hovering highlights the row/column and shows
 * which files are involved, clicking a row selects that file.
 */

import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { resolveCssVar, withAlpha } from "../graph/analyticsUtils";
import { useFontScale } from "../graph/analyticsHooks";

export interface MatrixNode {
  id: string;
  file_path: string;
  root_path: string;
  symbol_count: number;
}
export interface MatrixEdge {
  source: string;
  target: string;
  weight: number;
}

interface Props {
  nodes: MatrixNode[];
  edges: MatrixEdge[];
  root: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function relPath(filePath: string, root: string): string {
  if (root && filePath.startsWith(root)) {
    return filePath.slice(root.length).replace(/^[/\\]/, "") || filePath;
  }
  return filePath;
}

export function DependencyMatrix({ nodes, edges, root, selectedId, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fs = useFontScale();
  const [hover, setHover] = useState<{ r: number; c: number; x: number; y: number } | null>(null);

  // Order files by path so directories cluster along the diagonal. Only include
  // files that participate in at least one edge (keeps the matrix meaningful).
  const ordered = useMemo(() => {
    const connected = new Set<string>();
    for (const e of edges) { connected.add(e.source); connected.add(e.target); }
    return nodes
      .filter((n) => connected.has(n.id))
      .slice()
      .sort((a, b) => relPath(a.file_path, root).localeCompare(relPath(b.file_path, root)));
  }, [nodes, edges, root]);

  const indexOf = useMemo(() => {
    const m = new Map<string, number>();
    ordered.forEach((n, i) => m.set(n.id, i));
    return m;
  }, [ordered]);

  // Adjacency weight (i references j) + reverse lookup for cycle detection.
  const { weight, maxWeight } = useMemo(() => {
    const w = new Map<string, number>();
    let mx = 1;
    for (const e of edges) {
      const si = indexOf.get(e.source), ti = indexOf.get(e.target);
      if (si == null || ti == null) continue;
      w.set(`${si},${ti}`, e.weight);
      if (e.weight > mx) mx = e.weight;
    }
    return { weight: w, maxWeight: mx };
  }, [edges, indexOf]);

  const n = ordered.length;

  // Cell size adapts so the whole matrix fits the smaller viewport dimension
  // (min 4px so big repos stay pannable via the scroll container).
  const [dims, setDims] = useState({ width: 600, height: 600 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setDims({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const LABEL_W = 150;
  const avail = Math.min(dims.width - LABEL_W, dims.height - LABEL_W);
  const cell = Math.max(4, Math.min(20, Math.floor(avail / Math.max(1, n))));
  const gridSize = cell * n;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = LABEL_W + gridSize + 8;
    const H = LABEL_W + gridSize + 8;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const accent = resolveCssVar("--accent");
    const danger = resolveCssVar("--danger");
    const border = resolveCssVar("--border");
    const surface2 = resolveCssVar("--surface-2");
    const textCol = resolveCssVar("--text-secondary");
    const textDim = resolveCssVar("--text-tertiary");

    const selIdx = selectedId != null ? indexOf.get(selectedId) ?? -1 : -1;

    // grid background
    ctx.fillStyle = withAlpha(border, 0.15);
    ctx.fillRect(LABEL_W, LABEL_W, gridSize, gridSize);

    // selected row/col highlight band
    if (selIdx >= 0) {
      ctx.fillStyle = withAlpha(accent, 0.1);
      ctx.fillRect(LABEL_W, LABEL_W + selIdx * cell, gridSize, cell);
      ctx.fillRect(LABEL_W + selIdx * cell, LABEL_W, cell, gridSize);
    }
    // hover band
    if (hover) {
      ctx.fillStyle = withAlpha(accent, 0.08);
      ctx.fillRect(LABEL_W, LABEL_W + hover.r * cell, gridSize, cell);
      ctx.fillRect(LABEL_W + hover.c * cell, LABEL_W, cell, gridSize);
    }

    // cells
    for (const [key, w] of weight) {
      const [r, c] = key.split(",").map(Number);
      const intensity = 0.25 + 0.75 * (w / maxWeight);
      // Below the diagonal (r > c) = a reference that goes "backwards" in the
      // ordering. If the reverse edge also exists it's a cycle → tint danger.
      const isCycle = weight.has(`${c},${r}`);
      const col = isCycle ? danger : accent;
      ctx.fillStyle = withAlpha(col, intensity);
      ctx.fillRect(LABEL_W + c * cell + 0.5, LABEL_W + r * cell + 0.5, cell - 1, cell - 1);
    }

    // diagonal
    ctx.strokeStyle = withAlpha(border, 0.6);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LABEL_W, LABEL_W);
    ctx.lineTo(LABEL_W + gridSize, LABEL_W + gridSize);
    ctx.stroke();
    for (let i = 0; i <= n; i++) {
      const p = LABEL_W + i * cell + 0.5;
      ctx.beginPath(); ctx.moveTo(p, LABEL_W); ctx.lineTo(p, LABEL_W + gridSize); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(LABEL_W, p); ctx.lineTo(LABEL_W + gridSize, p); ctx.stroke();
    }

    // row labels (only when cells are tall enough to be legible)
    if (cell >= 8) {
      ctx.font = `${Math.min(11, cell - 1) * fs}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      for (let i = 0; i < n; i++) {
        const label = relPath(ordered[i].file_path, root);
        const short = label.length > 22 ? "…" + label.slice(-21) : label;
        ctx.fillStyle = i === selIdx ? accent : (i === hover?.r ? textCol : textDim);
        ctx.textAlign = "right";
        ctx.fillText(short, LABEL_W - 6, LABEL_W + i * cell + cell / 2);
      }
    }
    // A small hint of surface behind labels for contrast
    void surface2;
  }, [gridSize, cell, n, weight, maxWeight, indexOf, selectedId, hover, ordered, root, fs]);

  useEffect(() => { draw(); }, [draw]);

  const onMouseMove = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    const c = Math.floor((x - LABEL_W) / cell);
    const r = Math.floor((y - LABEL_W) / cell);
    if (r >= 0 && r < n && c >= 0 && c < n) {
      setHover({ r, c, x, y });
    } else if (r >= 0 && r < n && x < LABEL_W) {
      setHover({ r, c: -1, x, y }); // hovering a row label
    } else {
      setHover(null);
    }
  }, [cell, n]);

  const onClick = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const y = ev.clientY - rect.top;
    const r = Math.floor((y - LABEL_W) / cell);
    if (r >= 0 && r < n) onSelect(ordered[r].id);
    else onSelect(null);
  }, [cell, n, ordered, onSelect]);

  if (n === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-tertiary)]">
        No file dependencies to chart yet. Reindex, or check that files reference each other.
      </div>
    );
  }

  const hoverLabel = hover
    ? hover.c === -1
      ? relPath(ordered[hover.r].file_path, root)
      : `${relPath(ordered[hover.r].file_path, root)}  →  ${relPath(ordered[hover.c].file_path, root)}` +
        (weight.has(`${hover.r},${hover.c}`) ? `  (${weight.get(`${hover.r},${hover.c}`)}×)` : "  (no reference)")
    : null;

  return (
    <div ref={containerRef} className="flex-1 min-h-0 overflow-auto relative">
      <div className="p-2" onMouseMove={onMouseMove} onMouseLeave={() => setHover(null)} onClick={onClick}>
        <canvas ref={canvasRef} className="block cursor-pointer" />
      </div>
      {hoverLabel && (
        <div
          className="fixed pointer-events-none px-2 py-1 rounded-md text-[0.7rem] font-mono bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)] shadow-md max-w-md truncate z-50"
          style={{ left: (hover?.x ?? 0) + 170, top: (hover?.y ?? 0) + 60 }}
        >
          {hoverLabel}
        </div>
      )}
      {/* Legend */}
      <div className="sticky bottom-0 left-0 flex items-center gap-3 px-3 py-1.5 text-[0.65rem] text-[var(--text-tertiary)] bg-[color-mix(in_srgb,var(--surface)_85%,transparent)] border-t border-[var(--border)]">
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "var(--accent)" }} /> references
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "var(--danger)" }} /> cycle (mutual)
        </span>
        <span>row i → column j = file i references file j · darker = more</span>
      </div>
    </div>
  );
}
