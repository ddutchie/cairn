"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** Keyboard focus ring shared by Button and IconButton (mouse focus stays clean). */
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--background)]";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost" | "outline" | "danger" | "accent";
  size?: "xs" | "sm" | "md" | "lg" | "icon";
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-all duration-150 select-none",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          FOCUS_RING,
          // variants
          variant === "default" && "bg-[var(--surface-3)] text-[var(--text-primary)] hover:bg-[var(--border)] border border-[var(--border)]",
          variant === "ghost" && "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]",
          variant === "outline" && "border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--muted)] hover:text-[var(--text-primary)]",
          variant === "danger" && "bg-[var(--danger)]/10 text-[var(--danger)] border border-[var(--danger)]/20 hover:bg-[var(--danger)]/20",
          variant === "accent" && "bg-[var(--accent)] text-[var(--accent-fg,#fff)] hover:bg-[var(--accent-hover)] shadow-elev-1",
          // sizes
          size === "xs" && "h-6 px-2 text-xs gap-1",
          size === "sm" && "h-7 px-2.5 text-xs",
          size === "md" && "h-8 px-3 text-sm",
          size === "lg" && "h-9 px-4 text-sm",
          size === "icon" && "h-7 w-7 p-0",
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
