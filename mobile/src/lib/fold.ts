import type { HingeStatus } from "@expo/ui/swift-ui/modifiers";

/**
 * Where the iPhone Duo's crease is, derived from what the app can observe: the
 * hinge status and the window shape. Measured on the Duo simulator (see
 * `docs/mobile-wide-layouts.md`, "Poses"):
 *
 *   pose            window   hinge
 *   open, tall      669x951  fullyOpen
 *   laptop          669x951  partiallyOpen   ← horizontal crease
 *   open, wide      951x669  fullyOpen
 *   book            951x669  partiallyOpen   ← vertical crease
 *   closed (outer)  466x678  closed
 *
 * Laptop and tall have identical windows and insets, so the status is the only
 * signal; the axis follows the window's aspect (the crease runs across the
 * long dimension's middle, like Apple's split arrangement). Assumes the window
 * fills the inner display — in Split View the crease is no longer window-centred
 * until the native reserved-region frame replaces this (see the poses plan).
 */
export interface Fold {
  /** "horizontal" = crease runs left↔right, splitting top and bottom halves (laptop). */
  axis: "horizontal" | "vertical";
  /** Crease centre along the split axis, in window points (y for horizontal, x for vertical). */
  position: number;
  /** Width of the dead band around the crease, in points (observed ~20pt on the sim). */
  gutter: number;
}

/** Below this short side the window is the outer display, which has no crease. */
export const INNER_DISPLAY_MIN_SHORT_SIDE = 600;
export const FOLD_GUTTER = 20;

export function foldGeometry(
  window: { width: number; height: number },
  status: HingeStatus | null,
): Fold | null {
  if (status !== "partiallyOpen") return null;
  const { width, height } = window;
  if (Math.min(width, height) < INNER_DISPLAY_MIN_SHORT_SIDE) return null;
  return width < height
    ? { axis: "horizontal", position: height / 2, gutter: FOLD_GUTTER }
    : { axis: "vertical", position: width / 2, gutter: FOLD_GUTTER };
}

/** The two usable halves either side of the crease's gutter, as extents along the split axis. */
export function foldHalves(fold: Fold, extent: number): { before: number; after: number } {
  const half = fold.gutter / 2;
  return { before: Math.max(0, fold.position - half), after: Math.max(0, extent - (fold.position + half)) };
}
