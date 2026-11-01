"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "./button";
import { CountBadge } from "./count-badge";

export interface ViewTab<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  count?: number;
  /** Tooltip / longer description of the tab. */
  title?: string;
}

/**
 * The strip of view tabs at the top of a view (Board / Archive, the Insights
 * canvases): an h-9 bar, every tab labelled, scrolling sideways when it runs
 * out of room rather than hiding labels.
 */
export function ViewTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  children,
  className,
}: {
  tabs: ViewTab<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Right-aligned extras in the same bar. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2 px-4 h-9 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0", className)}>
      <div role="tablist" aria-label={ariaLabel} className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none">
        {tabs.map((tab) => {
          const active = tab.value === value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              title={tab.title}
              onClick={() => onChange(tab.value)}
              className={cn(
                "flex flex-shrink-0 items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
                FOCUS_RING,
                active
                  ? "bg-[var(--surface-2)] text-[var(--text-primary)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]",
              )}
            >
              {tab.icon}
              {tab.label}
              {tab.count !== undefined && <CountBadge count={tab.count} className="ml-0.5 px-1.5 py-0.5 text-2xs" />}
            </button>
          );
        })}
      </div>
      {children && <div className="ml-auto flex flex-shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
