/**
 * Task Force's fleet: player jet, one enemy ship per priority, project-review
 * saucer boss, and note pickup, as voxel sprite-stack models + biome levels.
 */

import type { Priority } from "../../types/domain";
import type { ArcadeProject } from "../pixel/arcade-data";
import { PRIORITY_PAL } from "../pixel/kinds";
import { makeModel, type Model } from "../pixel/models";
import { BIOME_ORDER, type BiomeName } from "../pixel/terrain";

export interface EnemySpec {
  hp: number;
  r: number;
  gap: number;
  score: number;
  size: number;
}

export const PRI_WEIGHT: Record<Priority, number> = {
  low: 0,
  medium: 1.5,
  high: 3,
  urgent: 4.5,
};

export const ENEMY_CFG: Record<Priority, EnemySpec> = {
  low: { hp: 2, r: 7, gap: 46, score: 100, size: 1 },
  medium: { hp: 4, r: 8, gap: 60, score: 220, size: 2 },
  high: { hp: 8, r: 9, gap: 76, score: 400, size: 2 },
  urgent: { hp: 14, r: 11, gap: 94, score: 750, size: 3 },
};

export interface LevelTask {
  title: string;
  priority: Priority;
}

export interface Level {
  name: string;
  biome: BiomeName;
  tasks: LevelTask[];
  notes: string[];
}

export const DEMO_LEVELS: Level[] = [
  {
    name: "Getting Started",
    biome: "tropic",
    tasks: [
      { title: "Create a project", priority: "low" },
      { title: "Add a few tasks", priority: "low" },
      { title: "Write a note", priority: "medium" },
      { title: "Tag something", priority: "low" },
      { title: "Set a due date", priority: "medium" },
      { title: "Connect desktop sync", priority: "high" },
      { title: "Clear the backlog", priority: "urgent" },
    ],
    notes: ["Welcome", "Shortcuts"],
  },
];

export function buildTaskForceLevels(projects: readonly ArcadeProject[]): Level[] {
  const active = projects.filter((p) => p.tasks.length > 0);
  if (!active.length) return DEMO_LEVELS;
  return active.slice(0, 6).map((p, i) => ({
    name: p.name,
    biome: p.biome ?? BIOME_ORDER[i % BIOME_ORDER.length],
    tasks: p.tasks.slice(0, 24).map((t) => ({ title: t.title, priority: t.priority })),
    notes: p.notes.map((n) => n.title),
  }));
}

const JP = { h: "#b8c2d6", d: "#6b7488", k: "#343b4c", a: "#2ec4b6", c: "#a8f4ff", n: "#22262f" };

export const PLAYER: Model = makeModel(15, 19, 6, (x, y, z) => {
  const dx = Math.abs(x - 7);
  if (z === 4 && dx === 0 && y >= 4 && y <= 7) return JP.c;
  if (z === 3 && dx === 0 && y >= 4 && y <= 8) return JP.c;
  if (y <= 2) return dx === 0 && z >= 1 && z <= 2 ? JP.a : null;
  if (y >= 17 && dx <= 1 && z >= 1 && z <= 2) return JP.n;
  if (y >= 3 && y <= 16 && dx <= 1 && z >= 1 && z <= 3) return z === 3 && dx === 0 ? JP.d : JP.h;
  if (y >= 6 && y <= 9 && dx === 2 && z >= 1 && z <= 2) return JP.k;
  if (z === 2 && y >= 7 && y <= 13 && dx <= 2 + (y - 7) * 0.9) return dx >= 6 ? JP.a : y === 13 ? JP.d : JP.h;
  if (z === 2 && y >= 14 && y <= 17 && dx <= 3 + (y - 14) * 0.6) return dx >= 4 ? JP.a : JP.h;
  if (dx === 2 && y >= 13 && y <= 17 && z >= 3 && z <= Math.min(5, 3 + (y - 13))) return z === 5 ? JP.a : JP.d;
  return null;
});

const EYE = "#ff3d6e";
const GUN = "#2a2f3a";

