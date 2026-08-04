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

const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const MINUTES = Array.from({ length: 60 }, (_, i) => i);      // 0..59
const MERIDIEMS = ["AM", "PM"] as const;

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function parse24(value?: string): [number, number] {
  if (!value) {
    const now = new Date();
    return [now.getHours(), now.getMinutes()];
  }
  const [h, m] = value.split(":").map((x) => parseInt(x, 10));
  return [Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0];
}

/** 12h from a 24h value. */
function to12(h24: number, m: number): { hour12: number; minute: number; isPm: boolean } {
  return { hour12: ((h24 + 11) % 12) + 1, minute: m, isPm: h24 >= 12 };
}

/** Friendly display ("9:00 PM"). The stored value stays 24h "HH:MM" for the schedule. */
function friendly(h24: number, m: number): string {
  const { hour12, isPm } = to12(h24, m);
  return `${hour12}:${pad2(m)} ${isPm ? "PM" : "AM"}`;
}

/** 24h from 12h wheel state. */
function to24(hour12: number, minute: number, isPm: boolean): string {
  const h24 = (hour12 % 12) + (isPm ? 12 : 0);
  return `${pad2(h24)}:${pad2(minute)}`;
}

/**
 * Time picker styled to match DatePicker: a trigger button + a portaled popover
 * with three scrollable wheel columns (hour 1–12, minute 00–59, AM/PM).
 */
export function TimePicker({ value, onChange, placeholder = "Pick a time", className }: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const { hour12, minute, isPm } = useMemo(() => {
    const [h, m] = parse24(value);
    return to12(h, m);
  }, [value]);

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

  function select(hour12v: number, minuteV: number, isPmV: boolean) {
    onChange(to24(hour12v, minuteV, isPmV));
  }

  function positionAndOpen() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const popoverW = 240;
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
        <span className="flex-1 truncate">{value ? friendly(...parse24(value)) : placeholder}</span>
      </button>
      {value && (
        <button
          type="button"
          aria-label="Clear time"
          onClick={handleClear}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <X size={10} />
        </button>
      )}

      {open && createPortal(
        <div
          data-dialog-portal
          className="cairn-timepicker-popover fixed z-[100] rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-3"
          style={{ top: `${popoverPos.top}px`, left: `${popoverPos.left}px` }}
        >
          <div className="flex items-baseline justify-center gap-1.5 mb-2">
            <span className="text-lg font-semibold text-[var(--text-primary)] font-mono">
              {hour12}:{pad2(minute)} {isPm ? "PM" : "AM"}
            </span>
          </div>

          <div className="flex items-stretch justify-center gap-2">
            <WheelColumn
              label="Hour"
              options={HOURS_12}
              selected={hour12}
              width="w-16"
              format={(v) => String(v)}
              onSelect={(v) => select(v, minute, isPm)}
            />
            <WheelColumn
              label="Min"
              options={MINUTES}
              selected={minute}
              width="w-16"
              format={(v) => pad2(v)}
              onSelect={(v) => select(hour12, v, isPm)}
            />
            <WheelColumn
              label=""
              options={MERIDIEMS}
              selected={isPm ? "PM" : "AM"}
              width="w-16"
              format={(v) => String(v)}
              onSelect={(v) => select(hour12, minute, v === "PM")}
            />
          </div>

          <div className="mt-2 pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                onChange(`${pad2(now.getHours())}:${pad2(now.getMinutes())}`);
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

interface WheelColumnProps<T extends string | number> {
  label: string;
  options: readonly T[];
  selected: T;
  width: string;
  format?: (v: T) => string;
  onSelect: (v: T) => void;
}

const ROW_H = 28; // h-7
const VISIBLE_ROWS = 5; // odd → selected sits in the middle
const STEP_PX = 60; // wheel delta needed to move one row

/**
 * A virtual wheel: no DOM scrolling at all. Mouse wheel / trackpad delta is
 * accumulated and converted into selection steps, so it always works (nothing
 * to fight over with snap or programmatic scroll). The selected option is kept
 * centred with neighbours above/below; clicking a row selects it directly.
 */
function WheelColumn<T extends string | number>({ label, options, selected, width, format, onSelect }: WheelColumnProps<T>) {
  const acc = useRef(0);
  const idx = Math.max(0, Math.min(options.length - 1, options.indexOf(selected)));
  const half = Math.floor(VISIBLE_ROWS / 2);

  // Native (non-passive) wheel listener so we can preventDefault reliably.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      acc.current += e.deltaY;
      let steps = 0;
      while (acc.current >= STEP_PX) { acc.current -= STEP_PX; steps++; }
      while (acc.current <= -STEP_PX) { acc.current += STEP_PX; steps--; }
      if (steps === 0) return;
      const base = idx;
      const next = Math.max(0, Math.min(options.length - 1, base + steps));
      if (next !== base) onSelect(options[next]);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [idx, options, onSelect]);

  const rows: Array<{ key: number; opt: T; active: boolean } | null> = Array.from({ length: VISIBLE_ROWS }, (_, r) => {
    const i = idx - half + r;
    if (i < 0 || i >= options.length) return null;
    return { key: i, opt: options[i], active: r === half };
  });

  return (
    <div className="flex flex-col items-center">
      {label && <div className="text-[0.714rem] text-[var(--text-tertiary)] mb-1">{label}</div>}
      <div ref={boxRef} className={cn(width, "relative select-none")} style={{ height: ROW_H * VISIBLE_ROWS }}>
        {/* Center selection band */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-7 rounded-md bg-[var(--accent-dim)]/40" />
        <div className="flex flex-col overflow-hidden">
          {rows.map((row, k) =>
            row === null ? (
              <div key={`pad-${k}`} className={cn("w-full flex items-center justify-center text-sm font-mono text-[var(--text-tertiary)]/40")} style={{ height: ROW_H }}>
                ·
              </div>
            ) : (
              <button
                key={row.key}
                type="button"
                onClick={() => onSelect(row.opt)}
                className={cn(
                  "w-full flex items-center justify-center text-sm font-mono transition-colors",
                  row.active ? "text-[var(--accent)] font-semibold" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                )}
                style={{ height: ROW_H }}
              >
                {format ? format(row.opt) : String(row.opt)}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
