"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "./button";
import { CountBadge } from "./count-badge";
import { Tooltip } from "./tooltip";

export interface ViewTab<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  count?: number;
  /** Tooltip / longer description of the tab. */
  title?: string;
}

/** The id of a tab in a `ViewTabs` strip, for the panel's `aria-labelledby`. */
export function viewTabId(panelId: string, value: string): string {
  return `${panelId}-tab-${value}`;
}

/**
 * The strip of view tabs at the top of a view (Board / Archive, the Insights
 * canvases): an h-9 bar, every tab labelled, scrolling sideways when it runs
 * out of room rather than hiding labels.
 *
 * Keyboard: one tab stop; arrow keys, Home and End move between tabs and
 * select them. Pass `panelId` and give the content `role="tabpanel"`, that
 * id, and `aria-labelledby={viewTabId(panelId, value)}` to connect the two.
 */
export function ViewTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  panelId,
  children,
  className,
}: {
  tabs: ViewTab<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** The id of the panel the tabs control. */
  panelId?: string;
  /** Right-aligned extras in the same bar. */
  children?: React.ReactNode;
  className?: string;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);

  function onKeyDown(e: React.KeyboardEvent) {
    const i = tabs.findIndex((t) => t.value === value);
    const last = tabs.length - 1;
    const next =
      e.key === "ArrowRight" ? (i >= last ? 0 : i + 1)
      : e.key === "ArrowLeft" ? (i <= 0 ? last : i - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    onChange(tabs[next].value);
    listRef.current?.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
  }

  return (
    <div className={cn("flex items-center gap-2 px-4 h-9 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0", className)}>
      <div ref={listRef} role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown} className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none">
        {tabs.map((tab) => {
          const active = tab.value === value;
          return (
            <Tooltip key={tab.value} content={tab.title} disabled={!tab.title}>
              <button
                type="button"
                role="tab"
                id={panelId ? viewTabId(panelId, tab.value) : undefined}
                aria-selected={active}
                aria-controls={active ? panelId : undefined}
                tabIndex={active ? 0 : -1}
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
            </Tooltip>
          );
        })}
      </div>
      {children && <div className="ml-auto flex flex-shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
