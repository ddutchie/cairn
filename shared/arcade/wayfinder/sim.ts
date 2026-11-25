/**
 * Wayfinder simulation — pure TypeScript, platform-agnostic.
 *
 * Builds the 640x900 voxel-island sea chart from projects, notes (islands),
 * wikilinks (sea lanes), open due tasks (cargo at the Today lighthouse,
 * skipping "later" and sorting "today" ahead of "untimed"), and overdue tasks
 * (storms). Supports mobile touch steering + iPhone Duo insets and desktop
 * Arrows/WASD + M chart key + live resize.
 */

import type { Priority } from "../../types/domain";
import type { ArcadeProject } from "../pixel/arcade-data";
import { NO_HUD, hudFrame, type InputMode, type PixelHud } from "../pixel/hud";
import { clamp } from "../pixel/kinds";
import { BAYER, BIOMES, fbm, fbmSampler, hash2, mulberry32, rgb, type BiomeName } from "../pixel/terrain";
import {
  CHOICE_COOLDOWN,
  KO_FRAMES,
  KO_PENALTY,
  MAX_SUPPLIES,
  OFFER_COST,
  RELIC_INFO,
  RETREAT_PENALTY,
  TRADE_COST,
  WALK_FRAMES,
  applyRelic,
  dealDeck,
  exploreLayout,
  freshVoyage,
  goldFor,
  inRect,
  isFight,
  kindAt,
  landRect,
  unlucky,
  wreckRelic,
  type Choice,
  type Expedition,
  type IslandInfo,
  type Relic,
  type Voyage,
} from "./expedition";
import { PCOL } from "./models";

export const WD = 640;
export const HD = 900;
export const FW = WD >> 3;
export const FH = HD >> 3;
export const RELIEF = 12;
export const DAY_FRAMES = 60 * 150;
const MAX_CRATES = 12;
const MAX_STORMS = 5;

export const WEIGHT: Record<Priority, number> = { low: 0.04, medium: 0.07, high: 0.1, urgent: 0.14 };

export type WayfinderState = "title" | "sail" | "map" | "log" | "explore";
export type WayfinderEvent =
  | "start"
  | "chart"
  | "lost"
  | "load"
  | "deliver"
  | "late"
  | "aground"
  | "kraken"
  | "escape"
  | "catch"
  | "done"
  | "dock"
  | "step"
  | "attack"
  | "hurt"
  | "loot"
  | "escape-island";

export interface Proj extends ArcadeProject {
  cx: number;
  cy: number;
}
export interface Isle {
  i: number;
  title: string;
  p: Proj | null;
  links: number[];
  orphan: boolean;
  charted: boolean;
  /** Landed on and walked all four steps this voyage. */
  explored: boolean;
  /** Note length, for expedition treasure. */
  words: number;
  biome: BiomeName;
  lift: number;
  r: number;
  x: number;
  y: number;
  harbour?: boolean;
  today?: boolean;
}
export interface Crate {
  title: string;
  p: Proj;
  pr: Priority;
  due: number;
}
export interface Storm {
  title: string;
  p: Proj;
  a: number;
  rr: number;
  r: number;
  x: number;
  y: number;
  bolt: number;
}
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  life: number;
  c: string;
  wake?: boolean;
}
export interface Pop {
  head: string;
  title: string;
  c: string;
  t: number;
}
export interface School {
  x: number;
  y: number;
  a: number;
  n: number;
  flee: number;
}
export interface Whale {
  x: number;
  y: number;
  a: number;
  cyc: number;
}
export interface Turtle {
  x: number;
  y: number;
  a: number;
}

