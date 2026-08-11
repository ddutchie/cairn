"use client";

/**
 * UnscheduledTray — droppable list of tasks with no due date. Drag a chip into
 * a day cell to schedule it; drag a dated task onto this tray to clear its due
 * date. Collapsible to stay out of the way.
 *
 * In the workspace-wide calendar (`groupByProject`), the undated tasks are split
 * into labelled per-project sections so a large backlog stays scannable; the
 * per-project calendar keeps a flat list (a single project needs no grouping).
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Inbox } from "lucide-react";
import { DraggableChip, DroppableTray } from "./CalendarDnd";
import type { TaskCard } from "@/types";
import { MicroLabel } from "@/components/ui/labels";

interface UnscheduledTrayProps {
  cards: TaskCard[];
  onOpenCard?: (cardId: string) => void;
  /** Group cards into per-project sections (workspace calendar). */
  groupByProject?: boolean;
  /** Project id → display name, for the group headers. */
  projectNames?: Map<string, string>;
}

export function UnscheduledTray({ cards, onOpenCard, groupByProject, projectNames }: UnscheduledTrayProps) {
  const [open, setOpen] = useState(true);

  // Split into sorted per-project sections when grouping; otherwise one flat
  // group so the render path is uniform.
  const groups = useMemo(() => {
    if (!groupByProject) return null;
    const byProject = new Map<string, TaskCard[]>();
    for (const c of cards) {
      const name = projectNames?.get(c.projectId) ?? "Unknown project";
      const arr = byProject.get(name);
      if (arr) arr.push(c);
      else byProject.set(name, [c]);
    }
    return [...byProject.entries()]
      .map(([name, items]) => ({ name, items }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [cards, groupByProject, projectNames]);

  const renderChip = (card: TaskCard) => (
    <div key={card.id} className="w-40">
      <DraggableChip card={card} onOpen={onOpenCard} />
    </div>
  );

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
            // Cap the height so a large backlog of undated tasks scrolls within a
            // fixed band instead of growing unbounded and covering the calendar.
            <div className="max-h-40 overflow-y-auto">
              {groups ? (
                <div className="flex flex-col gap-2">
                  {groups.map((g) => (
                    <div key={g.name}>
                      <MicroLabel className="flex items-center gap-1 px-0.5 pb-1">
                        <span className="truncate">{g.name}</span>
                        <span className="font-normal">{g.items.length}</span>
                      </MicroLabel>
                      <div className="flex flex-wrap gap-1">{g.items.map(renderChip)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1">{cards.map(renderChip)}</div>
              )}
            </div>
          )}
        </div>
      )}
    </DroppableTray>
  );
}
