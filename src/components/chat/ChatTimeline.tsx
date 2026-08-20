"use client";

import React, { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Minimal stub of dsh's TrajectoryTimeline — same interaction contract
// (drag horizontal → onRangeChange, wheel → zoom, click span → onRecordSelect)
// so ChatPanel and AgentChatPane can share it. Full deriveTrajectoryTimeline
// (lane 0 Input / 1 Model / 2 Tools, ttft/decoding) can replace deriveSpans later.

export interface TimelineSpan {
  start: number; // 0-1
  end: number;
  lane: 0 | 1 | 2;
  index: number;
  label: string;
  isError?: boolean;
}

export interface ChatTimelineProps {
  spans: TimelineSpan[];
  range: { start: number; end: number } | null;
  onRangeChange: (range: { start: number; end: number } | null) => void;
  onSpanSelect?: (index: number) => void;
  totalDurationMs?: number;
}

export function ChatTimeline({ spans, range, onRangeChange, onSpanSelect, totalDurationMs }: ChatTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ startX: number; start: number; end: number } | null>(null);
  const [hover, setHover] = useState<TimelineSpan | null>(null);

  const rangeStart = range?.start ?? 0;
  const rangeEnd = range?.end ?? 1;
  const isFiltered = range != null && (rangeStart > 0 || rangeEnd < 1);

  const toFraction = useCallback((clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const handleTrackMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-span]")) return;
    const f = toFraction(e.clientX);
    // Click on empty track → focus a small window around click
    const w = 0.2;
    onRangeChange({ start: Math.max(0, f - w / 2), end: Math.min(1, f + w / 2) });
  }, [toFraction, onRangeChange]);

  const handleSpanClick = useCallback((s: TimelineSpan, e: React.MouseEvent) => {
    e.stopPropagation();
    onSpanSelect?.(s.index);
    // Also focus timeline on this span
    const pad = 0.05;
    onRangeChange({ start: Math.max(0, s.start - pad), end: Math.min(1, s.end + pad) });
  }, [onSpanSelect, onRangeChange]);

  const handleHandleMouseDown = useCallback((side: "start" | "end", e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setDrag({ startX: e.clientX, start: rangeStart, end: rangeEnd });
    const onMove = (ev: MouseEvent) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = (ev.clientX - (drag?.startX ?? e.clientX)) / rect.width;
      // Use the captured start/end from mousedown, not live range, to avoid drift
      const base = drag ?? { start: rangeStart, end: rangeEnd, startX: e.clientX };
      if (side === "start") {
        const ns = Math.max(0, Math.min(base.end - 0.02, base.start + dx));
        onRangeChange({ start: ns, end: base.end });
      } else {
        const ne = Math.min(1, Math.max(base.start + 0.02, base.end + dx));
        onRangeChange({ start: base.start, end: ne });
      }
    };
    const onUp = () => {
      setDrag(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [drag, rangeStart, rangeEnd, onRangeChange]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    // Wheel → zoom anchored at cursor, like dsh
    const f = toFraction(e.clientX);
    const factor = Math.exp(e.deltaY * 0.0015);
    const w = (rangeEnd - rangeStart) * factor;
    const clampedW = Math.max(0.05, Math.min(1, w));
    const ns = Math.max(0, Math.min(1 - clampedW, f - clampedW * (f - rangeStart) / (rangeEnd - rangeStart || 1)));
    onRangeChange({ start: ns, end: ns + clampedW });
  }, [toFraction, rangeStart, rangeEnd, onRangeChange]);

  const handleDoubleClick = useCallback(() => onRangeChange(null), [onRangeChange]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[0.607rem] text-[var(--text-tertiary)]">
        <span>{isFiltered ? `Focused ${Math.round((rangeEnd - rangeStart) * 100)}%` : "Full timeline"} {totalDurationMs ? `· ${Math.round(totalDurationMs)}ms` : ""}</span>
        {isFiltered && (
          <button
            onClick={handleDoubleClick}
            className="px-1.5 py-0.5 rounded bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text-secondary)] transition-colors"
          >
            Reset
          </button>
        )}
      </div>
      <div
        ref={trackRef}
        onMouseDown={handleTrackMouseDown}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
        className="relative h-12 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden select-none"
        title="Drag to focus · Wheel to zoom · Double-click to reset · Click a span to focus it"
      >
        {/* Lanes */}
        <div className="absolute inset-1 flex flex-col gap-1">
          {[0, 1, 2].map((lane) => (
            <div key={lane} className="flex-1 relative rounded bg-[var(--surface)] border border-[var(--border-subtle)] overflow-hidden">
              {spans.filter((s) => s.lane === lane).map((s) => (
                <button
                  key={`${lane}-${s.index}-${s.label}`}
                  data-span
                  onClick={(e) => handleSpanClick(s, e)}
                  onMouseEnter={() => setHover(s)}
                  onMouseLeave={() => setHover((h) => (h?.index === s.index && h.lane === lane && h.label === s.label ? null : h))}
                  className={cn(
                    "absolute top-0.5 bottom-0.5 rounded text-[0.5rem] flex items-center justify-center overflow-hidden transition-colors",
                    s.isError ? "bg-[var(--danger)]/20 border border-[var(--danger)]/40" :
                    lane === 0 ? "bg-[var(--accent)]/15 border border-[var(--accent)]/30" :
                    lane === 1 ? "bg-[var(--text-primary)]/10 border border-[var(--text-primary)]/20" :
                    "bg-[var(--success)]/15 border border-[var(--success)]/30",
                    hover?.index === s.index && hover.lane === lane && hover.label === s.label && "ring-1 ring-[var(--accent)]"
                  )}
                  style={{ left: `${s.start * 100}%`, width: `${Math.max(1, (s.end - s.start) * 100)}%` }}
                  title={s.label}
                >
                  <span className="truncate px-1">{s.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        {/* Range overlay */}
        {isFiltered && (
          <>
            <div className="absolute inset-y-0 bg-black/20 pointer-events-none" style={{ left: 0, width: `${rangeStart * 100}%` }} />
            <div className="absolute inset-y-0 bg-black/20 pointer-events-none" style={{ left: `${rangeEnd * 100}%`, right: 0 }} />
            <div
              className="absolute inset-y-0 border-x-2 border-[var(--accent)] bg-[var(--accent)]/10 pointer-events-none"
              style={{ left: `${rangeStart * 100}%`, width: `${(rangeEnd - rangeStart) * 100}%` }}
            />
            <div
              onMouseDown={(e) => handleHandleMouseDown("start", e)}
              className="absolute top-0 bottom-0 w-2 -ml-1 cursor-ew-resize bg-[var(--accent)]/60 hover:bg-[var(--accent)] rounded-l"
              style={{ left: `${rangeStart * 100}%` }}
            />
            <div
              onMouseDown={(e) => handleHandleMouseDown("end", e)}
              className="absolute top-0 bottom-0 w-2 -mr-1 cursor-ew-resize bg-[var(--accent)]/60 hover:bg-[var(--accent)] rounded-r"
              style={{ left: `${rangeEnd * 100}%`, marginLeft: "-8px" }}
            />
          </>
        )}
        {hover && (
          <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 px-2 py-1 rounded bg-[var(--surface)] border border-[var(--border)] shadow-lg text-[0.643rem] whitespace-nowrap pointer-events-none">
            {hover.label}
          </div>
        )}
      </div>
      <div className="flex gap-1 text-[0.607rem] text-[var(--text-tertiary)]">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-[var(--accent)]/30 border border-[var(--accent)]/50" /> Input</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-[var(--text-primary)]/20 border border-[var(--text-primary)]/30" /> Model</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-[var(--success)]/30 border border-[var(--success)]/50" /> Tools</span>
      </div>
    </div>
  );
}

// Helper to derive spans from chat messages / turns — replace with
// deriveTrajectoryTimeline(turns, mode) when the full dsh projection is wired.
export function deriveSpansFromMessages(
  messages: Array<{ role: string; toolCalls?: unknown[]; reasoning?: string }>,
  opts?: { totalDurationMs?: number }
): TimelineSpan[] {
  if (messages.length === 0) return [];
  const spans: TimelineSpan[] = [];
  messages.forEach((m, i) => {
    const start = i / messages.length;
    const end = (i + 1) / messages.length;
    if (m.role === "user") {
      spans.push({ start, end, lane: 0, index: i, label: `Input ${i + 1}` });
    } else if (m.role === "assistant") {
      if (m.reasoning) spans.push({ start, end: end - 0.02, lane: 1, index: i, label: `Thinking ${i + 1}` });
      spans.push({ start: m.reasoning ? start + 0.02 : start, end, lane: 1, index: i, label: `Model ${i + 1}` });
      if (m.toolCalls && (m.toolCalls as unknown[]).length > 0) {
        spans.push({ start, end, lane: 2, index: i, label: `Tools ×${(m.toolCalls as unknown[]).length}` });
      }
    }
  });
  return spans;
}