function pack(r: number, g: number, b: number): number {
  return ((255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
}
const u32 = (hex: string) => pack(...rgb(hex));
function darken(hex: string, f: number): number {
  const [r, g, b] = rgb(hex);
  return pack((r * f) | 0, (g * f) | 0, (b * f) | 0);
}

export const FOG_SHADES = ["#0d1530", "#141d40", "#1d2852"].map(u32);
export const FOG_TEX: Uint32Array = (() => {
  const out = new Uint32Array(64 * 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const n =
        (fbm(x / 16, y / 16, 8) * (64 - x) * (64 - y) +
          fbm((x - 64) / 16, y / 16, 8) * x * (64 - y) +
          fbm(x / 16, (y - 64) / 16, 8) * (64 - x) * y +
          fbm((x - 64) / 16, (y - 64) / 16, 8) * x * y) /
        4096;
      const q = n + (BAYER[(y & 3) * 4 + (x & 3)] - 0.5) * 0.08;
      out[y * 64 + x] = FOG_SHADES[q < 0.47 ? 0 : q < 0.56 ? 1 : 2];
    }
  }
  return out;
})();

// The open sea's darker swell patches. They don't depend on the workspace, so
// each pixel is worked out once per run (0 = not yet, 1 = calm, 2 = swell).
const SWELL = new Uint8Array(WD * HD);
const swellNoise = fbmSampler(4);
function swellAt(x: number, y: number): boolean {
  const o = y * WD + x;
  if (!SWELL[o]) SWELL[o] = swellNoise.above(x * 0.02, y * 0.02, 0.55) ? 2 : 1;
  return SWELL[o] === 2;
}
let swellRow = 0;
/**
 * Works out a few more rows of the swell, so the arcade menu can do it a
 * slice per frame and Wayfinder opens without that wait. Stops once done.
 */
export function warmWayfinderSea(rows = 6): void {
  for (const end = Math.min(HD, swellRow + rows); swellRow < end; swellRow++) {
    for (let x = 0; x < WD; x++) swellAt(x, swellRow);
  }
}

const clipTitle = (s: string) => (s.length > 22 ? `${s.slice(0, 21)}.` : s);

export function buildWorld(projects: ArcadeProject[]) {
  const projs: Proj[] = projects.slice(0, 6).map((p, i, all) => {
    const a = (i / Math.max(1, all.length)) * Math.PI * 2 - Math.PI / 2;
    return { ...p, cx: WD / 2 + Math.cos(a) * 165, cy: HD / 2 + Math.sin(a) * 230 };
  });
  const notes = projs.flatMap((p) => p.notes.map((n) => ({ n, p }))).slice(0, 36);
  const index = new Map(notes.map((x, i) => [x.n.id, i]));
  const linked = new Set<number>();
  const links = notes.map(({ n }, i) => {
    const out = n.links.map((id) => index.get(id)).filter((j): j is number => j !== undefined && j !== i);
    if (out.length) linked.add(i);
    out.forEach((j) => linked.add(j));
    return out;
  });

  const islands: Isle[] = notes.map(({ n, p }, i) => {
    const orphan = !linked.has(i);
    const a = hash2(i, 1, 3) * Math.PI * 2;
    const d = orphan ? 0 : 30 + hash2(i, 2, 3) * 30;
    return {
      i,
      title: n.title,
      p,
      links: links[i],
      orphan,
      charted: false,
      explored: false,
      words: n.words,
      biome: p.biome,
      lift: 0,
      r: Math.round(9 + Math.sqrt(Math.min(n.words, 2400)) * 0.42),
      x: orphan ? WD / 2 + Math.cos(a) * 280 : p.cx + Math.cos(a) * d,
      y: orphan ? HD / 2 + Math.sin(a) * 400 : p.cy + Math.sin(a) * d,
    };
  });
  const harbours: Isle[] = projs.map((p, k) => ({
    i: 100 + k,
    title: p.name,
    p,
    r: 15,
    x: p.cx,
    y: p.cy,
    harbour: true,
    biome: p.biome,
    links: [],
    charted: true,
    explored: true,
    words: 0,
    orphan: false,
    lift: 0,
  }));
  const today: Isle = {
    i: 200,
    title: "TODAY",
    p: null,
    r: 11,
    x: WD / 2,
    y: HD / 2,
    today: true,
    biome: "tundra",
    links: [],
    charted: true,
    explored: true,
    words: 0,
    orphan: false,
    lift: 0,
  };
  const all = [...islands, ...harbours, today];

  for (let it = 0; it < 260; it++) {
    for (const a of islands) {
      let fx = 0, fy = 0;
      for (const b of all) {
        if (a === b) continue;
        const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 1, min = a.r + b.r + 22;
        if (d < min) {
          fx += (dx / d) * (min - d) * 0.5;
          fy += (dy / d) * (min - d) * 0.5;
        }
      }
      for (const j of a.links) {
        const b = islands[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        fx += (dx / d) * (d - 70) * 0.02;
        fy += (dy / d) * (d - 70) * 0.02;
      }
      if (a.orphan || !a.p) {
        const dx = a.x - WD / 2, dy = a.y - HD / 2, d = Math.hypot(dx, dy) || 1;
        fx += (dx / d) * 0.6;
        fy += (dy / d) * 0.6;
      } else {
        fx += (a.p.cx - a.x) * 0.01;
        fy += (a.p.cy - a.y) * 0.01;
      }
      a.x = clamp(a.x + fx, a.r + 20, WD - a.r - 20);
      a.y = clamp(a.y + fy, a.r + 30, HD - a.r - 30);
    }
  }

  const lanes: [Isle, Isle, "link" | "trunk"][] = [];
  islands.forEach((a) => a.links.forEach((j) => lanes.push([a, islands[j], "link"])));
  harbours.forEach((h) => lanes.push([h, today, "trunk"]));

  const E = new Float32Array(WD * HD);
  const NEAR = new Float32Array(WD * HD);
  const OWN = new Uint8Array(WD * HD).fill(255);
  all.forEach((is, k) => {
    const R = is.r * 1.9;
    const x0 = Math.max(0, (is.x - R) | 0);
    const x1 = Math.min(WD - 1, (is.x + R) | 0);
    const y0 = Math.max(0, (is.y - R) | 0);
    const y1 = Math.min(HD - 1, (is.y + R) | 0);
    const wobble = fbmSampler(is.i * 13 + 5);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - is.x, dy = y - is.y, wob = 0.75 + wobble.at(x * 0.06, y * 0.06) * 0.6;
        const d = Math.hypot(dx, dy) / (is.r * wob), o = y * WD + x, e = 1 - d * d;
        if (e > E[o]) {
          E[o] = e;
          OWN[o] = k;
        }
        const n = 1 - (d / 1.7) ** 2;
        if (n > NEAR[o]) {
          NEAR[o] = n;
          if (OWN[o] === 255) OWN[o] = k;
        }
      }
    }
  });

  const LANE = new Uint8Array(WD * HD);
  for (const [a, b, kind] of lanes) {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, w = kind === "trunk" ? 4 : 3;
    for (let s = 0; s <= len; s++) {
      const cx = a.x + ((b.x - a.x) * s) / len, cy = a.y + ((b.y - a.y) * s) / len;
      for (let dy = -w; dy <= w; dy++) {
        for (let dx = -w; dx <= w; dx++) {
          if (dx * dx + dy * dy > w * w) continue;
          const x = (cx + dx) | 0, y = (cy + dy) | 0;
          if (x >= 0 && y >= 0 && x < WD && y < HD) LANE[y * WD + x] = s % 18 < 2 && dx === 0 && dy === 0 ? 2 : 1;
        }
      }
    }
  }

  const worldPixels = new Uint8Array(WD * HD * 4);
  const wbuf = new Uint32Array(worldPixels.buffer);
  const WATER = BIOMES.tropic.water.map(u32);
  const LANE_C = u32("#5fb6e8");
  const BUOY = u32("#fff2a0");
  const owner = (k: number) => all[k] ?? today;
  const landColour = (e: number, k: number, x: number, y: number) => {
    const bands = BIOMES[owner(k).biome].bands;
    const q = e + (BAYER[(y & 3) * 4 + (x & 3)] - 0.5) * 0.06;
    const b = q < 0.1 ? 0 : q < 0.34 ? 1 : q < 0.6 ? 2 : q < 0.82 ? 3 : 4;
    const o = y * WD + x, up = y > 0 && x > 0 ? E[o - WD - 1] : e, sl = e - up;
    const shade = sl > 0.012 ? 2 : sl < -0.012 ? 0 : 1;
    let c = bands[b][shade];
    if (b === 2 && hash2(x, y, 9) < 0.18) c = bands[b][0];
    return u32(c);
  };

  for (let y = 0; y < HD; y++) {
    for (let x = 0; x < WD; x++) {
      const o = y * WD + x, n = NEAR[o];
      let c = n > 0.75 ? WATER[3] : n > 0.35 ? WATER[2] : n > 0 ? WATER[1] : swellAt(x, y) ? WATER[1] : WATER[0];
      if (n > 0.55 && n < 0.62 && hash2(x, y, 3) < 0.5) c = WATER[4];
      if (LANE[o] && E[o] <= 0) c = LANE[o] === 2 ? BUOY : BAYER[(y & 3) * 4 + (x & 3)] < 0.6 ? LANE_C : WATER[3];
      wbuf[o] = c;
    }
  }

  for (let x = 0; x < WD; x++) {
    let yb = HD;
    for (let r = HD - 1; r >= 0; r--) {
      const o = r * WD + x, e = E[o];
      if (e <= 0) continue;
      const y = r - Math.round(e * RELIEF);
      if (y >= yb) continue;
      const top = Math.max(0, y);
      wbuf[top * WD + x] = landColour(e, OWN[o], x, r);
      const side = darken(BIOMES[owner(OWN[o]).biome].bands[Math.min(4, (e * 5) | 0)][0], 0.7);
      for (let yy = top + 1; yy < Math.min(yb, r + 1); yy++) wbuf[yy * WD + x] = side;
      yb = top;
    }
  }
  for (const is of all) is.lift = Math.round(Math.max(0, E[(is.y | 0) * WD + (is.x | 0)]) * RELIEF);

  const tasks = projs.flatMap((p) => p.tasks.map((t) => ({ t, p })));
  const crates: Crate[] = tasks
    .filter((x) => !x.t.overdue && x.t.dueScope !== "later")
    .sort((a, b) => {
      const aToday = a.t.dueScope === "untimed" ? 1 : 0;
      const bToday = b.t.dueScope === "untimed" ? 1 : 0;
      return aToday !== bToday ? aToday - bToday : a.t.dueMin - b.t.dueMin;
    })
    .slice(0, MAX_CRATES)
    .map(({ t, p }) => ({ title: t.title, p, pr: t.priority, due: t.dueMin }));
  const stormTasks = tasks.filter((x) => x.t.overdue).slice(0, MAX_STORMS);
  return { projs, islands, harbours, today, all, E, NEAR, LANE, worldPixels, crates, stormTasks };
}

type World = ReturnType<typeof buildWorld>;
let lastWorld: { key: string; world: World } | null = null;

/**
 * `buildWorld`, reusing the last one while the workspace is unchanged (reopening
 * the game, or folding and unfolding the iPhone Duo, which starts a new game).
 * Islands get fresh copies because a voyage marks them explored and charted.
 */
