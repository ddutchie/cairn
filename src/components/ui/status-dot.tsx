"use client";

import { cn } from "@/lib/utils";

interface StatusDotProps {
  /** CSS colour (typically a `var(--token)`). Overrides any `bg-*` class. */
  color?: string;
  size?: "xs" | "sm" | "md";
  /** Pulsing dot for live/active states. */
  pulse?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const SIZES = {
  xs: "w-1 h-1",
  sm: "w-1.5 h-1.5",
  md: "w-2 h-2",
} as const;

/**
 * Single status-dot primitive. Replaces the ~15 hand-rolled
 * `w-1.5 h-1.5 rounded-full bg-[...]` spans (settings health rows, legend
 * dots, dirty indicators, activity pulses).
 */
export function StatusDot({ color, size = "sm", pulse = false, className, style }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "rounded-full flex-shrink-0",
        SIZES[size],
        !color && "bg-[var(--text-tertiary)]",
        pulse && "animate-pulse",
        className
      )}
      style={color ? { backgroundColor: color, ...style } : style}
    />
  );
}
