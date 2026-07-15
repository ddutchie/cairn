"use client";

import { ChevronRight, ChevronDown } from "lucide-react";

/** Collapsible section header (Staged / Modified / Untracked) wrapping its file rows. */
export function FileSection({
  label, count, expanded, onToggle, action, children,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        className="flex items-center gap-2 px-4 py-1.5 cursor-pointer hover:bg-[var(--surface-2)] transition-colors select-none"
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
        }}
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">{label}</span>
        <span className="text-[0.65rem] text-[var(--text-tertiary)] opacity-60">{count}</span>
        {action && (
          <div className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            {action}
          </div>
        )}
      </div>
      {expanded && (
        <div className="divide-y divide-[var(--border-subtle)] border-b border-[var(--border-subtle)]">
          {children}
        </div>
      )}
    </div>
  );
}
