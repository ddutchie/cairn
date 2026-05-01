"use client";

import React, { useMemo, useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import type { GraphNode } from "@/types";

interface Props {
  nodes: GraphNode[];
  onNodeClick: (node: GraphNode) => void;
  selectedNodeId: string | null;
}

// Blend two hex colours at a given ratio (0 = all a, 1 = all b)
function blendHex(a: string, b: string, t: number): string {
  const parse = (h: string) => {
    const s = h.replace("#", "").padStart(6, "0");
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  };
  const ca = parse(a);
  const cb = parse(b);
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * t);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * t);
  const bv = Math.round(ca[2] + (cb[2] - ca[2]) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bv.toString(16).padStart(2, "0")}`;
}

const FALLBACK_COLORS = [
  "#6366f1", "#8b5cf6", "#a855f7", "#ec4899",
  "#f43f5e", "#f97316", "#eab308", "#22c55e",
  "#14b8a6", "#06b6d4", "#3b82f6", "#64748b",
];

function tagColor(color: string | undefined | null, index: number): string {
  if (color && color.startsWith("#")) return color;
  return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

export function MatrixCanvas({ nodes, onNodeClick, selectedNodeId }: Props) {
  const { tags, notes, cards } = useCairnStore();
  const [hoveredCell, setHoveredCell] = useState<{ r: number; c: number } | null>(null);
  const [pinnedCell, setPinnedCell] = useState<{ r: number; c: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(600);

  useEffect(() => {
    const el = containerRef.current?.parentElement ?? containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout>;
    function measure() { setContainerWidth(el!.clientWidth); }
    measure();
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(timer); };
  }, []);

  const scopedEntityIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);

  const activeTags = useMemo(() => {
    const used = new Set<string>();
    for (const n of notes) {
      if (!scopedEntityIds.has(n.id)) continue;
      for (const t of n.tagIds) used.add(t);
    }
    for (const c of cards) {
      if (!scopedEntityIds.has(c.id)) continue;
      for (const t of c.tagIds) used.add(t);
    }
    return tags.filter((t) => used.has(t.id));
  }, [tags, notes, cards, scopedEntityIds]);

  const matrix = useMemo(() => {
    const n = activeTags.length;
    const m: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const tagIndex = new Map(activeTags.map((t, i) => [t.id, i]));
    function processTagIds(tagIds: string[]) {
      const indices = tagIds.map((tid) => tagIndex.get(tid)).filter((i): i is number => i !== undefined);
      for (let a = 0; a < indices.length; a++) {
        for (let b = 0; b < indices.length; b++) {
          m[indices[a]][indices[b]]++;
        }
      }
    }
    for (const note of notes) if (scopedEntityIds.has(note.id)) processTagIds(note.tagIds);
    for (const card of cards) if (scopedEntityIds.has(card.id)) processTagIds(card.tagIds);
    return m;
  }, [activeTags, notes, cards, scopedEntityIds]);

  function itemsWithBothTags(tagIdA: string, tagIdB: string): GraphNode[] {
    const result: GraphNode[] = [];
    for (const note of notes) {
      if (!scopedEntityIds.has(note.id)) continue;
      if (note.tagIds.includes(tagIdA) && note.tagIds.includes(tagIdB)) {
        const node = nodes.find((n) => n.id === note.id);
        if (node) result.push(node);
      }
    }
    for (const card of cards) {
      if (!scopedEntityIds.has(card.id)) continue;
      if (card.tagIds.includes(tagIdA) && card.tagIds.includes(tagIdB)) {
        const node = nodes.find((n) => n.id === card.id);
        if (node) result.push(node);
      }
    }
    return result;
  }

  if (activeTags.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-[var(--text-tertiary)]">No tagged items in this scope.</p>
      </div>
    );
  }

  const maxVal = Math.max(1, ...matrix.flatMap((row, i) => row.filter((_, j) => i !== j)));

  // Cell size and label width scale with available space.
  // Matrix scrolls if content overflows — cells never shrink below minimum.
  const PANEL_W = 288;
  const PADDING = 32;
  const availableW = Math.max(300, containerWidth - PANEL_W - PADDING);
  const CELL_SIZE = Math.max(40, Math.min(80, Math.floor(availableW / 6)));
  const LABEL_W = Math.max(100, Math.min(200, Math.floor(availableW * 0.18)));
  const HEADER_H = Math.max(64, Math.min(120, CELL_SIZE * 1.5));

  const tagColors = activeTags.map((t, i) => tagColor(t.color, i));

  const isAxisHighlight = (r: number, c: number) =>
    hoveredCell !== null && (r === hoveredCell.r || c === hoveredCell.c);



  const panelCell = pinnedCell ?? (hoveredCell?.r !== hoveredCell?.c ? hoveredCell : null);
  const panelItems = panelCell && panelCell.r !== panelCell.c
    ? itemsWithBothTags(activeTags[panelCell.r].id, activeTags[panelCell.c].id)
    : [];

  function handleCellClick2(r: number, c: number) {
    if (r === c) return;
    const val = matrix[r][c];
    if (val === 0) return;
    // Toggle pin: clicking the same cell again unpins
    if (pinnedCell?.r === r && pinnedCell?.c === c) {
      setPinnedCell(null);
    } else {
      setPinnedCell({ r, c });
    }
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-hidden min-h-0 flex">
      {/* Scrollable matrix area */}
      <div className="flex-1 overflow-auto px-4 py-6 flex items-start justify-center">
      <div className="flex-shrink-0">

        {/* Column headers — angled labels */}
        <div className="flex" style={{ marginLeft: LABEL_W }}>
          {activeTags.map((tag, c) => {
            const dimmed = hoveredCell !== null && hoveredCell.c !== c;
            return (
              <div
                key={tag.id}
                style={{ width: CELL_SIZE, height: HEADER_H, flexShrink: 0 }}
                className={cn(
                  "relative flex items-end justify-center pb-2 transition-opacity duration-100",
                  dimmed ? "opacity-30" : "opacity-100"
                )}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full absolute bottom-2 left-1/2 -translate-x-1/2"
                  style={{ background: tagColors[c] }}
                />
                <div
                  className="absolute bottom-6 left-1/2 origin-bottom-left"
                  style={{ transform: "rotate(-45deg) translateX(-50%)" }}
                >
                  <span className="text-[9px] font-medium text-[var(--text-secondary)] uppercase tracking-wide whitespace-nowrap">
                    {tag.name.length > 12 ? tag.name.slice(0, 11) + "…" : tag.name}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Grid body */}
        <div
          className="rounded-lg overflow-hidden"
          style={{
            boxShadow: "0 0 0 1px var(--border)",
            display: "grid",
            gridTemplateColumns: `${LABEL_W}px repeat(${activeTags.length}, ${CELL_SIZE}px)`,
          }}
        >
          {activeTags.map((rowTag, r) => (
            <React.Fragment key={rowTag.id}>
              {/* Row label */}
              <div
                style={{ height: CELL_SIZE }}
                className={cn(
                  "flex items-center px-3 border-b border-r border-[var(--border)] bg-[var(--surface)] transition-opacity duration-100",
                  hoveredCell && hoveredCell.r !== r ? "opacity-30" : "opacity-100"
                )}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0 mr-2"
                  style={{ background: tagColors[r] }}
                />
                <span
                  className="text-[10px] font-medium text-[var(--text-secondary)] truncate"
                  title={rowTag.name}
                >
                  {rowTag.name}
                </span>
              </div>

              {/* Cells */}
              {activeTags.map((colTag, c) => {
                const val = matrix[r][c];
                const isDiag = r === c;
                const isHovered = hoveredCell?.r === r && hoveredCell?.c === c;
                const axisHl = isAxisHighlight(r, c);
                const intensity = isDiag ? 1 : val / maxVal;
                const isClickable = !isDiag && val > 0;

                let cellBg: string;
                if (isDiag) {
                  cellBg = tagColors[r] + "33";
                } else if (val > 0) {
                  const blended = blendHex(tagColors[r], tagColors[c], 0.5);
                  const alpha = Math.round(intensity * 72 + 16).toString(16).padStart(2, "0");
                  cellBg = blended + alpha;
                } else {
                  cellBg = "transparent";
                }

                return (
                  <div
                    key={colTag.id}
                    style={{
                      width: CELL_SIZE,
                      height: CELL_SIZE,
                      background: cellBg,
                      flexShrink: 0,
                      outline: isHovered ? `1.5px solid ${blendHex(tagColors[r], tagColors[c], 0.5)}` : undefined,
                      outlineOffset: isHovered ? "-1.5px" : undefined,
                    }}
                    className={cn(
                      "flex items-center justify-center border-b border-r border-[var(--border)] transition-all duration-100",
                      isClickable && "cursor-pointer",
                      axisHl && !isHovered && !isDiag && "brightness-125",
                    )}
                    onMouseEnter={() => setHoveredCell({ r, c })}
                    onMouseLeave={() => setHoveredCell(null)}
                    onClick={() => handleCellClick2(r, c)}
                    title={
                      isDiag
                        ? `${rowTag.name}: ${val} item${val !== 1 ? "s" : ""}`
                        : `${rowTag.name} × ${colTag.name}: ${val}`
                    }
                  >
                    {isDiag ? (
                      <div className="flex flex-col items-center gap-0.5">
                        <div
                          className="w-3 rounded-full"
                          style={{ height: 2, background: tagColors[r], opacity: 0.8 }}
                        />
                        <span
                          className="text-[9px] font-semibold tabular-nums"
                          style={{ color: tagColors[r], opacity: 0.9 }}
                        >
                          {val}
                        </span>
                      </div>
                    ) : (
                      <span
                        className={cn(
                          "text-[10px] font-mono tabular-nums select-none",
                          val > 0
                            ? "text-[var(--text-primary)] font-semibold"
                            : "text-[var(--text-tertiary)] opacity-20"
                        )}
                      >
                        {val > 0 ? val : "·"}
                      </span>
                    )}
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 mt-3 px-1">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm opacity-50" style={{ background: tagColors[0] ?? "#6366f1" }} />
            <span className="text-[10px] text-[var(--text-tertiary)]">co-occurrence</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-1.5 rounded-full" style={{ background: tagColors[0] ?? "#6366f1" }} />
            <span className="text-[10px] text-[var(--text-tertiary)]">diagonal = total per tag</span>
          </div>
          <span className="text-[10px] text-[var(--text-tertiary)] opacity-50 ml-2">
            click a cell to inspect
          </span>
        </div>
      </div>
      </div>{/* end scrollable matrix area */}

      {/* Intersection detail panel — always rendered to avoid layout shift */}
      <div className="w-72 flex-shrink-0 border-l border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden">
        {panelItems.length > 0 && panelCell ? (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
              <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded"
                  style={{
                    background: tagColors[panelCell.r] + "22",
                    color: tagColors[panelCell.r],
                  }}
                >
                  <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: tagColors[panelCell.r] }} />
                  {activeTags[panelCell.r].name}
                </span>
                <span className="text-[10px] text-[var(--text-tertiary)]">×</span>
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded"
                  style={{
                    background: tagColors[panelCell.c] + "22",
                    color: tagColors[panelCell.c],
                  }}
                >
                  <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: tagColors[panelCell.c] }} />
                  {activeTags[panelCell.c].name}
                </span>
              </div>
              {pinnedCell && (
                <button
                  onClick={() => setPinnedCell(null)}
                  className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors flex-shrink-0"
                >
                  <span className="text-xs">✕</span>
                </button>
              )}
            </div>

            <p className="px-4 py-2 text-[10px] text-[var(--text-tertiary)] border-b border-[var(--border)]">
              {panelItems.length} shared item{panelItems.length !== 1 ? "s" : ""}
            </p>

            {/* Item list */}
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {panelItems.map((node) => {
                const isNote = node.type === "note";
                const isSelected = node.id === selectedNodeId;
                return (
                  <button
                    key={node.id}
                    onClick={() => onNodeClick(node)}
                    className={cn(
                      "flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left text-[11px] transition-colors",
                      isSelected
                        ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                        : "hover:bg-[var(--surface-2)] text-[var(--text-secondary)]"
                    )}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: isNote ? "var(--info)" : "var(--success)" }}
                    />
                    <span className="truncate flex-1">{node.title}</span>
                    <span className="ml-auto text-[9px] text-[var(--text-tertiary)] font-mono flex-shrink-0">
                      {isNote ? "note" : "task"}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          /* Empty state — panel stays visible to hold layout stable */
          <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-xs text-[var(--text-tertiary)]">Hover a cell to preview shared items.</p>
            <p className="text-[11px] text-[var(--text-tertiary)] opacity-50 leading-relaxed">
              Click a cell to pin the panel.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
