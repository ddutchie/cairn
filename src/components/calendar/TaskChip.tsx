"use client";

/**
 * TaskChip — a compact task representation inside a calendar day cell or tray.
 * Click opens the card detail modal (via the onOpen callback). The DnD card
 * wraps this in a draggable; this component stays presentational.
 */

import { Lock } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { PRIORITY_CSS_COLORS } from "@/lib/constants";
import type { TaskCard } from "@/types";

interface TaskChipProps {
  card: TaskCard;
  /** Render with overdue (danger) emphasis. */
  overdue?: boolean;
  onOpen?: (cardId: string) => void;
  /** Drag affordance — disables the click-to-open while dragging. */
  dragging?: boolean;
  /** Extra props (e.g. @dnd-kit listeners/attributes) spread onto the button. */
  dragProps?: React.HTMLAttributes<HTMLButtonElement>;
}

export const TaskChip = forwardRef<HTMLButtonElement, TaskChipProps>(function TaskChip(
  { card, overdue, onOpen, dragging, dragProps },
  ref,
) {
  const isBlocked = (card.blockedByIds ?? []).length > 0;

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => !dragging && onOpen?.(card.id)}
      title={card.title}
      {...dragProps}
      className={cn(
        "group w-full flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[0.643rem] leading-tight transition-colors",
        "border",
        dragging && "opacity-40",
        overdue
          ? "bg-[color-mix(in_srgb,var(--danger)_14%,var(--surface))] text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_30%,transparent)] hover:border-[var(--danger)]"
          : "bg-[var(--surface-2)] text-[var(--text-primary)] border-[var(--border-subtle)] hover:bg-[var(--surface-3)] hover:border-[var(--border)]",
      )}
    >
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: PRIORITY_CSS_COLORS[card.priority] ?? "var(--text-tertiary)" }}
        aria-hidden
      />
      <span className="truncate flex-1">{card.title}</span>
      {isBlocked && <Lock size={9} className="flex-shrink-0 text-[var(--warning)]" aria-hidden />}
    </button>
  );
});
