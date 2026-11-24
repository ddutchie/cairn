/**
 * Wayfinder voxel models: the boat, priority cargo crates, Today lighthouse,
 * harbour huts, sea creatures (whale, dolphin, turtle, kraken segments), and
 * the island-expedition cast (captain, biome foes, trees, chest, shrine, sign).
 */

import type { Priority } from "../../types/domain";
import { KINDS, PRIORITY_PAL, lerpHex } from "../pixel/kinds";
import { makeModel, type Model, type VoxelFn } from "../pixel/models";
import { hash2, type BiomeName } from "../pixel/terrain";

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

// ── Island expeditions ──────────────────────────────────────────────────────
// Seen from just behind the captain: a model's `y = d - 1` row faces the
// viewer, so backs, packs and tails sit on the high rows.

const INKY = "#0a0f1e";

/**
 * The captain, from behind (faces -y): a wide black tricorn with gold-trimmed,
 * turned-up brims, a red bandana with tails, a parrot on the left shoulder, a
 * long Wayfinder-orange coat with split tails, gold hem and a red sash, cream
 * breeches and boots. `glass` raises a brass spyglass and sheathes the cutlass.
 */
function captainModel(glass: boolean): Model {
  const cx = 8, cy = 4;
  const COAT = "#ef5a24", COAT_D = "#a8381a", COAT_B = "#d9501f", GOLD = "#e3a23b", HAT = "#1e1a1e", HAT_C = "#2a242a";
  const SKIN = "#f0c8a0", HAIR = "#5a3a22", BEARD = "#3a2416", CREAM = "#e8dcc0", WHITE = "#efe6d0", RED = "#c62a2a";
  return makeModel(17, 10, 25, (x, y, z) => {
    const sx = x - cx, dx = Math.abs(sx), dy = Math.abs(y - cy);
    // Parrot on the left shoulder: red, a green wing on the outside, a yellow
    // beak pointing ahead, and a long blue tail down the captain's back.
    if (sx === -5 || sx === -6) {
      if (y >= cy - 1 && y <= cy && z >= 15 && z <= 16) return sx === -6 ? (z === 15 && y === cy ? "#2f6be0" : "#2fae4a") : "#e0342c";
      if (y === cy - 1 && z >= 17 && z <= 18) return sx === -6 && z === 18 ? "#ffffff" : "#e0342c";
      if (sx === -6 && y === cy - 2 && z === 17) return "#ffd23c";
      if (sx === -5 && y >= cy + 1 && y <= cy + 2 && z >= 12 && z <= 14) return z === 12 ? "#ffd23c" : "#2f6be0";
    }
    // Boots and breeches.
    if (z < 3) return dx >= 1 && dx <= 2 && dy <= 1 ? (z === 2 ? "#5a3a22" : "#3a2416") : null;
    if (z < 6) return dx >= 1 && dx <= 2 && dy <= 1 ? CREAM : null;
    // Cutlass: raised on the right, or sheathed at the left hip.
    if (!glass && sx === 7) return y >= cy - 1 && y <= cy && z >= 9 && z <= 18 && (z < 18 || y === cy - 1) ? (z === 9 ? GOLD : "#dce5f7") : null;
    if (glass && sx === -5 && y === cy + 2) return z >= 3 && z <= 9 ? "#3a2416" : z <= 11 ? GOLD : null;
    // Arms: sleeves, white cuffs, hands. With the spyglass, the right arm is raised.
    if (dx === 5 && y >= cy - 1 && y <= cy + 1) {
      if (glass && sx === 5) {
        if (z >= 13 && z <= 14) return COAT_D;
        if (z >= 15 && z <= 17 && y <= cy) return z === 17 ? WHITE : COAT;
        return null;
      }
      if (z >= 7 && z <= 14) return z === 7 ? SKIN : z === 8 ? WHITE : y === cy + 1 ? COAT_D : COAT_B;
    }
    // Spyglass: a brass tube held out ahead, clear of the hat brim.
    if (glass && sx === 4 && z === 18 && y <= cy - 1) return y === cy - 1 ? SKIN : y === 0 ? "#8a5a1c" : "#d9a441";
    // Long coat: flared, split tails at the back, gold hem, red sash with a tail.
    if (z < 15) {
      const w = z <= 8 ? 4 : 3;
      if (sx === 3 && y === cy + 2 && z >= 7 && z <= 9) return RED;
      if (dx > w || dy > 2) return null;
      if (z <= 8 && dx === 0 && y === cy + 2) return null;
      if (z === 6) return GOLD;
      if (z === 10) return dx === 0 && y === cy - 2 ? GOLD : RED;
      if (z === 12 && dx === 1 && y === cy + 2) return GOLD;
      return dx === w ? COAT_D : y === cy + 2 ? COAT_B : COAT;
    }
    // Collar, head with a beard in front, a red bandana and its tails.
    if (z === 15) return dx <= 2 && dy <= 2 ? WHITE : null;
    if (z < 19) {
      if ((sx === 0 || sx === 1) && y === cy + 3 && z >= 15) return z === 15 ? "#8a1c1c" : RED;
      if (dx > 2 || dy > 2) return null;
      if (z === 18) return RED;
      if (y === cy - 2) return z === 16 ? BEARD : SKIN;
      return HAIR;
    }
    // Tricorn: a triangle pointing ahead, wider than the shoulders at the back,
    // its brims turned up into walls with a gold edge, and a crown.
    const reach = 1 + (y / 9) * 7, inHat = dx <= reach, rim = inHat && (dx > reach - 1.6 || y >= 8);
    const crown = dx <= 2 && dy <= 2;
    if (z === 19) return inHat ? (crown ? HAT_C : HAT) : null;
    if (z === 20) return crown ? HAT_C : rim ? HAT : null;
    if (z === 21) return crown ? HAT_C : rim ? GOLD : null;
    if (z === 22) return dx <= 2 && dy <= 1 ? HAT_C : null;
    return z === 23 && dx <= 1 && dy <= 1 ? HAT : null;
  });
}

