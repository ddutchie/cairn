"use client";

/**
 * CalendarView — project-scoped calendar that lays out task cards by dueDate.
 *
 * Month + week layouts with prev/next/today navigation. Tasks render as chips
 * in their due-date cell; clicking a chip opens the card detail modal.
 *
 * Drag-to-reschedule and the unscheduled/overdue trays are layered on in
 * follow-up cards — this component owns the read-only grid + navigation shell.
 */

import { useMemo, useState, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { CardDetailModal } from "@/components/kanban/card-detail";
import { MonthGrid } from "./MonthGrid";
import { WeekGrid } from "./WeekGrid";
import { DroppableDayCell } from "./CalendarDnd";
import { TaskChip } from "./TaskChip";
import { OverdueTray } from "./OverdueTray";
import { UnscheduledTray } from "./UnscheduledTray";
import { DayDetailModal } from "./DayDetailModal";
import {
  buildMonthGrid,
  buildWeekGrid,
  bucketByDate,
  shiftMonth,
  shiftWeek,
} from "./calendar-utils";
import { resolveDateDrop } from "./calendar-dnd";
import type { CalendarCell } from "./calendar-utils";
import type { TaskCard } from "@/types";

type CalendarLayout = "month" | "week";

export function CalendarView() {
  const { activeProjectId, cards, updateCard } = useCairnStore(
    useShallow((s) => ({
      activeProjectId: s.activeProjectId,
      // Subscribe to the raw array so the view re-renders when cards change —
      // the selector function alone is a stable ref and won't trigger updates.
      cards: s.cards,
      updateCard: s.updateCard,
    })),
  );

  const [layout, setLayout] = useState<CalendarLayout>("month");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [detailCardId, setDetailCardId] = useState<string | null>(null);
  const [draggingCard, setDraggingCard] = useState<TaskCard | null>(null);
  const [dayDetail, setDayDetail] = useState<{ cell: CalendarCell; cards: TaskCard[] } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  // `today` must not be frozen for the component's lifetime, or overdue/today
  // styling goes stale after midnight. Track a day-key and bump it on an
  // interval (and on window focus) so `today` recomputes when the date rolls.
  const [dayKey, setDayKey] = useState(() => new Date().toDateString());
  useEffect(() => {
    const tick = () => {
      const k = new Date().toDateString();
      setDayKey((prev) => (prev === k ? prev : k));
    };
    const interval = setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", tick);
    };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const today = useMemo(() => new Date(), [dayKey]);

  const projectCards = useMemo(
    () =>
      activeProjectId
        ? cards.filter((c) => c.projectId === activeProjectId && !c.archivedAt)
        : [],
    [activeProjectId, cards],
  );

  const { byDate, unscheduled, overdue } = useMemo(
    () => bucketByDate(projectCards, today),
    [projectCards, today],
  );

  const cells = useMemo(
    () => (layout === "month" ? buildMonthGrid(anchor, today) : buildWeekGrid(anchor, today)),
    [layout, anchor, today],
  );

  if (!activeProjectId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-[var(--text-tertiary)] text-sm">No project selected</p>
      </div>
    );
  }

  const step = (delta: number) =>
    setAnchor((a) => (layout === "month" ? shiftMonth(a, delta) : shiftWeek(a, delta)));

  function handleDragStart(event: DragStartEvent) {
    const card = event.active.data.current?.card as TaskCard | undefined;
    if (card) setDraggingCard(card);
  }

  function handleDragEnd(event: DragEndEvent) {
    const card = event.active.data.current?.card as TaskCard | undefined;
    setDraggingCard(null);
    if (!card) return;
    const overId = event.over?.id;
    const patch = resolveDateDrop(typeof overId === "string" ? overId : null, card);
    if (patch) updateCard(card.id, patch);
  }

  const periodLabel =
    layout === "month"
      ? format(anchor, "MMMM yyyy")
      : `Week of ${format(buildWeekGrid(anchor, today)[0].date, "MMM d, yyyy")}`;

  const renderCell = (cell: Parameters<typeof DroppableDayCell>[0]["cell"]) => (
    <DroppableDayCell
      cell={cell}
      cards={byDate.get(cell.key) ?? []}
      maxVisible={layout === "month" ? 3 : 8}
      onOpenCard={setDetailCardId}
      onShowMore={(c, cards) => setDayDetail({ cell: c, cards })}
    />
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 w-full overflow-hidden bg-[var(--background)]">
      {/* Toolbar */}
      <div className="h-9 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0 flex items-center gap-2 px-3">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label={layout === "month" ? "Previous month" : "Previous week"}
            className="p-1 rounded text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            aria-label={layout === "month" ? "Next month" : "Next week"}
            className="p-1 rounded text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setAnchor(new Date())}
          className="px-2 py-0.5 rounded text-[0.714rem] font-medium text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          Today
        </button>
        <span className="text-xs font-medium text-[var(--text-primary)] ml-1">{periodLabel}</span>
        {projectCards.length === 0 && (
          <span className="text-[0.643rem] text-[var(--text-tertiary)] ml-1">· no tasks yet</span>
        )}

        {/* Layout toggle */}
        <div className="ml-auto flex items-center rounded-md border border-[var(--border)] overflow-hidden">
          {(["month", "week"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLayout(l)}
              aria-pressed={layout === l}
              className={cn(
                "px-2 py-0.5 text-[0.714rem] font-medium capitalize transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                layout === l
                  ? "bg-[var(--accent)] text-[var(--surface)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]",
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDraggingCard(null)}
      >
        <OverdueTray cards={overdue} onOpenCard={setDetailCardId} />
        <div className="flex-1 flex flex-col min-h-0 p-3 overflow-hidden">
          {layout === "month" ? (
            <MonthGrid cells={cells} renderCell={renderCell} />
          ) : (
            <WeekGrid cells={cells} renderCell={renderCell} />
          )}
        </div>
        <UnscheduledTray cards={unscheduled} onOpenCard={setDetailCardId} />
        <DragOverlay dropAnimation={null}>
          {draggingCard ? (
            <div className="rotate-2 opacity-90 w-40 shadow-lg">
              <TaskChip card={draggingCard} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {detailCardId && (
        <CardDetailModal cardId={detailCardId} onClose={() => setDetailCardId(null)} />
      )}

      <DayDetailModal
        day={dayDetail}
        onClose={() => setDayDetail(null)}
        onOpenCard={setDetailCardId}
      />
    </div>
  );
}
