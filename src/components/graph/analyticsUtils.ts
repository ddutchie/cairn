/**
 * Shared utilities for analytics + Knowledge Graph canvas components.
 * Keep this file free of React imports — pure functions and constants only.
 *
 * Consolidated from `analyticsUtils.ts` + the former `graphUtils.ts` (P3-5 of the
 * cleanup plan): `resolveCssVar` was the only export in `graphUtils.ts` (12 lines)
 * and is now co-located here so there are 3 graph helper modules instead of 4.
 */

// ── CSS variable resolution (canvas-2D) ─────────────────────────────────────

/**
 * Resolve a CSS custom property to its computed value (hex/rgb string).
 * Used by canvas-2D rendering (ForceGraphCanvas, RadialTreeCanvas) which
 * needs the literal colour string, not a `var(--…)` reference.
 */
export function resolveCssVar(varName: string): string {
  if (typeof document === "undefined") return "#888";
  return getComputedStyle(document.documentElement)
    .getPropertyValue(varName.replace(/^var\((.+)\)$/, "$1"))
    .trim();
}

/**
 * Map a shared graph `ThemeToken` (camelCase, e.g. "textPrimary", "nodeProject")
 * to its CSS custom-property name (kebab-case, e.g. "--text-primary",
 * "--node-project"). Single source of truth for the token→var conversion used by
 * the graph canvases and the store's `nodeTypeColor`.
 */
export function tokenToCssVar(token: string): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Apply an alpha (0–1) to any CSS colour for canvas use.
 * Hex inputs use a fast `#rrggbbaa` path; every other format (rgb(), oklch(),
 * var(), …) is wrapped in `color-mix(in srgb, …, transparent)` so transparency
 * is preserved regardless of the theme token's colour format. Canvas 2D in the
 * bundled Chromium supports `color-mix()` as a fill/stroke style.
 */
export function withAlpha(color: string, opacity: number): string {
  const o = Math.max(0, Math.min(1, opacity));
  if (color.startsWith("#")) {
    const a = Math.round(o * 255).toString(16).padStart(2, "0");
    // normalise #rgb → #rrggbb
    if (color.length === 4) {
      const r = color[1], g = color[2], b = color[3];
      return `#${r}${r}${g}${g}${b}${b}${a}`;
    }
    return color.slice(0, 7) + a;
  }
  return `color-mix(in srgb, ${color} ${(o * 100).toFixed(2)}%, transparent)`;
}

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
