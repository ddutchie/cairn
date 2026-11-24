import type { CornerSafeInsets } from "@/lib/screen-corners";

/**
 * Where a pixel game's HUD must stay clear of, in game pixels: the safe area
 * plus the rounded display corners (`cornerSafeInsets`). `top`/`bottom` are
 * the rows reserved at each edge; `left`/`right` the columns along the sides
 * (the Duo's rail); the corner fields are the side insets for a row hugging
 * the top or bottom edge.
 */
export interface PixelHud {
  top: number;
  bottom: number;
  left: number;
  right: number;
  topLeft: number;
  topRight: number;
  bottomLeft: number;
  bottomRight: number;
}

export const NO_HUD: PixelHud = { top: 0, bottom: 0, left: 0, right: 0, topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 };

/** Converts point insets to game pixels at scale `k`, rounding outward. */
export function hudFromInsets(s: CornerSafeInsets, k: number): PixelHud {
  const g = (v: number) => Math.ceil(v / k);
  return {
    top: g(s.top),
    bottom: g(s.bottom),
    left: g(s.left),
    right: g(s.right),
    topLeft: g(s.topLeft),
    topRight: g(s.topRight),
    bottomLeft: g(s.bottomLeft),
    bottomRight: g(s.bottomRight),
  };
}