export const CAPTAIN_MODEL: Model = captainModel(false);

/** The rowboat the captain came ashore in, bow pointing inland (-y), oars shipped across the gunwales. */
export const ROWBOAT_MODEL: Model = makeModel(13, 18, 5, (x, y, z) => {
  const dx = Math.abs(x - 6), v = (y + 0.5) / 18, half = 4.6 * Math.pow(Math.sin(Math.PI * Math.min(1, v * 1.08)), 0.55);
  if (z === 4) return (y === 7 || y === 11) && dx <= 6 ? (dx >= 5 ? "#e8dcc0" : "#b08a5a") : null; // oars
  const w = z === 0 ? half - 1.5 : half;
  if (dx > w) return null;
  const wall = dx > w - 1.2 || y <= 1;
  if (z === 0) return "#3a2416";
  if (z === 1) return wall ? "#6e4426" : "#4a2e18";
  if (z === 2 && y === 9 && dx < w) return "#8a5a32"; // thwart
  if (!wall) return null;
  return z === 3 ? "#c8913f" : z === 2 ? "#7a4c2a" : "#6e4426";
});
export const CAPTAIN_GLASS_MODEL: Model = captainModel(true);

export interface ExpeditionFoe {
  name: string;
  model: Model;
}

/** A second foe per biome, so not every ambush is the same beast. */
const SECOND_FOES: Record<BiomeName, ExpeditionFoe> = {
  tropic: {
    name: "VINE SNAKE",
    model: makeModel(11, 12, 8, (x, y, z) => {
      const d = Math.hypot(x - 5, y - 5);
      // A coiled body, striped, with the head reared up toward the captain.
      if (z <= 2 && Math.abs(d - 3.4) < 1.1) return z === 2 ? ((Math.round(Math.atan2(y - 5, x - 5) * 3) & 1) ? "#e3d04a" : "#3f8f3a") : "#2a6a2a";
      if (x >= 4 && x <= 6 && y >= 8 && y <= 9 && z >= 2 && z <= 5) return x === 5 ? "#3f8f3a" : y === 9 && z < 5 ? null : "#2a6a2a";
      if (x >= 3 && x <= 7 && y >= 8 && y <= 11 && z >= 5 && z <= 7) {
        if (y === 11 && z === 7 && (x === 4 || x === 6)) return "#ffd23c";
        if (y === 11 && z === 5 && x === 5) return "#d9483b";
        return z === 7 ? "#4fa84a" : "#3f8f3a";
      }
      return null;
    }),
  },
  desert: {
    name: "DUNE BEETLE",
    model: makeModel(11, 12, 7, (x, y, z) => {
      const nx = (x - 5) / 5, ny = (y - 5.5) / 5.5, nz = z / 6;
      if (z === 0 && (x === 0 || x === 10) && (y === 3 || y === 6 || y === 9)) return "#2a1a10";
      if (x === 5 && y >= 10 && z >= 2 && z <= 4) return z === 4 ? "#c98a2c" : "#2a1a10";
      if (nx * nx + ny * ny + nz * nz > 1) return null;
      if (y >= 10 && z === 2 && (x === 3 || x === 7)) return "#ff5e3a";
      return x === 5 && z > 2 ? "#e3a23b" : nz > 0.6 ? "#5b8dd6" : "#2f4f7a";
    }),
  },
  tundra: {
    name: "ICE GOLEM",
    model: makeModel(13, 8, 16, (x, y, z) => {
      const dx = Math.abs(x - 6), ice = (c: string) => (hash2(x, y, z) < 0.15 ? "#e6f6ff" : c);
      if (z < 5) return dx >= 2 && dx <= 3 && y >= 2 && y <= 5 ? ice("#6aa8d0") : null;
      if (z < 12 && dx >= 5 && y >= 2 && y <= 5 && z >= 4 && z <= 10) return ice(z === 4 ? "#e6f6ff" : "#8fc4e6");
      if (z < 12) return dx <= 4 && y >= 1 && y <= 6 ? ice(dx === 4 ? "#6aa8d0" : "#a8d8f0") : null;
      if (dx > 2 || y < 2 || y > 6) return null;
      if (y === 6 && z === 13 && dx === 1) return "#4cc9f0";
      return ice("#c7e4ff");
    }),
  },
  volcano: {
    name: "MAGMA SLUG",
    model: makeModel(9, 15, 6, (x, y, z) => {
      const half = 3.6 * Math.sin(Math.PI * Math.min(1, (y + 0.5) / 14)), dx = Math.abs(x - 4);
      if ((x === 3 || x === 5) && y >= 12 && y <= 13 && z >= 3 && z <= 5) return z === 5 ? "#fff2a0" : "#3a2a28";
      if (dx > half || z > Math.round(half * 1.2)) return null;
      if (hash2(x, y, z) < 0.18 || (z === Math.round(half * 1.2) && (x + y) % 4 === 0)) return "#ff7a2a";
      return z > 2 ? "#4a3532" : "#2a1e1c";
    }),
  },
};

