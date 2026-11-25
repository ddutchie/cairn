/**
 * Basecamp voxel models — stacked sprite layers built with `makeModel` for
 * the Warden, project-tinted Settlers & Lodges, Twilight Brambles, and
 * clockwork valley landmarks.
 */

import { lerpHex } from "../pixel/kinds";
import { makeModel, type Model } from "../pixel/models";
import { hash2 } from "../pixel/terrain";

const INKY = "#0a0f1e";
const WOOD = "#7a4a2a";
const WOOD_D = "#52301a";
const WOOD_L = "#a86b3e";
const STONE = "#6c768a";
const STONE_D = "#485061";
const STONE_L = "#98a4b8";

/**
 * The Warden: hooded ranger in deep teal cloak, amber scarf, backpack roll,
 * and a raised right hand holding a swinging brass lantern. Faces -y (away/up),
 * rotated dynamically in `stack()` toward the walk direction.
 */
function buildWarden(lanternLit: boolean): Model {
  return makeModel(11, 9, 15, (x, y, z) => {
    const cx = 5, cy = 4;
    const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
    // Raised lantern on right side (x=9, y=1..2)
    if (x === 9 && (y === 1 || y === 2)) {
      if (z === 7 || z === 10) return "#3a2416";
      if (z >= 8 && z <= 9) return lanternLit ? "#fff2a0" : "#8fb8d8";
    }
    if (x === 8 && y === 2 && z === 10) return "#d9922b"; // lantern hook/arm
    // Backpack roll on back (y = 6..7)
    if (y >= 6 && y <= 7 && dx <= 2 && z >= 5 && z <= 10) {
      return z === 10 ? "#c99652" : dx === 2 ? "#5a3a22" : "#8a5a32";
    }
    // Boots
    if (z < 2) return dx === 1 && dy <= 1 ? "#3a2416" : null;
    // Cloak & legs
    if (z < 9) {
      const r = z < 4 ? 3 : 2.5;
      if (dx > r || dy > 2) return null;
      if (z === 5 && dy === 2 && dx <= 2) return "#d9822b"; // belt/satchel strap
      return dx >= 2 ? "#1b5954" : y >= cy + 1 ? "#24736c" : "#2ec4b6";
    }
    // Amber scarf collar
    if (z === 9 || z === 10) {
      if (dx > 2 || dy > 2) return null;
      return z === 10 ? "#ffbe55" : "#d97a24";
    }
    // Hooded head (facing -y has face, back has hood)
    if (z < 14) {
      if (dx > 2 || dy > 2) return null;
      if (y === cy - 2 && dx <= 1 && z >= 11 && z <= 12) return "#f0c8a0";
      return z === 13 && dx <= 1 && dy <= 1 ? "#2ec4b6" : "#1f6861";
    }
    return z === 14 && dx === 0 && dy === 0 ? "#2ec4b6" : null;
  });
}

export const WARDEN_MODEL: Model = buildWarden(false);
export const WARDEN_LIT_MODEL: Model = buildWarden(true);

const settlerCache = new Map<string, Model>();
/** Tiny autonomous project settler tinted with that project's accent colour. */
export function settlerModel(accent: string): Model {
  let m = settlerCache.get(accent);
  if (m) return m;
  const dark = lerpHex(accent, INKY, 0.35);
  const bright = lerpHex(accent, "#ffffff", 0.28);
  m = makeModel(7, 7, 11, (x, y, z) => {
    const dx = Math.abs(x - 3), dy = Math.abs(y - 3);
    if (z < 2) return dx === 1 && dy === 0 ? "#3a2416" : null;
    if (z < 6) return dx <= 2 && dy <= 1 ? (dx === 2 ? dark : accent) : null;
    if (z < 9) {
      if (dx > 1 || dy > 1) return null;
      if (y === 2 && z === 7) return "#f0c8a0";
      return z === 8 ? bright : accent;
    }
    return z === 9 && dx <= 1 && dy <= 1 ? bright : null;
  });
  settlerCache.set(accent, m);
  return m;
}

/** Central stone Hearthfire pit & crossed logs (flames are drawn live in render). */
export const HEARTH_MODEL: Model = makeModel(11, 11, 6, (x, y, z) => {
  const dx = x - 5, dy = y - 5;
  const r = Math.hypot(dx, dy);
  if (z <= 1 && r >= 3.2 && r <= 4.9) return (x + y) % 2 ? STONE : STONE_L;
  if (z === 0 && r < 3.2) return "#2a1814";
  if (z >= 1 && z <= 2 && r < 2.8) {
    if (Math.abs(dx - dy) <= 0.8 || Math.abs(dx + dy) <= 0.8) return WOOD_D;
    return z === 1 ? "#ef5a24" : "#ffbe44";
  }
  if (z === 3 && r < 1.3) return "#fff2a0";
  return null;
});

