/**
 * Fixed-yaw oblique projection for 3D-projected arcade views.
 *
 * Same voxel data, different camera: world (x, y, height) maps to volume
 * pixels with a dimetric-style shear, verticals stay vertical, and depth
 * (`x + y`) increases toward the viewer. Pure and unit-tested; renderers
 * call `project` for drawing and `unproject` to turn taps back into world
 * coordinates. No backend changes required.
 */

export const VOL = {
  /** Screen px per world px on the ground shear. */
  ox: 0.55,
  /** Screen px per world px of depth (steeper oblique tilt for 3D relief). */
  oy: 0.35,
  /** Screen px per height ledge (tall terraces like A Short Hike). */
  zh: 28,
  /** Volume-space origin and extents (fits a 1080×1320 fall line). */
  cx: 730,
  cy: 120,
  vw: 1330,
  vh: 980,
} as const;

export interface VPt {
  vx: number;
  vy: number;
}

const clampN = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** World point to volume pixels. Height only ever moves things up-screen. */
export function project(x: number, y: number, h: number): VPt {
  return {
    vx: (x - y) * VOL.ox + VOL.cx,
    vy: (x + y) * VOL.oy - h * VOL.zh + VOL.cy,
  };
}

/** Painter order: smaller depth is farther away. Height breaks ties. */
export function depthOf(x: number, y: number, h = 0): number {
  return x + y + h * 0.02;
}

/**
 * Volume pixels back to world coordinates. Height is unknown for a bare
 * screen point, so iterate: solve flat, sample the heightfield, re-solve.
 */
export function unproject(vx: number, vy: number, heightAt: (x: number, y: number) => number): { x: number; y: number } {
  let h = 1.5;
  let x = 540;
  let y = 500;
  for (let i = 0; i < 14; i++) {
    const a = (vx - VOL.cx) / VOL.ox;
    const s = (vy - VOL.cy + h * VOL.zh) / VOL.oy;
    x = clampN((a + s) / 2, 0, 1080);
    y = clampN((s - a) / 2, 0, 1320);
    const nextH = heightAt(x, y);
    if (Math.abs(nextH - h) < 0.005) break;
    h = h * 0.65 + nextH * 0.35;
  }
  return { x, y };
}

/** Top-left volume-space camera that centers (vx, vy) in a W×H viewport. */
export function camFor(vx: number, vy: number, W: number, H: number): { cx: number; cy: number } {
  return {
    cx: clampN(vx - W / 2, 0, Math.max(0, VOL.vw - W)),
    cy: clampN(vy - H / 2, 0, Math.max(0, VOL.vh - H)),
  };
}
