"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Canonical section-header label: uppercase, letter-spaced, tertiary. Use for
 * the headline label above a section/group. Consolidates the ad-hoc
 * `text-[0.714rem] font-semibold uppercase tracking-*` fragments.
 */
export function SectionLabel({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "text-[0.714rem] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Canonical micro field label: the small uppercase caption under/next to
 * fields and rows. Consolidates the ad-hoc `text-[0.643rem] font-medium
 * uppercase tracking-*` fragments.
 */
export function MicroLabel({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "text-[0.643rem] font-medium uppercase tracking-wide text-[var(--text-tertiary)]",
        className,
      )}
      {...props}
    />
  );
}
