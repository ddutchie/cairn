"use client";

import React, { useMemo, useRef, useState, useCallback } from "react";
import { useContainerDims, useFontScale } from "@/components/graph/analyticsHooks";
import { fmtFull, fmtCompact, fmtDay } from "./usage-format";
import { formatUsd } from "../../../shared/chat/provider-credits";
import type { UsageDayBucket } from "@/types/usage";

export type UsageMetric = "tokens" | "cost" | "requests";

interface Props {
  series: UsageDayBucket[];
  metric: UsageMetric;
}

const PAD_L = 52;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 24;
const HEIGHT = 280;

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return n * p;
}

export function UsageChart({ series, metric }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const { width: w } = useContainerDims(wrapRef as React.RefObject<HTMLDivElement | null>);
  const fontScale = useFontScale();
  const [hover, setHover] = useState<number | null>(null);

  const metricLabel = metric === "tokens" ? "Tokens" : metric === "cost" ? "Cost" : "Requests";

  const { paths, yTicks, xLabels, yMax } = useMemo(() => {
    if (series.length === 0) {
      return { paths: null as null, yTicks: [] as Array<{ v: number; y: number }>, xLabels: [] as Array<{ x: number; t: string }>, yMax: 0 };
    }
    const n = series.length;
    const colW = (w - PAD_L - PAD_R) / Math.max(1, n - 1);
    const X = (i: number) => PAD_L + i * colW;
    const valOf = (d: UsageDayBucket) => (metric === "cost" ? d.costUsd : metric === "requests" ? d.requests : d.completionTokens);
    const vals = series.map(valOf);
    const inVals = series.map((d) => d.promptTokens);
    const top = Math.max.apply(null, vals.concat(metric === "tokens" ? inVals : []));
    const nice = niceCeil(top);
    const Y = (v: number) => PAD_T + (HEIGHT - PAD_T - PAD_B) * (1 - v / nice);

    const line = (arr: number[]) => arr.map((v, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    const area = `${line(inVals)} L${X(n - 1).toFixed(1)},${Y(0).toFixed(1)} L${X(0).toFixed(1)},${Y(0).toFixed(1)} Z`;

    const yTicks = [];
    for (let t = 0; t <= 4; t++) {
      yTicks.push({ v: (nice * t) / 4, y: Y((nice * t) / 4) });
    }
    const step = n > 40 ? 14 : n > 14 ? 7 : 2;
    const xLabels = [];
    for (let i = 0; i < n; i += step) {
      xLabels.push({ x: X(i), t: fmtDay(series[i].day) });
    }
    return { paths: { area, in: line(inVals), out: line(vals) }, yTicks, xLabels, yMax: nice };
  }, [series, metric, w]);

  const handleMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect || series.length === 0) return;
      const colW = (w - PAD_L - PAD_R) / Math.max(1, series.length - 1);
      const idx = Math.round((e.clientX - rect.left - PAD_L) / colW);
      setHover(idx >= 0 ? Math.min(idx, series.length - 1) : null);
    },
    [series.length, w],
  );

  const hovered = hover != null ? series[hover] : null;
  const hoverX = hover != null && yMax > 0 ? PAD_L + hover * ((w - PAD_L - PAD_R) / Math.max(1, series.length - 1)) : 0;
  const inY = hovered ? PAD_T + (HEIGHT - PAD_T - PAD_B) * (1 - hovered.promptTokens / yMax) : 0;
  const outY = hovered ? PAD_T + (HEIGHT - PAD_T - PAD_B) * (1 - (metric === "cost" ? hovered.costUsd : metric === "requests" ? hovered.requests : hovered.completionTokens) / yMax) : 0;

  return (
    <div
      ref={wrapRef}
      className="relative w-full"
      style={{ height: HEIGHT }}
      onMouseMove={handleMove}
      onMouseLeave={() => setHover(null)}
    >
      {series.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--text-tertiary)]">
          No usage in this range yet.
        </div>
      ) : (
        <svg width={w} height={HEIGHT} className="block">
          {yTicks.map((t) => (
            <g key={t.v}>
              <line x1={PAD_L} x2={w - PAD_R} y1={t.y} y2={t.y} stroke="var(--border-subtle)" strokeWidth={1} />
              <text x={PAD_L - 8} y={t.y + 3} textAnchor="end" fontSize={10 * fontScale} fill="var(--text-tertiary)">
                {metric === "cost" ? (t.v >= 1 ? `$${t.v.toFixed(0)}` : `$${t.v.toFixed(2)}`) : fmtCompact(t.v)}
              </text>
            </g>
          ))}
          {xLabels.map((l) => (
            <text key={l.x} x={l.x} y={HEIGHT - 8} textAnchor="middle" fontSize={10 * fontScale} fill="var(--text-tertiary)">
              {l.t}
            </text>
          ))}
          {paths && (
            <>
              <path d={paths.area} fill="color-mix(in srgb, var(--accent) 16%, transparent)" stroke="none" />
              <path d={paths.in} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
              <path d={paths.out} fill="none" stroke="var(--info)" strokeWidth={2} strokeLinejoin="round" />
            </>
          )}
          {/* A single-day series has a degenerate area/line (nothing renders) —
              draw explicit markers so "only today" still shows on the chart. */}
          {series.length === 1 && yMax > 0 && (
            <g>
              <circle
                cx={PAD_L}
                cy={PAD_T + (HEIGHT - PAD_T - PAD_B) * (1 - series[0].promptTokens / yMax)}
                r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={1.5}
              />
              <circle
                cx={PAD_L}
                cy={PAD_T + (HEIGHT - PAD_T - PAD_B) * (1 - (metric === "cost" ? series[0].costUsd : metric === "requests" ? series[0].requests : series[0].completionTokens) / yMax)}
                r={4} fill="var(--info)" stroke="var(--surface)" strokeWidth={1.5}
              />
            </g>
          )}
          {hovered && (
            <g>
              <line x1={hoverX} x2={hoverX} y1={PAD_T} y2={HEIGHT - PAD_B} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />
              <circle cx={hoverX} cy={inY} r={3.5} fill="var(--accent)" />
              <circle cx={hoverX} cy={outY} r={3.5} fill="var(--info)" />
            </g>
          )}
        </svg>
      )}
      {hovered && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 shadow-xl"
          style={{
            left: Math.min(w - 170, Math.max(8, hoverX - 85)),
            top: Math.max(4, inY - 86),
          }}
        >
          <div className="text-[0.643rem] uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-1">{fmtDay(hovered.day)}</div>
          <div className="flex justify-between gap-6 text-xs">
            <span className="text-[var(--text-secondary)]">Input</span>
            <span className="font-mono font-semibold text-[var(--text-primary)]">{fmtFull(hovered.promptTokens)}</span>
          </div>
          <div className="flex justify-between gap-6 text-xs mt-1">
            <span className="text-[var(--text-secondary)]">Output</span>
            <span className="font-mono font-semibold text-[var(--text-primary)]">{fmtFull(hovered.completionTokens)}</span>
          </div>
          {metric === "cost" && (
            <div className="flex justify-between gap-6 text-xs mt-1">
              <span className="text-[var(--text-secondary)]">{metricLabel}</span>
              <span className="font-mono font-semibold text-[var(--text-primary)]">{formatUsd(hovered.costUsd)}</span>
            </div>
          )}
          {metric === "requests" && (
            <div className="flex justify-between gap-6 text-xs mt-1">
              <span className="text-[var(--text-secondary)]">Calls</span>
              <span className="font-mono font-semibold text-[var(--text-primary)]">{fmtFull(hovered.requests)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