const lodgeCache = new Map<string, Model>();
/** Project Camp (stage 1 = pitched canvas tent, stage 2 = timber workshop with warm windows & chimney). */
export function lodgeModel(accent: string, level: 1 | 2): Model {
  const key = `${accent}:${level}`;
  let m = lodgeCache.get(key);
  if (m) return m;
  const stripe = lerpHex(accent, "#fff6df", 0.15);
  const roofDark = lerpHex(accent, INKY, 0.25);

  if (level === 1) {
    m = makeModel(15, 13, 11, (x, y, z) => {
      const dx = Math.abs(x - 7);
      const h = 9 - dx * 1.25;
      if (x === 7 && y === 6 && z >= 9) return z === 10 ? accent : WOOD_D;
      if (z > h || y < 1 || y > 11) return null;
      if (y === 11 && dx <= 1 && z < 5) return INKY;
      if (z < h - 1.2 && y > 1 && y < 11) return null;
      return (dx >> 1) % 2 ? stripe : y === 11 ? "#efe4c8" : "#d8ccb0";
    });
  } else {
    m = makeModel(17, 15, 15, (x, y, z) => {
      const dx = Math.abs(x - 8), dy = Math.abs(y - 7);
      // Chimney at back-right
      if (x >= 11 && x <= 13 && y >= 3 && y <= 5 && z >= 7 && z <= 14) {
        return z === 14 ? STONE_L : (x + y + z) % 2 ? STONE : STONE_D;
      }
      // Timber walls
      if (z < 8) {
        if (dx > 6 || dy > 5) return null;
        if (y === 12 && dx <= 1 && z < 5) return z === 4 ? WOOD_L : "#3a2214"; // doorway
        if (dx === 6 && dy <= 2 && z >= 3 && z <= 5) return "#ffe484"; // warm glowing window
        if (z === 0) return STONE_D;
        return dx === 6 || dy === 5 ? (z % 2 ? WOOD : WOOD_L) : null;
      }
      // Pitched gabled roof in project accent
      const maxX = 7 - (z - 8) * 1.05;
      if (dx > maxX || dy > 6) return null;
      if (z === 14 && dx <= 1) return "#fff2a0";
      return dx >= maxX - 1.1 ? roofDark : ((x + z) % 3 === 0 ? stripe : accent);
    });
  }
  lodgeCache.set(key, m);
  return m;
}

/** Watchfire Brazier (stone basin — fire sprite animates above when lit). */
export const BRAZIER_MODEL: Model = makeModel(9, 9, 9, (x, y, z) => {
  const r = Math.hypot(x - 4, y - 4);
  if (z <= 1) return r <= 3.6 ? STONE_D : null;
  if (z <= 4) return r <= 2.1 ? STONE : null;
  if (z <= 7) return r <= 3.5 && (z < 7 || r >= 2.2) ? (z === 7 ? STONE_L : STONE_D) : null;
  if (z === 8 && r < 2.2) return "#4a3022";
  return null;
});

/** Mill Creek Sluice Gate with raised crank frame. */
export const SLUICE_MODEL: Model = makeModel(15, 9, 10, (x, y, z) => {
  // Side stone piers
  if ((x <= 2 || x >= 12) && y >= 1 && y <= 7 && z <= 6) {
    return (x + y + z) % 2 ? STONE : STONE_L;
  }
  // Overhead timber beam & wheel
  if (z === 8 && y === 4 && x >= 1 && x <= 13) return WOOD_L;
  if (x === 7 && y === 4 && z >= 6 && z <= 9) return z === 9 ? "#d9922b" : WOOD;
  // Gate planks (middle)
  if (x >= 3 && x <= 11 && y === 4 && z <= 5) {
    return z === 5 ? WOOD_L : (x % 2 ? WOOD : WOOD_D);
  }
  return null;
});

/** East Bluff Bronze Bell tower. */
export const BELL_MODEL: Model = makeModel(11, 9, 14, (x, y, z) => {
  const dx = Math.abs(x - 5), dy = Math.abs(y - 4);
  if (z === 0 && dx <= 4 && dy <= 3) return STONE;
  // Timber uprights
  if (z <= 11 && dx === 3 && dy <= 1) return z % 2 ? WOOD : WOOD_D;
  // Crossbeam & pitched cap
  if (z === 11 && dx <= 4 && dy <= 1) return WOOD_L;
  if (z >= 12 && dx <= 4 - (z - 12) && dy <= 2 - (z - 12)) return "#c95a3b";
  // Hanging bronze bell
  if (z >= 5 && z <= 9 && dx <= (z < 7 ? 2 : 1) && dy <= (z < 7 ? 2 : 1)) {
    return z === 5 ? "#fff0a8" : "#e3a23b";
  }
  if (z === 10 && dx === 0 && dy === 0) return WOOD_D;
  return null;
});