/** The ghost that haunts lost islands (notes nothing links to). */
export const GHOST_FOE: ExpeditionFoe = {
  name: "DROWNED GHOST",
  model: makeModel(11, 9, 14, (x, y, z) => {
    const dx = x - 5, dy = y - 4, r = z >= 9 ? 4.2 * Math.sqrt(Math.max(0, 1 - ((z - 9) / 5) ** 2)) : 4 + (z < 3 ? 0.6 : 0);
    if (dx * dx + dy * dy > r * r) return null;
    if (z < 2 && hash2(x, y, 3) < 0.45) return null;
    if (y >= 7 && z === 10 && (x === 3 || x === 7)) return INKY;
    if (y >= 7 && z === 7 && x >= 4 && x <= 6) return "#2a3a5a";
    return z < 3 ? "#a8c8e0" : hash2(x, y, z) < 0.1 ? "#ffffff" : "#d8f0ff";
  }),
};

/** A robed hermit with a white beard and a lantern staff, facing the captain. */
export const HERMIT_MODEL: Model = makeModel(11, 9, 18, (x, y, z) => {
  const dx = Math.abs(x - 5), dy = Math.abs(y - 4);
  if (x === 9 && y === 6) return z <= 15 ? "#6e4426" : z <= 17 ? (z === 16 ? "#ffd23c" : "#3a2416") : null;
  if (z < 11) {
    const w = 3.5 - z * 0.08;
    if (dx > w || dy > 3) return null;
    if (z === 7 && dy <= 3) return "#3a2416";
    return dx >= 3 ? "#5a3a22" : "#7a5434";
  }
  if (z < 16) {
    if (dx > 2 || dy > 2) return null;
    if (y >= 6 && dx <= 1 && z <= 13) return "#f4f0e6";
    if (y >= 6 && z === 14 && dx === 1) return INKY;
    if (y >= 6 && z === 14) return "#f0c8a0";
    return "#6a4a2e";
  }
  return dx <= 1 && dy <= 1 && z <= 17 ? "#5a3a22" : null;
});

const tentCache = new Map<string, Model>();
/** A project camp tent striped in the project's colour, its door toward the captain. */
export function tentModel(accent: string): Model {
  let m = tentCache.get(accent);
  if (m) return m;
  m = makeModel(15, 13, 11, (x, y, z) => {
    const dx = Math.abs(x - 7), h = 9 - dx * 1.25;
    if (x === 7 && y === 6 && z >= 9) return z === 10 ? accent : "#5a3a22";
    if (z > h || y < 1 || y > 11) return null;
    if (y === 11 && dx <= 1 && z < 5) return INKY;
    const shell = z >= h - 1.2 || y === 1 || y === 11;
    if (!shell) return null;
    return (dx >> 1) % 2 ? lerpHex(accent, INKY, y === 11 ? 0.1 : 0.25) : y === 11 ? "#f4ead0" : "#d8ccb0";
  });
  tentCache.set(accent, m);
  return m;
}

/** A broken hull run aground: planks with gaps, exposed ribs and a snapped mast. */
export const WRECK_MODEL: Model = makeModel(24, 12, 12, (x, y, z) => {
  const dy = Math.abs(y - 5.5), u = x / 23, half = 5 * Math.sin(Math.PI * Math.min(1, u * 1.05 + 0.04));
  if (x === 10 && y === 6 && z <= 11 && z >= 3) return z === 11 ? "#3a2416" : "#6e4426";
  if (x === 11 && y === 6 && z >= 9 && z <= 10) return "#6e4426";
  if (dy > half + 0.5 || z > 6 - Math.round(u * 2)) return null;
  const hull = dy > half - 1.2 || z === 0;
  if (!hull) return null;
  if (x > 16 && x % 2 === 1 && z > 0) return null;
  if (hash2(x, y, z) < 0.12) return null;
  return z === 6 - Math.round(u * 2) ? "#8a5a32" : z % 2 ? "#5a3a22" : "#6e4426";
});

