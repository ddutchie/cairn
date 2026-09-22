"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { FileText, ExternalLink } from "lucide-react";
import { FlowNodeShell, FLOW_HANDLE_CLASS } from "./flow-node-shell";
import { useCairnStore } from "@/store";
import { revealNote } from "@/lib/events";

export interface NoteRefNodeData {
  noteId?: string;
  resolvedTitle?: string;
  resolvedSnippet?: string;
}

export const NoteRefNode = memo(function NoteRefNode({ data, selected, isConnectable }: NodeProps) {
  const d = data as unknown as NoteRefNodeData;
  const setView = useCairnStore((s) => s.setView);
  const isLinked = Boolean(d.noteId);
  const hasNote = Boolean(d.noteId && d.resolvedTitle);
  const isDangling = isLinked && !hasNote;

  function handleOpen(e: React.MouseEvent) {
    e.stopPropagation();
    if (d.noteId) {
      revealNote(setView, d.noteId);
    }
  }

  return (
    <FlowNodeShell selected={selected}>
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} className={FLOW_HANDLE_CLASS} />
      <div className="px-3 pt-2.5 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <FileText size={12} className="text-[var(--text-tertiary)] shrink-0" />
            <span className="text-[0.714rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">Note</span>
          </div>
          {hasNote && (
            <button
              onClick={handleOpen}
              className="nodrag p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              title="Open note"
              aria-label="Open note"
            >
              <ExternalLink size={11} />
            </button>
          )}
        </div>
        {hasNote ? (
          <>
            <p className="mt-1 text-xs font-semibold text-[var(--text-primary)] leading-snug break-words">
              {d.resolvedTitle}
            </p>
            {d.resolvedSnippet && (
              <p className="mt-1 text-[0.786rem] text-[var(--text-tertiary)] line-clamp-2 break-words">
                {d.resolvedSnippet}
              </p>
            )}
          </>
        ) : isDangling ? (
          <p className="mt-1 text-[0.786rem] text-[var(--danger)] italic">Linked note not found</p>
        ) : (
          <p className="mt-1 text-[0.786rem] text-[var(--text-tertiary)] italic">No note linked</p>
        )}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} className={FLOW_HANDLE_CLASS} />
    </FlowNodeShell>
  );
});
