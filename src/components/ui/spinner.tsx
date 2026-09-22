"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface SpinnerProps {
  /** Icon size in px — matches the lucide `size` values used across the app (9–18). */
  size?: number;
  /** Colour tone. `inherit` (default) keeps the surrounding text colour so this
   *  is a drop-in for `<Loader2 className="animate-spin" />`. */
  tone?: "inherit" | "accent" | "muted";
  className?: string;
}

/**
 * Single loading-spinner primitive. Replaces every hand-rolled
 * `<Loader2 size={N} className="... animate-spin" />` (~60 call sites).
 */
export function Spinner({ size = 12, tone = "inherit", className }: SpinnerProps) {
  return (
    <Loader2
      size={size}
      aria-hidden="true"
      className={cn(
        "animate-spin shrink-0",
        tone === "accent" && "text-[var(--accent)]",
        tone === "muted" && "text-[var(--text-tertiary)]",
        className
      )}
    />
  );
}

interface RefreshSpinProps {
  size?: number;
  /** When true the refresh icon spins (loading); otherwise it renders static. */
  spinning?: boolean;
  className?: string;
}

/**
 * Refresh-icon variant for sync/reload affordances whose spin is conditional
 * (`<RefreshCw className={busy && "animate-spin"} />`). Defaults to spinning
 * so static `<RefreshCw className="animate-spin" />` loading indicators map
 * over unchanged.
 */
export function RefreshSpin({ size = 12, spinning = true, className }: RefreshSpinProps) {
  return (
    <RefreshCw
      size={size}
      aria-hidden="true"
      className={cn(spinning && "animate-spin", className)}
    />
  );
}
