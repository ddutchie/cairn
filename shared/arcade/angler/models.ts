/**
 * Angler voxel models, drawn as sprite stacks like Task Force's planes and
 * Wayfinder's boat: each fish seen from above (nose toward +x), and the angler.
 */

import { lerpHex } from "../pixel/kinds";
import { makeModel, type Model } from "../pixel/models";
import { hash2 } from "../pixel/terrain";
import { LOOKS } from "./sprites";
import { SPECIES, type FishSpec } from "./sim";

/** A fish from above: belly at the bottom layer, the patterned back on top, the tail fanned out behind. */
export function fishModel(f: FishSpec): Model {
  const look = LOOKS[f.species];
  const def = SPECIES[f.species];
  const L = Math.max(6, f.size);
  const tailW = Math.max(3, Math.round(L * (f.species === "pike" ? 0.22 : 0.3)));
  const D = Math.max(3, Math.round(L * def.girth)) | 1; // odd, so it has a middle row
  const finW = f.species === "angel" ? 3 : 2;
  const w = tailW + L, d = D + finW * 2, h = f.species === "puffer" || f.species === "angel" ? 4 : 3;
  const cy = (d - 1) / 2;
  const x0 = tailW;
  const cx = x0 + (L - 1) / 2;
  const fin = look.fin ?? f.accent;
  const mark = look.mark ?? lerpHex(f.accent, "#1a1a2a", 0.25);
  const dark = f.overdue ? 0.28 : 0;
  const shade = (c: string) => (dark ? lerpHex(c, "#4a2230", dark) : c);
  const eyeX = Math.round(x0 + L * 0.8);

  return makeModel(w, d, h, (x, y, z) => {
    const nx = (x - cx) / (L / 2), ny = (y - cy) / (D / 2);
    // Taper toward the tail: a teardrop, broadest a third back from the nose.
    const taper = nx < 0 ? 1 + nx * 0.35 : 1 - Math.max(0, nx - 0.3) * 0.5;
    const inBody = nx * nx + (ny / Math.max(0.3, taper)) ** 2 <= 1;
    if (inBody) {
      // Rounder in the middle layers: the top and bottom layers are a little narrower.
      const edge = Math.abs(ny / Math.max(0.3, taper));
      if ((z === 0 || z === h - 1) && edge > 0.8 && h > 2) return null;
      if (z === 0) return shade(look.belly);
      if (z < h - 1) {
        if (x === eyeX && (y === Math.round(cy - D / 2 + 0.5) || y === Math.round(cy + D / 2 - 0.5))) return f.overdue ? "#c02a2a" : "#10141e";
        return shade(look.body);
      }
      const bx = x - x0;
      let c = look.back;
      switch (look.pattern) {
        case "line":
          if (y === Math.round(cy) && bx > 1 && bx < L - 3) c = mark;
          break;
        case "bars":
          if (bx % 3 === 1 && bx > 1 && bx < L - 2) c = mark;
          break;
        case "spots":
          if (hash2(x, y, f.seed % 9973) > 0.72) c = mark;
          break;
        case "patch":
          if (hash2(x >> 1, y >> 1, f.seed % 9973) > 0.5) c = hash2(x >> 2, y >> 2, 7) > 0.5 ? "#ef6a2a" : f.accent;
          break;
      }
      return shade(c);
    }
    // Tail: a fan behind the body, forked at the end, in the middle layer.
    if (x < x0 && z === Math.floor(h / 2)) {
      const rel = (x0 - x) / tailW;
      const ay = Math.abs(y - cy);
      if (ay <= 0.6 + rel * (D / 2 + finW * 0.8) && !(rel > 0.6 && ay < (rel - 0.6) * D * 0.9)) return fin;
    }
    // Pectoral fins, just behind the head, flared out to the sides.
    if (z === 1 && Math.abs(x - (x0 + L * 0.62)) <= (f.species === "angel" ? 2 : 1)) {
      const ay = Math.abs(y - cy);
      if (ay > D / 2 - 0.5 && ay <= D / 2 + finW) return fin;
    }
    // A dorsal ridge along the back.
    if (z === h - 1 && y === Math.round(cy) && x >= x0 + L * 0.3 && x <= x0 + L * 0.6) return fin;
    return null;
  });
}

const JACKET = "#d9483b", JACKET_D = "#b8382e", SKIN = "#f0c8a0", HAT = "#e3a23b", HAT_D = "#c4862a", TROUSERS = "#3a4a6a";

/** The angler from above, sitting and facing +x: legs forward, a red jacket, a wide straw hat. */
export const ANGLER_MODEL: Model = makeModel(9, 9, 9, (x, y, z) => {
  const cy = 4;
  const ay = Math.abs(y - cy);
  // Legs out in front, two layers up (sitting on the dock edge).
  if (z <= 1 && x >= 5 && x <= 8 && (y === 2 || y === 3 || y === 5 || y === 6)) return x === 8 ? "#2a2a34" : TROUSERS;
  // Body.
  if (z >= 1 && z <= 5 && x >= 2 && x <= 5 && ay <= 2) return x === 2 || ay === 2 ? JACKET_D : JACKET;
  // Arms reaching forward to the rod.
  if (z === 4 && x >= 5 && x <= 6 && ay === 2) return JACKET;
  if (z === 4 && x === 7 && ay === 1) return SKIN;
  // Head.
  if (z >= 6 && z <= 7 && x >= 3 && x <= 4 && ay <= 1) return SKIN;
  // Hat: a crown and a wide brim.
  if (z === 7 && x >= 1 && x <= 7 && ay <= 3 && !(x >= 3 && x <= 4 && ay <= 1)) return (x + y) % 3 ? HAT : HAT_D;
  if (z === 8 && x >= 3 && x <= 4 && ay <= 1) return HAT;
  return null;
});

/** A tackle box by the angler. */
export const TACKLE_MODEL: Model = makeModel(5, 4, 3, (x, y, z) => (z === 2 ? (x === 2 ? "#c4ccd8" : "#3f9a4a") : "#2f7a3a"));
