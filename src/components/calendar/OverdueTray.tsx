"use client";

/**
 * OverdueTray — a banner listing tasks whose due date has passed. Chips are
 * draggable into day cells (or the unscheduled tray) for quick rescheduling.
 * Hidden entirely when there is nothing overdue.
 */

import { AlertTriangle } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { DraggableChip } from "./CalendarDnd";
import type { TaskCard } from "@/types";

interface OverdueTrayProps {
  cards: TaskCard[];
  onOpenCard?: (cardId: string) => void;
}

export function OverdueTray({ cards, onOpenCard }: OverdueTrayProps) {
  if (cards.length === 0) return null;

  return (
    <div className="flex-shrink-0 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--danger)_6%,transparent)] px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <AlertTriangle size={12} className="text-[var(--danger)]" />
        <span className="text-[0.714rem] font-medium text-[var(--danger)]">
          {cards.length} overdue {cards.length === 1 ? "task" : "tasks"}
        </span>
        <span className="text-[0.643rem] text-[var(--text-tertiary)]">
          drag onto a day to reschedule
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {cards.map((card) => (
          <div key={card.id} className="w-44">
            <DraggableChip card={card} overdue onOpen={onOpenCard} />
            {card.dueDate && (
              <span className="block px-1.5 text-[0.6rem] text-[var(--text-tertiary)] leading-tight">
                was {formatDate(card.dueDate)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