export const ENEMIES: Record<Priority, Model> = {
  low: makeModel(9, 9, 3, (x, y, z) => {
    const p = PRIORITY_PAL.low, dx = Math.abs(x - 4), dy = Math.abs(y - 4), m = dx + dy;
    if (z === 0 && m <= 3) return p.d;
    if (z === 1 && m <= 4) return (dx === 0 || dy === 0) && m >= 3 ? p.a : p.h;
    if (z === 2 && m <= 1) return y === 3 && x === 4 ? EYE : p.d;
    return null;
  }),
  medium: makeModel(13, 12, 4, (x, y, z) => {
    const p = PRIORITY_PAL.medium, dx = Math.abs(x - 6), half = y * 0.55;
    if (z === 0 && y >= 2 && dx <= half - 1) return p.d;
    if (z === 1 && dx <= half) return y >= 10 ? p.d : dx >= half - 0.8 && y > 5 ? p.a : p.h;
    if (z === 2 && dx <= 1 && y >= 2 && y <= 10) return p.h;
    if (z === 3 && dx === 0 && y >= 4 && y <= 6) return y === 4 ? EYE : p.d;
    return null;
  }),
  high: makeModel(17, 15, 5, (x, y, z) => {
    const p = PRIORITY_PAL.high, dx = Math.abs(x - 8);
    if (z === 4 && dx === 0 && y >= 4 && y <= 7) return y === 4 ? EYE : GUN;
    if (z === 3 && dx <= 1 && y >= 6 && y <= 8) return p.d;
    if (z <= 1 && dx >= 5 && dx <= 7 && y >= 3 && y <= 13) return y === 3 ? p.a : z === 0 ? p.d : p.h;
    if (z === 2 && dx === 6 && y >= 4 && y <= 12) return p.h;
    if (z === 1 && y >= 7 && y <= 10 && dx <= 7) return y === 10 ? p.d : p.h;
    if (dx <= 2 && y >= 1 && y <= 13 && z <= 2) {
      if (y <= 2) return dx <= 1 ? p.a : null;
      return z === 0 ? p.d : p.h;
    }
    return null;
  }),
  urgent: makeModel(23, 20, 7, (x, y, z) => {
    const p = PRIORITY_PAL.urgent, ex = (x - 11) / 11, ey = (y - 10) / 9.5, rr = ex * ex + ey * ey;
    const sc = [1, 0.95, 0.85, 0.55, 0.38, 0.26, 0.15][z];
    if (rr <= sc * sc) {
      if (z <= 2) {
        if (z === 2 && Math.abs(x - 11) % 4 === 0 && y > 4) return p.a;
        return z === 0 ? p.d : p.h;
      }
      if (z === 3) return (x + y) % 3 === 0 ? p.d : p.h;
      if (z === 4) return p.d;
      return z === 6 ? EYE : p.a;
    }
    const ax = Math.abs(x - 11);
    if (z <= 1 && y <= 6 && ax >= 6 && ax <= 8) return z === 0 ? p.d : p.a;
    return null;
  }),
};

export const BOSS: Model = makeModel(41, 33, 9, (x, y, z) => {
  const ex = (x - 20) / 20, ey = (y - 16) / 16, rr = ex * ex + ey * ey;
  const sc = [1, 0.97, 0.9, 0.75, 0.6, 0.45, 0.32, 0.2, 0.1][z];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6, tx = 20 + Math.cos(a) * 15, ty = 16 + Math.sin(a) * 12;
    if ((z === 3 || z === 4) && (x - tx) ** 2 + (y - ty) ** 2 <= 2.3) return z === 4 ? GUN : "#4a5068";
  }
  if (rr > sc * sc) return null;
  if (z === 0) return "#3a2340";
  if (z <= 2) {
    const a = Math.atan2(y - 16, x - 20);
    return ((((a / Math.PI) * 8) | 0) + 16) % 2 ? "#8f3a7a" : "#c45aa8";
  }
  if (z <= 5) return rr < 0.2 ? "#9aa3bd" : "#e0e4f0";
  return z === 8 ? "#ffd2e0" : EYE;
});

export const NOTE: Model = makeModel(9, 11, 3, (x, y, z) => {
  if (x >= 7 && y <= 1) return z === 0 ? "#cbbd96" : null;
  if (z === 0) return "#bfae86";
  if (z === 1) return "#e9dfc3";
  return (y === 3 || y === 5 || y === 7) && x >= 1 && x <= 6 ? "#8a97b8" : "#fffaf0";
});

export const PLAYER_MODEL = PLAYER;
export const ENEMY_MODELS = ENEMIES;
export const BOSS_MODEL = BOSS;
export const PICKUP_MODEL = NOTE;
