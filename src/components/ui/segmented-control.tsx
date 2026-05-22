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
}

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div className={cn("flex rounded-lg border border-[var(--border)] overflow-hidden text-xs bg-[var(--surface)]", className)}>
      {options.map((opt, idx) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 transition-colors cursor-pointer select-none font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]",
              active && "bg-[var(--accent)] text-white hover:bg-[var(--accent)] hover:text-white",
              idx > 0 && !active && "border-l border-[var(--border)]"
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
