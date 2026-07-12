"use client";

/**
 * DependencyMatrix — a Design-Structure-Matrix (DSM) of the codebase, aggregated
 * to DIRECTORY level so it stays legible on large repos (a raw file×file matrix
 * of 700+ files is unreadable). Rows/columns are folders (grouped to a chosen
 * path depth); a shaded cell at (row i, col j) means files in folder i reference
 * files in folder j, darker = more references. Directory self-references (the
 * diagonal) show internal cohesion. Mutual references (i↔j) are tinted red as
 * potential architectural cycles.
 *
 * Why directory-level: it collapses hundreds of files into ~10–40 modules, so
 * the blocks are readable and the big cross-cutting dependencies stand out.
 * A depth selector controls granularity (top-level folders → deeper).
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
  /** Selected file id — its directory group is highlighted. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function relPath(filePath: string, root: string): string {
  if (root && filePath.startsWith(root)) {
    return filePath.slice(root.length).replace(/^[/\\]/, "") || filePath;
  }
  return filePath;
}

/** The directory group for a file, truncated to `depth` path segments. */
function groupOf(filePath: string, root: string, depth: number): string {
  const rel = relPath(filePath, root);
  const parts = rel.split(/[/\\]/);
  if (parts.length <= 1) return "(root)";
  const dir = parts.slice(0, -1); // drop the filename
  return dir.slice(0, depth).join("/") || "(root)";
}

