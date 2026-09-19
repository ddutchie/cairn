"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Link2, ExternalLink } from "lucide-react";
import { FlowNodeShell, FLOW_HANDLE_CLASS } from "./flow-node-shell";

export interface UrlNodeData {
  url: string;
  title?: string;
  description?: string;
}

export const UrlNode = memo(function UrlNode({ data, selected, isConnectable }: NodeProps) {
  const d = data as unknown as UrlNodeData;

  let hostname = "";
  try { hostname = new URL(d.url).hostname.replace(/^www\./, ""); } catch { /* invalid url */ }

  function handleOpen(e: React.MouseEvent) {
    e.stopPropagation();
    if (d.url) window.open(d.url, "_blank", "noopener,noreferrer");
  }

  return (
    <FlowNodeShell selected={selected}>
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} className={FLOW_HANDLE_CLASS} />
      <div className="px-3 pt-2.5 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Link2 size={12} className="text-[var(--text-tertiary)] shrink-0" />
            <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate" title={d.url}>{hostname || "URL"}</span>
          </div>
          {d.url && (
            <button
              onClick={handleOpen}
              className="nodrag p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              title="Open link"
              aria-label="Open link"
            >
              <ExternalLink size={11} />
            </button>
          )}
        </div>
        {d.title && (
          <p className="mt-1 text-xs font-semibold text-[var(--text-primary)] leading-snug break-words">
            {d.title}
          </p>
        )}
        {d.description && (
          <p className="mt-1 text-[0.786rem] text-[var(--text-tertiary)] line-clamp-2 break-words">
            {d.description}
          </p>
        )}
        {!d.title && d.url && (
          <p className="mt-1 text-[0.786rem] text-[var(--accent)] break-all line-clamp-2">{d.url}</p>
        )}
        {!d.title && !d.url && (
          <p className="mt-1 text-[0.786rem] text-[var(--text-tertiary)] italic">Double-click to add URL</p>
        )}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} className={FLOW_HANDLE_CLASS} />
    </FlowNodeShell>
  );
});
