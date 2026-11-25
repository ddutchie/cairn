/**
 * Tideglass voxel models — stacked sprite layers for the lighthouse
 * archipelago mystery. Same `makeModel` language as Wayfinder/Basecamp.
 */

import { makeModel, type Model } from "../pixel/models";

const INKY = "#0a0f1e";

/** The Wick: oilskin tender with brass tideglass lens on the chest. */
export const WICK_MODEL: Model = makeModel(9, 9, 13, (x, y, z) => {
  const cx = 4, cy = 4;
  const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
  if (z < 2) return dx <= 1 && dy <= 1 ? "#3a2416" : null;
  if (z < 8) {
    if (dx > 2 || dy > 2) return null;
    if (z === 5 && dx <= 1 && y === cy) return "#fff2a0";
    return dx === 2 ? "#14343a" : "#1f5a63";
  }
  if (z < 11) {
    if (dx > 2 || dy > 2) return null;
    if (y === cy - 2 && dx <= 1 && z === 9) return "#f0c8a0";
    return z === 10 ? "#e8a33d" : "#245a63";
  }
  return z === 11 && dx <= 1 && dy <= 1 ? "#e8a33d" : null;
});

/** Lighthouse: striped tower with lamp room (beam drawn live). */
export const LIGHTHOUSE_MODEL: Model = makeModel(13, 13, 22, (x, y, z) => {
  const dx = x - 6, dy = y - 6;
  const r = Math.hypot(dx, dy);
  if (z < 2) return r < 6 ? "#485061" : null;
  if (z < 16) {
    if (r > 3.4) return null;
    if (r > 2.6) return z % 4 < 2 ? "#efe4c8" : "#c44536";
    return z % 4 < 2 ? "#d8ccb0" : "#a83a2e";
  }
  if (z < 19) {
    if (r > 3) return null;
    if (r > 2) return "#3a2416";
    return z === 18 ? "#fff2a0" : "#ffd97a";
  }
  if (z < 21) return r < 3.4 && r > 2.6 ? "#3a2416" : null;
  return r < 2 ? "#c44536" : null;
});

/** Tide mill + sluice gate: timber wheelhouse over the channel. */
export const MILL_MODEL: Model = makeModel(15, 13, 12, (x, y, z) => {
  const dx = Math.abs(x - 7);
  if (z < 2) return y >= 2 && y <= 10 && dx <= 6 ? "#485061" : null;
  if (z < 7) {
    if (y < 2 || y > 10 || dx > 5) return null;
    if (x === 7 && y >= 4 && y <= 8) return "#1c2a3a";
    if (z === 6) return "#7a4a2a";
    return (x + y) % 2 ? "#8a5a32" : "#6e4526";
  }
  if (z < 10) {
    if (dx > 4 || y < 3 || y > 9) return null;
    if (y === 9 && dx <= 1) return "#0a0f1e";
    return (x >> 1) % 2 ? "#a86b3e" : "#8a5a32";
  }
  return z === 10 && dx <= 3 && y >= 4 && y <= 8 ? "#52301a" : null;
});

/** Radio mast: guy-wired tower with dish. */
export const RADIO_MODEL: Model = makeModel(11, 11, 18, (x, y, z) => {
  const cx = 5, cy = 5;
  const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
  if (z < 2) return dx <= 3 && dy <= 3 ? "#485061" : null;
  if (z < 14) {
    if (dx + dy > 1) {
      if (z < 6 && dx === 3 && dy === 3) return "#6c768a";
      return null;
    }
    return z % 2 ? "#8b93b8" : "#5b6b82";
  }
  if (z < 16) return dx <= 2 && dy <= 1 ? "#2ec4b6" : null;
  return z === 16 && x === cx && y === cy ? "#fff2a0" : null;
});

/** Dock + moored skiff. */
export const DOCK_MODEL: Model = makeModel(15, 11, 6, (x, y, z) => {
  if (z < 2) {
    if (y < 6) return x >= 1 && x <= 13 && (y % 2 === 0 || x % 3 === 0) ? "#7a4a2a" : null;
    const hx = x - 7, hy = (y - 8) * 2;
    return hx * hx + hy * hy < 16 ? (z === 1 ? "#1f5a63" : "#14343a") : null;
  }
  if (z < 4) {
    if (y >= 6) {
      const hx = x - 7;
      if (Math.abs(hx) <= 2 && y >= 7 && y <= 9) return "#8a5a32";
    }
    return y < 6 && (x === 1 || x === 13) ? "#52301a" : null;
  }
  return z === 4 && y >= 7 && y <= 9 && Math.abs(x - 7) <= 1 ? "#e8a33d" : null;
});

/** Harbour hut tinted by project accent. */
const hutCache = new Map<string, Model>();
export function hutModel(accent: string): Model {
  let m = hutCache.get(accent);
  if (m) return m;
  m = makeModel(13, 11, 10, (x, y, z) => {
    const dx = Math.abs(x - 6);
    if (z < 3) return y >= 1 && y <= 9 && dx <= 5 ? "#6c768a" : null;
    if (z < 7) {
      if (y < 2 || y > 8 || dx > 4) return null;
      if (y === 8 && dx <= 1) return INKY;
      if (z >= 4 && z <= 5 && y >= 4 && y <= 5 && dx <= 2) return "#ffe9a8";
      return dx === 4 ? accent : "#d8ccb0";
    }
    if (z < 9) {
      const h = 8 - dx;
      if (z > h || y < 2 || y > 8) return null;
      return accent;
    }
    return z === 9 && dx <= 1 && y >= 3 && y <= 7 ? "#52301a" : null;
  });
  hutCache.set(accent, m);
  return m;
}

