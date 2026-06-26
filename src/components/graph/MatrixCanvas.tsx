"use client";

import React, { useMemo, useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { GraphNode } from "@/types";
import { CanvasEmptyState } from "./AnalyticsShared";

interface Props {
  nodes: GraphNode[];
  onNodeClick: (node: GraphNode) => void;
  selectedNodeId: string | null;
}

function blendHex(a: string, b: string, t: number): string {
  const parse = (h: string) => {
    const s = h.replace("#", "").padStart(6, "0");
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  };
  const ca = parse(a), cb = parse(b);
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
  const { tags, notes, cards } = useCairnStore(useShallow((s) => ({ tags: s.tags, notes: s.notes, cards: s.cards })));
  const [hoveredCell, setHoveredCell] = useState<{ r: number; c: number } | null>(null);
  const [pinnedCell,  setPinnedCell]  = useState<{ r: number; c: number } | null>(null);

  const scopedEntityIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);

  const activeTags = useMemo(() => {
    const used = new Set<string>();
    for (const n of notes) { if (!scopedEntityIds.has(n.id)) continue; for (const t of n.tagIds) used.add(t); }
    for (const c of cards) { if (!scopedEntityIds.has(c.id)) continue; for (const t of c.tagIds) used.add(t); }
    return tags.filter((t) => used.has(t.id));
  }, [tags, notes, cards, scopedEntityIds]);

  const activeTagsKey = useMemo(() => activeTags.map((t) => t.id).join(","), [activeTags]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPinnedCell(null);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHoveredCell(null);
  }, [activeTagsKey]);

  const matrix = useMemo(() => {
    const n = activeTags.length;
    const m: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const tagIndex = new Map(activeTags.map((t, i) => [t.id, i]));
    function processTagIds(tagIds: string[]) {
      const indices = tagIds.map((tid) => tagIndex.get(tid)).filter((i): i is number => i !== undefined);
      for (let a = 0; a < indices.length; a++)
        for (let b = 0; b < indices.length; b++)
          m[indices[a]][indices[b]]++;
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
      <div className="flex-1 relative">
        <CanvasEmptyState message="No tagged items in this scope." />
      </div>
    );
  }

  const maxVal    = Math.max(1, ...matrix.flatMap((row, i) => row.filter((_, j) => i !== j)));
  const tagColors = activeTags.map((t, i) => tagColor(t.color, i));

  // Fix bounds checks to prevent TypeError crashes when filtering tag list shrinks
  const panelCell = pinnedCell && pinnedCell.r < activeTags.length && pinnedCell.c < activeTags.length
    ? pinnedCell
    : (hoveredCell !== null && hoveredCell.r < activeTags.length && hoveredCell.c < activeTags.length ? hoveredCell : null);
  const panelItems = panelCell ? itemsWithBothTags(activeTags[panelCell.r].id, activeTags[panelCell.c].id) : [];

  const n = activeTags.length;

  // Dynamic parameters based on tag density to maximize screen utilization
  const cellMin = n > 20 ? 24 : n > 10 ? 32 : 44;
  const cellMax = n > 20 ? 36 : n > 10 ? 48 : 80;
  const maxLabelLen = n > 20 ? 8 : n > 10 ? 10 : 14;
  const headerHeight = "5.5rem";
  const labelWidth = "minmax(6rem, 10rem)";
  const cellTemplate = `clamp(${cellMin}px, calc((100cqw - 10rem) / ${n}), ${cellMax}px)`;

  function handleCellClick(r: number, c: number) {
    if (matrix[r][c] === 0) return;
    setPinnedCell(pinnedCell?.r === r && pinnedCell?.c === c ? null : { r, c });
  }

  const isAxisHighlight = (r: number, c: number) =>
    hoveredCell !== null && (r === hoveredCell.r || c === hoveredCell.c);

  return (
    <div className="flex-1 overflow-hidden min-h-0 flex flex-col lg:flex-row">
      {/* Scrollable matrix area — container query context */}
      <div
        className="flex-1 overflow-auto px-6 py-6 flex items-start"
        style={{ containerType: "inline-size" } as React.CSSProperties}
      >
        {/* mx-auto allows centering when there is extra space, and aligns to start when overflowing */}
        <div className="flex-shrink-0 mx-auto">
          
          {/* Single CSS Grid Layout to synchronize column/row sticky offsets natively */}
          <div
            className="rounded-lg"
            style={{
              boxShadow: "0 0 0 1px var(--border)",
              display: "grid",
              gridTemplateColumns: `${labelWidth} repeat(${n}, ${cellTemplate})`,
            }}
          >
            {/* Top-left corner cell */}
            <div
              style={{
                height: headerHeight,
                position: "sticky",
                top: 0,
                left: 0,
                zIndex: 30,
                background: "var(--surface)",
              }}
              className="border-b border-r border-[var(--border)] rounded-tl-lg"
            />

            {/* Column headers — angled labels */}
            {activeTags.map((tag, c) => {
              const fontSizeClass = n > 20 ? "text-[0.55rem]" : n > 10 ? "text-[0.6rem]" : "text-[0.643rem]";
              return (
                <div
                  key={`header-${tag.id}`}
                  style={{
                    height: headerHeight,
                    position: "sticky",
                    top: 0,
                    zIndex: 20,
                    background: "var(--surface)",
                  }}
                  className={cn(
                    "relative flex items-end justify-center pb-2 border-b border-r border-[var(--border)] transition-opacity duration-150",
                    hoveredCell !== null && hoveredCell.c !== c ? "opacity-30" : "opacity-100",
                    c === n - 1 && "rounded-tr-lg"
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
                    <span className={cn("font-medium text-[var(--text-secondary)] uppercase tracking-wide whitespace-nowrap", fontSizeClass)}>
                      {tag.name.length > maxLabelLen ? tag.name.slice(0, maxLabelLen - 1) + "…" : tag.name}
                    </span>
                  </div>
                </div>
              );
            })}

            {/* Grid rows */}
            {activeTags.map((rowTag, r) => (
              <React.Fragment key={rowTag.id}>
                {/* Row label */}
                <div
                  style={{
                    height: `clamp(${cellMin}px, calc((100cqw - 10rem) / ${n}), ${cellMax}px)`,
                    position: "sticky",
                    left: 0,
                    zIndex: 10,
                    background: "var(--surface)",
                  }}
                  className={cn(
                    "flex items-center px-3 border-b border-r border-[var(--border)] transition-opacity duration-150",
                    hoveredCell && hoveredCell.r !== r ? "opacity-30" : "opacity-100",
                    r === n - 1 && "rounded-bl-lg"
                  )}
                >
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 mr-2" style={{ background: tagColors[r] }} />
                  <span className="text-[0.714rem] font-medium text-[var(--text-secondary)] truncate" title={rowTag.name}>
                    {rowTag.name}
                  </span>
                </div>

                {/* Cells */}
                {activeTags.map((colTag, c) => {
                  const val      = matrix[r][c];
                  const isDiag   = r === c;
                  const isHov    = hoveredCell?.r === r && hoveredCell?.c === c;
                  const axisHl   = isAxisHighlight(r, c);
                  const intensity = isDiag ? 1 : val / maxVal;

                  let cellBg: string;
                  if (isDiag) {
                    cellBg = tagColors[r] + "33";
                  } else if (val > 0) {
                    const blended = blendHex(tagColors[r], tagColors[c], 0.5);
                    const alpha   = Math.round(intensity * 72 + 16).toString(16).padStart(2, "0");
                    cellBg = blended + alpha;
                  } else {
                    cellBg = "transparent";
                  }

                  const isPinned = pinnedCell?.r === r && pinnedCell?.c === c;
                  // Hide numbers inside the cells for dense layouts unless hovered, pinned, or pointer is not hovering
                  const showValue = val > 0 && (n <= 20 || isHov || isPinned || hoveredCell === null);

                  return (
                    <div
                      key={colTag.id}
                      style={{
                        background: cellBg,
                        outline: isHov ? `1.5px solid ${blendHex(tagColors[r], tagColors[c], 0.5)}` : undefined,
                        outlineOffset: isHov ? "-1.5px" : undefined,
                      }}
                      className={cn(
                        "flex items-center justify-center border-b border-r border-[var(--border)] transition-colors duration-100",
                        !isDiag && val > 0 && "cursor-pointer",
                        axisHl && !isHov && !isDiag && "brightness-125",
                        r === n - 1 && c === n - 1 && "rounded-br-lg"
                      )}
                      onMouseEnter={() => setHoveredCell({ r, c })}
                      onMouseLeave={() => setHoveredCell(null)}
                      onClick={() => handleCellClick(r, c)}
                      title={isDiag
                        ? `${rowTag.name}: ${val} item${val !== 1 ? "s" : ""}`
                        : `${rowTag.name} × ${colTag.name}: ${val}`}
                    >
                      {isDiag ? (
                        <div className="flex flex-col items-center gap-0.5">
                          <div className="w-3 rounded-full" style={{ height: 2, background: tagColors[r], opacity: 0.8 }} />
                          {showValue && (
                            <span className="text-[0.643rem] font-semibold tabular-nums" style={{ color: tagColors[r], opacity: 0.9 }}>
                              {val}
                            </span>
                          )}
                        </div>
                      ) : (
                        showValue ? (
                          <span className={cn(
                            "text-[0.714rem] font-mono tabular-nums select-none",
                            "text-[var(--text-primary)] font-semibold"
                          )}>
                            {val}
                          </span>
                        ) : null
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
              <span className="text-[0.714rem] text-[var(--text-tertiary)]">co-occurrence</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-1.5 rounded-full" style={{ background: tagColors[0] ?? "#6366f1" }} />
              <span className="text-[0.714rem] text-[var(--text-tertiary)]">diagonal = total per tag</span>
            </div>
            <span className="text-[0.714rem] text-[var(--text-tertiary)] opacity-50 ml-2">click a cell to inspect</span>
          </div>
        </div>
      </div>

      {/* Detail panel — always rendered to prevent layout shift */}
      <div className="h-64 lg:h-auto lg:w-72 flex-shrink-0 border-t lg:border-t-0 lg:border-l border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden">
        {panelItems.length > 0 && panelCell ? (
          <>
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
              <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                {[panelCell.r, panelCell.c].map((idx, i) => (
                  <React.Fragment key={idx}>
                    {i === 1 && <span className="text-[0.714rem] text-[var(--text-tertiary)]">×</span>}
                    <span
                      className="inline-flex items-center gap-1 text-[0.786rem] font-semibold px-1.5 py-0.5 rounded"
                      style={{ background: tagColors[idx] + "22", color: tagColors[idx] }}
                    >
                      <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: tagColors[idx] }} />
                      {activeTags[idx].name}
                    </span>
                  </React.Fragment>
                ))}
              </div>
              {pinnedCell && (
                <button
                  onClick={() => setPinnedCell(null)}
                  className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors flex-shrink-0 ml-1"
                >
                  <span className="text-xs">✕</span>
                </button>
              )}
            </div>
            <p className="px-4 py-2 text-[0.714rem] text-[var(--text-tertiary)] border-b border-[var(--border)]">
              {panelItems.length} shared item{panelItems.length !== 1 ? "s" : ""}
            </p>
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {panelItems.map((node) => {
                const isNote     = node.type === "note";
                const isSelected = node.id === selectedNodeId;
                return (
                  <button
                    key={node.id}
                    onClick={() => onNodeClick(node)}
                    className={cn(
                      "flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left text-[0.786rem] transition-colors",
                      isSelected
                        ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                        : "hover:bg-[var(--surface-2)] text-[var(--text-secondary)]"
                    )}
                  >
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: isNote ? "var(--info)" : "var(--success)" }} />
                    <span className="truncate flex-1">{node.title}</span>
                    <span className="ml-auto text-[0.643rem] text-[var(--text-tertiary)] font-mono flex-shrink-0">
                      {isNote ? "note" : "task"}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-xs text-[var(--text-tertiary)]">Hover a cell to preview shared items.</p>
            <p className="text-[0.786rem] text-[var(--text-tertiary)] opacity-50 leading-relaxed">Click a cell to pin the panel.</p>
          </div>
        )}
      </div>
    </div>
  );
}
