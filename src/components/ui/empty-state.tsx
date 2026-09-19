"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** Optional icon rendered in a muted circle above the copy. */
  icon?: LucideIcon;
  /** Accent-tinted icon circle (e.g. agent/product surfaces) vs default muted. */
  iconTone?: "muted" | "accent";
  title?: ReactNode;
  description?: ReactNode;
  /** CTA rendered below the copy (e.g. `<Button size="sm">…</Button>`). */
  action?: ReactNode;
  children?: ReactNode;
  /**
   * Canvas-overlay mode: absolutely positioned over the parent
   * (`pointer-events-none`) for D3/graph canvases. Default is inline flow.
   */
  overlay?: boolean;
  className?: string;
}

/**
 * Single empty-state primitive. Merges the four one-off implementations
 * (`CanvasEmptyState`, `ConversationEmptyState`, `AgentEmptyState`,
 * `KnowledgeGraphView`'s private states) plus the ~30 inline
 * `No … yet` paragraphs scattered across views.
 */
export function EmptyState({
  icon: Icon,
  iconTone = "muted",
  title,
  description,
  action,
  children,
  overlay = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        overlay
          ? "absolute inset-0 flex items-center justify-center pointer-events-none"
          : "flex flex-col items-center justify-center flex-1 gap-2 text-center px-4 py-3",
        className
      )}
    >
      <div className="flex flex-col items-center gap-2 w-full">
        {Icon && (
          <div
            className={cn(
              "w-10 h-10 rounded-full flex items-center justify-center",
              iconTone === "accent"
                ? "bg-[var(--accent-dim)] border border-[color-mix(in_srgb,var(--accent)_20%,transparent)]"
                : "bg-[var(--surface-2)]"
            )}
          >
            <Icon
              size={18}
              aria-hidden="true"
              className={iconTone === "accent" ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]"}
            />
          </div>
        )}
        {title && (
          <p className="text-[0.786rem] font-medium text-[var(--text-secondary)]">{title}</p>
        )}
        {description && (
          <p className="text-[0.714rem] text-[var(--text-tertiary)] max-w-48">{description}</p>
        )}
        {action}
        {children}
      </div>
    </div>
  );
}
