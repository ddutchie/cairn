"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FlowNodeShellProps {
  selected?: boolean;
  /**
   * `default` — neutral border, accent ring when selected (idea / note_ref /
   * task_ref / url nodes). `accent` — always accent-tinted border
   * (ai_summary node).
   */
  tone?: "default" | "accent";
  minWidth?: string;
  maxWidth?: string;
  className?: string;
  children: ReactNode;
}

/** Shared connection-handle styling for flow nodes. */
export const FLOW_HANDLE_CLASS = "!bg-[var(--accent)] !border-[var(--surface)] !w-2.5 !h-2.5";

/**
 * Single card shell for React Flow nodes. Merges the 5 copy-pasted
 * `min-w-[180px] max-w-[2xxpx] rounded-xl border …` shells (Url / Idea /
 * NoteRef / TaskRef / AiSummary). GroupNode stays bespoke (resizer, no card).
 */
export function FlowNodeShell({
  selected = false,
  tone = "default",
  minWidth = "min-w-[180px]",
  maxWidth = "max-w-[260px]",
  className,
  children,
}: FlowNodeShellProps) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-[var(--surface)] shadow-sm transition-shadow",
        minWidth,
        maxWidth,
        selected
          ? "border-[var(--accent)] shadow-[0_0_0_2px_var(--accent-dim)]"
          : tone === "accent"
            ? "border-[var(--accent)]/30 hover:border-[var(--accent)]/60"
            : "border-[var(--border)] hover:border-[var(--border-hover)]",
        className
      )}
    >
      {children}
    </div>
  );
}
