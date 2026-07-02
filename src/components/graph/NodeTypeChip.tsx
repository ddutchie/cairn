"use client";

import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { nodeTypeColor } from "@/store/slices/graph";
import type { GraphNodeType } from "@/types";

type NodeType = GraphNodeType;

interface NodeTypeChipProps {
  type: NodeType;
  /**
   * Filter-toggle mode. When `active` is provided the chip renders as a
   * toggle button (coloured when active, dimmed when not) and calls `onClick`.
   * When omitted the chip renders as a static coloured label.
   */
  active?: boolean;
  onClick?: () => void;
  /** Wrap the button in a tooltip (filter mode only). */
  tooltip?: string;
  /** Leading colour dot diameter in px (default 6). Set 0 to hide. */
  dotSize?: number;
  className?: string;
}

/**
 * Shared node-type chip used by the Knowledge Graph filter bar, the Insights
 * table filter, the graph detail panel header, and the table canvas cells.
 * Consolidates the repeated `color-mix(... 12%/30% ...)` styling + colour dot.
 */
export function NodeTypeChip({ type, active, onClick, tooltip, dotSize = 6, className }: NodeTypeChipProps) {
  const color = nodeTypeColor(type);
  const isToggle = active !== undefined;

  // Static label chip
  if (!isToggle) {
    return (
      <span
        className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.714rem] font-medium capitalize", className)}
        style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
      >
        {dotSize > 0 && (
          <span className="rounded-full flex-shrink-0" style={{ width: dotSize, height: dotSize, background: color }} />
        )}
        {type}
      </span>
    );
  }

  // Interactive toggle-filter chip
  const button = (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1 px-2 py-1 rounded text-[0.786rem] capitalize transition-colors border",
        active ? "border-transparent" : "border-[var(--border)] text-[var(--text-tertiary)] opacity-50",
        className,
      )}
      style={active ? {
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        color,
        borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
      } : undefined}
    >
      {dotSize > 0 && (
        <span className="rounded-full flex-shrink-0" style={{ width: dotSize, height: dotSize, background: active ? color : "currentColor" }} />
      )}
      {type}
    </button>
  );

  return tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button;
}
