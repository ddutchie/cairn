"use client";

import React from "react";

type RadarAxis = { key: string; label: string; short: string; value: number; color: string };

export function ProjectHealthRadar({
  axes,
  size = 280,
}: {
  axes: RadarAxis[];
  size?: number;
}) {
  const n = axes.length;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.38;
  const levels = 4;

  const angleFor = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;

  const pointFor = (value: number, i: number) => {
    const a = angleFor(i);
    const r = radius * Math.max(0, Math.min(1, value));
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  };

  const polygonPoints = axes.map((ax, i) => pointFor(ax.value, i).join(",")).join(" ");

  // grid rings
  const rings = Array.from({ length: levels }, (_, li) => {
    const r = radius * ((li + 1) / levels);
    return axes.map((_, i) => {
      const a = angleFor(i);
      return `${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`;
    }).join(" ");
  });

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 md:p-[18px]" style={{ boxShadow: "0 8px 24px rgba(0,0,0,.28)" }}>
      <div className="flex items-center gap-2 mb-3">
        <span className="w-5 h-5 rounded-md grid place-items-center bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-tertiary)] text-[0.625rem]">⬢</span>
        <h2 className="text-[0.813rem] font-semibold tracking-tight">Project health</h2>
        <span className="text-xs font-normal text-[var(--text-tertiary)]">— 6-axis radar</span>
        <span className="ml-auto text-[0.643rem] font-mono text-[var(--text-tertiary)] hidden sm:inline">0 → 1</span>
      </div>

      <div className="flex flex-col lg:flex-row gap-8 items-center lg:items-start">
        <div className="w-full max-w-[280px] aspect-square flex-shrink-0 mr-2">
          <svg width="100%" height="100%" viewBox={`0 0 ${size} ${size}`} className="overflow-visible block" role="img" aria-label="Project health radar">
          {/* rings */}
          {rings.map((pts, i) => (
            <polygon key={i} points={pts} fill="none" stroke="var(--border)" strokeWidth={i === levels - 1 ? 1.25 : 1} opacity={i === levels - 1 ? 0.9 : 0.5} />
          ))}
          {/* axes */}
          {axes.map((_, i) => {
            const a = angleFor(i);
            const x2 = cx + Math.cos(a) * radius;
            const y2 = cy + Math.sin(a) * radius;
            return <line key={i} x1={cx} y1={cy} x2={x2} y2={y2} stroke="var(--border)" strokeWidth={1} opacity={0.7} />;
          })}
          {/* value polygon */}
          <polygon points={polygonPoints} fill="color-mix(in srgb,var(--accent) 18%, transparent)" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
          {/* dots */}
          {axes.map((ax, i) => {
            const [x, y] = pointFor(ax.value, i);
            return <circle key={ax.key} cx={x} cy={y} r={3.5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={1.5} />;
          })}
          {/* labels */}
          {axes.map((ax, i) => {
            const a = angleFor(i);
            const r = radius + 18;
            const x = cx + Math.cos(a) * r;
            const y = cy + Math.sin(a) * r;
            const anchor = Math.cos(a) > 0.35 ? "start" : Math.cos(a) < -0.35 ? "end" : "middle";
            const dy = Math.sin(a) > 0.5 ? 4 : Math.sin(a) < -0.5 ? -6 : 3;
            return (
              <text key={ax.key} x={x} y={y + dy} textAnchor={anchor as never} fontSize={10} fontWeight={600} fill="var(--text-tertiary)" style={{ letterSpacing: "0.04em" }}>
                {ax.short}
                <tspan dx={3} fontSize={8} fill="var(--text-tertiary)" opacity={0.9}>
                  {Math.round(ax.value * 100)}
                </tspan>
              </text>
            );
          })}
          {/* center */}
          <circle cx={cx} cy={cy} r={2} fill="var(--text-tertiary)" opacity={0.6} />
        </svg>
        </div>

        <div className="flex-1 min-w-0 w-full">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 gap-2">
            {axes.map((ax) => (
              <div key={ax.key} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: ax.color }} />
                  <span className="text-[0.714rem] font-semibold text-[var(--text-secondary)] truncate">{ax.label}</span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(ax.value * 100)}%`, background: ax.color }} />
                </div>
                <div className="mt-1 text-[0.643rem] font-mono text-[var(--text-tertiary)] tabular-nums">{Math.round(ax.value * 100)}%</div>
              </div>
            ))}
          </div>
          <p className="text-[0.714rem] leading-relaxed text-[var(--text-tertiary)] mt-3">
            Six balance axes from live project data — completion, momentum, focus, knowledge, flow, calm (inverse urgent load). 100 is healthiest.
          </p>
        </div>
      </div>
    </div>
  );
}

export function useRadarAxes(metrics: {
  completionRate: number;
  openCards: { length: number };
  overdueCount: number;
  todayCount: number;
  notes: { length: number };
  pinnedNotes: { length: number };
  recentNotes: { length: number };
  bottleneck: { count: number } | null;
  priorityCounts: { urgent: number; high: number; medium: number; low: number };
  columns: { id: string; type: string }[];
  allCards: { length: number };
  activityByDay: { items: unknown[] }[];
}): RadarAxis[] {
  const open = Math.max(metrics.openCards.length, 1);
  const total = Math.max(metrics.allCards.length, 1);
  const need = metrics.overdueCount + metrics.todayCount;

  const completion = Math.max(0, Math.min(1, metrics.completionRate / 100));

  // Momentum: recent notes + done share + activity
  const recentRatio = metrics.notes.length ? metrics.recentNotes.length / Math.min(metrics.notes.length, 8) : 0;
  const doneRatio = (total - open) / total;
  const activityRatio = Math.min(metrics.activityByDay.length / 5, 1);
  const momentum = Math.max(0, Math.min(1, recentRatio * 0.35 + doneRatio * 0.4 + activityRatio * 0.25));

  const focus = Math.max(0, Math.min(1, 1 - need / open));

  // Knowledge: notes volume + pinned health
  const notesVol = Math.min(metrics.notes.length / 12, 1);
  const pinnedHealth = metrics.notes.length ? Math.min(metrics.pinnedNotes.length / 4, 1) * 0.6 + 0.4 : 0;
  const knowledge = Math.max(0, Math.min(1, notesVol * 0.7 + pinnedHealth * 0.3));

  // Flow: bottleneck pressure
  const bottleneckCount = metrics.bottleneck?.count ?? 0;
  const flow = Math.max(0, Math.min(1, 1 - bottleneckCount / open));

  // Urgency: high-priority load inverse
  const urgentHigh = (metrics.priorityCounts.urgent ?? 0) + (metrics.priorityCounts.high ?? 0);
  const urgency = Math.max(0, Math.min(1, 1 - urgentHigh / open));

  // Calm is 1 - high-priority load: 100 = low pressure, 0 = swamped with urgent/high. Label as Calm so green = healthy.
  const calm = urgency;
  return [
    { key: "completion", label: "Completion", short: "Done", value: completion, color: "var(--success)" },
    { key: "momentum", label: "Momentum", short: "Mome", value: momentum, color: "var(--accent)" },
    { key: "focus", label: "Focus", short: "Focus", value: focus, color: "var(--info)" },
    { key: "knowledge", label: "Knowledge", short: "Know", value: knowledge, color: "#a78bfa" },
    { key: "flow", label: "Flow", short: "Flow", value: flow, color: "var(--warning)" },
    { key: "calm", label: "Calm", short: "Calm", value: calm, color: "var(--success)" },
  ];
}