/** A cairn of stacked flat stones: the marker on a trapped path. */
export const CAIRN_MODEL: Model = makeModel(9, 9, 13, (x, y, z) => {
  const tiers: [number, number, number, string][] = [[0, 2, 3.8, "#6a6a72"], [3, 5, 3, "#8a8a92"], [6, 7, 2.4, "#727278"], [8, 9, 1.8, "#9a9aa2"], [10, 12, 1.2, "#7e7e86"]];
  for (const [z0, z1, r, c] of tiers) {
    if (z < z0 || z > z1) continue;
    const ox = (hash2(z0, 1, 5) - 0.5) * 1.2, oy = (hash2(z0, 2, 5) - 0.5) * 1.2;
    if (Math.hypot(x - 4 - ox, y - 4 - oy) > r) return null;
    return z === z1 ? lerpHex(c, "#ffffff", 0.15) : c;
  }
  return null;
});

/** One foe per biome, facing the captain (their faces are on the high-y rows). */
export const EXPEDITION_FOES: Record<BiomeName, ExpeditionFoe> = {
  tropic: {
    name: "REEF CRAB",
    model: makeModel(15, 9, 7, (x, y, z) => {
      const dx = Math.abs(x - 7);
      if (z === 0) return (dx === 5 || dx === 6) && (y === 2 || y === 4 || y === 6) ? "#7a1f22" : null;
      if (dx >= 5) return y >= 5 && y <= 7 && z >= 2 && z <= 4 ? (z === 4 ? "#ffd2c2" : dx === 7 ? "#7a1f22" : "#d9483b") : null;
      if (dx > 4 || y < 1 || y > 6 || z > 4) return z === 5 && (x === 5 || x === 9) && y === 6 ? INKY : z === 6 && (x === 5 || x === 9) && y === 6 ? "#fff2a0" : null;
      if (z === 4) return dx <= 3 && y >= 2 && y <= 5 ? (hash2(x, y, 4) < 0.25 ? "#ffd2c2" : "#e8644f") : null;
      return z === 1 ? "#7a1f22" : "#d9483b";
    }),
  },
  desert: {
    name: "SAND SCORPION",
    model: makeModel(13, 13, 9, (x, y, z) => {
      const dx = Math.abs(x - 6);
      if (y <= 5 && dx === 0) {
        const tz = 1 + (5 - y);
        if (z === tz || z === tz - 1) return y === 0 ? "#7a1f22" : "#e3a23b";
        if (y === 0 && z === tz + 1) return "#fff0a8";
        return null;
      }
      if (y >= 6 && y <= 10 && dx <= 2 && z >= 1 && z <= 2) return z === 2 ? (y % 2 ? "#e3a23b" : "#c98a2c") : "#8f5a1c";
      if (z === 0 && y >= 6 && y <= 10 && (dx === 3 || dx === 4) && y % 2 === 0) return "#8f5a1c";
      if (y >= 10 && y <= 12 && dx >= 3 && dx <= 5 && z >= 1 && z <= 2) return (y === 12 && dx === 4) || dx === 5 ? "#8f5a1c" : z === 2 ? "#fff0a8" : "#e3a23b";
      if (y === 11 && (x === 5 || x === 7) && z === 3) return INKY;
      return null;
    }),
  },
  tundra: {
    name: "FROST WISP",
    model: makeModel(9, 9, 11, (x, y, z) => {
      const dx = x - 4, dy = y - 4, dz = z - 6;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz * 0.8);
      if (z < 3) return Math.abs(dx) + Math.abs(dy) <= 3 - z && hash2(x, y, z) < 0.55 ? "#c7e4ff" : null;
      if (r > 3.6) return null;
      if (y >= 7 && z === 7 && (x === 3 || x === 5)) return INKY;
      if (y >= 7 && z === 8 && (x === 3 || x === 5)) return "#ffffff";
      return z >= 8 ? "#c7e4ff" : r < 2.4 ? "#5b8dd6" : "#8fb8ff";
    }),
  },
  volcano: {
    name: "CINDER IMP",
    model: makeModel(11, 7, 14, (x, y, z) => {
      const dx = Math.abs(x - 5);
      if (z < 4) return (x === 3 || x === 7) && y >= 2 && y <= 4 ? "#3a1a14" : null;
      if (z < 10) {
        if (dx === 5 && z >= 5 && z <= 7 && y >= 2 && y <= 4) return z === 7 ? "#fff2a0" : "#c2401f";
        if (dx > 3 || y < 1 || y > 5) return null;
        if (y === 5 && dx <= 1 && z >= 5 && z <= 7) return "#ffb347";
        return hash2(x, y, z) < 0.15 ? "#ffb347" : dx === 3 ? "#7a1f22" : "#ef5a24";
      }
      if (z < 13) {
        if (dx > 2 || y < 1 || y > 5) return null;
        if (y === 5 && z === 11 && dx === 1) return "#fff2a0";
        return "#ef5a24";
      }
      return (dx === 2 || dx === 3) && y === 3 ? "#2a1a10" : null;
    }),
  },
};


