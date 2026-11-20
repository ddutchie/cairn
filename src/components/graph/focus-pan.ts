/**
 * Where to pan the force canvas so a keyboard-focused node is on screen.
 * Pure: the canvas feeds it the node's world position, the current view
 * transform (`k`, `x`, `y`) and the canvas size.
 */

export interface ViewTransform { k: number; x: number; y: number }

/** Screen px a focused node must keep from the canvas edge to count as visible. */
export const FOCUS_MARGIN = 48;

/** The node's position on screen under `t`. */
export const toScreen = (t: ViewTransform, x: number, y: number) => ({ x: x * t.k + t.x, y: y * t.k + t.y });

/** Whether a node at world (`x`,`y`) is on screen, clear of the edge by `margin`. */
export function isOnScreen(t: ViewTransform, x: number, y: number, width: number, height: number, margin = FOCUS_MARGIN): boolean {
  const s = toScreen(t, x, y);
  return s.x >= margin && s.x <= width - margin && s.y >= margin && s.y <= height - margin;
}

/**
 * What to do for a focused node: `wait` while the layout hasn't given it a
 * position (try again when it has), `none` when it is already on screen,
 * `pan` when it is not.
 */
export function planFocusPan(
  node: { x?: number | null; y?: number | null } | undefined,
  t: ViewTransform,
  width: number,
  height: number,
): "wait" | "none" | "pan" {
  if (!node || node.x == null || node.y == null) return "wait";
  return isOnScreen(t, node.x, node.y, width, height) ? "none" : "pan";
}
