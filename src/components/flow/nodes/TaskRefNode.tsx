"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CheckSquare, ExternalLink } from "lucide-react";
import { cn, PRIORITY_COLORS } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { CairnEvents } from "@/lib/events";

export interface TaskRefNodeData {
  cardId?: string;
  resolvedTitle?: string;
  resolvedPriority?: string;
  resolvedColumnName?: string;
}

export const TaskRefNode = memo(function TaskRefNode({ data, selected, isConnectable }: NodeProps) {
  const d = data as unknown as TaskRefNodeData;
  const setView = useCairnStore((s) => s.setView);
  const hasCard = Boolean(d.cardId && d.resolvedTitle);

  function handleOpen(e: React.MouseEvent) {
    e.stopPropagation();
    setView("board");
    if (d.cardId) window.dispatchEvent(CairnEvents.openCard(d.cardId));
  }

  return (
    <div
      className={cn(
        "min-w-[180px] max-w-[260px] rounded-xl border bg-[var(--surface)] shadow-sm transition-shadow",
        selected
          ? "border-[var(--accent)] shadow-[0_0_0_2px_var(--accent-dim)]"
          : "border-[var(--border)] hover:border-[var(--border-hover)]"
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} className="!bg-[var(--accent)] !border-[var(--surface)] !w-2.5 !h-2.5" />
      <div className="px-3 pt-2.5 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <CheckSquare size={12} className="text-[var(--text-tertiary)] shrink-0" />
            <span className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">Task</span>
          </div>
          {hasCard && (
            <button
              onClick={handleOpen}
              className="nodrag p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors"
              title="Open board"
            >
              <ExternalLink size={11} />
            </button>
          )}
        </div>
        {hasCard ? (
          <>
            <p className="mt-1 text-xs font-semibold text-[var(--text-primary)] leading-snug break-words">
              {d.resolvedTitle}
            </p>
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              {d.resolvedPriority && (
                <span className={cn(
                  "text-[10px] font-medium px-1.5 py-0.5 rounded-full border border-[var(--border)]",
                  PRIORITY_COLORS[d.resolvedPriority as keyof typeof PRIORITY_COLORS]
                )}>
                  {d.resolvedPriority}
                </span>
              )}
              {d.resolvedColumnName && (
                <span className="text-[10px] text-[var(--text-tertiary)] px-1.5 py-0.5 rounded-full border border-[var(--border)]">
                  {d.resolvedColumnName}
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="mt-1 text-[11px] text-[var(--text-tertiary)] italic">No task linked</p>
        )}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} className="!bg-[var(--accent)] !border-[var(--surface)] !w-2.5 !h-2.5" />
    </div>
  );
});