export function worldFor(projects: ArcadeProject[]): World {
  const key = JSON.stringify(projects);
  if (lastWorld?.key !== key) lastWorld = { key, world: buildWorld(projects) };
  const w = lastWorld.world;
  const islands = w.islands.map((is) => ({ ...is }));
  const harbours = w.harbours.map((h) => ({ ...h }));
  const today = { ...w.today };
  return { ...w, islands, harbours, today, all: [...islands, ...harbours, today] };
}

export interface WayfinderSpec {
  width: number;
  height: number;
  projects: ArcadeProject[];
  hud?: PixelHud;
  inputMode?: InputMode;
  best?: number;
  seed?: number;
}

export class WayfinderSim {
  W: number;
  H: number;
  hud: PixelHud;
  readonly inputMode: InputMode;
  readonly islands: Isle[];
  readonly harbours: Isle[];
  readonly today: Isle;
  readonly all: Isle[];
  readonly E: Float32Array;
  readonly NEAR: Float32Array;
  readonly LANE: Uint8Array;
  readonly worldPixels: Uint8Array;
  readonly allCrates: Crate[];
  readonly stormTasks: { t: ArcadeProject["tasks"][number]; p: Proj }[];
  readonly cargoTotal: number;
  readonly fog = new Float32Array(FW * FH);
  fogVersion = 0;
  /** Fog cells changed since the renderer last asked: [x0, y0, x1, y1] inclusive, or null. */
  private fogDirty: [number, number, number, number] | null = [0, 0, FW - 1, FH - 1];
  private readonly rand: () => number;

  state: WayfinderState = "title";
  t = 0;
  stateT = 0;
  clock = 0;
  camX = 0;
  camY = 0;
  boat = { x: WD / 2, y: HD / 2 + 22, a: 0, v: 0, cargo: [] as Crate[] };
  crates: Crate[] = [];
  storms: Storm[] = [];
  parts: Particle[] = [];
  pops: Pop[] = [];
  steer: { x: number; y: number } | null = null;
  score = 0;
  best: number;
  delivered = 0;
  late = 0;
  charted = 0;
  shake = 0;
  flash = 0;
  calm = false;
  events: WayfinderEvent[] = [];

  schools: School[] = [];
  whales: Whale[] = [];
  turtles: Turtle[] = [];
  pod = { on: 0, met: false };
  kraken = { phase: "none" as "none" | "stir" | "up" | "sink", x: 0, y: 0, t: 0, done: false, arms: [] as { a: number; r: number; h: number }[] };
  crew = { idle: 0, cast: 0, bite: 0, nextBite: 0, swim: "deck" as "deck" | "dive" | "swim", st: 0, sa: 0 };
  private keys: Record<string, boolean> = {};

  /** Captain hearts, supplies and banked relic buffs; reset each new day. */
  voyage: Voyage = freshVoyage();
  /** The task crate offered at this landing's camp (moved into the hold on banking). */
  private expCrate: Crate | null = null;
  /** The storm brewed by this landing's overdue task. */
  private expStorm: Storm | null = null;
  /** The unexplored note island the boat is anchored next to, if any. */
  nearIsland: Isle | null = null;
  /** The running island expedition while `state === "explore"`. */
  exp: Expedition | null = null;

  constructor(opts: WayfinderSpec) {
    this.W = opts.width;
    this.H = opts.height;
    this.hud = opts.hud ?? NO_HUD;
    this.inputMode = opts.inputMode ?? "touch";
    this.best = opts.best ?? 0;
    this.rand = mulberry32(opts.seed ?? 31);

    const w = worldFor(opts.projects);
    this.islands = w.islands;
    this.harbours = w.harbours;
    this.today = w.today;
    this.all = w.all;
    this.E = w.E;
    this.NEAR = w.NEAR;
    this.LANE = w.LANE;
    this.worldPixels = w.worldPixels;
    this.allCrates = w.crates;
    this.stormTasks = w.stormTasks;
    this.cargoTotal = w.crates.length;

    this.reset();
    this.updateCamera();
  }

