"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Lightbulb, CheckSquare } from "lucide-react";
import { FlowNodeShell, FLOW_HANDLE_CLASS } from "./flow-node-shell";
import { IconButton } from "@/components/ui/icon-button";

export interface IdeaNodeData {
  title: string;
  body?: string;
  /** Injected by flow-view — promotes this idea to a task card */
  onPromote?: (nodeId: string) => void;
}

export const IdeaNode = memo(function IdeaNode({ id, data, selected, isConnectable }: NodeProps) {
  const d = data as unknown as IdeaNodeData;
  return (
    <FlowNodeShell selected={selected} maxWidth="max-w-[280px]">
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} className={FLOW_HANDLE_CLASS} />
      <div className="px-3 pt-2.5 pb-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 min-w-0">
            <Lightbulb size={13} className="text-[var(--accent)] shrink-0 mt-0.5" />
            <p className="text-xs font-semibold text-[var(--text-primary)] leading-snug break-words">
              {d.title || "Untitled idea"}
            </p>
          </div>
          {d.onPromote && (
            <IconButton
              label="Promote to task"
              onClick={(e) => { e.stopPropagation(); d.onPromote!(id); }}
              className="size-auto nodrag p-0.5 text-[var(--text-tertiary)] hover:text-[var(--accent)]"
            >
              <CheckSquare size={11} />
            </IconButton>
          )}
        </div>
        {d.body && (
          <p className="mt-1.5 text-sm text-[var(--text-tertiary)] leading-relaxed line-clamp-3 break-words pl-5 whitespace-pre-wrap">
            {d.body}
          </p>
        )}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} className={FLOW_HANDLE_CLASS} />
    </FlowNodeShell>
  );
});