/** South-West Shortwave Radio Tower. */
export const RADIO_MODEL: Model = makeModel(9, 9, 17, (x, y, z) => {
  const dx = Math.abs(x - 4), dy = Math.abs(y - 4);
  if (z === 0 && dx <= 3 && dy <= 3) return STONE_D;
  const w = z < 6 ? 2 : z < 11 ? 1 : 0;
  if (z <= 11 && (dx === w || dy === w) && dx <= w && dy <= w) {
    return z % 2 ? STONE_L : STONE;
  }
  if (z >= 12 && z <= 14 && dx === 0 && dy === 0) return "#98a4b8";
  if (z === 11 && dx <= 2 && dy === 0) return "#e3a23b"; // cross aerial
  if (z >= 15 && dx === 0 && dy === 0) return z === 16 ? "#ff5c44" : "#fff2a0";
  return null;
});

/** Northern Ancient Hollow Cairn (gains capstone when awakened). */
export const CAIRN_MODEL: Model = makeModel(11, 11, 16, (x, y, z) => {
  const dx = Math.abs(x - 5), dy = Math.abs(y - 5);
  const r = Math.hypot(dx, dy);
  if (z < 3) return r <= 4.3 ? (z === 0 ? STONE_D : STONE) : null;
  if (z < 6) return r <= 3.3 ? (dx <= 1 && y >= 7 && z >= 3 ? INKY : STONE_L) : null;
  if (z < 9) return r <= 2.6 ? ((x + z) % 2 ? "#4cc9f0" : STONE) : null;
  if (z < 12) return r <= 1.8 ? STONE_L : null;
  if (z < 15) return r <= 1.1 ? "#fff2a0" : null;
  return null;
});

/** Sunken brass-bound treasure chest revealed by the Moonlit Causeway. */
export const CHEST_MODEL: Model = makeModel(9, 7, 7, (x, y, z) => {
  if (y === 0 || y === 6 || x === 0 || x === 8) return null;
  if (z === 3 && x === 4 && y === 5) return "#fff2a0"; // lock clasp
  if (z >= 4 && (x === 2 || x === 6)) return "#e3a23b"; // brass bands
  if (z <= 3 && (x === 2 || x === 6)) return "#e3a23b";
  if (z === 6 && (y === 1 || y === 5)) return null;
  return z >= 4 ? "#a86b3e" : "#7a4a2a";
});

/** Overdue-task Twilight Bramble patch with violet spores. */
export const BRAMBLE_MODEL: Model = makeModel(11, 11, 8, (x, y, z) => {
  const r = Math.hypot(x - 5, y - 5);
  if (r > 4.8 - z * 0.45) return null;
  if (z >= 5 && hash2(x, y, z) < 0.25) return "#c45aa8"; // glowing twilight bud
  if (hash2(x + 3, y, z) < 0.18) return "#7c3f8a";
  return z % 2 ? "#2d4c2a" : "#1c331e";
});

/** Valley Pine tree for the forest perimeter. */
export const PINE_MODEL: Model = makeModel(11, 11, 16, (x, y, z) => {
  const r = Math.hypot(x - 5, y - 5);
  if (z < 4) return r <= 1.4 ? WOOD_D : null;
  const tier = (z - 4) % 4;
  const maxR = 4.6 - Math.floor((z - 4) / 4) * 1.1 - tier * 0.65;
  if (r > maxR) return null;
  return tier === 0 ? "#1f4d28" : hash2(x, y, z) < 0.16 ? "#4c963d" : "#2e6d32";
});

/** Collectible stacked Timber logs. */
export const TIMBER_MODEL: Model = makeModel(7, 7, 5, (x, y, z) => {
  if (z <= 1 && (y === 1 || y === 3 || y === 5) && x >= 1 && x <= 5) {
    return x === 1 || x === 5 ? "#d9b078" : WOOD;
  }
  if (z === 2 && (y === 2 || y === 4) && x >= 1 && x <= 5) {
    return x === 1 || x === 5 ? "#d9b078" : WOOD_L;
  }
  if (z === 3 && y === 3 && x >= 2 && x <= 4) return WOOD_L;
  return null;
});

/** Glowing golden Spark / Clue crystal. */
export const SPARK_MODEL: Model = makeModel(5, 5, 7, (x, y, z) => {
  const d = Math.abs(x - 2) + Math.abs(y - 2) + Math.abs(z - 3);
  if (d > 2) return null;
  return d === 0 ? "#ffffff" : z >= 3 ? "#fff2a0" : "#ff9e44";
});
