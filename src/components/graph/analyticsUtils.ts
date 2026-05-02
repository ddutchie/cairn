/**
 * Shared utilities for analytics canvas components.
 * Keep this file free of React imports — pure functions and constants only.
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

/** CSS-variable colour for each priority level. */
export const PRIORITY_COLOR: Record<string, string> = {
  low:    "var(--text-tertiary)",
  medium: "var(--info)",
  high:   "var(--warning)",
  urgent: "var(--danger)",
};

/** Numeric sort weight — higher = more urgent. */
export const PRIORITY_WEIGHT: Record<string, number> = {
  low: 0, medium: 1, high: 2, urgent: 3,
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
