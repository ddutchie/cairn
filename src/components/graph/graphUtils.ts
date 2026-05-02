/**
 * Shared utilities for Knowledge Graph canvas components
 * (ForceGraphCanvas, RadialTreeCanvas).
 */

/** Resolves a CSS custom property to its computed hex/rgb value. */
export function resolveCssVar(varName: string): string {
  if (typeof document === "undefined") return "#888";
  return getComputedStyle(document.documentElement)
    .getPropertyValue(varName.replace(/^var\((.+)\)$/, "$1"))
    .trim();
}
