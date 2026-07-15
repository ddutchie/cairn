"use client";

import { RefreshCw, File, RotateCcw } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { statusLabel, statusColor } from "./git-helpers";
import { InlineDiff } from "./InlineDiff";

/** One changed file: hover stage/unstage + discard actions, name, +/- stat, status chip, and an expandable inline diff. */
export function FileRow({
  path, status, onAction, actionLabel, actionColor,
  stat, rawDiff, expanded, loading, onToggle, onDiscard,
}: {
  path: string;
  status: string;
  onAction: () => void;
  actionLabel: string;
  actionColor: string;
  stat?: { added: number; deleted: number };
  rawDiff: string;
  expanded: boolean;
  loading: boolean;
  onToggle: () => void;
  onDiscard: () => void;
}) {
  const hasDiffStats = stat && (stat.added > 0 || stat.deleted > 0);
  return (
    <>
      <div
        className="flex items-center gap-2 px-6 py-1.5 hover:bg-[var(--surface-2)] transition-colors group cursor-pointer"
        onClick={onToggle}
      >
        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
          <Tooltip content={actionLabel === "+" ? "Stage changes in this file" : "Unstage changes in this file"}>
            <button
              onClick={onAction}
              className="w-4 h-4 rounded flex items-center justify-center text-[0.65rem] font-bold hover:scale-110 transition-transform cursor-pointer"
              style={{ color: actionColor, backgroundColor: `color-mix(in srgb, ${actionColor} 15%, transparent)` }}
            >
              {actionLabel}
            </button>
          </Tooltip>
          <Tooltip content="Discard all changes in this file">
            <button
              onClick={onDiscard}
              className="w-4 h-4 rounded flex items-center justify-center text-[var(--danger)] hover:scale-110 transition-transform cursor-pointer"
              style={{ backgroundColor: `color-mix(in srgb, var(--danger) 15%, transparent)` }}
            >
              <RotateCcw size={10} />
            </button>
          </Tooltip>
        </div>
        <File size={9} className="text-[var(--text-tertiary)] flex-shrink-0 opacity-50" />
        <span className="text-[0.714rem] text-[var(--text-primary)] font-mono truncate flex-1">{path}</span>
        {hasDiffStats && (
          <span className="text-[0.65rem] font-mono flex-shrink-0 space-x-1">
            <span className="text-[var(--success)]">+{stat.added}</span>
            <span className="text-[var(--danger)]">-{stat.deleted}</span>
          </span>
        )}
        {loading && (
          <RefreshCw size={10} className="animate-spin text-[var(--text-tertiary)]" />
        )}
        <span
          className="text-[0.65rem] font-mono px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ color: statusColor(status), backgroundColor: `color-mix(in srgb, ${statusColor(status)} 10%, transparent)` }}
        >
          {statusLabel(status)}
        </span>
      </div>
      {expanded && (
        <InlineDiff rawDiff={rawDiff} loading={loading} />
      )}
    </>
  );
}
