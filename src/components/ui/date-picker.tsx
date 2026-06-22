"use client";

import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
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
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = value ? parse(value, "yyyy-MM-dd", new Date()) : undefined;
  const isValidDate = selected && isValid(selected);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      // Check both the trigger container AND the portal target (document.body).
      // The calendar popover is portaled to body, so containerRef won't contain it.
      if (containerRef.current?.contains(e.target as Node)) return;
      // The popover itself has class "cairn-datepicker-popover" — check if click was inside it.
      const popoverEl = document.querySelector(".cairn-datepicker-popover");
      if (popoverEl?.contains(e.target as Node)) return;
      setOpen(false);
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

  function positionAndOpen() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const popoverW = 260; // approximate DayPicker width
      const popoverH = 340; // approximate DayPicker height
      const gap = 4;
      // Default: left edge of popover = trigger's left edge
      let left = rect.left;
      // Clamp: if popover would overflow right viewport edge, shift left
      if (left + popoverW > window.innerWidth - 8) {
        left = window.innerWidth - popoverW - 8;
      }
      // Clamp: never go past left viewport edge
      if (left < 8) left = 8;
      // Default: open below trigger
      let top = rect.bottom + gap;
      // If there is not enough room below, open above the trigger
      if (top + popoverH > window.innerHeight - 8) {
        top = rect.top - popoverH - gap;
      }
      // Clamp: never extend above the viewport top
      if (top < 8) top = 8;
      setPopoverPos({ top, left });
    }
    setOpen((o) => !o);
  }

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={positionAndOpen}
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

      {/* Popover — rendered via createPortal to document.body so it escapes all
           parent containing blocks (e.g. Radix Dialog's transform: translate(-50%, -50%)
           which breaks position:fixed for descendants, and overflow-y-auto which clips
           absolutely-positioned children). */}
      {open && createPortal(
        <div
          data-dialog-portal
          className="cairn-datepicker-popover fixed z-[100] rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-2"
          style={{
            top: `${popoverPos.top}px`,
            left: `${popoverPos.left}px`,
          }}
        >
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
              selected:    "bg-[var(--accent)] text-[var(--background)] hover:bg-[var(--accent-hover)] hover:text-[var(--background)]",
              today:       "font-semibold text-[var(--accent)]",
              outside:     "text-[var(--text-tertiary)] opacity-30",
              disabled:    "opacity-20 cursor-not-allowed",
            }}
          />
        </div>,
        document.body
      )}
    </div>
  );
}
