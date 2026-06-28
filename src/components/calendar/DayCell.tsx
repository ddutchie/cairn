"use client";

/**
 * DayCell — a single day in the month/week grid. Presentational: the DnD card
 * makes this a droppable by passing droppableRef + isOver. Renders its task
 * chips and a "+N more" affordance when there are too many to show.
 */

import { cn } from "@/lib/utils";
import { TaskChip } from "./TaskChip";
import type { CalendarCell } from "./calendar-utils";
import type { TaskCard } from "@/types";
import type { ReactNode } from "react";

interface DayCellProps {
  cell: CalendarCell;
  cards: TaskCard[];
  /** Week view gives cells more vertical room → show more chips. */
  maxVisible?: number;
  onOpenCard?: (cardId: string) => void;
  /** Called when the "+N more" affordance is clicked (month view). */
  onShowMore?: (cell: CalendarCell, cards: TaskCard[]) => void;
  /** DnD wiring (optional). */
  droppableRef?: (el: HTMLElement | null) => void;
  isOver?: boolean;
  /** Override chip rendering (e.g. to wrap in a draggable). */
  renderChip?: (card: TaskCard) => ReactNode;
}

export function DayCell({
  cell,
  cards,
  maxVisible = 3,
  onOpenCard,
  onShowMore,
  droppableRef,
  isOver,
  renderChip,
}: DayCellProps) {
  const dayNum = cell.date.getDate();
  const visible = cards.slice(0, maxVisible);
  const overflow = cards.length - visible.length;

  return (
    <div
      ref={droppableRef}
      className={cn(
        "flex flex-col h-full min-h-0 border-b border-r border-[var(--border)] p-1 gap-0.5 overflow-hidden transition-colors",
        // In-month cells sit on the surface; out-of-month recede into the background.
        cell.inMonth ? "bg-[var(--surface)]" : "bg-[var(--background)]",
        // Today's whole cell gets a soft accent wash so it reads at a glance.
        cell.isToday && "bg-[color-mix(in_srgb,var(--accent)_8%,var(--surface))]",
        isOver && "bg-[color-mix(in_srgb,var(--accent)_18%,var(--surface))] ring-1 ring-inset ring-[var(--accent)]",
      )}
    >
      <div className="flex items-center justify-between px-0.5">
        <span
          className={cn(
            "inline-flex items-center justify-center text-[0.643rem] font-semibold tabular-nums",
            cell.isToday
              ? "h-[1.125rem] min-w-[1.125rem] px-1 rounded-full bg-[var(--accent)] text-[var(--accent-fg)]"
              : cell.inMonth
                ? "text-[var(--text-secondary)]"
                : "text-[var(--text-tertiary)] opacity-70",
          )}
        >
          {dayNum}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 overflow-y-auto min-h-0">
        {visible.map((card) =>
          renderChip ? renderChip(card) : <TaskChip key={card.id} card={card} onOpen={onOpenCard} />,
        )}
        {overflow > 0 && (
          <button
            type="button"
            onClick={() => onShowMore?.(cell, cards)}
            className="px-1 py-0.5 text-left text-[0.6rem] font-medium text-[var(--text-tertiary)] rounded hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            +{overflow} more
          </button>
        )}
      </div>
    </div>
  );
}
