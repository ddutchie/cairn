"use client";

import React, { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { Clock, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEscapeKey } from "@/hooks/useEscapeKey";

interface TimePickerProps {
  /** "HH:MM" (24-hour). */
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

const MINUTES_STEP = 5;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 / MINUTES_STEP }, (_, i) => i * MINUTES_STEP);

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function parseTime(value?: string): [number, number] {
  if (!value) {
    const now = new Date();
    return [now.getHours(), Math.round(now.getMinutes() / MINUTES_STEP) * MINUTES_STEP % 60];
  }
  const [h, m] = value.split(":").map((x) => parseInt(x, 10));
  return [Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0];
}

/**
 * Time picker styled to match DatePicker: a trigger button + a popover portaled
 * to document.body with hour and minute grids. Used by the schedule builder.
 */
export function TimePicker({ value, onChange, placeholder = "Pick a time", className }: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const [hour, minute] = useMemo(() => parseTime(value), [value]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (containerRef.current?.contains(e.target as Node)) return;
      const popoverEl = document.querySelector(".cairn-timepicker-popover");
      if (popoverEl?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  useEscapeKey(() => setOpen(false), open);

  function select(h: number, m: number) {
    onChange(`${pad2(h)}:${pad2(m)}`);
  }

  function positionAndOpen() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const popoverW = 220;
      const popoverH = 300;
      const gap = 4;
      let left = rect.left;
      if (left + popoverW > window.innerWidth - 8) left = window.innerWidth - popoverW - 8;
      if (left < 8) left = 8;
      let top = rect.bottom + gap;
      if (top + popoverH > window.innerHeight - 8) top = rect.top - popoverH - gap;
      if (top < 8) top = 8;
      setPopoverPos({ top, left });
    }
    setOpen((o) => !o);
  }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange("");
  }

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={positionAndOpen}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs border transition-colors text-left",
          "bg-[var(--surface-2)] border-[var(--border)]",
          open ? "border-[var(--accent)]" : "hover:border-[var(--accent)]/50",
          value ? "text-[var(--text-secondary)]" : "text-[var(--text-tertiary)]"
        )}
      >
        <Clock size={11} className="flex-shrink-0 text-[var(--text-tertiary)]" />
        <span className="flex-1 truncate">{value ? value : placeholder}</span>
        {value && (
          <span
            role="button"
            onClick={handleClear}
            className="flex-shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            <X size={10} />
          </span>
        )}
      </button>

      {open && createPortal(
        <div
          data-dialog-portal
          className="cairn-timepicker-popover fixed z-[100] rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-3 w-52"
          style={{ top: `${popoverPos.top}px`, left: `${popoverPos.left}px` }}
        >
          <div className="flex items-baseline justify-center gap-1 mb-2">
            <span className="text-lg font-semibold text-[var(--text-primary)] font-mono">
              {pad2(hour)}:{pad2(minute)}
            </span>
            <span className="text-[0.714rem] text-[var(--text-tertiary)]">24h</span>
          </div>

          <div className="space-y-2">
            <div>
              <div className="text-[0.714rem] font-medium text-[var(--text-tertiary)] mb-1">Hour</div>
              <div className="grid grid-cols-6 gap-1 max-h-24 overflow-y-auto pr-0.5">
                {HOURS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => select(h, minute)}
                    className={cn(
                      "h-6 rounded-md text-xs transition-colors font-mono",
                      h === hour
                        ? "bg-[var(--accent)] text-[var(--background)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                    )}
                  >
                    {pad2(h)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[0.714rem] font-medium text-[var(--text-tertiary)] mb-1">
                Minute ({MINUTES_STEP}-min steps)
              </div>
              <div className="grid grid-cols-6 gap-1">
                {MINUTES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => select(hour, m)}
                    className={cn(
                      "h-6 rounded-md text-xs transition-colors font-mono",
                      m === minute
                        ? "bg-[var(--accent)] text-[var(--background)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                    )}
                  >
                    {pad2(m)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-2 pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                select(now.getHours(), now.getMinutes());
              }}
              className="text-xs text-[var(--accent)] hover:underline"
            >
              Now
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              Done
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
