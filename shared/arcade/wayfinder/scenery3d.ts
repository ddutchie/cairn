/**
 * Low-poly scenery for the 3D island stage, built per biome from seeded
 * variants (`pixel/lowpoly.ts`): a few dozen triangles a piece, so an island
 * can carry a hundred of them. Sizes are in stage units (the captain stands
 * about 26 tall).
 */

import { lerpHex } from "../pixel/kinds";
import { LowPoly } from "../pixel/lowpoly";
import type { Mesh3D } from "../pixel/raster3d";
import { BIOMES, mulberry32, type BiomeName } from "../pixel/terrain";

export interface ScenerySet {
  /** Beach and lowland: palms, cacti, shrubs. */
  low: Mesh3D[];
  /** Slopes: trees. */
  mid: Mesh3D[];
  /** Undergrowth anywhere on land. */
  bush: Mesh3D[];
  /** Loose boulders. */
  rock: Mesh3D[];
  /** Tall rock formations on high ground. */
  crag: Mesh3D[];
  /** Pebbles and tufts along the trail. */
  tuft: Mesh3D[];
}

const VARIANTS = 5;

export function buildScenery(biome: BiomeName, seed: number): ScenerySet {
  const rand = mulberry32(seed * 7919 + 17);
  const B = BIOMES[biome], [leafDark, leafLight] = B.tree, rock = B.bands[3];
  const bark = biome === "tundra" ? "#4a3a30" : biome === "volcano" ? "#2a2224" : "#6e4a2e";
  const r = (a: number, b: number) => a + rand() * (b - a);
  const many = (f: (lp: LowPoly, i: number) => void): Mesh3D[] =>
    Array.from({ length: VARIANTS }, (_, i) => {
      const lp = new LowPoly(rand);
      f(lp, i);
      return lp.build();
    });
  const snow = biome === "tundra" ? "#f2f6fc" : undefined;
  const rockStyle = (i: number) => ({ c: rock[i % 3], top: snow ?? (biome === "tropic" ? lerpHex(rock[1], leafLight, 0.45) : biome === "volcano" ? "#4a4446" : undefined), topAt: 0.7, vary: 0.1 });

  // A curved trunk in segments, leaning off its base.
  const trunk = (lp: LowPoly, h: number, r0: number, lean: number, segs: number): [number, number, number] => {
    let x = 0, y = 0, z = 0;
    const a = rand() * Math.PI * 2;
    for (let s = 0; s < segs; s++) {
      const u = (s + 1) / segs, lx = Math.cos(a) * lean * u * u / segs, ly = Math.sin(a) * lean * u * u / segs;
      const rr = r0 * (1 - (s / segs) * 0.45);
      lp.column(x, y, z, rr, rr * 0.86, h / segs + 0.4, 5, { c: s % 2 ? bark : lerpHex(bark, "#000000", 0.15), vary: 0.04 }, { lean: [lx, ly], cap: s === segs - 1 });
      x += lx;
      y += ly;
      z += h / segs;
    }
    return [x, y, z];
  };

  const set: ScenerySet = { low: [], mid: [], bush: [], rock: [], crag: [], tuft: [] };

  // Boulders: squat faceted lumps, sometimes a pair.
  set.rock = many((lp, i) => {
    const s = r(6, 13);
    lp.blob(0, 0, s * 0.45, s, s * r(0.7, 1), s * r(0.55, 0.8), rockStyle(i), 1, 0.28);
    if (i % 2) lp.blob(s * 0.9, s * 0.3, s * 0.25, s * 0.5, s * 0.45, s * 0.4, rockStyle(i + 1), 0, 0.3);
  });
  // Crags: stacked, tapering, rough rock pillars.
  set.crag = many((lp, i) => {
    const tiers = 2 + (i % 3);
    let z = 0, rr = r(22, 34), x = 0, y = 0;
    for (let t = 0; t < tiers; t++) {
      const h = r(18, 34), top = rr * r(0.55, 0.8), lean: [number, number] = [r(-4, 4), r(-4, 4)];
      lp.column(x, y, z - 2, rr, top, h, 5 + (t % 2), { ...rockStyle(t + i), c: rock[(t + i) % 3] }, { jitter: 0.22, lean });
      x += lean[0];
      y += lean[1];
      z += h - 3;
      rr = top * r(0.85, 1);
    }
    // A spur beside the main stack.
    lp.column(rr * 1.6, -rr * 0.4, -2, rr * 0.7, rr * 0.3, z * 0.45, 5, rockStyle(i + 2), { jitter: 0.25 });
  });
  set.tuft = many((lp, i) => {
    if (i < 2) lp.blob(0, 0, 1.2, r(2, 3.2), r(1.6, 2.6), 1.6, rockStyle(i), 0, 0.3);
    else for (let k = 0; k < 3; k++) lp.column(r(-2, 2), r(-2, 2), 0, r(0.6, 1), 0, r(3, 6), 3, { c: k % 2 ? leafLight : leafDark }, { lean: [r(-1.5, 1.5), r(-1.5, 1.5)] });
  });

  switch (biome) {
    case "tropic":
      set.low = many((lp) => {
        const [x, y, z] = trunk(lp, r(40, 58), 2.2, r(8, 18), 4);
        const n = 6 + Math.floor(rand() * 2);
        for (let k = 0; k < n; k++) lp.frond(x, y, z, (k / n) * Math.PI * 2 + r(-0.2, 0.2), r(16, 22), r(3, 4.5), r(6, 11), { c: k % 2 ? leafLight : leafDark, vary: 0.08 });
        lp.blob(x, y, z - 1.5, 2.2, 2.2, 2, { c: "#8a5a32" }, 0, 0.1);
      });
      set.mid = many((lp) => {
        const [x, y, z] = trunk(lp, r(18, 26), 2.6, r(2, 6), 2);
        const lumps = 2 + Math.floor(rand() * 2);
        for (let k = 0; k < lumps; k++) lp.blob(x + r(-6, 6), y + r(-6, 6), z + r(2, 10), r(10, 15), r(10, 15), r(7, 11), { c: k % 2 ? leafLight : leafDark, top: lerpHex(leafLight, "#ffffff", 0.15), topAt: 0.8, vary: 0.08 });
      });
      set.bush = many((lp) => {
        for (let k = 0; k < 2; k++) lp.blob(r(-3, 3), r(-3, 3), 4, r(5, 8), r(5, 8), r(4, 6), { c: k ? leafLight : leafDark, vary: 0.1 }, 0);
      });
      break;
    case "desert":
      set.low = many((lp, i) => {
        // Saguaro: a ribbed column with one or two arms.
        const h = r(26, 40), cact = { c: i % 2 ? leafDark : leafLight, vary: 0.05 };
        lp.column(0, 0, 0, 3.2, 2.8, h, 6, cact);
        for (let k = 0; k < 1 + (i % 2); k++) {
          const s = k ? -1 : 1, az = r(h * 0.35, h * 0.6), ax = s * r(5, 7);
          lp.column(0, 0, az, 1.8, 1.8, 2, 5, cact, { lean: [ax, 0], cap: false });
          lp.column(ax, 0, az + 1, 2, 1.8, r(8, 14), 5, cact);
        }
      });
      set.mid = many((lp) => {
        // Acacia: a thin leaning trunk under one flat crown.
        const [x, y, z] = trunk(lp, r(20, 28), 1.8, r(6, 10), 2);
        lp.blob(x, y, z + 2, r(14, 18), r(12, 16), r(3, 4.5), { c: leafDark, top: leafLight, topAt: 0.5, vary: 0.08 }, 1, 0.25);
      });
      set.bush = many((lp) => lp.blob(0, 0, 3, r(4, 6), r(4, 6), r(2.5, 4), { c: leafDark, top: lerpHex(leafLight, "#c2a85c", 0.5), vary: 0.12 }, 0, 0.35));
      break;
    case "tundra":
      set.low = many((lp) => lp.blob(0, 0, 3, r(5, 9), r(5, 8), r(3, 5), { c: "#9aa6b2", top: "#f2f6fc", topAt: 0.4 }, 1, 0.3));
      set.mid = many((lp) => {
        // Fir: a trunk under three snow-capped cones.
        lp.column(0, 0, 0, 1.8, 1.4, 10, 5, { c: bark });
        let z = 6, rr = r(11, 14);
        for (let k = 0; k < 3; k++) {
          const h = rr * 1.5;
          lp.column(0, 0, z, rr, 0, h, 7, { c: k % 2 ? leafDark : lerpHex(leafDark, "#000000", 0.12), top: "#f2f6fc", topAt: 0.55, vary: 0.06 });
          z += h * 0.5;
          rr *= 0.72;
        }
      });
      set.bush = many((lp) => lp.column(0, 0, 0, r(4, 6), 0, r(8, 12), 6, { c: leafDark, top: "#f2f6fc", topAt: 0.5 }));
      break;
    case "volcano":
      set.low = many((lp) => {
        // A dead tree: a black trunk with a few bare branches.
        const [x, y, z] = trunk(lp, r(22, 32), 2, r(2, 6), 3);
        for (let k = 0; k < 3; k++) {
          const a = rand() * Math.PI * 2, len = r(7, 12);
          lp.column(x * 0.8, y * 0.8, z * r(0.55, 0.9), 1, 0.4, len, 4, { c: bark }, { lean: [Math.cos(a) * len, Math.sin(a) * len] });
        }
      });
      set.mid = many((lp) => {
        const [x, y, z] = trunk(lp, r(16, 22), 2, r(2, 6), 2);
        lp.blob(x, y, z + 3, r(8, 11), r(8, 11), r(6, 8), { c: leafDark, top: "#4a4446", topAt: 0.75, vary: 0.1 });
      });
      set.bush = many((lp, i) => {
        // Glowing vents among the rubble.
        lp.blob(0, 0, 2, r(4, 6), r(4, 6), r(2, 3), { c: rock[0], vary: 0.1 }, 0);
        if (i % 2) lp.blob(0, 0, 3.2, 2, 2, 1, { c: B.lava ? B.lava[2] : "#ffb347", vary: 0 }, 0, 0);
      });
      break;
  }
  return set;
}
