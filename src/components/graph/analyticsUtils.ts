/**
 * Shared constants and helpers for the Insights canvases (time buckets,
 * priority weights, padding, label truncation). Keep this file free of React
 * imports. Renderer-generic colour helpers live in `@/lib/viz/color`.
 */

// ── Time helpers ──────────────────────────────────────────────────────────────

export const HOUR_MS = 3_600_000;
export const DAY_MS  = 86_400_000;

export function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export function floorDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

// ── Priority ──────────────────────────────────────────────────────────────────

/**
 * CSS-variable colour for each priority level.
 * Canonical source lives in `@/lib/constants` (`PRIORITY_CSS_COLORS`);
 * re-exported here under the canvas-friendly `PRIORITY_COLOR` name so the
 * analytics canvases keep a single import site.
 */
export { PRIORITY_CSS_COLORS as PRIORITY_COLOR } from "@/lib/constants";

/** Numeric sort weight — higher = more urgent. */
export const PRIORITY_WEIGHT: Record<string, number> = {
  low: 0, medium: 1, high: 2, urgent: 3,
};

/**
 * Sort key for ascending sort (urgent → low). Convenience for canvases that
 * sort by priority ascending: `arr.sort((a, b) => PRIORITY_SORT_ORDER[a] - PRIORITY_SORT_ORDER[b])`.
 */
export const PRIORITY_SORT_ORDER: Record<string, number> = {
  urgent: 0, high: 1, medium: 2, low: 3,
};

// ── String helpers ────────────────────────────────────────────────────────────

/**
 * Truncate a project/task name to `max` characters, appending "…" if needed.
 * Default max is 18 characters.
 */
export function truncateName(name: string, max = 18): string {
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

// ── SVG layout ────────────────────────────────────────────────────────────────

/** Standard padding used across all SVG-based analytics canvases. */
export const CANVAS_PAD = {
  top:    48,
  right:  32,
  bottom: 40,
  left:   140,
} as const;
