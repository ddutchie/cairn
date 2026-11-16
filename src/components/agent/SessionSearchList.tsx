"use client";

import { useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject, type SyntheticEvent } from "react";
import { Search, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { SessionRow } from "./SessionRow";
import type { SessionSummary } from "@/lib/session-registry";

// ── Search input ─────────────────────────────────────────────────────────────

interface SessionSearchInputProps {
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  clearLabel: string;
  clearButtonClassName: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  /** Listbox the Arrow keys jump into. */
  listRef: RefObject<HTMLDivElement | null>;
  /** Escape behavior differs per surface (clear-only vs clear-then-close). */
  onEscape: () => void;
}

export function SessionSearchInput({
  query,
  onQueryChange,
  placeholder,
  clearLabel,
  clearButtonClassName,
  inputRef,
  autoFocus,
  listRef,
  onEscape,
}: SessionSearchInputProps) {
  const fallbackRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-[var(--surface-2)] px-2 py-1">
      <Search size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
      <input
        ref={inputRef ?? fallbackRef}
        autoFocus={autoFocus}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onEscape();
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
            e.preventDefault();
            const options = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
            if (!options || options.length === 0) return;
            if (e.key === "ArrowDown") options[0]?.focus();
            else options[options.length - 1]?.focus();
          }
        }}
        placeholder={placeholder}
        className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
      />
      {query && <IconButton label={clearLabel} onClick={() => onQueryChange("")} className={clearButtonClassName}><X size={11} /></IconButton>}
    </div>
  );
}

// ── Row list ─────────────────────────────────────────────────────────────────

interface SessionSearchListProps {
  sessions: SessionSummary[];
  activeId?: string | null;
  isRunning: (session: SessionSummary) => boolean;
  onSelect: (session: SessionSummary) => void;
  onRemove?: (event: SyntheticEvent, session: SessionSummary) => void;
  compact?: boolean;
  listboxId: string;
  ariaLabel: string;
  emptyText: string;
  emptyClassName?: string;
  listClassName?: string;
  listRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}

export function SessionSearchList({
  sessions,
  activeId,
  isRunning,
  onSelect,
  onRemove,
  compact,
  listboxId,
  ariaLabel,
  emptyText,
  emptyClassName = "px-2 py-2 text-center text-xs text-[var(--text-tertiary)]",
  listClassName = "flex-1 min-h-0 overflow-y-auto pb-1 space-y-0.5",
  listRef,
  onKeyDown,
}: SessionSearchListProps) {
  const hasActive = activeId != null;
  return (
    <div
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={listClassName}
    >
      {sessions.length === 0 ? (
        <p className={emptyClassName}>{emptyText}</p>
      ) : sessions.map((session, index) => {
        const selected = activeId === session.id;
        return (
          <SessionRow
            key={session.id}
            session={session}
            selected={selected}
            running={isRunning(session)}
            tabIndex={selected ? 0 : !hasActive && index === 0 ? 0 : -1}
            onSelect={() => void onSelect(session)}
            onRemove={onRemove ? (event) => onRemove(event, session) : undefined}
            compact={compact}
          />
        );
      })}
    </div>
  );
}
