"use client";

import React, { useMemo } from "react";

export interface ContextRingCategory {
  /** Stable key (also the React key). */
  key: string;
  /** Token count for this slice. */
  value: number;
  /** Any CSS colour, including a `var(--token)`. */
  color: string;
}

interface ContextRingGlyphProps {
  usage: { promptTokens: number; contextLimit?: number; contextWindow?: number };
  categories: ContextRingCategory[];
  /** Colour of the whole filled arc; a function receives the fill fraction (0–1). */
  fillColor?: string | ((fillFraction: number) => string);
  size?: number;
  strokeWidth?: number;
  className?: string;
}

/**
 * The ring is a fill gauge: the arc length is how full the context window is
 * (promptTokens / limit), and the filled arc is split by the breakdown proportions.
 */
export const ContextRingGlyph: React.FC<ContextRingGlyphProps> = ({ usage, categories, fillColor, size = 20, strokeWidth = 2.5, className }) => {
  const center = size / 2;
  const radius = center - strokeWidth / 2;
  const circumference = 2 * Math.PI * radius;

  const segments = useMemo(() => {
    const total = usage.promptTokens;
    if (!total || total <= 0) return [];
    const limit = usage.contextLimit || usage.contextWindow || 0;
    const fillFraction = limit > 0 ? Math.min(1, total / limit) : 1;
    const filledArc = fillFraction * circumference;
    const solid = typeof fillColor === "function" ? fillColor(fillFraction) : fillColor;
    let offset = 0;
    return categories
      .filter((c) => c.value > 0)
      .map((c) => {
        const length = (c.value / total) * filledArc;
        const seg = { key: c.key, color: solid ?? c.color, length, dashOffset: -offset };
        offset += length;
        return seg;
      })
      .filter((s) => s.length > 0);
  }, [usage.promptTokens, usage.contextLimit, usage.contextWindow, circumference, categories, fillColor]);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={className} style={{ transform: "rotate(-90deg)", flexShrink: 0 }}>
      <circle cx={center} cy={center} r={radius} fill="none" stroke="color-mix(in srgb, var(--text-muted) 25%, transparent)" strokeWidth={strokeWidth} />
      {segments.map((s) => (
        <circle
          key={s.key}
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={s.color}
          strokeWidth={strokeWidth}
          strokeDasharray={`${s.length} ${circumference - s.length}`}
          strokeDashoffset={s.dashOffset}
          style={{ transition: "stroke-dasharray 0.3s ease, stroke-dashoffset 0.3s ease" }}
        />
      ))}
    </svg>
  );
};