/** Sunken chest, half-buried. */
export const CHEST_MODEL: Model = makeModel(11, 9, 7, (x, y, z) => {
  const dx = Math.abs(x - 5), dy = Math.abs(y - 4);
  if (z < 2) return dx <= 4 && dy <= 3 ? "#485061" : null;
  if (z < 5) return dx <= 3 && dy <= 2 ? (z === 4 ? "#e8a33d" : "#7a4a2a") : null;
  return z === 5 && dx <= 3 && dy <= 2 ? "#ffdf8a" : null;
});

/** Lens vault (the Fifth Tideglass): stone cairn with empty lens ring. */
export const VAULT_MODEL: Model = makeModel(11, 11, 12, (x, y, z) => {
  const dx = x - 5, dy = y - 5;
  const r = Math.hypot(dx, dy);
  if (z < 3) return r < 4.6 ? "#485061" : null;
  if (z < 8) {
    if (r > 3.4 || r < 1.6) return null;
    return (x + y + z) % 2 ? "#98a4b8" : "#6c768a";
  }
  if (z < 10) return r < 2.6 && r > 1.2 ? "#fff2a0" : null;
  return r < 1.4 ? "#a8f4e8" : null;
});

/** Cargo crate with rope. */
export const CRATE_MODEL: Model = makeModel(9, 9, 7, (x, y, z) => {
  const dx = Math.abs(x - 4), dy = Math.abs(y - 4);
  if (dx > 3 || dy > 3) return null;
  if (z === 0 || z === 6) return "#8a5a32";
  if (x === 4 || y === 4) return "#e8a33d";
  return "#a86b3e";
});

/** Driftwood gear small enough to jam the sluice. */
export const GEAR_MODEL: Model = makeModel(7, 7, 3, (x, y, z) => {
  const dx = x - 3, dy = y - 3;
  const r = Math.hypot(dx, dy);
  if (r > 2.8) {
    if ((x + y) % 2 === 0 && r < 3.6) return "#8a5a32";
    return null;
  }
  if (r < 1.2) return null;
  return z === 2 ? "#e8a33d" : "#7a4a2a";
});

/** Tide shard: glowing glass fragment. */
export const SHARD_MODEL: Model = makeModel(5, 5, 7, (x, y, z) => {
  const dx = Math.abs(x - 2), dy = Math.abs(y - 2);
  if (dx + dy > 2) return null;
  if (z >= 5) return dx + dy === 0 ? "#ffffff" : null;
  return z % 2 ? "#a8f4e8" : "#47a3e6";
});

/** Pines for the headlands. */
export const PINE_MODEL: Model = makeModel(7, 7, 12, (x, y, z) => {
  const dx = Math.abs(x - 3), dy = Math.abs(y - 3);
  if (z < 2) return dx <= 1 && dy <= 1 ? "#52301a" : null;
  if (z < 10) {
    const r = 4 - z * 0.32;
    return dx + dy <= r ? (z % 2 ? "#1f5a3c" : "#2a7a4e") : null;
  }
  return dx + dy <= 1 ? "#2a7a4e" : null;
});

/** Coastal & alpine boulders for 3D terrain landmarks. */
export const ROCK_MODEL: Model = makeModel(7, 7, 6, (x, y, z) => {
  const dx = x - 3, dy = y - 3;
  const r = Math.hypot(dx, dy);
  if (r > 3.1 - z * 0.45) return null;
  if (z >= 4) return "#98a4b8";
  return (x + y + z) % 2 ? "#6c768a" : "#485061";
});

/** Wooden trail fork signpost. */
export const SIGN_MODEL: Model = makeModel(5, 3, 9, (x, y, z) => {
  if (z < 5) return x === 2 && y === 1 ? "#52301a" : null;
  if (z >= 5 && z <= 7 && y === 1) return x === 0 || x === 4 ? "#d9b078" : "#8a5a32";
  return null;
});

/** Timber plank bridge spanning the mill channel. */
export const BRIDGE_MODEL: Model = makeModel(11, 7, 3, (x, y, z) => {
  if (z === 0) return y === 0 || y === 6 ? "#52301a" : "#8a5a32";
  if (z <= 2 && (y === 0 || y === 6) && x % 4 === 0) return "#7a4a2a";
  return null;
});

const npcCache = new Map<string, Model>();
/** One of the four islanders, tinted by role. */
export function npcModel(accent: string): Model {
  let m = npcCache.get(accent);
  if (m) return m;
  m = makeModel(7, 7, 11, (x, y, z) => {
    const dx = Math.abs(x - 3), dy = Math.abs(y - 3);
    if (z < 2) return dx <= 1 && dy <= 0 ? "#3a2416" : null;
    if (z < 6) return dx <= 2 && dy <= 1 ? accent : null;
    if (z < 9) {
      if (dx > 1 || dy > 1) return null;
      if (y === 2 && z === 7) return "#f0c8a0";
      return z === 8 ? "#ffe9a8" : accent;
    }
    return z === 9 && dx <= 1 && dy <= 1 ? "#ffe9a8" : null;
  });
  npcCache.set(accent, m);
  return m;
}
