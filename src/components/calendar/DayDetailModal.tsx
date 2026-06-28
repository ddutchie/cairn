"use client";

/**
 * DayDetailModal — lists every task due on a single day. Opened from the
 * "+N more" affordance in a packed month cell. Chips open the card detail
 * modal via onOpenCard (same flow as the calendar grid).
 */

import { format } from "date-fns";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TaskChip } from "./TaskChip";
import type { CalendarCell } from "./calendar-utils";
import type { TaskCard } from "@/types";

interface DayDetailModalProps {
  day: { cell: CalendarCell; cards: TaskCard[] } | null;
  onClose: () => void;
  onOpenCard?: (cardId: string) => void;
}

export function DayDetailModal({ day, onClose, onOpenCard }: DayDetailModalProps) {
  const open = day !== null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {day && (
        <DialogContent size="sm" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{format(day.cell.date, "EEEE, MMMM d, yyyy")}</DialogTitle>
            <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-0.5">
              {day.cards.length} {day.cards.length === 1 ? "task" : "tasks"} due
            </p>
          </DialogHeader>
          <div className="p-3 max-h-[60vh] overflow-y-auto flex flex-col gap-1">
            {day.cards.map((card) => (
              <TaskChip
                key={card.id}
                card={card}
                onOpen={(id) => {
                  onClose();
                  onOpenCard?.(id);
                }}
              />
            ))}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
