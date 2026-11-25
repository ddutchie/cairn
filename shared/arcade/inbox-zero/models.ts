/**
 * Inbox Zero models, tag definitions, and centered serpentine board geometry.
 */

import type { Priority } from "../../types/domain";
import { PRIORITY_PAL, clamp } from "../pixel/kinds";
import { makeModel, type Model } from "../pixel/models";

export const CELL = 12;
export const CORE_GX = 15;
export const CORE_GY = 21;
export const MAX_WAVES = 5;
export const MAX_SHOP_W = 72;

/** Serpentine through the centered 15-cell core, in core-relative grid cells. */
export const PATH_CELLS: readonly [number, number][] = [
  [1, -1], [1, 4], [13, 4], [13, 9], [1, 9], [1, 14], [13, 14], [13, 18], [7, 18], [7, 21],
];

export const PRIO: Record<Priority, { hp: number; v: number; reward: number; h: string; d: string }> = {
  low: { hp: 4, v: 0.32, reward: 3, ...PRIORITY_PAL.low },
  medium: { hp: 8, v: 0.36, reward: 5, ...PRIORITY_PAL.medium },
  high: { hp: 15, v: 0.4, reward: 8, ...PRIORITY_PAL.high },
  urgent: { hp: 26, v: 0.5, reward: 12, ...PRIORITY_PAL.urgent },
};

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

export interface CoreSegment {
  a: { x: number; y: number };
  b: { x: number; y: number };
  len: number;
}

const CORE_POINTS = PATH_CELLS.map(([c, r]) => ({
  x: c * CELL + CELL / 2,
  y: r * CELL + CELL / 2,
}));

export const CORE_SEGMENTS: CoreSegment[] = CORE_POINTS.slice(1).map((b, i) => {
  const a = CORE_POINTS[i];
  return { a, b, len: Math.hypot(b.x - a.x, b.y - a.y) };
});

export const PATH_LEN = CORE_SEGMENTS.reduce((s, g) => s + g.len, 0);

const onPathMask = new Uint8Array(CORE_GX * CORE_GY);
for (const { a, b } of CORE_SEGMENTS) {
  const c0 = (Math.min(a.x, b.x) / CELL) | 0;
  const c1 = (Math.max(a.x, b.x) / CELL) | 0;
  const r0 = (Math.min(a.y, b.y) / CELL) | 0;
  const r1 = (Math.max(a.y, b.y) / CELL) | 0;
  for (let r = Math.max(0, r0); r <= Math.min(CORE_GY - 1, r1); r++) {
    for (let c = c0; c <= c1; c++) onPathMask[r * CORE_GX + c] = 1;
  }
}

export function isOnPath(c: number, r: number): boolean {
  return c >= 0 && c < CORE_GX && r >= 0 && r < CORE_GY && onPathMask[r * CORE_GX + c] === 1;
}

function distToSeg(px0: number, py0: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px0 - ax) * dx + (py0 - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px0 - (ax + t * dx), py0 - (ay + t * dy));
}

/** True when core-relative cell `(c, r)` is off the serpentine and within #FOCUS reach. */
export function canBuildCore(c: number, r: number): boolean {
  if (r < 0 || r >= CORE_GY || isOnPath(c, r)) return false;
  if (c >= 0 && c < CORE_GX) return true;
  const x = c * CELL + CELL / 2, y = r * CELL + CELL / 2;
  const maxRange = TAGS[2].range;
  return CORE_SEGMENTS.some(({ a, b }) => distToSeg(x, y, a.x, a.y, b.x, b.y) <= maxRange);
}

export interface BoardColumnsLayout {
  coreX: number;
  minC: number;
  maxC: number;
  shopW: number;
  shopX0: number;
}

export interface BoardLayout extends BoardColumnsLayout {
  topY: number;
  shopY: number;
  shopH: number;
}

export function boardLayout(w: number, hudLeft = 0, hudRight = 0): BoardColumnsLayout {
  const usableW = Math.max(CORE_GX * CELL, w - hudLeft - hudRight);
  const coreX = Math.floor(hudLeft + (usableW - CORE_GX * CELL) / 2);
  const minC = Math.max(-Math.floor((coreX - hudLeft) / CELL), -Math.floor(coreX / CELL)) || 0;
  const maxC = CORE_GX - 1 + Math.floor((w - hudRight - coreX - CORE_GX * CELL) / CELL);
  const shopW = Math.min(MAX_SHOP_W, Math.floor(usableW / TAGS.length));
  const shopX0 = Math.round(hudLeft + (usableW - shopW * TAGS.length) / 2);
  return { coreX, minC, maxC, shopW, shopX0 };
}

export function fullBoardLayout(w: number, H: number, hudTop = 0, hudBottom = 0, hudLeft = 0, hudRight = 0, shopH = 32): BoardLayout {
  const cols = boardLayout(w, hudLeft, hudRight);
  const topY = Math.max(26, hudTop + 22);
  const shopY = H - hudBottom - shopH;
  return { ...cols, topY, shopY, shopH };
}

export function alongFlow(d: number, lay: Pick<BoardLayout, "coreX" | "topY">): { x: number; y: number; dir: number } {
  let rem = d;
  for (const g of CORE_SEGMENTS) {
    if (rem <= g.len) {
      const f = rem / g.len;
      return {
        x: lay.coreX + g.a.x + (g.b.x - g.a.x) * f,
        y: lay.topY + g.a.y + (g.b.y - g.a.y) * f,
        dir: Math.atan2(g.b.x - g.a.x, -(g.b.y - g.a.y)),
      };
    }
    rem -= g.len;
  }
  const e = CORE_POINTS[CORE_POINTS.length - 1];
  return { x: lay.coreX + e.x, y: lay.topY + e.y, dir: Math.PI };
}
