"use client";

/**
 * The Today stack, drawn in the style of the app icon: rounded slabs with a
 * lit top band and a dark lip, the accent block (with the sparkle) on top.
 *
 * - `CairnStack`: the Today header. Slabs are weighted by lane count.
 * - `MiniStack`: the same mark at 12–28px (the Today tab, the Automations row,
 *   the Refresh button while a run is gathering).
 *
 * Motion (`globals.css`, off under prefers-reduced-motion): `busy` bobs the
 * top block and sweeps a light over it; `drop` stacks the slabs bottom-up once,
 * used when a brief the user hasn't seen arrives.
 */

import { useId } from "react";
import { cn } from "@/lib/utils";

export type StackLane = "focus" | "need" | "prep" | "fyi";

interface Layer { lane: StackLane; h: number; w: number; fill: string }

const FILL: Record<StackLane, string> = {
  fyi: "var(--stone-1)",
  prep: "var(--stone-2)",
  need: "var(--stone-3)",
  focus: "var(--accent)",
};

function sparklePath(cx: number, cy: number, k: number): string {
  const j = k * 0.28;
  return `M${cx} ${cy - k} L${cx + j} ${cy - j} L${cx + k} ${cy} L${cx + j} ${cy + j} L${cx} ${cy + k} L${cx - j} ${cy + j} L${cx - k} ${cy} L${cx - j} ${cy - j}Z`;
}

/** Bottom-up positions: each layer sits `gap` above the one below it, centred. */
function placeLayers(layers: Layer[], width: number, gap: number, bottom: number) {
  const out: Array<Layer & { x: number; y: number }> = [];
  for (const l of layers) {
    const prev = out[out.length - 1];
    const y = (prev ? prev.y - gap : bottom) - l.h;
    out.push({ ...l, x: (width - l.w) / 2, y });
  }
  return out;
}

