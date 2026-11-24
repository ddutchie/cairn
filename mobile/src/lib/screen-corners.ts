/**
 * Rounded display corners. Safe-area insets cover the notch, Dynamic Island,
 * home indicator and the iPhone Duo's side rail, but not the rounded corners
 * themselves: with the Duo unfolded the top inset is 0 (the status pill sits in
 * the rail), so text pinned to the top-left corner gets clipped by the curve.
 *
 * `cornerSafeInsets` adds that: each edge keeps a small minimum, and rows that
 * hug the top or bottom edge get enough side inset that their outer corner
 * clears the curve at that height. Pure, so it is shared by every full-bleed
 * surface (the pixel games' HUDs today) and unit tested.
 */

/**
 * Display corner radius in points. iOS doesn't expose it; current iPhones sit
 * around 47–62pt, so this errs to the rounder side.
 */
export const DISPLAY_CORNER_RADIUS = 56;

export interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CornerSafeInsets extends Edges {
  /** Side insets for a row that starts `top` points down (hugging the top edge). */
  topLeft: number;
  topRight: number;
  /** Side insets for a row that ends `bottom` points up (hugging the bottom edge). */
  bottomLeft: number;
  bottomRight: number;
}

/** How far in from the side a point `d` from the top or bottom edge must sit to clear the corner curve. */
export function cornerClearance(d: number, radius = DISPLAY_CORNER_RADIUS): number {
  if (d >= radius) return 0;
  const k = radius - Math.max(0, d);
  return radius - Math.sqrt(radius * radius - k * k);
}

export function cornerSafeInsets(
  insets: Edges,
  opts: {
    radius?: number;
    /** Minimum top and bottom inset, so nothing touches the edge. */
    minEdge?: number;
    /**
     * Cap on the bottom inset: most of it is the home indicator, which
     * full-bleed content can draw under.
     */
    maxBottom?: number;
  } = {},
): CornerSafeInsets {
  const radius = opts.radius ?? DISPLAY_CORNER_RADIUS, minEdge = opts.minEdge ?? 10;
  const top = Math.max(insets.top, minEdge);
  const bottom = Math.max(Math.min(insets.bottom, opts.maxBottom ?? Infinity), minEdge);
  const topCurve = cornerClearance(top, radius), bottomCurve = cornerClearance(bottom, radius);
  return {
    top,
    bottom,
    left: insets.left,
    right: insets.right,
    topLeft: Math.ceil(Math.max(insets.left, topCurve)),
    topRight: Math.ceil(Math.max(insets.right, topCurve)),
    bottomLeft: Math.ceil(Math.max(insets.left, bottomCurve)),
    bottomRight: Math.ceil(Math.max(insets.right, bottomCurve)),
  };
}
