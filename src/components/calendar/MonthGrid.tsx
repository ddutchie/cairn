"use client";

/**
 * MonthGrid — 6×7 weekday-headed month grid. Cell rendering is delegated to
 * `renderCell` so the DnD layer can wrap each cell in a droppable without this
 * component knowing about drag state.
 */

import type { ReactNode } from "react";
import type { CalendarCell } from "./calendar-utils";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface MonthGridProps {
  cells: CalendarCell[];
  renderCell: (cell: CalendarCell) => ReactNode;
}

export function MonthGrid({ cells, renderCell }: MonthGridProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0 border-l border-t border-[var(--border)] rounded-md overflow-hidden">
      <div className="grid grid-cols-7 flex-shrink-0">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="px-1.5 py-1.5 text-[0.6rem] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] bg-[var(--surface-2)] border-b border-r border-[var(--border)]"
          >
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 grid-rows-6 flex-1 min-h-0">
        {cells.map((cell) => (
          <div key={cell.key} className="min-h-0 min-w-0 h-full">
            {renderCell(cell)}
          </div>
        ))}
      </div>
    </div>
  );
}