function Slabs({ layers, width, gap, pad, radius, sparkle, dot, busy, drop, onPick, className, label }: {
  layers: Layer[];
  width: number;
  gap: number;
  pad: number;
  radius: (h: number) => number;
  sparkle: boolean;
  dot?: boolean;
  busy?: boolean;
  drop?: boolean;
  onPick?: (lane: StackLane) => void;
  className?: string;
  /** Accessible name; when absent the mark is decorative. */
  label?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const total = layers.reduce((sum, l) => sum + l.h, 0) + gap * (layers.length - 1);
  const shadow = Math.max(1.5, width * 0.02);
  const H = total + pad * 2 + shadow * 2;
  const placed = placeLayers(layers, width, gap, H - pad - shadow);

  return (
    <svg
      viewBox={`0 0 ${width} ${H}`}
      width={width}
      height={H}
      className={cn("cairn-stack shrink-0 overflow-visible", busy && "is-busy", drop && "is-drop", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <ellipse cx={width / 2} cy={H - shadow} rx={width * 0.42} ry={shadow} fill="color-mix(in srgb, black 25%, transparent)" />
      {placed.map((l, i) => {
        const rx = radius(l.h);
        const band = Math.max(l.h * 0.22, Math.min(l.h * 0.34, 10));
        const lip = Math.max(l.h * 0.12, Math.min(l.h * 0.18, 5));
        const clip = `${uid}-${l.lane}`;
        const top = i === placed.length - 1;
        return (
          <g
            key={l.lane}
            className={cn("cairn-slab", top && "is-top", onPick && "cursor-pointer transition-[filter] hover:brightness-125")}
            style={drop ? { animationDelay: `${i * 110}ms` } : undefined}
            onClick={onPick ? () => onPick(l.lane) : undefined}
          >
            <clipPath id={clip}><rect x={l.x} y={l.y} width={l.w} height={l.h} rx={rx} /></clipPath>
            <rect x={l.x} y={l.y + Math.max(0.6, l.h * 0.06)} width={l.w} height={l.h} rx={rx} fill="color-mix(in srgb, black 28%, transparent)" />
            <rect x={l.x} y={l.y} width={l.w} height={l.h} rx={rx} fill={l.fill} />
            <g clipPath={`url(#${clip})`}>
              <rect x={l.x} y={l.y} width={l.w} height={band} fill="color-mix(in srgb, white 16%, transparent)" />
              <rect x={l.x} y={l.y + l.h - lip} width={l.w} height={lip} fill="color-mix(in srgb, black 22%, transparent)" />
              {top && <rect className="cairn-shine" x={l.x} y={l.y} width={l.w} height={l.h} fill="color-mix(in srgb, white 55%, transparent)" opacity={0} />}
            </g>
            {top && sparkle && (
              <path d={sparklePath(l.x + l.w / 2, l.y + l.h / 2 - 0.3, Math.min(l.h, l.w) * 0.28)} fill="color-mix(in srgb, white 92%, transparent)" />
            )}
            {top && dot && (
              <circle cx={l.x + l.w - 1} cy={l.y + 0.5} r={Math.max(2.4, l.h * 0.42)} fill="var(--accent)" stroke="var(--background)" strokeWidth={1.2} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** The Today header: slabs weighted by lane count, focus on top. */
export function CairnStack({ counts, onPick, muted, busy, drop, className }: {
  counts: { need: number; prep: number; fyi: number };
  onPick?: (lane: StackLane) => void;
  /** Grey top block (no brief yet). */
  muted?: boolean;
  busy?: boolean;
  drop?: boolean;
  className?: string;
}) {
  // An empty lane stays a thin plate so the silhouette never breaks.
  const h = (n: number) => 9 + Math.min(n, 6) * 4.5;
  return (
    <Slabs
      layers={[
        { lane: "fyi", h: h(counts.fyi), w: 116, fill: FILL.fyi },
        { lane: "prep", h: h(counts.prep), w: 110, fill: FILL.prep },
        { lane: "need", h: h(counts.need), w: 104, fill: FILL.need },
        { lane: "focus", h: 24, w: 96, fill: muted ? FILL.need : FILL.focus },
      ]}
      width={132}
      gap={3}
      pad={6}
      radius={(lh) => Math.min(10, lh * 0.42)}
      sparkle
      busy={busy}
      drop={drop}
      onPick={onPick}
      className={className}
    />
  );
}

/**
 * The mark at icon size. Three equal slabs; `dot` marks a brief the user hasn't
 * opened, `busy` animates while a run is gathering.
 */
export function MiniStack({ size = 16, dot, busy, muted, label, className }: {
  size?: number;
  dot?: boolean;
  busy?: boolean;
  muted?: boolean;
  label?: string;
  className?: string;
}) {
  const s = size / 20;
  return (
    <Slabs
      layers={[
        { lane: "fyi", h: 4.6 * s, w: 18 * s, fill: FILL.fyi },
        { lane: "prep", h: 4.6 * s, w: 17 * s, fill: FILL.prep },
        { lane: "focus", h: 5.2 * s, w: 16 * s, fill: muted ? FILL.need : FILL.focus },
      ]}
      width={20 * s}
      gap={1 * s}
      pad={0.5 * s}
      radius={(lh) => lh * 0.36}
      sparkle={size >= 24}
      dot={dot}
      busy={busy}
      label={label}
      className={className}
    />
  );
}

// ── Seen state: drives the tab dot and the one-time drop-in ────────────────

const SEEN_KEY = (projectId: string) => `today:seen:${projectId}`;
export const TODAY_SEEN_EVENT = "cairn:today-seen";

export function todaySeenAt(projectId: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(SEEN_KEY(projectId));
}

export function markTodaySeen(projectId: string, generatedAt: string): void {
  if (todaySeenAt(projectId) === generatedAt) return;
  localStorage.setItem(SEEN_KEY(projectId), generatedAt);
  window.dispatchEvent(new CustomEvent(TODAY_SEEN_EVENT, { detail: { projectId } }));
}
