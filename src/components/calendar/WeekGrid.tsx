"use client";

/**
 * WeekGrid — a single 7-day row with taller cells than the month view. Cell
 * rendering is delegated to `renderCell` (same contract as MonthGrid).
 */

import type { ReactNode } from "react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import type { CalendarCell } from "./calendar-utils";

interface WeekGridProps {
  cells: CalendarCell[];
  renderCell: (cell: CalendarCell) => ReactNode;
}

export function WeekGrid({ cells, renderCell }: WeekGridProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0 border-l border-t border-[var(--border)] rounded-md overflow-hidden">
      <div className="grid grid-cols-7 flex-shrink-0">
        {cells.map((cell) => (
          <div
            key={cell.key}
            className={cn(
              "px-1.5 py-1.5 text-[0.6rem] font-semibold uppercase tracking-wider border-b border-r border-[var(--border)]",
              cell.isToday
                ? "text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface-2))]"
                : "text-[var(--text-tertiary)] bg-[var(--surface-2)]",
            )}
          >
            {format(cell.date, "EEE d")}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 flex-1 min-h-0">
        {cells.map((cell) => (
          <div key={cell.key} className="min-h-0 min-w-0 h-full">
            {renderCell(cell)}
          </div>
        ))}
      </div>
    </div>
  );
}
