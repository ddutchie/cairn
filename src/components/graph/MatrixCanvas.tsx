"use client";

import React, { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import type { GraphNode } from "@/types";

interface Props {
  nodes: GraphNode[];
  onNodeClick: (node: GraphNode) => void;
  selectedNodeId: string | null;
}

export function MatrixCanvas({ nodes, onNodeClick, selectedNodeId }: Props) {
  const { tags, notes, cards } = useCairnStore();
  const [hoveredCell, setHoveredCell] = useState<{ r: number; c: number } | null>(null);

  // Only tags that appear on any node in scope
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

  // Co-occurrence matrix: activeTags × activeTags
  // cell[i][j] = number of entities that have both tag i and tag j
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

    for (const note of notes) {
      if (scopedEntityIds.has(note.id)) processTagIds(note.tagIds);
    }
    for (const card of cards) {
      if (scopedEntityIds.has(card.id)) processTagIds(card.tagIds);
    }

    return m;
  }, [activeTags, notes, cards, scopedEntityIds]);

  // Items sharing both tags (for tooltip)
  function itemsWithBothTags(tagIdA: string, tagIdB: string): Array<{ id: string; title: string; type: string }> {
    const result: Array<{ id: string; title: string; type: string }> = [];
    for (const note of notes) {
      if (!scopedEntityIds.has(note.id)) continue;
      if (note.tagIds.includes(tagIdA) && note.tagIds.includes(tagIdB))
        result.push({ id: note.id, title: note.title, type: "note" });
    }
    for (const card of cards) {
      if (!scopedEntityIds.has(card.id)) continue;
      if (card.tagIds.includes(tagIdA) && card.tagIds.includes(tagIdB))
        result.push({ id: card.id, title: card.title, type: "card" });
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

  // Max co-occurrence for colour scaling (exclude diagonal)
  const maxVal = Math.max(
    1,
    ...matrix.flatMap((row, i) => row.filter((_, j) => i !== j))
  );

  const CELL_SIZE = Math.max(28, Math.min(52, Math.floor(560 / activeTags.length)));
  const LABEL_W = 120;

  // Hovered cell info
  const hoveredItems = hoveredCell && hoveredCell.r !== hoveredCell.c
    ? itemsWithBothTags(activeTags[hoveredCell.r].id, activeTags[hoveredCell.c].id)
    : [];

  return (
    <div className="flex-1 overflow-auto p-6 min-h-0 flex gap-6">
      {/* Matrix */}
      <div className="flex-shrink-0">
        <div className="flex">
          {/* Corner spacer */}
          <div style={{ width: LABEL_W, height: LABEL_W }} className="flex-shrink-0" />

          {/* Column labels (rotated) */}
          {activeTags.map((tag) => (
            <div
              key={tag.id}
              style={{ width: CELL_SIZE, height: LABEL_W, flexShrink: 0 }}
              className="flex items-end justify-center pb-2 overflow-hidden"
            >
              <span
                className="text-[10px] text-[var(--text-secondary)] whitespace-nowrap"
                style={{
                  writingMode: "vertical-rl",
                  transform: "rotate(180deg)",
                  maxHeight: LABEL_W - 8,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {tag.name}
              </span>
            </div>
          ))}
        </div>

        {/* Rows */}
        {activeTags.map((rowTag, r) => (
          <div key={rowTag.id} className="flex items-center">
            {/* Row label */}
            <div
              style={{ width: LABEL_W, height: CELL_SIZE, flexShrink: 0 }}
              className="flex items-center pr-2 overflow-hidden"
            >
              <span
                className="text-[11px] text-[var(--text-secondary)] truncate w-full text-right"
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

              // Intensity 0–1
              const intensity = isDiag ? 1 : val / maxVal;

              // Diagonal = tag's total entity count
              const cellBg = isDiag
                ? `color-mix(in srgb, ${rowTag.color} 30%, var(--surface-2))`
                : val > 0
                ? `color-mix(in srgb, var(--accent) ${Math.round(intensity * 60 + 8)}%, var(--surface-2))`
                : "var(--surface-2)";

              return (
                <div
                  key={colTag.id}
                  style={{ width: CELL_SIZE, height: CELL_SIZE, background: cellBg, flexShrink: 0 }}
                  className={cn(
                    "flex items-center justify-center border border-[var(--background)] cursor-default transition-all text-[10px] font-mono",
                    isHovered && "ring-1 ring-inset ring-[var(--accent)]",
                    !isDiag && val > 0 && "cursor-pointer"
                  )}
                  onMouseEnter={() => setHoveredCell({ r, c })}
                  onMouseLeave={() => setHoveredCell(null)}
                  title={isDiag ? `${rowTag.name}: ${val} items` : `${rowTag.name} × ${colTag.name}: ${val}`}
                >
                  <span className={cn("select-none", isDiag ? "text-[var(--text-tertiary)]" : val > 0 ? "text-[var(--text-primary)]" : "text-transparent")}>
                    {val > 0 ? val : "·"}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Tooltip panel */}
      <div className="flex-1 min-w-0">
        {hoveredCell && hoveredCell.r !== hoveredCell.c && hoveredItems.length > 0 ? (
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 max-w-xs">
            <p className="text-xs font-semibold text-[var(--text-primary)] mb-1">
              {activeTags[hoveredCell.r].name} × {activeTags[hoveredCell.c].name}
            </p>
            <p className="text-[11px] text-[var(--text-tertiary)] mb-3">
              {hoveredItems.length} shared item{hoveredItems.length !== 1 ? "s" : ""}
            </p>
            <div className="space-y-1">
              {hoveredItems.slice(0, 8).map((item) => {
                const node = nodes.find((n) => n.id === item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => node && onNodeClick(node)}
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1 rounded text-left text-[11px] transition-colors",
                      selectedNodeId === item.id
                        ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                        : "hover:bg-[var(--surface-2)] text-[var(--text-secondary)]"
                    )}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: item.type === "note" ? "var(--info)" : "var(--success)" }}
                    />
                    <span className="truncate">{item.title}</span>
                  </button>
                );
              })}
              {hoveredItems.length > 8 && (
                <p className="text-[10px] text-[var(--text-tertiary)] px-2">
                  +{hoveredItems.length - 8} more
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--text-tertiary)]">
              Hover a cell to see shared items.
            </p>
            <p className="text-[11px] text-[var(--text-tertiary)]">
              Diagonal = total items per tag. Off-diagonal = items sharing both tags. Darker = more overlap.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
