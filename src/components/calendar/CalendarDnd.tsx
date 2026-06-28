"use client";

/**
 * DnD wrappers for the calendar. Kept separate so DayCell/TaskChip stay
 * presentational and unit-friendly. These wire @dnd-kit's useDroppable /
 * useDraggable around them.
 */

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { DayCell } from "./DayCell";
import { TaskChip } from "./TaskChip";
import { UNSCHEDULED_DROP_ID } from "./calendar-dnd";
import { cn } from "@/lib/utils";
import type { CalendarCell } from "./calendar-utils";
import type { TaskCard } from "@/types";
import type { ReactNode } from "react";

/** Draggable task chip. `data.card` is read back in handleDragEnd. */
export function DraggableChip({
  card,
  overdue,
  onOpen,
}: {
  card: TaskCard;
  overdue?: boolean;
  onOpen?: (cardId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `card:${card.id}`,
    data: { card },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={isDragging ? "opacity-40" : undefined}
    >
      <TaskChip card={card} overdue={overdue} onOpen={onOpen} dragging={isDragging} />
    </div>
  );
}

/** Droppable container for the unscheduled tray. */
export function DroppableTray({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: UNSCHEDULED_DROP_ID });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        className,
        isOver && "ring-1 ring-inset ring-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]",
      )}
    >
      {children}
    </div>
  );
}

/** Droppable day cell keyed by its "yyyy-MM-dd" date key. */
export function DroppableDayCell({
  cell,
  cards,
  maxVisible,
  onOpenCard,
  onShowMore,
}: {
  cell: CalendarCell;
  cards: TaskCard[];
  maxVisible?: number;
  onOpenCard?: (cardId: string) => void;
  onShowMore?: (cell: CalendarCell, cards: TaskCard[]) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: cell.key });

  return (
    <DayCell
      cell={cell}
      cards={cards}
      maxVisible={maxVisible}
      onOpenCard={onOpenCard}
      onShowMore={onShowMore}
      droppableRef={setNodeRef}
      isOver={isOver}
      renderChip={(card) => <DraggableChip key={card.id} card={card} onOpen={onOpenCard} />}
    />
  );
}
