"use client";

import type { KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from "react";
import { Code2, MessageSquare, Terminal, Trash2 } from "lucide-react";
import { cn, formatDateCompact } from "@/lib/utils";
import type { SessionKind } from "@/types";
import type { SessionSummary } from "@/lib/session-registry";

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
}

/** One session entry — shared by the sidebar tree, dropdown, and popout so
 *  all surfaces stay on the same type scale, spacing, and selection treatment.
 *  Outer wrapper is roving-focus neutral (role=presentation); the inner div
 *  carries role=option so the delete button is NOT nested inside an option. */
export function SessionRow({ session, selected, running, onSelect, onRemove, tabIndex }: SessionRowProps) {
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
  return (
    <div role="presentation" className="group relative flex items-center gap-1">
        <div
          role="option"
          aria-selected={selected}
          aria-keyshortcuts={onRemove ? "Delete" : undefined}
          tabIndex={optionTabIndex}
          onClick={onSelect}
          onKeyDown={handleKeyDown}
          className={cn(
            "relative overflow-hidden flex flex-1 min-w-0 items-center gap-2 rounded-md border-l-2 px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] cursor-pointer",
            selected
              ? "border-l-[var(--accent)] bg-[var(--accent-dim)]"
              : running
                ? "border-l-[var(--accent)]/60 bg-[var(--accent-dim)]/30"
                : "border-l-transparent hover:bg-[var(--surface-2)]",
          )}
        >
        <div className="flex items-center gap-2 flex-1 min-w-0 text-left">
          <span className={cn("flex-shrink-0", selected ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]")}>
            <SessionTypeIcon kind={session.kind} size={13} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs text-[var(--text-primary)]">{session.title}</span>
            <span className="flex items-center gap-1.5 mt-0.5 text-[0.714rem] text-[var(--text-tertiary)]">
              <span>{kindLabel(session.kind)}</span>
              <span aria-hidden>·</span>
              <span>{formatDateCompact(session.updatedAt)}</span>
              {session.mode === "plan" && <span className="text-[var(--warning)]">plan</span>}
            </span>
          </span>
          </div>
          {running && (
            <>
              <span className="pointer-events-none absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--border)]/60" aria-hidden />
              <span className="pointer-events-none absolute bottom-0 left-0 h-[2px] w-[42%] bg-[var(--accent)] animate-cairn-indeterminate" aria-hidden />
              <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">running</span>
            </>
          )}
        </div>
       {onRemove && session.kind !== "terminal" && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Delete ${kindLabel(session.kind).toLowerCase()} session`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(e);
          }}
          className="flex-shrink-0 grid place-items-center w-7 h-7 rounded opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] focus-visible:text-[var(--danger)] transition-opacity duration-150"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}
