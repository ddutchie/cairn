/**
 * Powder Run voxel models — snowboarder, priority task gems, note scrolls,
 * alpine pines, kicker ramps, and boulders for the 3D halfpipe.
 */

import type { Priority } from "../../types/domain";
import { PRIORITY_PAL } from "../pixel/kinds";
import { makeModel, type Model } from "../pixel/models";

/** Snowboarder: dark board at z=0..1, parka & goggles facing +Y down-pipe. */
export const BOARDER_MODEL: Model = makeModel(7, 9, 11, (x, y, z) => {
  const dx = Math.abs(x - 3);
  if (z === 0) return dx <= 1 && y >= 0 && y <= 8 ? (y === 0 || y === 8 ? "#ff5e8a" : "#1c2438") : null;
  if (z < 3) return dx <= 1 && Math.abs(y - 4) <= 1 ? "#2b364f" : null;
  if (z < 7) return dx <= 2 && Math.abs(y - 4) <= 1 ? (z === 4 ? "#fff2a0" : "#ff7242") : null;
  if (z < 10) {
    if (dx > 1 || Math.abs(y - 4) > 1) return null;
    if (y === 5 && z === 8) return "#2ec4b6"; // ski goggles
    return "#dfe9f4";
  }
  return z === 10 && dx === 0 && y === 4 ? "#ff5e8a" : null;
});

/** Glowing golden Note scroll tucked on the halfpipe lips. */
export const NOTE_MODEL: Model = makeModel(5, 5, 7, (x, y, z) => {
  const dx = Math.abs(x - 2), dy = Math.abs(y - 2);
  if (dx > 1 || dy > 1) return null;
  if (z === 0 || z === 6) return "#d9a23b";
  return (x + z) % 2 ? "#fff2a0" : "#ffe27a";
});

const taskCache = new Map<Priority, Model>();
export function taskGemModel(pr: Priority): Model {
  let m = taskCache.get(pr);
  if (m) return m;
  const pal = PRIORITY_PAL[pr];
  m = makeModel(5, 5, 7, (x, y, z) => {
    const dx = Math.abs(x - 2), dy = Math.abs(y - 2);
    const r = dx + dy;
    if (z === 0 || z === 6) return r === 0 ? pal.a : null;
    if (z === 1 || z === 5) return r <= 1 ? pal.h : null;
    return r <= 2 ? (z === 3 && r <= 1 ? "#ffffff" : pal.a) : null;
  });
  taskCache.set(pr, m);
  return m;
}

/** Snow-dusted alpine pine for the halfpipe rims. */
export const PINE_MODEL: Model = makeModel(7, 7, 13, (x, y, z) => {
  const dx = Math.abs(x - 3), dy = Math.abs(y - 3);
  if (z < 3) return dx <= 1 && dy <= 1 ? "#52301a" : null;
  const r = 4 - (z - 2) * 0.34;
  if (dx + dy > r) return null;
  return z >= 10 || (z % 3 === 0 && dx + dy >= r - 0.8) ? "#e8f2fc" : z % 2 ? "#1f5a3c" : "#2e7a4e";
});

/** Jagged alpine boulder hazard. */
export const BOULDER_MODEL: Model = makeModel(7, 7, 6, (x, y, z) => {
  const r = Math.hypot(x - 3, y - 3);
  if (r > 3.2 - z * 0.48) return null;
  return z >= 4 ? "#e6f0fa" : (x + y + z) % 2 ? "#5b657a" : "#3a4256";
});

/** Kicker snow ramp. */
export const RAMP_MODEL: Model = makeModel(7, 7, 4, (x, y, z) => {
  if (x < 1 || x > 5) return null;
  const maxZ = Math.floor((y / 6) * 3.5);
  if (z > maxZ) return null;
  return z === maxZ ? "#ffffff" : "#b9d4ee";
});
