"use client";

import { cn } from "@/lib/utils";

export interface ToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible label (rendered as aria-label). */
  label?: string;
  id?: string;
  className?: string;
}

/**
 * Canonical switch/toggle primitive. Replaces the ad-hoc `role="switch"` +
 * `inline-flex h-5 w-9 rounded-full` markup that was reimplemented across
 * settings and onboarding. Colours via CSS vars; includes a focus ring and
 * disabled state.
 */
export function Toggle({
  checked,
  onCheckedChange,
  disabled,
  label,
  id,
  className,
}: ToggleProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex items-center h-5 w-9 rounded-full transition-colors duration-200 flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        checked ? "bg-[var(--accent)]" : "bg-[var(--surface-3)] border border-[var(--border)]",
        disabled && "opacity-40 cursor-default",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-[var(--surface)] shadow-sm transition-transform",
          checked ? "translate-x-4.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
