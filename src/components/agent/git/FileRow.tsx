"use client";

import { Copy, Diff, File, Minus, Plus, RotateCcw } from "lucide-react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuTrigger, CONTEXT_MENU_DANGER,
} from "@/components/ui/context-menu";
import { RefreshSpin } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { statusLabel, statusColor } from "./git-helpers";
import { InlineDiff } from "./InlineDiff";
import { IconButton } from "@/components/ui/icon-button";

/** One changed file: hover stage/unstage + discard actions, name, +/- stat, status chip, and an expandable inline diff. */
export function FileRow({
  path, status, onAction, actionLabel, actionColor,
  stat, rawDiff, expanded, loading, onToggle, onDiscard, discardArmed,
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
  /** Two-step discard confirm: first click arms (highlighted), second fires. */
  discardArmed?: boolean;
}) {
  const hasDiffStats = stat && (stat.added > 0 || stat.deleted > 0);
  return (
    <>
      <ContextMenu>
      <ContextMenuTrigger asChild>
      <div
        role="button"
        tabIndex={0}
        className="flex items-center gap-2 px-6 py-1.5 hover:bg-[var(--surface-2)] transition-colors group cursor-pointer"
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
        }}
      >
        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
          <Tooltip content={actionLabel === "+" ? "Stage changes in this file" : "Unstage changes in this file"}>
            <button
              onClick={onAction}
              className="w-4 h-4 rounded flex items-center justify-center text-2xs font-bold hover:scale-110 transition-transform cursor-pointer"
              style={{ color: actionColor, backgroundColor: `color-mix(in srgb, ${actionColor} 15%, transparent)` }}
            >
              {actionLabel}
            </button>
          </Tooltip>
          <IconButton
            label={discardArmed ? "Click again to discard all changes in this file" : "Discard all changes in this file"} tooltipSide="top"
            onClick={onDiscard}
            className="w-4 h-4 text-[var(--danger)] hover:scale-110 transition-transform cursor-pointer"
            style={{ backgroundColor: discardArmed
              ? `color-mix(in srgb, var(--danger) 35%, transparent)`
              : `color-mix(in srgb, var(--danger) 15%, transparent)` }}
          >
            <RotateCcw size={10} />
          </IconButton>
        </div>
        <File size={9} className="text-[var(--text-tertiary)] flex-shrink-0 opacity-50" />
        <span className="text-xs text-[var(--text-primary)] font-mono truncate flex-1">{path}</span>
        {hasDiffStats && (
          <span className="text-2xs font-mono flex-shrink-0 space-x-1">
            <span className="text-[var(--success)]">+{stat.added}</span>
            <span className="text-[var(--danger)]">-{stat.deleted}</span>
          </span>
        )}
        {loading && (
          <RefreshSpin size={10} className="text-[var(--text-tertiary)]" />
        )}
        <span
          className="text-2xs px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ color: statusColor(status), backgroundColor: `color-mix(in srgb, ${statusColor(status)} 10%, transparent)` }}
        >
          {statusLabel(status)}
        </span>
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onToggle}>
          <Diff size={13} /> {expanded ? "Hide diff" : "Show diff"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onAction}>
          {actionLabel === "+" ? <Plus size={13} /> : <Minus size={13} />}
          {actionLabel === "+" ? "Stage file" : "Unstage file"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(path)}>
          <Copy size={13} /> Copy path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onDiscard} className={CONTEXT_MENU_DANGER}>
          <RotateCcw size={13} /> {discardArmed ? "Click again to confirm discard" : "Discard changes"}
        </ContextMenuItem>
      </ContextMenuContent>
      </ContextMenu>
      {expanded && (
        <InlineDiff rawDiff={rawDiff} loading={loading} />
      )}
    </>
  );
}