const TREE_SPECS: Record<BiomeName, [number, number, number, VoxelFn]> = {
  tropic: [13, 13, 22, (x, y, z) => {
    const dx = x - 6, dy = y - 6, bend = Math.round(z / 8);
    if (z < 17) return dx - bend >= 0 && dx - bend <= 1 && dy >= 0 && dy <= 1 ? (z % 3 ? "#7a4a2a" : "#5a3a22") : null;
    const r = Math.hypot(dx - 2, dy);
    const frond = (Math.abs(dx - 2) <= 0 || Math.abs(dy) <= 0 || Math.abs(Math.abs(dx - 2) - Math.abs(dy)) <= 0) && r <= 7 - (z - 17);
    if (z === 17 && r < 1.5) return "#5a3a22";
    return frond ? (z >= 20 ? "#86d94c" : z >= 19 ? "#5cb83a" : "#2f7a2f") : null;
  }],
  desert: [9, 5, 18, (x, y, z) => {
    const dx = x - 4;
    const trunk = Math.abs(dx) <= 1 && y >= 1 && y <= 3;
    const armL = x <= 2 && x >= 0 && y === 2 && ((z === 7 && x <= 2) || (x === 0 && z >= 7 && z <= 12));
    const armR = x >= 6 && y === 2 && ((z === 10 && x >= 6) || (x === 8 && z >= 10 && z <= 14));
    if (trunk && z < 17) return (x + z) % 3 === 0 ? "#5e6b2a" : z === 16 ? "#e8644f" : "#7d8c3a";
    if (armL || armR) return "#7d8c3a";
    return null;
  }],
  tundra: [11, 11, 22, (x, y, z) => {
    const r = Math.hypot(x - 5, y - 5);
    if (z < 4) return r < 1 ? "#3d4452" : null;
    // Three overlapping skirts, each wide at its base and narrowing upward.
    const tier = (z - 4) % 6, cone = 1 + (4.6 - (z - 4) * 0.18) * (1 - tier / 6);
    if (r > cone) return null;
    if (z === 21) return "#dfe9f4";
    return tier === 5 && r > cone - 1.2 ? "#dfe9f4" : hash2(x, y, z) < 0.2 ? "#2e4f45" : "#1f3a33";
  }],
  volcano: [9, 9, 18, (x, y, z) => {
    const dx = x - 4, dy = y - 4;
    if (dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1) return z < 16 ? (hash2(x, y, z) < 0.15 ? "#c2401f" : "#231e20") : null;
    if (z === 10 && dy === 0 && dx >= -3 && dx < 0) return "#3a3436";
    if (z === 13 && dy === 1 && dx > 1 && dx <= 4) return "#3a3436";
    if (z >= 11 && z <= 12 && dx === -4 && dy === 0) return "#ffb347";
    return null;
  }],
};

/** Flanking corridor trees, one silhouette per biome (palm, cactus, pine, charred snag). */
export const TREE_MODELS = Object.fromEntries(
  (Object.keys(TREE_SPECS) as BiomeName[]).map((b) => [b, makeModel(...TREE_SPECS[b])]),
) as Record<BiomeName, Model>;

/**
 * The same trees at twice the resolution, backlit: the downstage wing reads as
 * a dark silhouette against the fog. Finer voxels (drawn at half the scale)
 * keep its blocks the same size as the captain's, with a ragged leaf edge and
 * mottled leaves instead of plain doubled blocks.
 */
export const NEAR_TREE_MODELS = Object.fromEntries(
  (Object.keys(TREE_SPECS) as BiomeName[]).map((b) => {
    const [w, d, h, fn] = TREE_SPECS[b];
    const at = (x: number, y: number, z: number) => (x < 0 || y < 0 || z < 0 || x >= w || y >= d || z >= h ? null : fn(x, y, z));
    return [b, makeModel(w * 2, d * 2, h * 2, (x, y, z) => {
      const X = x >> 1, Y = y >> 1, Z = z >> 1, c = at(X, Y, Z);
      if (!c) return null;
      const edge = !at(X + 1, Y, Z) || !at(X - 1, Y, Z) || !at(X, Y + 1, Z) || !at(X, Y - 1, Z) || !at(X, Y, Z + 1);
      const r = hash2(x, y, z * 7 + 3);
      if (edge && Z > 2 && r < 0.3) return null;
      const m = r < 0.2 ? lerpHex(c, "#ffffff", 0.12) : r > 0.8 ? lerpHex(c, INKY, 0.2) : c;
      return lerpHex(m, INKY, 0.3);
    })];
  }),
) as Record<BiomeName, Model>;

