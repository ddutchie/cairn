"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Lightbulb, CheckSquare } from "lucide-react";
import { cn } from "@/lib/utils";

export interface IdeaNodeData {
  title: string;
  body?: string;
  /** Injected by flow-view — promotes this idea to a task card */
  onPromote?: (nodeId: string) => void;
}

export const IdeaNode = memo(function IdeaNode({ id, data, selected, isConnectable }: NodeProps) {
  const d = data as unknown as IdeaNodeData;
  return (
    <div
      className={cn(
        "min-w-[180px] max-w-[280px] rounded-xl border bg-[var(--surface)] shadow-sm transition-shadow",
        selected
          ? "border-[var(--accent)] shadow-[0_0_0_2px_var(--accent-dim)]"
          : "border-[var(--border)] hover:border-[var(--border-hover)]"
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} className="!bg-[var(--accent)] !border-[var(--surface)] !w-2.5 !h-2.5" />
      <div className="px-3 pt-2.5 pb-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 min-w-0">
            <Lightbulb size={13} className="text-[var(--accent)] shrink-0 mt-0.5" />
            <p className="text-xs font-semibold text-[var(--text-primary)] leading-snug break-words">
              {d.title || "Untitled idea"}
            </p>
          </div>
          {d.onPromote && (
            <button
              onClick={(e) => { e.stopPropagation(); d.onPromote!(id); }}
              title="Promote to task"
              className="nodrag shrink-0 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors"
            >
              <CheckSquare size={11} />
            </button>
          )}
        </div>
        {d.body && (
          <p className="mt-1.5 text-[0.786rem] text-[var(--text-tertiary)] leading-relaxed line-clamp-3 break-words pl-5 whitespace-pre-wrap">
            {d.body}
          </p>
        )}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} className="!bg-[var(--accent)] !border-[var(--surface)] !w-2.5 !h-2.5" />
    </div>
  );
});
