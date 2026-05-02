"use client";

import React, { useState, useRef, useEffect } from "react";
import { DayPicker, type DayPickerProps } from "react-day-picker";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { format, parse, isValid } from "date-fns";
import { Calendar, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface DatePickerProps {
  value?: string; // ISO date string "YYYY-MM-DD"
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  className?: string;
}

export function DatePicker({ value, onChange, placeholder = "Pick a date", className }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = value ? parse(value, "yyyy-MM-dd", new Date()) : undefined;
  const isValidDate = selected && isValid(selected);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  function handleSelect(day: Date | undefined) {
    onChange(day ? format(day, "yyyy-MM-dd") : undefined);
    setOpen(false);
  }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange(undefined);
  }

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs border transition-colors text-left",
          "bg-[var(--surface-2)] border-[var(--border)]",
          open ? "border-[var(--accent)]" : "hover:border-[var(--accent)]/50",
          isValidDate ? "text-[var(--text-secondary)]" : "text-[var(--text-tertiary)]"
        )}
      >
        <Calendar size={11} className="flex-shrink-0 text-[var(--text-tertiary)]" />
        <span className="flex-1 truncate">
          {isValidDate ? format(selected, "MMM d, yyyy") : placeholder}
        </span>
        {isValidDate && (
          <span
            role="button"
            onClick={handleClear}
            className="flex-shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            <X size={10} />
          </span>
        )}
      </button>

      {/* Popover */}
      {open && (
        <div className="absolute z-50 mt-1 left-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-2">
          <DayPicker
            mode="single"
            selected={isValidDate ? selected : undefined}
            onSelect={handleSelect}
            showOutsideDays
            components={{
              Chevron: ({ orientation }: { orientation?: string }) =>
                orientation === "left"
                  ? <ChevronLeft size={13} />
                  : <ChevronRight size={13} />,
            } as DayPickerProps["components"]}
            classNames={{
              root:        "text-xs",
              months:      "flex flex-col",
              month:       "space-y-2",
              month_caption: "flex items-center justify-between px-1 py-1",
              caption_label: "text-xs font-semibold text-[var(--text-primary)]",
              nav:         "flex items-center gap-1",
              button_previous: "p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors",
              button_next:     "p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors",
              weeks:       "space-y-0.5",
              weekdays:    "flex",
              weekday:     "w-8 text-center text-[0.714rem] font-medium text-[var(--text-tertiary)] py-1",
              week:        "flex",
              day:         "w-8 h-8 flex items-center justify-center rounded-md text-[0.786rem] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors cursor-pointer",
              day_button:  "w-full h-full flex items-center justify-center rounded-md",
              selected:    "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] hover:text-white",
              today:       "font-semibold text-[var(--accent)]",
              outside:     "text-[var(--text-tertiary)] opacity-30",
              disabled:    "opacity-20 cursor-not-allowed",
            }}
          />
        </div>
      )}
    </div>
  );
}
