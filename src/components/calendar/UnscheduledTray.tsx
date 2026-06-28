"use client";

/**
 * UnscheduledTray — droppable list of tasks with no due date. Drag a chip into
 * a day cell to schedule it; drag a dated task onto this tray to clear its due
 * date. Collapsible to stay out of the way.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { DraggableChip, DroppableTray } from "./CalendarDnd";
import type { TaskCard } from "@/types";

interface UnscheduledTrayProps {
  cards: TaskCard[];
  onOpenCard?: (cardId: string) => void;
}

export function UnscheduledTray({ cards, onOpenCard }: UnscheduledTrayProps) {
  const [open, setOpen] = useState(true);

  return (
    <DroppableTray className="flex-shrink-0 border-t border-[var(--border)] bg-[var(--surface)] rounded-t-md">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[0.714rem] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Inbox size={12} />
        Unscheduled
        <span className="text-[var(--text-tertiary)] font-normal">{cards.length}</span>
      </button>
      {open && (
        <div className="px-3 pb-2 min-h-[2.25rem]">
          {cards.length === 0 ? (
            <p className="text-[0.643rem] text-[var(--text-tertiary)] py-1">
              No unscheduled tasks. Drag a task here to clear its due date.
            </p>
          ) : (
            <div className={cn("flex flex-wrap gap-1")}>
              {cards.map((card) => (
                <div key={card.id} className="w-40">
                  <DraggableChip card={card} onOpen={onOpenCard} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </DroppableTray>
  );
}
