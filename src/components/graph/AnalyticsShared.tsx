"use client";

/**
 * Shared React components for analytics canvas components.
 */
import React from "react";
import * as d3 from "d3";
import { DAY_MS } from "./analyticsUtils";

// ── CanvasEmptyState ──────────────────────────────────────────────────────────

interface EmptyStateProps {
  message?: string;
}

export function CanvasEmptyState({ message = "No data to show." }: EmptyStateProps) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <p className="text-xs text-[var(--text-tertiary)]">{message}</p>
    </div>
  );
}

// ── CanvasTooltip ─────────────────────────────────────────────────────────────

interface TooltipProps {
  x: number;
  y: number;
  containerW: number;
  containerH?: number;
  children: React.ReactNode;
  maxW?: number;
}

export function CanvasTooltip({ x, y, containerW, maxW = 220, children }: TooltipProps) {
  return (
    <div
      className="absolute pointer-events-none z-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg p-2.5 text-[0.786rem]"
      style={{
        maxWidth: maxW,
        left: Math.min(x + 14, containerW - maxW - 8),
        top:  Math.max(y - 44, 8),
      }}
    >
      {children}
    </div>
  );
}

// ── SvgTimeAxis ───────────────────────────────────────────────────────────────

interface TimeAxisProps {
  xScale: d3.ScaleTime<number, number>;
  plotW: number;
  plotH: number;
  padLeft: number;
  padTop: number;
  padBottom: number;
  bucketMs: number;
  svgHeight: number;
  showToday?: boolean;
}

export function SvgTimeAxis({
  xScale,
  plotW,
  plotH: _plotH,
  padLeft,
  padTop,
  padBottom,
  bucketMs,
  svgHeight,
  showToday = true,
}: TimeAxisProps) {
  const lineColor = "var(--text-primary)";
  const fmt = d3.timeFormat(bucketMs < DAY_MS ? "%b %d %H:%M" : "%b %d");

  const count = Math.max(2, Math.floor(plotW / 100));
  const ticks = xScale.ticks(count).map((d) => ({
    ms:    d.getTime(),
    x:     xScale(d),
    label: fmt(d),
  }));

  const todayX    = xScale(new Date());
  const showTodayLine = showToday && todayX >= padLeft && todayX <= padLeft + plotW;

  return (
    <>
      {ticks.map(({ ms, x, label }) => (
        <g key={ms}>
          <line
            x1={x} y1={padTop - 6}
            x2={x} y2={svgHeight - padBottom}
            stroke={lineColor} strokeOpacity={0.06} strokeWidth={1}
          />
          <text
            x={x} y={padTop - 10}
            textAnchor="middle"
            fill={lineColor} fillOpacity={0.3}
            fontSize={8} fontFamily="var(--font-mono)"
          >
            {label}
          </text>
        </g>
      ))}

      {showTodayLine && (
        <>
          <line
            x1={todayX} y1={padTop - 4}
            x2={todayX} y2={svgHeight - padBottom}
            stroke={lineColor} strokeOpacity={0.18}
            strokeWidth={1} strokeDasharray="3,3"
          />
          <text
            x={todayX} y={padTop - 10}
            textAnchor="middle"
            fill={lineColor} fillOpacity={0.35}
            fontSize={8} fontFamily="var(--font-mono)"
          >
            TODAY
          </text>
        </>
      )}
    </>
  );
}