/** A brass-bound sea chest. */
export const CHEST_MODEL: Model = makeModel(12, 8, 9, (x, y, z) => {
  const dx = Math.abs(x - 5.5);
  if (dx > 5.5 || y > 7) return null;
  if (z >= 6) return Math.abs(y - 3.5) <= 3.5 - (z - 6) * 1.2 ? (x === 1 || x === 10 ? "#c9a06a" : "#8b5e3c") : null;
  if (z === 5) return "#c9a06a";
  if (y === 7 && dx <= 1 && z >= 3 && z <= 5) return "#fff2a0";
  return x === 1 || x === 10 || z === 0 ? "#c9a06a" : (z & 1 ? "#7a4a2a" : "#8b5e3c");
});

/** A cairn beacon stone with a glowing rune facing the captain. */
export const SHRINE_MODEL: Model = makeModel(11, 9, 20, (x, y, z) => {
  const dx = Math.abs(x - 5), dy = Math.abs(y - 4);
  if (z < 3) return dx <= 5 && dy <= 4 ? (z === 2 ? "#727885" : "#5a5f6a") : null;
  if (z < 17) {
    const w = 3 - (z > 13 ? 1 : 0);
    if (dx > w || dy > 2) return null;
    if (y === 6 && dx <= 1 && z >= 8 && z <= 11) return "#fff2a0";
    return hash2(x, y, z) < 0.12 ? "#8d94a0" : dx === w ? "#3d4f73" : "#5a6f96";
  }
  return dx <= 1 && dy <= 1 ? (z === 19 ? "#4cc9f0" : "#5a6f96") : null;
});

/** A wooden signpost pointing inland. */
export const SIGN_MODEL: Model = makeModel(13, 3, 18, (x, y, z) => {
  if (x === 6 && y === 1) return z < 17 ? "#7a4a2a" : null;
  if (z >= 11 && z <= 14 && y === 1 && x >= 1 && x <= 12) {
    if (x === 12 && (z === 11 || z === 14)) return null;
    return z === 12 && x >= 3 && x <= 9 && x % 2 ? "#5a3a22" : "#c9a06a";
  }
  return null;
});

// ── Expedition set dressing: boulders, pebbles and tufts per biome ─────────

interface RockLook {
  body: [string, string, string];
  /** Colour on upward faces (moss, sand, snow, ash). */
  cap: string | null;
  /** Thin seams (strata, lava cracks). */
  seam: string | null;
}

const ROCK_LOOK: Record<BiomeName, RockLook> = {
  tropic: { body: ["#5f5a5a", "#807878", "#a49b96"], cap: "#4a9a3c", seam: null },
  desert: { body: ["#8a4f2e", "#a8623a", "#c97d4d"], cap: "#efc98a", seam: "#6e3a22" },
  tundra: { body: ["#5a5f6a", "#727885", "#8d94a0"], cap: "#f2f6fc", seam: null },
  volcano: { body: ["#231e20", "#2f292b", "#3e3638"], cap: "#4d4548", seam: "#ef6a24" },
};

/** A lumpy boulder: a noise-dented ellipsoid with a capped top and seams. */
function boulder(w: number, d: number, h: number, seed: number, look: RockLook, dark: number): Model {
  const shade = (c: string) => (dark ? lerpHex(c, INKY, dark) : c);
  return makeModel(w, d, h, (x, y, z) => {
    const nx = (x - (w - 1) / 2) / (w / 2), ny = (y - (d - 1) / 2) / (d / 2), nz = z / h;
    // Broken stone: a squat, faceted block whose faces are chipped in 3-voxel planes.
    const dent = 0.72 + hash2(Math.floor(x / 3), Math.floor(y / 3), seed + Math.floor(z / 3)) * 0.32;
    const ax = Math.abs(nx), ay = Math.abs(ny);
    const r = 0.6 * Math.max(ax, ay) + 0.4 * Math.hypot(nx, ny) + Math.pow(nz, 2.5) * 0.75;
    if (r > dent) return null;
    const top = r > dent - 0.1 && nz > 0.6;
    if (top && look.cap && hash2(x >> 1, y >> 1, seed + 9) < 0.4) return shade(look.cap);
    if (look.seam && (z + (x >> 2)) % 5 === 0 && hash2(x, y, z + seed) < 0.55) return shade(look.seam);
    return shade(look.body[hash2(x, y, z * 3 + seed) < 0.3 ? 0 : nz > 0.5 ? 2 : 1]);
  });
}