export function DependencyMatrix({ nodes, edges, root, selectedId, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fs = useFontScale();
  const [hover, setHover] = useState<{ r: number; c: number; x: number; y: number } | null>(null);
  const [depth, setDepth] = useState(2);

  // Map each file → directory group, then build the ordered list of groups.
  const { groups, groupOfFile } = useMemo(() => {
    const gof = new Map<string, string>();
    const set = new Set<string>();
    for (const n of nodes) {
      const g = groupOf(n.file_path, root, depth);
      gof.set(n.id, g);
      set.add(g);
    }
    const list = [...set].sort((a, b) => a.localeCompare(b));
    return { groups: list, groupOfFile: gof };
  }, [nodes, root, depth]);

  const groupIndex = useMemo(() => {
    const m = new Map<string, number>();
    groups.forEach((g, i) => m.set(g, i));
    return m;
  }, [groups]);

  // Aggregate edge weights between directory groups + track cycles.
  const { weight, maxWeight, fileCountPerGroup } = useMemo(() => {
    const w = new Map<string, number>();
    let mx = 1;
    for (const e of edges) {
      const gs = groupOfFile.get(e.source), gt = groupOfFile.get(e.target);
      if (gs == null || gt == null) continue;
      const si = groupIndex.get(gs)!, ti = groupIndex.get(gt)!;
      const key = `${si},${ti}`;
      const nw = (w.get(key) ?? 0) + e.weight;
      w.set(key, nw);
      if (nw > mx) mx = nw;
    }
    const fc = new Map<string, number>();
    for (const n of nodes) {
      const g = groupOfFile.get(n.id)!;
      fc.set(g, (fc.get(g) ?? 0) + 1);
    }
    return { weight: w, maxWeight: mx, fileCountPerGroup: fc };
  }, [edges, groupOfFile, groupIndex, nodes]);

  const n = groups.length;
  const selGroup = selectedId != null ? groupOfFile.get(selectedId) ?? null : null;
  const selIdx = selGroup != null ? groupIndex.get(selGroup) ?? -1 : -1;

  const [dims, setDims] = useState({ width: 600, height: 600 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setDims({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const LABEL_W = 190;
  // Directory-level → far fewer rows, so cells can be big and labelled.
  const avail = Math.min(dims.width - LABEL_W, dims.height - LABEL_W - 40);
  const cell = Math.max(10, Math.min(36, Math.floor(avail / Math.max(1, n))));
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
    const textCol = resolveCssVar("--text-secondary");
    const textDim = resolveCssVar("--text-tertiary");

    ctx.fillStyle = withAlpha(border, 0.12);
    ctx.fillRect(LABEL_W, LABEL_W, gridSize, gridSize);

    if (selIdx >= 0) {
      ctx.fillStyle = withAlpha(accent, 0.1);
      ctx.fillRect(LABEL_W, LABEL_W + selIdx * cell, gridSize, cell);
      ctx.fillRect(LABEL_W + selIdx * cell, LABEL_W, cell, gridSize);
    }
    if (hover) {
      ctx.fillStyle = withAlpha(accent, 0.08);
      ctx.fillRect(LABEL_W, LABEL_W + hover.r * cell, gridSize, cell);
      ctx.fillRect(LABEL_W + hover.c * cell, LABEL_W, cell, gridSize);
    }

    // cells
    for (const [key, w] of weight) {
      const [r, c] = key.split(",").map(Number);
      const intensity = 0.2 + 0.8 * Math.sqrt(w / maxWeight);
      const isCycle = r !== c && weight.has(`${c},${r}`);
      const col = r === c ? textDim : isCycle ? danger : accent;
      ctx.fillStyle = withAlpha(col, intensity);
      ctx.fillRect(LABEL_W + c * cell + 1, LABEL_W + r * cell + 1, cell - 2, cell - 2);
      // show the count when cells are large enough
      if (cell >= 22) {
        ctx.font = `${9 * fs}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = intensity > 0.55 ? resolveCssVar("--background") : withAlpha(textCol, 0.8);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(w), LABEL_W + c * cell + cell / 2, LABEL_W + r * cell + cell / 2);
      }
    }

    // grid lines + diagonal
    ctx.strokeStyle = withAlpha(border, 0.5);
    ctx.lineWidth = 1;
    for (let i = 0; i <= n; i++) {
      const p = LABEL_W + i * cell + 0.5;
      ctx.beginPath(); ctx.moveTo(p, LABEL_W); ctx.lineTo(p, LABEL_W + gridSize); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(LABEL_W, p); ctx.lineTo(LABEL_W + gridSize, p); ctx.stroke();
    }

    // labels — rows (right-aligned) + columns (rotated)
    ctx.font = `${Math.min(12, cell - 2) * fs}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    for (let i = 0; i < n; i++) {
      const label = groups[i];
      const short = label.length > 26 ? "…" + label.slice(-25) : label;
      const isSel = i === selIdx;
      const isHov = i === hover?.r || i === hover?.c;
      ctx.fillStyle = isSel ? accent : isHov ? textCol : textDim;
      // row label
      ctx.textAlign = "right";
      ctx.fillText(short, LABEL_W - 8, LABEL_W + i * cell + cell / 2);
      // column label (rotated -45°)
      ctx.save();
      ctx.translate(LABEL_W + i * cell + cell / 2, LABEL_W - 8);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = "left";
      ctx.fillText(short, 0, 0);
      ctx.restore();
    }
  }, [gridSize, cell, n, weight, maxWeight, selIdx, hover, groups, fs]);

  useEffect(() => { draw(); }, [draw]);

  const cellFromEvent = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    const c = Math.floor((x - LABEL_W) / cell);
    const r = Math.floor((y - LABEL_W) / cell);
    return { r, c, x, y };
  }, [cell]);

  const onMouseMove = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    const p = cellFromEvent(ev);
    if (p && p.r >= 0 && p.r < n && p.c >= 0 && p.c < n) setHover(p);
    else if (p && p.r >= 0 && p.r < n && p.x < LABEL_W) setHover({ ...p, c: -1 });
    else setHover(null);
  }, [cellFromEvent, n]);

  const onClick = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    const p = cellFromEvent(ev);
    if (!p || p.r < 0 || p.r >= n) { onSelect(null); return; }
    // Select the first file in the clicked row's group so the side panel fills.
    const g = groups[p.r];
    const firstFile = nodes.find((f) => groupOfFile.get(f.id) === g);
    onSelect(firstFile?.id ?? null);
  }, [cellFromEvent, n, groups, nodes, groupOfFile, onSelect]);

  const maxDepth = useMemo(
    () => Math.max(1, ...nodes.map((f) => relPath(f.file_path, root).split(/[/\\]/).length - 1)),
    [nodes, root],
  );

  if (nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-tertiary)]">
        No file dependencies to chart yet.
      </div>
    );
  }

  const hoverLabel = hover
    ? hover.c === -1
      ? `${groups[hover.r]} · ${fileCountPerGroup.get(groups[hover.r]) ?? 0} files`
      : `${groups[hover.r]}  →  ${groups[hover.c]}` +
        (weight.has(`${hover.r},${hover.c}`) ? `  (${weight.get(`${hover.r},${hover.c}`)} refs)` : "  (none)")
    : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Depth control */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] flex-shrink-0 text-[0.7rem] text-[var(--text-tertiary)]">
        <span>{n} folders · grouped by directory depth</span>
        <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden ml-1">
          {Array.from({ length: Math.min(4, maxDepth) }, (_, i) => i + 1).map((d) => (
            <button
              key={d}
              onClick={() => setDepth(d)}
              className={`px-2 py-0.5 transition-colors ${
                depth === d
                  ? "bg-[var(--surface-3)] text-[var(--text-primary)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              } ${d > 1 ? "border-l border-[var(--border)]" : ""}`}
            >
              {d}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: "var(--accent)" }} /> refs</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: "var(--danger)" }} /> cycle</span>
        </span>
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 overflow-auto relative">
        <div className="p-2" onMouseMove={onMouseMove} onMouseLeave={() => setHover(null)} onClick={onClick}>
          <canvas ref={canvasRef} className="block cursor-pointer" />
        </div>
        {hoverLabel && (
          <div
            className="fixed pointer-events-none px-2 py-1 rounded-md text-[0.7rem] font-mono bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)] shadow-md max-w-md truncate z-50"
            style={{ left: (hover?.x ?? 0) + 210, top: (hover?.y ?? 0) + 80 }}
          >
            {hoverLabel}
          </div>
        )}
      </div>
    </div>
  );
}
