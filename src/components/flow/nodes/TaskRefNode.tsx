"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CheckSquare, ExternalLink } from "lucide-react";
import { cn, PRIORITY_COLORS } from "@/lib/utils";
import { FlowNodeShell, FLOW_HANDLE_CLASS } from "./flow-node-shell";
import { useCairnStore } from "@/store";
import { revealCard } from "@/lib/events";

export interface TaskRefNodeData {
  cardId?: string;
  resolvedTitle?: string;
  resolvedPriority?: string;
  resolvedColumnName?: string;
}

export const TaskRefNode = memo(function TaskRefNode({ data, selected, isConnectable }: NodeProps) {
  const d = data as unknown as TaskRefNodeData;
  const setView = useCairnStore((s) => s.setView);
  const isLinked = Boolean(d.cardId);
  const hasCard = Boolean(d.cardId && d.resolvedTitle);
  const isDangling = isLinked && !hasCard;

  function handleOpen(e: React.MouseEvent) {
    e.stopPropagation();
    if (d.cardId) revealCard(setView, d.cardId);
  }

  return (
    <FlowNodeShell selected={selected}>
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} className={FLOW_HANDLE_CLASS} />
      <div className="px-3 pt-2.5 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <CheckSquare size={12} className="text-[var(--text-tertiary)] shrink-0" />
            <span className="text-[0.714rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">Task</span>
          </div>
          {hasCard && (
            <button
              onClick={handleOpen}
              className="nodrag p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              title="Open board"
              aria-label="Open board"
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
                  "text-[0.714rem] font-medium px-1.5 py-0.5 rounded-full border border-[var(--border)]",
                  PRIORITY_COLORS[d.resolvedPriority as keyof typeof PRIORITY_COLORS]
                )}>
                  {d.resolvedPriority}
                </span>
              )}
              {d.resolvedColumnName && (
                <span className="text-[0.714rem] text-[var(--text-tertiary)] px-1.5 py-0.5 rounded-full border border-[var(--border)]">
                  {d.resolvedColumnName}
                </span>
              )}
            </div>
          </>
        ) : isDangling ? (
          <p className="mt-1 text-[0.786rem] text-[var(--danger)] italic">Linked task not found</p>
        ) : (
          <p className="mt-1 text-[0.786rem] text-[var(--text-tertiary)] italic">No task linked</p>
        )}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} className={FLOW_HANDLE_CLASS} />
    </FlowNodeShell>
  );
});