const ROCK_SIZES: [number, number, number][] = [[18, 14, 10], [12, 10, 7], [24, 16, 13], [9, 8, 5]];

/** Four boulders per biome, lit for mid-stage. */
export const ROCK_MODELS = Object.fromEntries(
  (Object.keys(ROCK_LOOK) as BiomeName[]).map((b) => [b, ROCK_SIZES.map(([w, d, h], i) => boulder(w, d, h, i * 11 + 3, ROCK_LOOK[b], 0))]),
) as Record<BiomeName, Model[]>;

const TUFT_COL: Record<BiomeName, [string, string]> = {
  tropic: ["#2f7a2f", "#86d94c"],
  desert: ["#7d8c3a", "#c2a85c"],
  tundra: ["#5d7a6a", "#dfe9f4"],
  volcano: ["#3a3436", "#c2401f"],
};

/** Ground scatter per biome: [pebble, tuft]. */
export const FLOOR_PROPS = Object.fromEntries(
  (Object.keys(ROCK_LOOK) as BiomeName[]).map((b) => [
    b,
    [
      boulder(4, 3, 2, 5, ROCK_LOOK[b], 0),
      makeModel(7, 5, 7, (x, y, z) => {
        // Thin blades from a shared root, leaning outward, lighter at the tips.
        const blades = [[3, 2, 6, 0, 0], [1, 2, 4, -1, 0], [5, 2, 5, 1, 0], [2, 1, 3, 0, -1], [4, 3, 4, 0, 1], [3, 3, 5, 0, 1]];
        for (const [bx, by, len, lx, ly] of blades) {
          if (z >= len) continue;
          const px = bx + Math.round((lx * z) / 3), py = by + Math.round((ly * z) / 3);
          if (x === px && y === py) return TUFT_COL[b][z >= len - 2 ? 1 : 0];
        }
        return null;
      }),
    ],
  ]),
) as Record<BiomeName, Model[]>;

// ── Rock formations ─────────────────────────────────────────────────────────
// Big voxel set pieces for the expedition stage, as heightmaps: the stack
// shading makes ledge tops bright and covered faces dark, so they read as real
// stone. Four forms (terraced cliff, spires, mesa, rubble), mirrored for the
// right-hand wing, and optionally tinted toward the fog colour so distant ones
// sit back (atmospheric perspective). Built on first use: a phone shouldn't
// pay for these at app start.

export type RockForm = "terrace" | "spires" | "mesa" | "rubble";
export const ROCK_FORMS: RockForm[] = ["terrace", "spires", "mesa", "rubble"];

const CLIFF_W = 26;
const CLIFF_D = 18;
const CLIFF_H = 34;
const cliffCache = new Map<string, Model>();

/** Height of a formation's column at (ix, y); `ix` already runs outer edge (0) to trail side. */
function formHeight(form: RockForm, ix: number, y: number, seed: number): number {
  const u = ix / (CLIFF_W - 1), v = y / (CLIFF_D - 1);
  const jitter = (hash2(Math.floor(ix / 5), Math.floor(y / 4), seed) - 0.5) * 10;
  const chip = hash2(ix, y, seed + 3) < 0.08 ? 2 : 0;
  let h = 0;
  if (form === "terrace") {
    // Ledges step down toward the camera more than toward the trail, so their tops show.
    h = Math.round((CLIFF_H * (1.08 - 0.45 * u - 0.6 * v) + jitter) / 7) * 7;
  } else if (form === "spires") {
    // Three or four tapering stacks of different heights.
    for (let i = 0; i < 4; i++) {
      const cx = 3 + hash2(i, 1, seed) * (CLIFF_W - 6), cy = 3 + hash2(i, 2, seed) * (CLIFF_D - 6);
      const r = 3 + hash2(i, 3, seed) * 3.5, top = CLIFF_H * (0.55 + hash2(i, 4, seed) * 0.45) * (1 - 0.35 * (cx / CLIFF_W));
      const d = Math.hypot(ix - cx, y - cy) / r;
      if (d < 1) h = Math.max(h, Math.round((top * (1 - d * d * 0.45)) / 4) * 4);
    }
    if (h === 0 && hash2(ix >> 1, y >> 1, seed + 6) < 0.25) h = 2; // scree at their feet
  } else if (form === "mesa") {
    // A flat cap on sheer walls, with one low bench toward the trail and camera.
    const edge = Math.max(u - 0.55, v - 0.6) + jitter * 0.012;
    h = edge < 0 ? Math.round(CLIFF_H * 0.82) : edge < 0.22 ? Math.round(CLIFF_H * 0.3) : 0;
  } else {
    // Rubble: a heap of squat boulders.
    for (let i = 0; i < 6; i++) {
      const cx = hash2(i, 5, seed) * CLIFF_W, cy = 2 + hash2(i, 6, seed) * (CLIFF_D - 4);
      const r = 3 + hash2(i, 7, seed) * 5, top = CLIFF_H * (0.2 + hash2(i, 8, seed) * 0.3) * (1.2 - u * 0.6);
      const d = Math.max(Math.abs(ix - cx), Math.abs(y - cy) * 1.2) / r;
      if (d < 1) h = Math.max(h, Math.round(top * Math.sqrt(1 - d * d)));
    }
  }
  return Math.max(0, Math.min(CLIFF_H - 3, h - chip));
}

