"use client";

import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, SyntheticEvent } from "react";
import { Code2, Copy, ExternalLink, Hash, MessageSquare, Terminal, Trash2 } from "lucide-react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuTrigger, CONTEXT_MENU_DANGER,
} from "@/components/ui/context-menu";
import { cn, formatDateCompact } from "@/lib/utils";
import type { SessionKind } from "@/types";
import type { SessionSummary } from "@/lib/session-registry";
import { IconButton } from "@/components/ui/icon-button";

export function kindLabel(kind: SessionKind): string {
  if (kind === "chat") return "Chat";
  if (kind === "coding") return "Coding";
  return "Terminal";
}

export function SessionTypeIcon({ kind, size }: { kind: SessionKind; size: number }) {
  if (kind === "chat") return <MessageSquare size={size} />;
  if (kind === "coding") return <Code2 size={size} />;
  return <Terminal size={size} />;
}

export interface SessionRowProps {
  session: SessionSummary;
  selected: boolean;
  running: boolean;
  onSelect: () => void;
  onRemove?: (event: SyntheticEvent) => void;
  tabIndex?: number;
  /** Single-line sidebar-tree density: icon + title with the date right-aligned
   *  (mirroring the Views rows' shortcut position). Drops the "Kind ·" prefix —
   *  the icon already encodes it — full detail stays in the title tooltip. */
  compact?: boolean;
}

/** One session entry — shared by the sidebar tree, dropdown, and popout so
 *  all surfaces stay on the same type scale, spacing, and selection treatment.
 *  Outer wrapper is roving-focus neutral (role=presentation); the inner div
 *  carries role=option so the delete button is NOT nested inside an option. */
export function SessionRow({ session, selected, running, onSelect, onRemove: onRemoveProp, tabIndex, compact = false }: SessionRowProps) {
  // A running session can't be deleted — stop it first. (The store aborts the
  // live loop on delete, which would silently kill the turn mid-flight.)
  const onRemove = running ? undefined : onRemoveProp;
  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    } else if ((e.key === "Delete" || e.key === "Backspace") && onRemove) {
      e.preventDefault();
      e.stopPropagation();
      onRemove(e);
    }
  }
  const optionTabIndex = tabIndex !== undefined ? tabIndex : (selected ? 0 : -1);
  const fullLabel = `${session.title} — ${kindLabel(session.kind)} · ${formatDateCompact(session.updatedAt)}${session.mode === "plan" ? " · plan" : ""}`;
  const withMenu = (row: ReactElement) => (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onSelect}>
          <ExternalLink size={13} /> Open session
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(session.title)}>
          <Copy size={13} /> Copy title
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(session.id)}>
          <Hash size={13} /> Copy session ID
        </ContextMenuItem>
        {onRemove && session.kind !== "terminal" && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onRemove({ stopPropagation() {} } as unknown as SyntheticEvent)} className={CONTEXT_MENU_DANGER}>
              <Trash2 size={13} /> Delete session
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
  if (compact) {
    return withMenu(
      <div role="presentation" className="group relative flex items-center gap-1">
        <div
          role="option"
          aria-selected={selected}
          aria-label={fullLabel}
          aria-keyshortcuts={onRemove ? "Delete" : undefined}
          tabIndex={optionTabIndex}
          onClick={onSelect}
          onKeyDown={handleKeyDown}
          title={fullLabel}
          className={cn(
            "relative overflow-hidden flex flex-1 min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] cursor-pointer",
            selected
              ? "bg-[var(--accent-dim)] text-[var(--accent)]"
              : running
                ? "bg-[color-mix(in_srgb,var(--accent-dim)_30%,transparent)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]",
          )}
        >
          <span className={cn("flex-shrink-0", selected ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]")}>
            <SessionTypeIcon kind={session.kind} size={13} />
          </span>
          <span className="min-w-0 flex-1 truncate">{session.title}</span>
          <span className="ml-auto flex-shrink-0 text-2xs tabular-nums text-[var(--text-tertiary)] group-hover:opacity-0 transition-opacity">
            {formatDateCompact(session.updatedAt)}
          </span>
          {session.mode === "plan" && <span className="flex-shrink-0 text-2xs text-[var(--warning)]">plan</span>}
          {running && (
            <>
              <span className="pointer-events-none absolute bottom-0 left-0 right-0 h-[2px] bg-[color-mix(in_srgb,var(--border)_60%,transparent)]" aria-hidden />
              <span className="pointer-events-none absolute bottom-0 left-0 h-[2px] w-[42%] bg-[var(--accent)] animate-cairn-indeterminate" aria-hidden />
              <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">running</span>
            </>
          )}
        </div>
        {onRemove && session.kind !== "terminal" && (
          <IconButton
            label={`Delete ${kindLabel(session.kind).toLowerCase()} session`}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(e);
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] focus-visible:text-[var(--danger)] transition-opacity duration-150"
          >
            <Trash2 size={12} />
          </IconButton>
        )}
      </div>
    );
  }
  return withMenu(
    <div role="presentation" className="group relative flex items-center gap-1">
        <div
          role="option"
          aria-selected={selected}
          aria-keyshortcuts={onRemove ? "Delete" : undefined}
          tabIndex={optionTabIndex}
          onClick={onSelect}
          onKeyDown={handleKeyDown}
          className={cn(
            "relative overflow-hidden flex flex-1 min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] cursor-pointer",
            // Same selection treatment as the compact rows, Select and Combobox:
            // an accent-dim fill, no side stripe.
            selected
              ? "bg-[var(--accent-dim)]"
              : running
                ? "bg-[color-mix(in_srgb,var(--accent-dim)_30%,transparent)] hover:bg-[var(--surface-2)]"
                : "hover:bg-[var(--surface-2)]",
          )}
        >
        <div className="flex items-center gap-2 flex-1 min-w-0 text-left">
          <span className={cn("flex-shrink-0", selected ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]")}>
            <SessionTypeIcon kind={session.kind} size={13} />
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate text-xs", selected ? "text-[var(--accent)] font-medium" : "text-[var(--text-primary)]")}>{session.title}</span>
            <span className="flex items-center gap-1.5 mt-0.5 text-xs text-[var(--text-tertiary)]">
              <span>{kindLabel(session.kind)}</span>
              <span aria-hidden>·</span>
              <span>{formatDateCompact(session.updatedAt)}</span>
              {session.mode === "plan" && <span className="text-[var(--warning)]">plan</span>}
            </span>
          </span>
          </div>
          {running && (
            <>
              <span className="pointer-events-none absolute bottom-0 left-0 right-0 h-[2px] bg-[color-mix(in_srgb,var(--border)_60%,transparent)]" aria-hidden />
              <span className="pointer-events-none absolute bottom-0 left-0 h-[2px] w-[42%] bg-[var(--accent)] animate-cairn-indeterminate" aria-hidden />
              <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">running</span>
            </>
          )}
        </div>
       {onRemove && session.kind !== "terminal" && (
        <IconButton
          label={`Delete ${kindLabel(session.kind).toLowerCase()} session`}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(e);
          }}
          className="w-7 h-7 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] focus-visible:text-[var(--danger)] transition-opacity duration-150"
        >
          <Trash2 size={12} />
        </IconButton>
      )}
    </div>
  );
}
