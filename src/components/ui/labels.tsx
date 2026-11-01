"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Canonical section-header label: sentence case, medium weight, tertiary. Use
 * for the headline label above a section/group. Cairn labels are not set in
 * caps; the sidebar's group headers are the one deliberate exception.
 */
export function SectionLabel({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "text-xs font-medium text-[var(--text-tertiary)]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Canonical micro field label: the small caption under/next to fields and
 * rows, one step below SectionLabel.
 */
export function MicroLabel({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "text-2xs font-medium text-[var(--text-tertiary)]",
        className,
      )}
      {...props}
    />
  );
}
