"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface SegmentedControlOption<T> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

export interface SegmentedControlProps<T> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  /** Names the group for assistive tech. Required: a group of toggle
   *  buttons means nothing to a screen reader without it. */
  ariaLabel: string;
  /** "sm" fits a 36px toolbar (h-9 view headers). */
  size?: "sm" | "md";
}

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  className,
  ariaLabel,
  size = "md",
}: SegmentedControlProps<T>) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("flex flex-shrink-0 whitespace-nowrap border border-[var(--border)] overflow-hidden text-xs bg-[var(--surface)]", size === "sm" ? "rounded-md" : "rounded-lg", className)}>
      {options.map((opt, idx) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex-1 flex items-center justify-center gap-1 border-0",
              size === "sm" ? "py-0.5 px-2" : "py-1.5 px-1.5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] transition-colors cursor-pointer select-none font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]",
              active && "bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]",
              idx > 0 && "border-l border-[var(--border)]"
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
