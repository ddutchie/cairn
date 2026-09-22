"use client";

import { cn } from "@/lib/utils";

interface CountBadgeProps {
  count: number;
  /** Accent (unread/alert) vs neutral (totals) vs surface (on-buttons). */
  tone?: "accent" | "neutral" | "surface";
  className?: string;
}

/**
 * Single numeric-pill primitive for counts: board/archive totals, nav unread
 * badges, queued/live overlays. Positioning stays at the call site via
 * `className` ( several are absolutely-positioned overlays).
 */
export function CountBadge({ count, tone = "neutral", className }: CountBadgeProps) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "rounded-full text-center font-semibold",
        tone === "accent" && "bg-[var(--accent)] text-[var(--accent-fg)]",
        tone === "neutral" && "bg-[var(--surface-3)] text-[var(--text-tertiary)]",
        tone === "surface" && "bg-[var(--surface-3)] border border-[var(--border)] text-[var(--text-secondary)]",
        className
      )}
    >
      {count}
    </span>
  );
}