/**
 * A rock formation. `variant` picks the form and seed; `haze` (0..1) tints
 * every colour toward `fog` so far formations sit back in the mist, and
 * `shade` (0..1) darkens toward ink for backlit near wings. `sun` (+1 from
 * the right, -1 from the left) warms the faces turned to the light and
 * darkens the ones turned away.
 */
export function cliffModel(biome: BiomeName, variant: number, mirror: boolean, fog = "#ffffff", haze = 0, shade = 0, sun: -1 | 0 | 1 = 0, scale: 1 | 2 = 1): Model {
  const key = `${biome}|${variant}|${mirror}|${fog}|${haze}|${shade}|${sun}|${scale}`;
  const hit = cliffCache.get(key);
  if (hit) return hit;
  const form = ROCK_FORMS[variant % ROCK_FORMS.length];
  const look = ROCK_LOOK[biome], seed = 101 + variant * 37, tuft = TUFT_COL[biome];
  const tint = (c: string) => {
    const lit = shade ? lerpHex(c, INKY, shade) : c;
    return haze ? lerpHex(lit, fog, haze) : lit;
  };
  const C = new Map<string, string>();
  // Light: 0 plain, 1 facing the sun, 2 turned away.
  let light = 0;
  const col = (c: string) => {
    const id = c + light;
    let t = C.get(id);
    if (!t) C.set(id, (t = tint(light === 1 ? lerpHex(c, "#fff4d8", 0.22) : light === 2 ? lerpHex(c, INKY, 0.22) : c)));
    return t;
  };
  // At scale 2 the same form is sampled on a finer grid (drawn at half the
  // scale), with a voxel of roughness on every edge, so near rock has blocks
  // the size of the captain's instead of twice as coarse.
  const CW = CLIFF_W * scale, CD = CLIFF_D * scale, CH = CLIFF_H * scale;
  const heights = new Int16Array(CW * CD);
  for (let y = 0; y < CD; y++) {
    for (let x = 0; x < CW; x++) {
      const ix = mirror ? CW - 1 - x : x, h = Math.round(formHeight(form, (ix + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5, seed) * scale);
      heights[y * CW + x] = h > 0 && scale > 1 ? Math.max(1, h - (hash2(ix, y, seed + 17) < 0.3 ? 1 : 0)) : h;
    }
  }
  const m = makeModel(CW, CD, CH, (x, y, z) => {
    const h = heights[y * CW + x];
    if (h <= 0) return null;
    if (z >= h) {
      // Tufts rooted on the ledges (not on far, hazy rock: they'd only be noise).
      const t = hash2(x, y, seed + 11);
      if (haze < 0.5 && t < 0.035 && z < h + 2 + Math.round(t * 50)) return col(tuft[z === h ? 0 : 1]);
      return null;
    }
    const ix = mirror ? CW - 1 - x : x;
    const hr = x + 1 < CW ? heights[y * CW + x + 1] : 0, hl = x > 0 ? heights[y * CW + x - 1] : 0;
    light = sun > 0 ? (hr <= z ? 1 : hl <= z ? 2 : 0) : sun < 0 ? (hl <= z ? 1 : hr <= z ? 2 : 0) : 0;
    // Three tones, like a painted rock: lit ledge tops, a dark lip under each
    // ledge, and plain faces (the stack's own shading darkens covered voxels).
    if (z === h - 1) return col(look.cap && hash2(x >> 2, y >> 2, seed + 5) < 0.3 ? look.cap : look.body[2]);
    if (z === h - 2 && h > 6) return col(look.body[0]);
    if (haze < 0.5 && hash2(Math.floor(ix / scale), 0, seed + 7) < 0.07 && ix % scale === 0 && z < h - 3) return col("#1a1a20"); // long vertical crack
    if (look.seam && z % 9 === 4) return col(look.seam);
    return col(z % 9 === 0 ? look.body[0] : look.body[1]);
  });
  cliffCache.set(key, m);
  return m;
}

/** Each biome's foes: the first is the classic, the second its rival. */
export const FOE_ROSTER: Record<BiomeName, ExpeditionFoe[]> = Object.fromEntries(
  (Object.keys(EXPEDITION_FOES) as BiomeName[]).map((b) => [b, [EXPEDITION_FOES[b], SECOND_FOES[b]]]),
) as Record<BiomeName, ExpeditionFoe[]>;
