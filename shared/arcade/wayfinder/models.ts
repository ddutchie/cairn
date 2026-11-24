/**
 * Wayfinder voxel models: the boat, priority cargo crates, Today lighthouse,
 * harbour huts, and sea creatures (whale, dolphin, turtle, kraken segments).
 */

import type { Priority } from "../../types/domain";
import { KINDS, PRIORITY_PAL } from "../pixel/kinds";
import { makeModel, type Model } from "../pixel/models";
import { hash2 } from "../pixel/terrain";

export const PCOL: Record<Priority, string> = {
  low: PRIORITY_PAL.low.h,
  medium: PRIORITY_PAL.medium.h,
  high: PRIORITY_PAL.high.h,
  urgent: PRIORITY_PAL.urgent.h,
};

export const BOAT_MODEL: Model = makeModel(7, 13, 7, (x, y, z) => {
  const half = y < 3 ? y * 0.9 : y > 10 ? 3 - (y - 10) * 0.5 : 3;
  const dx = Math.abs(x - 3);
  if (z <= 1 && dx <= half) return z === 0 ? "#5a3a22" : dx >= half - 0.6 ? "#7a4a2a" : "#a8693a";
  if (z === 2 && dx <= half - 1 && y > 1 && y < 12) return "#c9a06a";
  if (z >= 2 && x === 3 && y === 6) return "#4a2e1a";
  if (z >= 3 && z <= 5 && y === 7 && dx <= 3) return z === 5 ? "#ffffff" : "#efe6d0";
  if (z === 6 && x === 3 && y === 6) return "#ef5a24";
  return null;
});

export const CRATE_MODELS: Record<Priority, Model> = Object.fromEntries(
  (Object.keys(PCOL) as Priority[]).map((k) => [
    k,
    makeModel(4, 4, 3, (x, y, z) => (z === 2 ? (x === 0 || y === 0 ? "#e8c890" : "#c9a06a") : x === 1 || y === 1 ? PCOL[k] : "#8a5a32")),
  ]),
) as Record<Priority, Model>;

export const LIGHTHOUSE_MODEL: Model = makeModel(5, 5, 14, (x, y, z) => {
  const d = Math.abs(x - 2) + Math.abs(y - 2);
  if (z < 11) return d <= 2 - (z > 7 ? 1 : 0) ? ((z >> 1) & 1 ? "#d9483b" : "#f2ede0") : null;
  if (z === 11 || z === 12) return d <= 1 ? "#fff2a0" : null;
  return d === 0 ? "#2a2f3a" : null;
});

export const WHALE_MODEL: Model = makeModel(9, 22, 4, (x, y, z) => {
  const half = y < 3 ? 1 + y : y < 12 ? 4 : y < 18 ? 4 - (y - 12) * 0.55 : 0.6;
  const dx = Math.abs(x - 4);
  if (y >= 19) return z <= 1 && dx <= (y - 18) * 1.6 ? "#2e3f5c" : null;
  if (dx > half) return null;
  if (z === 0) return "#9fb3cf";
  if (z === 3) return dx <= half - 2 ? (y === 2 && dx === 0 ? "#22304a" : "#2e3f5c") : null;
  if (z === 2 && y === 4 && dx === 3) return "#0d1426";
  return hash2(x, y, z) < 0.08 ? "#c7d0e6" : z === 2 ? "#3a4e6e" : "#4a6185";
});

export const DOLPHIN_MODEL: Model = makeModel(5, 11, 3, (x, y, z) => {
  const half = y < 2 ? 0.6 : y < 7 ? 2 : y < 9 ? 1 : 0.4;
  const dx = Math.abs(x - 2);
  if (y >= 9) return z === 0 && dx <= (y - 8) * 1.4 ? "#5a6f96" : null;
  if (dx > half) return null;
  if (z === 2) return dx === 0 && y >= 3 && y <= 5 ? "#3d4f73" : null;
  return z === 0 ? "#c7d0e6" : y === 0 ? "#6b7fa6" : "#7f93b8";
});

export const TURTLE_MODEL: Model = makeModel(7, 9, 3, (x, y, z) => {
  const dx = Math.abs(x - 3);
  if (z === 0) return ((y === 2 || y === 6) && dx === 3) || (y === 0 && dx === 0) ? "#8fb070" : null;
  if (y < 1 || y > 7 || dx > (y < 2 || y > 6 ? 1 : 2)) return null;
  if (z === 2) return dx <= 1 && y > 1 && y < 7 ? ((x + y) % 2 ? "#6b8f3a" : "#4f7a3a") : null;
  return "#3d5a2e";
});

export const KRAKEN_SEGS: Model[] = [5, 4, 4, 3, 3, 2].map((w, i) =>
  makeModel(w, w, 2, (x, y, z) => {
    const c = (w - 1) / 2;
    const d = Math.abs(x - c) + Math.abs(y - c);
    if (d > c + 0.5) return null;
    if (z === 1 && x === Math.floor(c) && y === w - 1 && i < 5) return "#e8b8e0";
    return z === 1 ? "#a8509a" : "#7a2f72";
  }),
);

export function hutModel(accent: string): Model {
  return makeModel(5, 5, 5, (x, y, z) =>
    z < 3 ? (z === 1 && y === 4 && x === 2 ? "#2a1a10" : "#e8dcc0") : Math.abs(x - 2) <= 4 - z + 1 ? (y === 0 ? KINDS.project.l : accent) : null,
  );
}