  private rng(a: number, b: number): number {
    return a + this.rand() * (b - a);
  }
  timeAt(f: number): string {
    const m = 9 * 60 + Math.round((f / DAY_FRAMES) * 9 * 60);
    return `${String((m / 60) | 0).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
  dueFrame(c: Crate): number {
    return clamp((c.due / (9 * 60)) * DAY_FRAMES, DAY_FRAMES * 0.1, DAY_FRAMES * 0.96);
  }
  fogAt(x: number, y: number): number {
    return this.fog[clamp((y / 8) | 0, 0, FH - 1) * FW + clamp((x / 8) | 0, 0, FW - 1)];
  }
  reveal(x: number, y: number, r: number): void {
    const gx = x / 8, gy = y / 8, R = r / 8;
    const x0 = Math.max(0, (gx - R) | 0), x1 = Math.min(FW - 1, (gx + R) | 0);
    const y0 = Math.max(0, (gy - R) | 0), y1 = Math.min(FH - 1, (gy + R) | 0);
    let changed = false;
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const d = Math.hypot(i + 0.5 - gx, j + 0.5 - gy);
        if (d < R) {
          // fround: the grid is float32, so compare at its precision or every reveal counts as a change.
          const idx = j * FW + i, nv = Math.fround(clamp(1.3 - d / R, 0, 1));
          if (nv > this.fog[idx]) {
            this.fog[idx] = nv;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      this.fogVersion++;
      this.markFog(x0, y0, x1, y1);
    }
  }
  private markFog(x0: number, y0: number, x1: number, y1: number): void {
    const d = this.fogDirty;
    this.fogDirty = d ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)] : [x0, y0, x1, y1];
  }
  /** The fog cells changed since the last call, then forgets them (the sea renderer redraws only those). */
  takeFogDirty(): [number, number, number, number] | null {
    const d = this.fogDirty;
    this.fogDirty = null;
    return d;
  }
  private addScore(n: number): void {
    this.score += n;
    if (this.score > this.best) this.best = this.score;
  }
  private pop(head: string, title: string, c: string): void {
    this.pops.push({ head, title, c, t: 0 });
    if (this.pops.length > 2) this.pops.shift();
  }

  resize(width: number, height: number): void {
    if (this.W === width && this.H === height) return;
    this.W = width;
    this.H = height;
    this.updateCamera();
  }

  private updateCamera(): void {
    const lx = this.boat.x + Math.sin(this.boat.a) * this.boat.v * 22;
    const ly = this.boat.y - Math.cos(this.boat.a) * this.boat.v * 30;
    this.camX = this.W >= WD ? Math.round((WD - this.W) / 2) : clamp(Math.round(lx - this.W / 2), 0, WD - this.W);
    this.camY = clamp(Math.round(ly - this.H * 0.55), 0, HD - this.H);
  }

  reset(): void {
    this.clock = 0;
    this.score = 0;
    this.delivered = 0;
    this.late = 0;
    this.charted = 0;
    this.boat = { x: WD / 2, y: HD / 2 + 22, a: 0, v: 0, cargo: [] };
    this.crates = this.allCrates.map((c) => ({ ...c }));
    this.storms = this.stormTasks.map(({ t: st, p }, i) => {
      const a = (i * 1.9 + 0.4) % (Math.PI * 2), rr = 42 + (i % 2) * 16;
      return { title: st.title, p, a, rr, r: 22, x: p.cx + Math.cos(a) * rr, y: p.cy + Math.sin(a) * rr * 0.8, bolt: 0 };
    });
    this.parts = [];
    this.pops = [];
    this.fog.fill(0);
    this.fogVersion++;
    this.markFog(0, 0, FW - 1, FH - 1);
    for (const is of this.islands) is.charted = is.explored = false;
    this.voyage = freshVoyage();
    this.exp = null;
    this.nearIsland = null;
    this.reveal(this.today.x, this.today.y, 76);
    for (const h of this.harbours) this.reveal(h.x, h.y, 58);

    const openWater = (pad: number): [number, number] => {
      for (let k = 0; k < 40; k++) {
        const x = this.rng(pad, WD - pad), y = this.rng(pad, HD - pad);
        if (this.NEAR[(y | 0) * WD + (x | 0)] <= 0.1) return [x, y];
      }
      return [WD * 0.2, HD * 0.25];
    };
    this.schools = Array.from({ length: 8 }, () => {
      const [x, y] = openWater(40);
      return { x, y, a: this.rng(0, Math.PI * 2), n: 9 + ((this.rand() * 5) | 0), flee: 0 };
    });
    this.whales = Array.from({ length: 2 }, () => {
      const [x, y] = openWater(90);
      return { x, y, a: this.rng(0, Math.PI * 2), cyc: (this.rand() * 900) | 0 };
    });
    this.turtles = Array.from({ length: 4 }, (_, i) => {
      const h = this.harbours[i % Math.max(1, this.harbours.length)];
      const a = this.rng(0, Math.PI * 2), d = (h?.r ?? 15) + 18 + this.rng(0, 12);
      return { x: clamp((h?.x ?? WD / 2) + Math.cos(a) * d, 20, WD - 20), y: clamp((h?.y ?? HD / 2) + Math.sin(a) * d, 20, HD - 20), a: a + Math.PI / 2 };
    });
    this.pod = { on: 0, met: false };
    this.kraken = { phase: "none", x: 0, y: 0, t: 0, done: false, arms: [] };
    this.crew = { idle: 0, cast: 0, bite: 0, nextBite: 0, swim: "deck", st: 0, sa: 0 };
  }

  private mapButtonRect(): { x0: number; y0: number; x1: number; y1: number } {
    const { lx, y: ty } = hudFrame(this.hud, this.W, this.H).top;
    return { x0: lx - 2, y0: ty + 6, x1: lx + 64, y1: ty + 22 };
  }

  down(x: number, y: number): void {
    if (this.state === "title" || (this.state === "log" && this.stateT > 60)) {
      this.state = "sail";
      this.stateT = 0;
      this.reset();
      this.events.push("start");
      return;
    }
    if (this.state === "map") {
      this.state = "sail";
      return;
    }
    if (this.state === "explore") {
      this.exploreDown(x, y);
      return;
    }
    if (this.state === "sail") {
      if (this.nearIsland && inRect(landRect(this.W, this.H, this.hud, this.boat.cargo.length), x, y)) {
        this.land(this.nearIsland);
        return;
      }
      const mb = this.mapButtonRect();
      if (x >= mb.x0 && x <= mb.x1 && y >= mb.y0 && y <= mb.y1) {
        this.state = "map";
        this.steer = null;
        return;
      }
      this.steer = { x, y };
    }
  }

  move(x: number, y: number): void {
    if (this.steer) this.steer = { x, y };
  }

  up(): void {
    this.steer = null;
  }

  setKey(code: string, down: boolean): boolean {
    if (this.state === "explore") {
      if (!down) {
        if (code in this.keys) this.keys[code] = false;
        return false;
      }
      return this.exploreKey(code);
    }
    if (down && this.state === "sail" && this.nearIsland && (code === "KeyE" || code === "Space" || code === "Enter")) {
      this.land(this.nearIsland);
      return true;
    }
    if (down && code === "Escape" && this.state === "map") {
      this.state = "sail";
      return true;
    }
    if (code === "ArrowLeft" || code === "KeyA" || code === "ArrowRight" || code === "KeyD" || code === "ArrowUp" || code === "KeyW") {
      this.keys[code] = down;
      return true;
    }
    if (!down) return false;
    if (code === "KeyM") {
      if (this.state === "sail") {
        this.state = "map";
        this.steer = null;
        return true;
      }
      if (this.state === "map") {
        this.state = "sail";
        return true;
      }
    }
    if ((code === "Space" || code === "Enter") && (this.state === "title" || (this.state === "log" && this.stateT > 60))) {
      this.state = "sail";
      this.stateT = 0;
      this.reset();
      this.events.push("start");
      return true;
    }
    return false;
  }

  private stepCreatures(): void {
    for (const s of this.schools) {
      if (Math.hypot(s.x - this.boat.x, s.y - this.boat.y) < 36 && this.boat.v > 0.3) s.flee = 70;
      if (s.flee > 0) s.flee--;
      const sp = s.flee > 0 ? 0.45 : 0.14;
      s.a += s.flee > 0 ? clamp(Math.atan2(s.x - this.boat.x, -(s.y - this.boat.y)) - s.a, -0.1, 0.1) : (this.rand() - 0.5) * 0.06;
      const nx = s.x + Math.sin(s.a) * sp, ny = s.y - Math.cos(s.a) * sp;
      if (nx < 20 || ny < 20 || nx > WD - 20 || ny > HD - 20 || this.E[(ny | 0) * WD + (nx | 0)] > 0) s.a += Math.PI * 0.7;
      else {
        s.x = nx;
        s.y = ny;
      }
    }
    for (const w of this.whales) {
      w.cyc = (w.cyc + 1) % 950;
      w.a += 0.002;
      const nx = w.x + Math.sin(w.a) * 0.22, ny = w.y - Math.cos(w.a) * 0.22;
      if (nx < 50 || ny < 50 || nx > WD - 50 || ny > HD - 50 || this.NEAR[(ny | 0) * WD + (nx | 0)] > 0.2) w.a += 0.05;
      else {
        w.x = nx;
        w.y = ny;
      }
    }
    for (const tt of this.turtles) {
      tt.a += (this.rand() - 0.5) * 0.04;
      const nx = tt.x + Math.sin(tt.a) * 0.12, ny = tt.y - Math.cos(tt.a) * 0.12;
      if (nx < 16 || ny < 16 || nx > WD - 16 || ny > HD - 16 || this.E[(ny | 0) * WD + (nx | 0)] > 0.05) tt.a += Math.PI * 0.5;
      else {
        tt.x = nx;
        tt.y = ny;
      }
    }
    const o = (this.boat.y | 0) * WD + (this.boat.x | 0);
    const fast = this.LANE[o] > 0 && this.boat.v > 0.9;
    this.pod.on = clamp(this.pod.on + (fast ? 0.015 : -0.02), 0, 1);
    if (this.pod.on > 0.5 && !this.pod.met) {
      this.pod.met = true;
      this.pop("DOLPHINS AT THE BOW", "+1 KNOT IN THE LANES", "#c7e4ff");
    }
    if (this.pod.on === 0) this.pod.met = false;
  }

  private stepKraken(): void {
    const k = this.kraken;
    if (k.phase === "none") {
      const deep = this.NEAR[(this.boat.y | 0) * WD + (this.boat.x | 0)] <= 0 && fbm(this.boat.x * 0.02, this.boat.y * 0.02, 4) > 0.5;
      if (!k.done && this.state === "sail" && this.clock > DAY_FRAMES * 0.22 && deep && this.boat.v > 0.4 && this.rand() < 0.004) {
        Object.assign(k, { phase: "stir", x: this.boat.x + Math.sin(this.boat.a) * 10, y: this.boat.y - Math.cos(this.boat.a) * 10, t: 0, done: true });
        k.arms = Array.from({ length: 6 }, (_, i) => ({ a: (i / 6) * Math.PI * 2 + 0.3, r: 32, h: 0 }));
        this.pop("SOMETHING STIRS", "BELOW THE HULL", "#e8b8e0");
        if (!this.calm) this.shake = 1.5;
      }
      return;
    }
    k.t++;
    if (k.phase === "stir" && k.t > 110) {
      k.phase = "up";
      k.t = 0;
      if (!this.calm) this.shake = 3;
      this.pop("THE KRAKEN", "SAIL CLEAR OF THE ARMS", "#ff5e8a");
      this.events.push("kraken");
    }
    if (k.phase === "up") {
      for (const a of k.arms) {
        a.h = Math.min(1, a.h + 0.03);
        a.r = Math.max(16, 32 - k.t * 0.03);
      }
      for (const a of k.arms) {
        const ax = k.x + Math.cos(a.a) * a.r, ay = k.y + Math.sin(a.a) * a.r;
        if (Math.hypot(ax - this.boat.x, ay - this.boat.y) < 6 && a.h > 0.8) {
          const c = [...this.boat.cargo].sort((p, q) => WEIGHT[q.pr] - WEIGHT[p.pr])[0];
          if (c && this.voyage.kraken > 0) {
            this.voyage.kraken--;
            this.pop("KRAKEN TOOTH", "THE KRAKEN LET GO", "#fff2a0");
          } else if (c) {
            this.boat.cargo = this.boat.cargo.filter((x) => x !== c);
            this.crates.unshift(c);
            this.pop("THE KRAKEN TOOK", c.title, "#ff5e8a");
          } else {
            this.pop("THE KRAKEN", "FOUND YOUR HOLD EMPTY", "#e8b8e0");
          }
          this.boat.v = -0.8;
          if (!this.calm) this.shake = 4;
          k.phase = "sink";
          k.t = 0;
          this.events.push("kraken");
          for (let i = 0; i < 20; i++) {
            this.parts.push({ x: ax, y: ay, vx: this.rng(-1, 1), vy: this.rng(-1.5, -0.3), g: 0.06, life: 24, c: i % 2 ? "#e6f6ff" : "#a8509a" });
          }
          return;
        }
      }
      const far = Math.hypot(this.boat.x - k.x, this.boat.y - k.y) > 60;
      if (far || k.t > 480) {
        if (far) {
          this.addScore(50);
          this.pop("ESCAPED THE KRAKEN", "+50", "#8dff9a");
          this.events.push("escape");
        }
        k.phase = "sink";
        k.t = 0;
      }
    }
    if (k.phase === "sink") {
      for (const a of k.arms) a.h = Math.max(0, a.h - 0.03);
      if (k.t > 60) k.phase = "none";
    }
  }

  deckPoint(lx: number, lf: number): { x: number; y: number } {
    const rx = Math.cos(this.boat.a), ry = Math.sin(this.boat.a), fx = Math.sin(this.boat.a), fy = -Math.cos(this.boat.a);
    return { x: this.boat.x + rx * lx + fx * lf, y: this.boat.y + ry * lx + fy * lf };
  }
  swimmerPos(): { x: number; y: number } {
    const a = this.boat.a + this.crew.sa;
    return { x: this.boat.x + Math.cos(a) * 13, y: this.boat.y + Math.sin(a) * 13 };
  }
  lineEnd(): { x: number; y: number } {
    return this.deckPoint(-16 - this.crew.cast * 4, -5);
  }

  private stepCrew(): void {
    const keyThrottle = this.keys.ArrowUp || this.keys.KeyW;
    const activeState = this.state === "sail" || this.state === "title";
    const idle = activeState && !this.steer && !keyThrottle && Math.abs(this.boat.v) < 0.08 && this.kraken.phase === "none";
    if (!idle) {
      if (this.crew.swim === "swim") {
        const sp = this.swimmerPos();
        for (let i = 0; i < 6; i++) this.parts.push({ x: sp.x, y: sp.y, vx: this.rng(-0.6, 0.6), vy: this.rng(-1, -0.2), g: 0.06, life: 14, c: "#e6f6ff" });
      }
      Object.assign(this.crew, { idle: 0, cast: 0, bite: 0, swim: "deck" });
      return;
    }
    this.crew.idle++;
    if (this.crew.idle > 80) {
      if (this.crew.cast < 1) {
        this.crew.cast = Math.min(1, this.crew.cast + 0.035);
        if (this.crew.cast >= 1) this.crew.nextBite = 200 + this.rand() * 300;
      } else if (this.crew.bite > 0) {
        if (--this.crew.bite === 0) this.catchSomething();
      } else if (--this.crew.nextBite <= 0) this.crew.bite = 40;
    }
    if (this.crew.idle > 200 && this.crew.swim === "deck") {
      this.crew.swim = "dive";
      this.crew.st = 0;
      this.crew.sa = 0;
    }
    if (this.crew.swim === "dive" && ++this.crew.st > 24) {
      this.crew.swim = "swim";
      this.crew.st = 0;
      const p = this.swimmerPos();
      for (let i = 0; i < 10; i++) this.parts.push({ x: p.x, y: p.y, vx: this.rng(-0.8, 0.8), vy: this.rng(-1.4, -0.4), g: 0.07, life: 18, c: "#e6f6ff" });
    }
    if (this.crew.swim === "swim") {
      this.crew.st++;
      this.crew.sa += 0.012;
    }
  }

  // ── Island expeditions ────────────────────────────────────────────────────

  get holdSize(): number {
    return 3 + this.voyage.cargo;
  }

  /** The nearest unexplored note island the boat is idling beside (slow, no kraken). */
  findLanding(): Isle | null {
    if (this.state !== "sail" || this.kraken.phase !== "none" || Math.abs(this.boat.v) > 0.95) return null;
    let best: Isle | null = null, bestD = Infinity;
    for (const is of this.islands) {
      if (is.explored) continue;
      const d = Math.hypot(is.x - this.boat.x, is.y - this.boat.y);
      if (d < is.r * 1.4 + 12 && d < bestD) {
        best = is;
        bestD = d;
      }
    }
    return best;
  }

  /** What this island and its project bring to a landing: links, an overdue task, a waiting crate. */
  islandInfo(is: Isle): IslandInfo {
    const storm = is.p ? (this.storms.find((st) => st.p === is.p) ?? null) : null;
    const crate = is.p && !is.orphan ? (this.crates.find((c) => c.p === is.p) ?? null) : null;
    return {
      isleIndex: is.i,
      title: clipTitle(is.title),
      biome: is.biome,
      orphan: is.orphan,
      words: is.words,
      links: is.links.map((j) => ({ isle: j, title: this.islands[j].title })),
      project: is.p ? { name: is.p.name, accent: is.p.accent } : null,
      overdue: storm ? storm.title : null,
      crate: crate ? { title: crate.title, pr: crate.pr } : null,
      luck: this.voyage.luck,
    };
  }

  /** Anchor beside `is` and walk inland through its deck of encounters. The sea clock stops while ashore. */
  land(is: Isle): void {
    if (this.state !== "sail" || is.explored) return;
    this.boat.v = 0;
    this.boat.a = Math.atan2(is.x - this.boat.x, -(is.y - this.boat.y));
    this.steer = null;
    this.keys = {};
    this.state = "explore";
    this.stateT = 0;
    this.nearIsland = null;
    const info = this.islandInfo(is), { deck, mood, routes } = dealDeck(info);
    this.expCrate = info.crate ? (this.crates.find((c) => c.p === is.p) ?? null) : null;
    this.expStorm = info.overdue ? (this.storms.find((st) => st.p === is.p) ?? null) : null;
    this.exp = {
      isleIndex: is.i,
      title: info.title,
      biome: is.biome,
      orphan: is.orphan,
      mood,
      words: is.words,
      rich: 1 + clamp(is.words / 1500, 0, 1),
      luck: info.luck,
      deck,
      step: 0,
      phase: "step",
      links: info.links,
      routes,
      charts: [],
      project: info.project,
      overdue: info.overdue,
      crate: info.crate,
      crateTaken: false,
      calmed: false,
      foe: 0,
      foeHp: 0,
      foeMax: 0,
      foeTurn: true,
      scouted: false,
      gold: 0,
      bonus: 0,
      relics: [],
      sel: 0,
      t: 0,
      walk: WALK_FRAMES,
      trail: 0,
      swing: 0,
      hit: 0,
      hurt: 0,
      cool: CHOICE_COOLDOWN,
      toast: { s: mood === "lost" ? "A LOST ISLAND..." : "ASHORE!", c: mood === "lost" ? "#c7e4ff" : "#8dff9a", t: 60 },
    };
    this.events.push("dock");
  }

  private say(s: string, c: string): void {
    if (this.exp) this.exp.toast = { s, c, t: 75 };
  }

  private nextStep(): void {
    const e = this.exp!;
    e.step++;
    e.walk = WALK_FRAMES;
    e.sel = 0;
    const kind = kindAt(e);
    if (isFight(kind)) {
      e.foe = e.mood === "lost" ? -1 : Math.floor(hash2(e.isleIndex, e.step, 23) * 2);
      const base = kind === "den" ? 5 : kind === "overdue" ? 4 : 3 + (e.rich >= 1.6 ? 1 : 0);
      e.foeMax = Math.max(1, base - (e.scouted ? 1 : 0));
      e.foeHp = e.foeMax;
      e.foeTurn = true;
    }
    this.events.push("step");
  }

  private gain(e: Expedition, g: number, msg: string): void {
    e.gold += g;
    this.say(msg, "#fff2a0");
    this.events.push("loot");
  }

  private heal(): void {
    const v = this.voyage;
    v.hp = Math.min(v.maxHp, v.hp + 1);
    v.supplies = Math.min(MAX_SUPPLIES, v.supplies + 1);
  }

  /** Spend a supply, or a heart when there are none. Returns false if that knocked the captain out. */
  private pay(why: string): boolean {
    const v = this.voyage;
    if (v.supplies > 0) {
      v.supplies--;
      this.say(`${why} -1 SUPPLY`, "#c7e4ff");
      return true;
    }
    this.hurtCaptain(`${why} -1 HEART`);
    return this.exp!.phase === "step";
  }

  private refuse(e: Expedition, msg: string): false {
    this.say(msg, "#ff5e8a");
    e.cool = 0;
    return false;
  }

  private hurtCaptain(why: string): void {
    const e = this.exp!;
    this.voyage.hp = Math.max(0, this.voyage.hp - 1);
    e.hurt = 14;
    if (!this.calm) this.shake = 3;
    this.events.push("hurt");
    if (this.voyage.hp <= 0) {
      e.phase = "ko";
      e.t = 0;
      e.toast = null;
    } else this.say(why, "#ff5e8a");
  }

  /** Pick option A or B on the current step. Ignored while the last choice is still settling. */
  choose(which: Choice): boolean {
    const e = this.exp;
    if (this.state !== "explore" || !e || e.phase !== "step" || e.cool > 0) return false;
    e.cool = CHOICE_COOLDOWN;
    e.sel = which === "a" ? 0 : 1;
    const v = this.voyage, A = which === "a", kind = kindAt(e);
    const onward = () => {
      if (e.phase === "step") this.nextStep();
      return true;
    };
    switch (kind) {
      case "shore":
        if (A) {
          e.scouted = true;
          this.say("SCOUTED THE TRAIL", "#c7e4ff");
        } else this.gain(e, goldFor(e, 8), `+${goldFor(e, 8)} GOLD`);
        return onward();
      case "fork": {
        const r = e.routes![A ? 0 : 1];
        e.deck.splice(e.step + 1, 0, r.kind);
        if (r.isle >= 0 && !e.charts.includes(r.isle)) e.charts.push(r.isle);
        this.say(r.isle >= 0 ? `TOWARD ${r.title}`.slice(0, 24) : "INTO THE WILD", "#c7e4ff");
        return onward();
      }
      case "ambush":
      case "den":
      case "overdue":
        if (A) {
          e.swing = 14;
          e.hit = 8;
          e.foeHp--;
          if (!this.calm) this.shake = 2;
          this.events.push("attack");
          if (e.foeHp <= 0) {
            const g = goldFor(e, kind === "den" ? 18 : kind === "overdue" ? 12 : e.foe < 0 ? 14 : 10);
            e.gold += g;
            if (kind === "den" && !e.relics.includes("IRON HEART")) e.relics.push("IRON HEART");
            if (kind === "overdue") {
              e.calmed = true;
              if (!e.relics.includes("STORM GLASS")) e.relics.push("STORM GLASS");
            }
            this.say(kind === "den" ? `IRON HEART! +${g}G` : kind === "overdue" ? "THE STORM EASES" : `DEFEATED! +${g}G`, "#8dff9a");
            this.events.push("loot");
            this.nextStep();
            return true;
          }
          if (e.foeTurn) this.hurtCaptain("IT HIT BACK -1 HEART");
          else this.say("HIT!", "#ff9a6b");
          e.foeTurn = !e.foeTurn;
          return true;
        }
        if (v.supplies > 0) {
          v.supplies--;
          this.say(kind === "den" ? "SLIPPED PAST" : "BAITED IT AWAY", "#c7e4ff");
          return onward();
        }
        this.hurtCaptain("SCRATCHED -1 HEART");
        return onward();
      case "cache":
        if (A) {
          e.relics.push(e.orphan ? "DEEP RELIC" : "KNOT CHARM");
          e.gold += goldFor(e, 12);
          this.say(e.orphan ? "A DEEP RELIC!" : `KNOT CHARM +${goldFor(e, 12)}G`, "#fff2a0");
          this.events.push("loot");
        } else {
          this.heal();
          this.say("+1 HEART +1 SUPPLY", "#8dff9a");
        }
        return onward();
      case "camp":
        if (A && e.crate && !e.crateTaken) {
          e.crateTaken = true;
          this.say(this.boat.cargo.length < this.holdSize ? "CRATE LOADED ON THE BOAT" : "CRATE RESERVED AT CAMP", this.boat.cargo.length < this.holdSize ? "#8dff9a" : "#fff2a0");
          this.events.push("loot");
        } else if (A) this.gain(e, goldFor(e, 6), `FORAGED +${goldFor(e, 6)}G`);
        else {
          this.heal();
          this.say("RESTED +1 HEART +1 SUP", "#8dff9a");
        }
        return onward();
      case "bridge":
        if (A) {
          if (unlucky(e, 1, 0.4)) this.hurtCaptain("A PLANK SNAPPED -1 HEART");
          else this.gain(e, goldFor(e, 14), `ACROSS! +${goldFor(e, 14)}G`);
        } else if (!this.pay("CLIMBED DOWN")) return true;
        return onward();
      case "ford":
        if (A) {
          if (unlucky(e, 2, 0.35)) this.hurtCaptain("SLIPPED ON A ROCK -1 HEART");
          else {
            v.supplies = Math.min(MAX_SUPPLIES, v.supplies + 1);
            this.say("CAUGHT A FISH +1 SUPPLY", "#8dff9a");
          }
        } else this.say("WADED ACROSS", "#c7e4ff");
        return onward();
      case "hermit":
        if (A) {
          if (e.gold < TRADE_COST) return this.refuse(e, `NEED ${TRADE_COST} GOLD`);
          e.gold -= TRADE_COST;
          e.relics.push("LUCKY COIN");
          this.say("A LUCKY COIN", "#fff2a0");
          this.events.push("loot");
        } else if (e.links.length) {
          for (const l of e.links.slice(0, 3)) if (!e.charts.includes(l.isle)) e.charts.push(l.isle);
          this.say("HE MARKS YOUR CHART", "#4cc9f0");
        } else {
          e.scouted = true;
          this.say("HE WARNS OF WHAT'S AHEAD", "#c7e4ff");
        }
        return onward();
      case "wreck":
        if (A) {
          if (v.supplies <= 0) return this.refuse(e, "NEED A SUPPLY");
          v.supplies--;
          const r = wreckRelic(e);
          e.relics.push(r);
          this.say(r, "#fff2a0");
          this.events.push("loot");
        } else {
          v.supplies = Math.min(MAX_SUPPLIES, v.supplies + 1);
          this.gain(e, goldFor(e, 6), `+1 SUP +${goldFor(e, 6)}G`);
        }
        return onward();
      case "trap":
        if (A) {
          if (e.scouted) this.say("STEPPED AROUND IT", "#c7e4ff");
          else if (!this.pay("DETOUR")) return true;
        } else {
          e.gold += goldFor(e, 10);
          if (e.scouted) this.say(`+${goldFor(e, 10)}G STASH`, "#fff2a0");
          else this.hurtCaptain(`SNARED! +${goldFor(e, 10)}G -1 HEART`);
          this.events.push("loot");
        }
        return onward();
      case "shrine":
        if (A) {
          e.relics.push("SPYGLASS");
          this.say("THE CHART GLOWS", "#4cc9f0");
        } else {
          if (e.gold < OFFER_COST) return this.refuse(e, `NEED ${OFFER_COST} GOLD`);
          e.gold -= OFFER_COST;
          e.bonus += e.orphan ? 50 : 25;
          e.relics.push("BLESSED HOLD");
          this.say("BLESSED BY THE CAIRN", "#fff2a0");
        }
        e.phase = "summary";
        e.t = 0;
        this.events.push("loot");
        return true;
    }
  }

  /** Back to the ship: banks everything after the shrine, otherwise loses unbanked treasure and a little time. */
  retreat(): void {
    const e = this.exp;
    if (this.state !== "explore" || !e) return;
    if (e.phase === "summary") return this.bank();
    if (e.phase === "ko") return;
    this.clock = Math.min(DAY_FRAMES, this.clock + RETREAT_PENALTY);
    this.leaveIsland("BACK ABOARD", "TREASURE LEFT BEHIND", "#c7e4ff");
  }

  /** Clear the island: bank treasure, apply relic buffs, chart it, and sail on. */
  bank(): void {
    const e = this.exp;
    if (this.state !== "explore" || !e || e.phase !== "summary") return;
    const is = this.islands[e.isleIndex];
    this.addScore(e.gold + e.bonus + (e.orphan ? 60 : 30));
    for (const r of e.relics) applyRelic(this.voyage, r);
    is.explored = true;
    if (!is.charted) {
      is.charted = true;
      this.charted++;
    }
    if (e.relics.includes("SPYGLASS")) {
      for (const o of this.islands) if (o.orphan && Math.hypot(o.x - is.x, o.y - is.y) < 220) this.reveal(o.x, o.y, 30);
    }
    // Trails taken toward linked notes chart those islands.
    for (const j of e.charts) {
      const o = this.islands[j];
      if (!o) continue;
      this.reveal(o.x, o.y, 30);
      if (!o.charted) {
        o.charted = true;
        this.charted++;
      }
    }
    // The camp's crate goes in the hold (if there's room) for its project's harbour.
    if (e.crateTaken && this.expCrate) {
      const i = this.crates.indexOf(this.expCrate);
      if (i >= 0 && this.boat.cargo.length < this.holdSize) {
        this.crates.splice(i, 1);
        this.boat.cargo.push(this.expCrate);
        this.pop("LOADED", this.expCrate.title, PCOL[this.expCrate.pr]);
        this.events.push("load");
      } else if (i >= 0) this.pop("HOLD FULL", "THE CRATE WAITS AT TODAY", "#ff9a6b");
    }
    // Beating the overdue task's foe shrinks its storm.
    if (e.calmed && this.expStorm) this.expStorm.r = Math.max(10, Math.round(this.expStorm.r * 0.6));
    this.leaveIsland("ISLAND EXPLORED", `${is.title} +${e.gold + e.bonus}`, "#8dff9a");
    const fresh = e.relics.filter((r, i, all) => all.indexOf(r) === i);
    if (fresh.length) this.pop(`RELIC: ${fresh[0]}`, RELIC_INFO[fresh[0] as Relic], "#fff2a0");
    this.events.push("loot");
  }

  private leaveIsland(head: string, title: string, c: string): void {
    this.exp = null;
    this.expCrate = this.expStorm = null;
    this.state = "sail";
    this.stateT = 241;
    this.boat.v = 0;
    this.steer = null;
    this.keys = {};
    this.pop(head, title, c);
    this.events.push("escape-island");
  }

  private stepExplore(): void {
    const e = this.exp;
    if (!e) return;
    e.t++;
    if (e.walk > 0) {
      e.walk--;
      e.trail += 1;
    }
    if (e.swing > 0) e.swing--;
    if (e.hit > 0) e.hit--;
    if (e.hurt > 0) e.hurt--;
    if (e.cool > 0) e.cool--;
    if (e.toast && --e.toast.t <= 0) e.toast = null;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - 0.25);
    if (e.phase === "ko" && e.t >= KO_FRAMES) this.knockedOut();
  }

  private knockedOut(): void {
    this.voyage.hp = 1;
    this.expCrate = this.expStorm = null;
    this.clock = Math.min(DAY_FRAMES, this.clock + KO_PENALTY);
    this.leaveIsland("WASHED BACK ABOARD", "TREASURE LOST - 1 HEART", "#ff9a6b");
  }

  private exploreDown(x: number, y: number): void {
    const e = this.exp;
    if (!e) return;
    const L = exploreLayout(this.W, this.H, this.hud);
    if (e.phase === "ko") {
      if (e.t > 40) this.knockedOut();
      return;
    }
    if (e.phase === "summary") {
      this.bank();
      return;
    }
    if (inRect(L.sail, x, y)) this.retreat();
    else if (inRect(L.a, x, y)) this.choose("a");
    else if (inRect(L.b, x, y)) this.choose("b");
  }

  private exploreKey(code: string): boolean {
    const e = this.exp;
    if (!e) return false;
    if (e.phase === "ko") {
      if (e.t > 40 && (code === "Space" || code === "Enter" || code === "Escape")) this.knockedOut();
      return code === "Space" || code === "Enter" || code === "Escape";
    }
    if (e.phase === "summary") {
      if (code === "Escape" || code === "Enter" || code === "Space" || code === "KeyE" || code === "Digit1" || code === "Numpad1") {
        this.bank();
        return true;
      }
      return false;
    }
    switch (code) {
      case "Escape":
        this.retreat();
        return true;
      case "Digit1":
      case "Numpad1":
        this.choose("a");
        return true;
      case "Digit2":
      case "Numpad2":
        this.choose("b");
        return true;
      case "ArrowLeft":
      case "KeyA":
        e.sel = 0;
        return true;
      case "ArrowRight":
      case "KeyD":
        e.sel = 1;
        return true;
      case "Enter":
      case "Space":
      case "KeyE":
        this.choose(e.sel === 0 ? "a" : "b");
        return true;
    }
    return false;
  }

  private catchSomething(): void {
    const CATCHES = ["A MACKEREL", "A SARDINE", "AN OLD BOOT", "A COD", "A TANGLE OF KELP"];
    const lost = this.islands.filter((i) => i.orphan && !i.charted), end = this.lineEnd();
    for (let i = 0; i < 8; i++) this.parts.push({ x: end.x, y: end.y, vx: this.rng(-0.6, 0.6), vy: this.rng(-1.4, -0.4), g: 0.07, life: 16, c: "#e6f6ff" });
    if (this.state === "sail") {
      if (lost.length && this.rand() < 0.3) {
        const n = lost[(this.rand() * lost.length) | 0];
        this.reveal(n.x, n.y, 40);
        this.pop("A MESSAGE IN A BOTTLE", `IT LEADS TO ${n.title}`, "#fff2a0");
      } else {
        const c = CATCHES[(this.rand() * CATCHES.length) | 0];
        if (c !== "AN OLD BOOT") this.addScore(5);
        this.pop("THE CREW CAUGHT", c, "#c7e4ff");
      }
      this.events.push("catch");
    }
    this.crew.cast = 0;
    this.crew.idle = 81;
  }

  private wake(lane: boolean): void {
    const bx = this.boat.x - Math.sin(this.boat.a) * 7, by = this.boat.y + Math.cos(this.boat.a) * 7;
    if (this.t % 2 === 0) {
      for (const s of [-1, 1]) {
        this.parts.push({
          x: bx + Math.cos(this.boat.a) * 2 * s,
          y: by + Math.sin(this.boat.a) * 2 * s,
          vx: Math.cos(this.boat.a) * 0.15 * s,
          vy: Math.sin(this.boat.a) * 0.15 * s,
          g: 0,
          life: lane ? 34 : 24,
          c: "#e6f6ff",
          wake: true,
        });
      }
    }
  }

  private stepParts(): void {
    for (const p of this.parts) {
      p.vy += p.g;
      p.x += p.vx;
      p.y += p.vy;
      p.life--;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const p of this.pops) p.t++;
    this.pops = this.pops.filter((p) => p.t < 110);
  }

  step(): void {
    this.t++;
    this.stateT++;
    if (this.state === "explore") {
      this.stepExplore();
      this.stepParts();
      return;
    }
    if (this.state === "sail") {
      this.stepCreatures();
      this.stepKraken();
      this.stepCrew();
    } else if (this.state === "title") {
      this.stepCreatures();
      this.stepCrew();
    }
    if (this.state === "title") {
      this.boat.x = WD / 2;
      this.boat.y = HD / 2 + 22;
      this.boat.a = Math.sin(this.t * 0.015) * 0.14;
      this.boat.v = 0;
      this.stepParts();
      this.updateCamera();
      return;
    }
    if (this.state !== "sail") {
      this.stepParts();
      return;
    }

    this.clock++;
    const keyTurn = (this.keys.ArrowRight || this.keys.KeyD ? 1 : 0) - (this.keys.ArrowLeft || this.keys.KeyA ? 1 : 0);
    const keyDrive = !!(this.keys.ArrowUp || this.keys.KeyW);
    if (keyTurn) this.boat.a += keyTurn * 0.055;
    if (this.steer) {
      const want = Math.atan2(this.steer.x + this.camX - this.boat.x, -(this.steer.y + this.camY - this.boat.y));
      let da = want - this.boat.a;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      this.boat.a += clamp(da, -0.08, 0.08);
    }

    const o = (this.boat.y | 0) * WD + (this.boat.x | 0);
    const onLane = this.LANE[o] > 0;
    const load = this.boat.cargo.reduce((s, c) => s + WEIGHT[c.pr], 0);
    let top = (onLane ? 1.75 : 1.18) * (1 - load) * (1 + this.pod.on * 0.12) * (1 + this.voyage.speed);
    const inStorm = this.storms.find((s) => Math.hypot(s.x - this.boat.x, s.y - this.boat.y) < s.r);
    if (inStorm) {
      top *= 0.45 + this.voyage.storm;
      if (!this.calm && this.t % 20 === 0) this.shake = 2;
    }
    const throttle = !!(this.steer || keyDrive);
    this.boat.v += ((throttle ? top : 0) - this.boat.v) * 0.06;
    const nx = this.boat.x + Math.sin(this.boat.a) * this.boat.v;
    const ny = this.boat.y - Math.cos(this.boat.a) * this.boat.v;
    const no = (ny | 0) * WD + (nx | 0);
    if (nx < 4 || ny < 4 || nx > WD - 4 || ny > HD - 4 || this.E[no] > 0.04) {
      this.boat.v *= -0.3;
      if (!this.calm) this.shake = 1.5;
      this.events.push("aground");
    } else {
      this.boat.x = nx;
      this.boat.y = ny;
    }
    if (this.boat.v > 0.3) this.wake(onLane);
    this.reveal(this.boat.x, this.boat.y, 64 + this.voyage.fog);
    this.nearIsland = this.findLanding();

    for (const is of this.islands) {
      if (!is.charted && this.fogAt(is.x, is.y) > 0.5) {
        is.charted = true;
        this.charted++;
        this.pop(is.orphan ? "LOST NOTE CHARTED" : "CHARTED", is.title, is.orphan ? "#fff2a0" : "#c7e4ff");
        this.addScore(is.orphan ? 30 : 10);
        this.events.push(is.orphan ? "lost" : "chart");
      }
    }

    if (Math.hypot(this.boat.x - this.today.x, this.boat.y - this.today.y) < this.today.r + 16) {
      while (this.boat.cargo.length < this.holdSize && this.crates.length) {
        const c = this.crates.shift()!;
        this.boat.cargo.push(c);
        this.pop("LOADED", c.title, PCOL[c.pr]);
        this.events.push("load");
      }
    }

    for (const h of this.harbours) {
      if (Math.hypot(this.boat.x - h.x, this.boat.y - h.y) < h.r + 18) {
        for (const c of this.boat.cargo.filter((x) => x.p === h.p)) {
          const isLate = this.clock > this.dueFrame(c);
          this.delivered++;
          if (isLate) this.late++;
          this.addScore(isLate ? 50 : 100);
          this.pop(isLate ? "LATE" : "DELIVERED", c.title, isLate ? "#ff9a6b" : "#8dff9a");
          this.events.push(isLate ? "late" : "deliver");
          for (let i = 0; i < 14; i++) {
            this.parts.push({ x: h.x, y: h.y - h.lift - 6, vx: this.rng(-1, 1), vy: this.rng(-1.6, -0.4), g: 0.06, life: 26, c: [h.p!.accent, "#fff2a0", "#ffffff"][i % 3] });
          }
          if (!this.calm) this.flash = 6;
        }
        this.boat.cargo = this.boat.cargo.filter((x) => x.p !== h.p);
      }
    }

    for (const s of this.storms) {
      s.a += 0.004;
      s.x = s.p.cx + Math.cos(s.a) * s.rr;
      s.y = s.p.cy + Math.sin(s.a) * s.rr * 0.8;
      if (s.bolt > 0) s.bolt--;
      else if (this.rand() < 0.006) s.bolt = 8;
    }

    if (this.clock >= DAY_FRAMES || (!this.crates.length && !this.boat.cargo.length && this.islands.every((is) => is.explored))) {
      this.state = "log";
      this.stateT = 0;
      this.steer = null;
      this.events.push("done");
    }
    if (this.shake > 0) this.shake = Math.max(0, this.shake - 0.25);
    if (this.flash > 0) this.flash--;
    this.stepParts();
    this.updateCamera();
  }
}
