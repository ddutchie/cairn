"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Tooltip } from "./tooltip";
import { FOCUS_RING } from "./button";

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Required: becomes the tooltip and the accessible name. */
  label: string;
  /** Optional shortcut shown after the label in the tooltip, e.g. "⌘/". */
  shortcut?: string;
  /** ghost = no chrome until hover; outline = bordered well (header actions). */
  variant?: "ghost" | "outline";
  size?: "sm" | "md";
  /** Menu-open state: solid accent fill. */
  active?: boolean;
  /** Toggle that is on (e.g. a panel shown): accent tint, sets aria-pressed. */
  pressed?: boolean;
  /** Tooltip text when it should say more than the accessible name. */
  tooltip?: React.ReactNode;
  tooltipSide?: "top" | "bottom" | "left" | "right";
  /** Hide the tooltip (e.g. while this button's own menu is open). */
  tooltipDisabled?: boolean;
}

/**
 * Icon-only button. Every icon button needs a label, so it's a required prop
 * here rather than an easily forgotten `aria-label`: the same text drives the
 * tooltip. One shape (rounded-md) for every icon button in the app.
 */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    { label, shortcut, variant = "ghost", size = "md", active = false, pressed, tooltip, tooltipSide = "bottom", tooltipDisabled, className, children, type = "button", ...props },
    ref,
  ) => (
    <Tooltip content={tooltip ?? (shortcut ? `${label} (${shortcut})` : label)} side={tooltipSide} disabled={tooltipDisabled}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={pressed}
        className={cn(
          "grid place-items-center flex-shrink-0 rounded-md border transition-colors",
          "disabled:opacity-40 disabled:pointer-events-none",
          FOCUS_RING,
          size === "sm" ? "w-6 h-6" : "w-7 h-7",
          active
            ? "bg-[var(--accent)] text-[var(--accent-fg)] border-[var(--accent)]"
            : pressed
              ? "bg-[var(--accent-dim)] text-[var(--accent)] border-transparent"
              : variant === "outline"
              ? "bg-[var(--surface-2)] border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] hover:border-[var(--muted)]"
              : "border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  ),
);

IconButton.displayName = "IconButton";
