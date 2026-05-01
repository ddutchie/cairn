"use client";

import { memo } from "react";
import { NodeResizer, Handle, Position, type NodeProps } from "@xyflow/react";
import { Layers } from "lucide-react";
import { cn } from "@/lib/utils";

export interface GroupNodeData {
  label?: string;
  color?: string; // accent | purple | green | orange | red — maps to CSS vars
}

// Map semantic color names to CSS variable pairs (background tint + border)
const COLOR_MAP: Record<string, { bg: string; border: string; text: string }> = {
  accent:  { bg: "var(--accent-dim)",                    border: "var(--accent)",   text: "var(--accent)" },
  purple:  { bg: "color-mix(in srgb, var(--accent) 8%, transparent)",   border: "color-mix(in srgb, var(--accent) 40%, transparent)",   text: "var(--accent)" },
  green:   { bg: "color-mix(in srgb, var(--success) 8%, transparent)",  border: "color-mix(in srgb, var(--success) 40%, transparent)",  text: "var(--success)" },
  orange:  { bg: "color-mix(in srgb, var(--warning) 8%, transparent)",  border: "color-mix(in srgb, var(--warning) 40%, transparent)",  text: "var(--warning)" },
  red:     { bg: "color-mix(in srgb, var(--danger) 8%, transparent)",   border: "color-mix(in srgb, var(--danger) 40%, transparent)",   text: "var(--danger)" },
};

const DEFAULT_COLOR = COLOR_MAP.accent;

export const GroupNode = memo(function GroupNode({ data, selected }: NodeProps) {
  const d = data as unknown as GroupNodeData;
  const colors = (d.color && COLOR_MAP[d.color]) ? COLOR_MAP[d.color] : DEFAULT_COLOR;

  return (
    <>
      <NodeResizer
        minWidth={160}
        minHeight={100}
        isVisible={selected}
        lineStyle={{ stroke: colors.border, strokeWidth: 1 }}
        handleStyle={{ background: colors.border, border: "none", borderRadius: 2, width: 8, height: 8 }}
      />
      <div
        className={cn(
          "w-full h-full rounded-2xl border transition-colors",
          selected ? "border-dashed" : "border-solid"
        )}
        style={{
          background: colors.bg,
          borderColor: selected ? colors.border : colors.border.replace("0.4", "0.2"),
        }}
      >
        {/* Header label — top-left, inside the group */}
        <div className="absolute top-2 left-3 flex items-center gap-1.5 pointer-events-none select-none">
          <Layers size={11} style={{ color: colors.text }} className="shrink-0" />
          <span
            className="text-[11px] font-semibold leading-none"
            style={{ color: colors.text }}
          >
            {d.label || "Group"}
          </span>
        </div>
      </div>
      {/* Handles so React Flow doesn't error if edges reference this node */}
      <Handle type="target" position={Position.Left} className="opacity-0 !pointer-events-none" />
      <Handle type="source" position={Position.Right} className="opacity-0 !pointer-events-none" />
    </>
  );
});
