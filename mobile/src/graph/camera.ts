export interface Camera {
  /** Scale. */
  k: number;
  /** Translation in screen px: screen = world * k + (tx, ty). */
  tx: number;
  ty: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 6;
/** Initial zoom before the first auto-fit lands (matches the WebView). */
export const INITIAL_ZOOM = 0.85;

export const clampZoom = (k: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k));

export function screenToWorld(c: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - c.tx) / c.k, y: (sy - c.ty) / c.k };
}

export function worldToScreen(c: Camera, x: number, y: number): { x: number; y: number } {
  return { x: x * c.k + c.tx, y: y * c.k + c.ty };
}

/** A camera that puts the world origin at the viewport centre. */
export function centeredCamera(width: number, height: number, k = INITIAL_ZOOM): Camera {
  return { k, tx: width / 2, ty: height / 2 };
}

/** Zoom to `k` keeping the world point under screen (sx, sy) fixed. */
export function zoomAt(c: Camera, k: number, sx: number, sy: number): Camera {
  const nk = clampZoom(k);
  const w = screenToWorld(c, sx, sy);
  return { k: nk, tx: sx - w.x * nk, ty: sy - w.y * nk };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding box of the nodes, padded by their radius; null when empty. */
export function boundsOf(nodes: readonly { x: number; y: number; r: number }[], extra = 8): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    const pad = n.r + extra;
    minX = Math.min(minX, n.x - pad);
    minY = Math.min(minY, n.y - pad);
    maxX = Math.max(maxX, n.x + pad);
    maxY = Math.max(maxY, n.y + pad);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Camera framing `b` inside the viewport with `margin` px to spare. */
export function fitCamera(b: Bounds, width: number, height: number, margin = 40): Camera {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const k = clampZoom(Math.min((width - margin) / bw, (height - margin) / bh));
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return { k, tx: width / 2 - cx * k, ty: height / 2 - cy * k };
}

export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  return { k: a.k + (b.k - a.k) * t, tx: a.tx + (b.tx - a.tx) * t, ty: a.ty + (b.ty - a.ty) * t };
}

export const easeCubicInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Minimum touch target radius on screen (pt), regardless of node size. */
export const MIN_TOUCH_RADIUS = 22;

/**
 * Nearest node whose centre is within max(radius, MIN_TOUCH_RADIUS / k) of the
 * world point; null when nothing is close enough. Brute force: the graph tops
 * out at a few thousand nodes and this runs once per touch.
 */
export function hitNode<T extends { x: number; y: number; r: number }>(
  nodes: readonly T[],
  wx: number,
  wy: number,
  k: number,
): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  const touch = MIN_TOUCH_RADIUS / k;
  for (const n of nodes) {
    const d = Math.hypot(n.x - wx, n.y - wy);
    if (d <= Math.max(n.r, touch) && d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}
