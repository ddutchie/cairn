"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

interface OverflowPillProps {
  count: number;
  names: string[];
  /** When provided, the pill becomes a button (used to expand/collapse). */
  onClick?: () => void;
  /** Label override — defaults to "+N". */
  label?: string;
  /** Overrides the names-based tooltip (e.g. a collapse hint). */
  tooltip?: string;
  className?: string;
}

/** Preview this many hidden item names before trailing "+N more". */
const TOOLTIP_NAME_PREVIEW = 5;

function previewNames(names: string[]): string {
  if (names.length === 0) return "More";
  if (names.length <= TOOLTIP_NAME_PREVIEW) return names.join(", ");
  const rest = names.length - TOOLTIP_NAME_PREVIEW;
  return `${names.slice(0, TOOLTIP_NAME_PREVIEW).join(", ")}… +${rest} more`;
}

/**
 * Compact "+N" pill shown when a list is capped (tags, artifact chips, etc.),
 * styled to sit beside `<Badge size="xs">`. Hover reveals the hidden names;
 * passing onClick turns it into an expand/collapse toggle.
 */
export function OverflowPill({ count, names, onClick, label, tooltip, className }: OverflowPillProps) {
  const pillClasses = cn(
    "inline-flex items-center rounded border border-[var(--border)] px-1 py-0.5 text-[0.643rem] font-medium text-[var(--text-tertiary)] select-none",
    onClick
      ? "cursor-pointer bg-transparent transition-colors hover:text-[var(--text-secondary)] hover:border-[var(--text-tertiary)]"
      : "cursor-default",
    className,
  );
  const content = onClick ? (
    <button type="button" onClick={onClick} className={pillClasses}>
      {label ?? `+${count}`}
    </button>
  ) : (
    <span className={pillClasses}>
      {label ?? `+${count}`}
    </span>
  );
  return <Tooltip content={tooltip ?? previewNames(names)}>{content}</Tooltip>;
}
