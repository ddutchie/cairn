/**
 * Inbox Zero voxel models and tower/card definitions: one sticky-note card
 * model per priority and one pinned-tag tower model per tag and upgrade level.
 */

import type { Priority } from "@cairn/shared/types/domain";
import { makeModel, type Model } from "@/games/pixel/models";
import { ENEMY_PALETTE } from "@/games/task-force/models";

export const FIRE = ["#ffffff", "#fff2a0", "#ffb347", "#ef5a24", "#7a3a2a"];

export type TagId = "quick" | "bug" | "focus" | "batch";

export interface TagDef {
  id: TagId;
  name: string;
  c: string;
  l: string;
  cost: number;
  range: number;
  rate: number;
  dmg: number;
  slow?: number;
  splash?: number;
  blurb: string;
}

export const TAGS: TagDef[] = [
  { id: "quick", name: "#QUICK", c: "#7cc46a", l: "#e9ff9a", cost: 10, range: 30, rate: 16, dmg: 1, blurb: "FAST" },
  { id: "bug", name: "#BUG", c: "#c45aa8", l: "#ffd2f0", cost: 15, range: 28, rate: 36, dmg: 0.6, slow: 80, blurb: "SLOWS" },
  { id: "focus", name: "#FOCUS", c: "#5b8dd6", l: "#c7e4ff", cost: 25, range: 62, rate: 70, dmg: 7, blurb: "LONG" },
  { id: "batch", name: "#BATCH", c: "#e3a23b", l: "#fff0a8", cost: 30, range: 34, rate: 64, dmg: 3, splash: 16, blurb: "SPLASH" },
];

export const PRIO: Record<Priority, { hp: number; v: number; reward: number; h: string; d: string }> = {
  low: { hp: 4, v: 0.32, reward: 3, h: ENEMY_PALETTE.low.h, d: ENEMY_PALETTE.low.d },
  medium: { hp: 8, v: 0.36, reward: 5, h: ENEMY_PALETTE.medium.h, d: ENEMY_PALETTE.medium.d },
  high: { hp: 15, v: 0.4, reward: 8, h: ENEMY_PALETTE.high.h, d: ENEMY_PALETTE.high.d },
  urgent: { hp: 26, v: 0.5, reward: 12, h: ENEMY_PALETTE.urgent.h, d: ENEMY_PALETTE.urgent.d },
};

/** A task card: sticky note with priority stripe and two text lines. */
export const CARD_MODELS: Record<Priority, Model> = Object.fromEntries(
  (Object.keys(PRIO) as Priority[]).map((k) => [
    k,
    makeModel(9, 9, k === "urgent" ? 4 : k === "high" ? 3 : 2, (x, y, z) => {
      if (z === 0) return "#b8ad8e";
      if (y <= 1) return PRIO[k].h;
      if ((y === 4 || y === 6) && x >= 1 && x <= (y === 6 ? 5 : 7)) return "#8a97b8";
      return z % 2 ? "#fffaf0" : "#efe6d0";
    }),
  ]),
) as Record<Priority, Model>;

function tagModel(t: TagDef, lvl: number): Model {
  const h = 3 + lvl * 2;
  return makeModel(9, 11, h, (x, y, z) => {
    const dx = Math.abs(x - 4);
    if (z < h - 2) return dx <= 1 && Math.abs(y - 6) <= 1 ? (z === 0 ? "#2a2f3a" : "#4a5068") : null;
    if (y < 1 || y > 9 || dx > Math.min(3, y)) return null;
    if (x === 4 && y === 2) return null;
    if (z === h - 1) return y === 9 || dx === Math.min(3, y) ? t.c : t.l;
    return t.c;
  });
}

export const TOWER_MODELS: Record<TagId, Model[]> = Object.fromEntries(
  TAGS.map((t) => [t.id, [0, 1, 2].map((l) => tagModel(t, l))]),
) as Record<TagId, Model[]>;
