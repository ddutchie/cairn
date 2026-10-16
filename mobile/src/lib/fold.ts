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
 * long dimension's middle, like Apple's split arrangement). That inference assumes
 * the window fills the inner display, so it is only the fallback: when the native
 * `fold-region` module reports the real division ReservedRegion frame,
 * `foldFromRegion` derives the crease from it (correct in Split View too) and
 * `resolveFold` prefers it.
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

/** A rect in window points. */
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Regions thinner than this once clipped to the window don't touch it. */
const MIN_REGION_THICKNESS = 1;

/**
 * The crease from the real division region's frame (window coordinates, margins
 * included). The frame is clipped to the window — in Split View the region may
 * lie wholly outside it (null) or only overlap its edge (a sliver at that edge).
 * The axis follows the clipped band: wider than tall → a horizontal crease.
 */
export function foldFromRegion(region: Frame, window: { width: number; height: number }): Fold | null {
  const left = Math.max(region.x, 0);
  const top = Math.max(region.y, 0);
  const right = Math.min(region.x + region.width, window.width);
  const bottom = Math.min(region.y + region.height, window.height);
  const w = right - left;
  const h = bottom - top;
  if (w < MIN_REGION_THICKNESS || h < MIN_REGION_THICKNESS) return null;
  return w > h
    ? { axis: "horizontal", position: top + h / 2, gutter: h }
    : { axis: "vertical", position: left + w / 2, gutter: w };
}

/**
 * The crease to lay out around. `region` is the native division-region frame:
 * `undefined` when the API is unavailable (older iOS, Android, build without the
 * module) → infer from hinge status + window shape; `null` when the OS reports no
 * active region (flat, outer display, Split View window clear of the crease);
 * a frame otherwise.
 */
export function resolveFold(
  window: { width: number; height: number },
  status: HingeStatus | null,
  region: Frame | null | undefined,
): Fold | null {
  if (region === undefined) return foldGeometry(window, status);
  return region ? foldFromRegion(region, window) : null;
}

/** Share of the window the open item takes when no crease splits it. */
export const SIDE_PANE_SHARE = 0.6;

/**
 * Width of the pane that opens beside a screen. With a vertical crease inside the
 * window the pane starts on it, so the screen and the open item each get their own
 * half. Otherwise (flat, closed, or a Split View window that only touches the crease
 * at its edge, where "half the window" would miss it) the open item takes the larger
 * share. Driven by the crease geometry, never by the hinge status alone.
 */
export function sidePaneWidth(windowWidth: number, fold: Fold | null): number {
  const splits = fold != null && fold.axis === "vertical" && fold.position > windowWidth * 0.25 && fold.position < windowWidth * 0.75;
  return Math.round(splits ? windowWidth - fold.position : windowWidth * SIDE_PANE_SHARE);
}
