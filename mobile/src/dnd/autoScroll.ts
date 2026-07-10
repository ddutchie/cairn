/**
 * Pure math for drag auto-scroll + scroll-aware hit-testing, extracted so the
 * edge-ramp and frame-offset logic can be unit-tested without reanimated / a
 * device. All functions are worklet-safe (no closures over non-worklet state).
 */

/** Default edge hot-zone (px) at each end of the scroll viewport. */
export const AUTO_SCROLL_EDGE = 64;
/** Max auto-scroll speed (px per frame) at the deepest point of the edge zone. */
export const AUTO_SCROLL_MAX_SPEED = 14;

/**
 * Auto-scroll delta (px, signed) for one frame given the finger position along
 * the scroll axis and the viewport's start/end (window coords on that axis).
 *
 *   - finger within `edge` of the start → negative (scroll toward start)
 *   - finger within `edge` of the end   → positive (scroll toward end)
 *   - otherwise → 0
 *
 * Speed ramps linearly with how deep the finger is into the edge zone, capped
 * at `maxSpeed`, so the edge feels responsive without overshooting.
 */
export function autoScrollDelta(
  pos: number,
  viewportStart: number,
  viewportEnd: number,
  edge: number = AUTO_SCROLL_EDGE,
  maxSpeed: number = AUTO_SCROLL_MAX_SPEED,
): number {
  "worklet";
  const lo = viewportStart + edge;
  const hi = viewportEnd - edge;
  // Degenerate viewport (smaller than two edges): no auto-scroll.
  if (hi <= lo) return 0;
  if (pos < lo) {
    const depth = Math.min(lo - pos, edge) / edge; // 0..1
    return -depth * maxSpeed;
  }
  if (pos > hi) {
    const depth = Math.min(pos - hi, edge) / edge; // 0..1
    return depth * maxSpeed;
  }
  return 0;
}

/** Clamp `v` into [min, max]. */
export function clampScroll(v: number, min: number, max: number): number {
  "worklet";
  return v < min ? min : v > max ? max : v;
}

/**
 * A zone's window rect adjusted for how far the scroller has moved since the
 * rects were measured. When the list scrolls by `scrollDelta` on `axis`, every
 * zone shifts by `-scrollDelta` in window space, so we subtract it here instead
 * of re-measuring (which is async + laggy).
 *
 * `scrollDelta = currentOffset - offsetAtMeasureTime`.
 */
export function adjustRectForScroll(
  rect: { x: number; y: number; width: number; height: number },
  scrollDelta: number,
  axis: "x" | "y",
): { x: number; y: number; width: number; height: number } {
  "worklet";
  if (axis === "x") return { ...rect, x: rect.x - scrollDelta };
  return { ...rect, y: rect.y - scrollDelta };
}

/** True when `(px, py)` is inside `rect`. */
export function pointInRect(
  px: number,
  py: number,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  "worklet";
  return px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height;
}
