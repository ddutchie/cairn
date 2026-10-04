/**
 * Colour helpers for canvas-2D and SVG visualisations: resolve CSS custom
 * properties to literal colours, apply alpha, and map theme tokens to vars.
 * Pure functions, no React.
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
 * Per-frame memoised `resolveCssVar`. `getComputedStyle` + `getPropertyValue`
 * is far too slow to call once per node/edge per frame (thousands of calls on a
 * large graph), so canvas draw loops create one reader at the top of each frame
 * and look colours up through it. A fresh reader per frame keeps theme changes
 * correct without any invalidation bookkeeping.
 */
export function createCssVarReader(): (varName: string) => string {
  if (typeof document === "undefined") return () => "#888";
  let style: CSSStyleDeclaration | null = null;
  const cache = new Map<string, string>();
  return (varName) => {
    let v = cache.get(varName);
    if (v === undefined) {
      style ??= getComputedStyle(document.documentElement);
      v = style.getPropertyValue(varName.replace(/^var\((.+)\)$/, "$1")).trim();
      cache.set(varName, v);
    }
    return v;
  };
}

/** Per-frame memoised `withAlpha` (same rationale as `createCssVarReader`). */
export function createAlphaCache(): (color: string, opacity: number) => string {
  const cache = new Map<string, string>();
  return (color, opacity) => {
    const key = `${color}|${opacity}`;
    let v = cache.get(key);
    if (v === undefined) {
      v = withAlpha(color, opacity);
      cache.set(key, v);
    }
    return v;
  };
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
