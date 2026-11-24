/**
 * Wayfinder simulation (pure, no Skia). Builds the sea chart from projects,
 * notes (islands), links (sea lanes), open tasks (cargo at the Today
 * lighthouse), and overdue tasks (storms). Runs at 60 Hz with deterministic
 * `mulberry32` randomness.
 */

import type { Priority } from "@cairn/shared/types/domain";
import type { ArcadeProject } from "@/games/pixel/arcade-data";
import { NO_HUD, type PixelHud } from "@/games/pixel/hud";
import { clamp } from "@/games/pixel/kinds";
import { BAYER, BIOMES, fbm, hash2, mulberry32, rgb, type BiomeName } from "@/games/pixel/terrain";
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

export type WayfinderState = "title" | "sail" | "map" | "log";
export type WayfinderEvent = "start" | "chart" | "lost" | "load" | "deliver" | "late" | "aground" | "kraken" | "escape" | "catch" | "done";

export interface Proj extends ArcadeProject { cx: number; cy: number }
export interface Isle {
  i: number;
  title: string;
  p: Proj | null;
  r: number;
  x: number;
  y: number;
  links: number[];
  orphan: boolean;
  charted: boolean;
  biome: BiomeName;
  harbour?: boolean;
  today?: boolean;
  lift: number;
}
export interface Crate { title: string; p: Proj; pr: Priority; due: number }
export interface Storm { title: string; p: Proj; a: number; rr: number; r: number; x: number; y: number; bolt: number }
export interface Particle { x: number; y: number; vx: number; vy: number; g: number; life: number; c: string; wake?: boolean }
export interface Pop { head: string; title: string; c: string; t: number }
export interface School { x: number; y: number; a: number; n: number; flee: number }
export interface Whale { x: number; y: number; a: number; cyc: number }
export interface Turtle { x: number; y: number; a: number }

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
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const n =
        (fbm(x / 16, y / 16, 8) * (64 - x) * (64 - y) +
          fbm((x - 64) / 16, y / 16, 8) * x * (64 - y) +
          fbm(x / 16, (y - 64) / 16, 8) * (64 - x) * y +
          fbm((x - 64) / 16, (y - 64) / 16, 8) * x * y) / 4096;
      const q = n + (BAYER[(y & 3) * 4 + (x & 3)] - 0.5) * 0.08;
      out[y * 64 + x] = FOG_SHADES[q < 0.47 ? 0 : q < 0.56 ? 1 : 2];
    }
  return out;
})();

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
    const orphan = !linked.has(i), a = hash2(i, 1, 3) * Math.PI * 2, d = orphan ? 0 : 30 + hash2(i, 2, 3) * 30;
    return {
      i, title: n.title, p, links: links[i], orphan, charted: false, biome: p.biome, lift: 0,
      r: Math.round(9 + Math.sqrt(Math.min(n.words, 2400)) * 0.42),
      x: orphan ? WD / 2 + Math.cos(a) * 280 : p.cx + Math.cos(a) * d,
      y: orphan ? HD / 2 + Math.sin(a) * 400 : p.cy + Math.sin(a) * d,
    };
  });
  const harbours: Isle[] = projs.map((p, k) => ({
    i: 100 + k, title: p.name, p, r: 15, x: p.cx, y: p.cy, harbour: true, biome: p.biome, links: [], charted: true, orphan: false, lift: 0,
  }));
  const today: Isle = {
    i: 200, title: "TODAY", p: null, r: 11, x: WD / 2, y: HD / 2, today: true, biome: "tundra", links: [], charted: true, orphan: false, lift: 0,
  };
  const all = [...islands, ...harbours, today];

  for (let it = 0; it < 260; it++)
    for (const a of islands) {
      let fx = 0, fy = 0;
      for (const b of all) {
        if (a === b) continue;
        const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 1, min = a.r + b.r + 22;
        if (d < min) { fx += (dx / d) * (min - d) * 0.5; fy += (dy / d) * (min - d) * 0.5; }
      }
      for (const j of a.links) {
        const b = islands[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        fx += (dx / d) * (d - 70) * 0.02; fy += (dy / d) * (d - 70) * 0.02;
      }
      if (a.orphan || !a.p) {
        const dx = a.x - WD / 2, dy = a.y - HD / 2, d = Math.hypot(dx, dy) || 1;
        fx += (dx / d) * 0.6; fy += (dy / d) * 0.6;
      } else { fx += (a.p.cx - a.x) * 0.01; fy += (a.p.cy - a.y) * 0.01; }
      a.x = clamp(a.x + fx, a.r + 20, WD - a.r - 20);
      a.y = clamp(a.y + fy, a.r + 30, HD - a.r - 30);
    }

  const lanes: [Isle, Isle, "link" | "trunk"][] = [];
  islands.forEach((a) => a.links.forEach((j) => lanes.push([a, islands[j], "link"])));
  harbours.forEach((h) => lanes.push([h, today, "trunk"]));

  const E = new Float32Array(WD * HD), NEAR = new Float32Array(WD * HD), OWN = new Uint8Array(WD * HD).fill(255);
  all.forEach((is, k) => {
    const R = is.r * 1.9, x0 = Math.max(0, (is.x - R) | 0), x1 = Math.min(WD - 1, (is.x + R) | 0), y0 = Math.max(0, (is.y - R) | 0), y1 = Math.min(HD - 1, (is.y + R) | 0);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const dx = x - is.x, dy = y - is.y, wob = 0.75 + fbm(x * 0.06, y * 0.06, is.i * 13 + 5) * 0.6;
        const d = Math.hypot(dx, dy) / (is.r * wob), o = y * WD + x, e = 1 - d * d;
        if (e > E[o]) { E[o] = e; OWN[o] = k; }
        const n = 1 - (d / 1.7) ** 2;
        if (n > NEAR[o]) { NEAR[o] = n; if (OWN[o] === 255) OWN[o] = k; }
      }
  });

  const LANE = new Uint8Array(WD * HD);
  for (const [a, b, kind] of lanes) {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, w = kind === "trunk" ? 4 : 3;
    for (let s = 0; s <= len; s++) {
      const cx = a.x + ((b.x - a.x) * s) / len, cy = a.y + ((b.y - a.y) * s) / len;
      for (let dy = -w; dy <= w; dy++)
        for (let dx = -w; dx <= w; dx++) {
          if (dx * dx + dy * dy > w * w) continue;
          const x = (cx + dx) | 0, y = (cy + dy) | 0;
          if (x >= 0 && y >= 0 && x < WD && y < HD) LANE[y * WD + x] = s % 18 < 2 && dx === 0 && dy === 0 ? 2 : 1;
        }
    }
  }

  const worldPixels = new Uint8Array(WD * HD * 4);
  const wbuf = new Uint32Array(worldPixels.buffer);
  const WATER = BIOMES.tropic.water.map(u32), LANE_C = u32("#5fb6e8"), BUOY = u32("#fff2a0");
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

  for (let y = 0; y < HD; y++)
    for (let x = 0; x < WD; x++) {
      const o = y * WD + x, n = NEAR[o];
      let c = n > 0.75 ? WATER[3] : n > 0.35 ? WATER[2] : n > 0 ? WATER[1] : fbm(x * 0.02, y * 0.02, 4) > 0.55 ? WATER[1] : WATER[0];
      if (n > 0.55 && n < 0.62 && hash2(x, y, 3) < 0.5) c = WATER[4];
      if (LANE[o] && E[o] <= 0) c = LANE[o] === 2 ? BUOY : BAYER[(y & 3) * 4 + (x & 3)] < 0.6 ? LANE_C : WATER[3];
      wbuf[o] = c;
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
    .filter((x) => !x.t.overdue)
    .sort((a, b) => a.t.dueMin - b.t.dueMin)
    .slice(0, MAX_CRATES)
    .map(({ t, p }) => ({ title: t.title, p, pr: t.priority, due: t.dueMin }));
  const stormTasks = tasks.filter((x) => x.t.overdue).slice(0, MAX_STORMS);
  return { projs, islands, harbours, today, all, E, NEAR, LANE, worldPixels, crates, stormTasks };
}

export class WayfinderSim {
  readonly W: number;
  readonly H: number;
  readonly hud: PixelHud;
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

  constructor(opts: { width: number; height: number; projects: ArcadeProject[]; hud?: PixelHud; best?: number; seed?: number }) {
    this.W = opts.width;
    this.H = opts.height;
    this.hud = opts.hud ?? NO_HUD;
    this.best = opts.best ?? 0;
    this.rand = mulberry32(opts.seed ?? 31);

    const w = buildWorld(opts.projects);
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
    const gx = x / 8, gy = y / 8, R = r / 8, x0 = Math.max(0, (gx - R) | 0), x1 = Math.min(FW - 1, (gx + R) | 0), y0 = Math.max(0, (gy - R) | 0), y1 = Math.min(FH - 1, (gy + R) | 0);
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++) {
        const d = Math.hypot(i + 0.5 - gx, j + 0.5 - gy);
        if (d < R) this.fog[j * FW + i] = Math.max(this.fog[j * FW + i], clamp(1.3 - d / R, 0, 1));
      }
  }
  private addScore(n: number): void {
    this.score += n;
    if (this.score > this.best) this.best = this.score;
  }
  private pop(head: string, title: string, c: string): void {
    this.pops.push({ head, title, c, t: 0 });
    if (this.pops.length > 2) this.pops.shift();
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
    for (const is of this.islands) is.charted = false;
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
    const lx = Math.max(4, this.hud.left + 4), ty = Math.max(4, this.hud.top);
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
    if (this.state === "sail") {
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

  private stepCreatures(): void {
    for (const s of this.schools) {
      if (Math.hypot(s.x - this.boat.x, s.y - this.boat.y) < 36 && this.boat.v > 0.3) s.flee = 70;
      if (s.flee > 0) s.flee--;
      const sp = s.flee > 0 ? 0.45 : 0.14;
      s.a += s.flee > 0 ? clamp(Math.atan2(s.x - this.boat.x, -(s.y - this.boat.y)) - s.a, -0.1, 0.1) : (this.rand() - 0.5) * 0.06;
      const nx = s.x + Math.sin(s.a) * sp, ny = s.y - Math.cos(s.a) * sp;
      if (nx < 20 || ny < 20 || nx > WD - 20 || ny > HD - 20 || this.E[(ny | 0) * WD + (nx | 0)] > 0) s.a += Math.PI * 0.7;
      else { s.x = nx; s.y = ny; }
    }
    for (const w of this.whales) {
      w.cyc = (w.cyc + 1) % 950;
      w.a += 0.002;
      const nx = w.x + Math.sin(w.a) * 0.22, ny = w.y - Math.cos(w.a) * 0.22;
      if (nx < 50 || ny < 50 || nx > WD - 50 || ny > HD - 50 || this.NEAR[(ny | 0) * WD + (nx | 0)] > 0.2) w.a += 0.04;
      else { w.x = nx; w.y = ny; }
    }
    for (const tt of this.turtles) {
      tt.a += 0.008;
      const nx = tt.x + Math.sin(tt.a) * 0.1, ny = tt.y - Math.cos(tt.a) * 0.1;
      if (this.E[(ny | 0) * WD + (nx | 0)] > 0) tt.a += 0.06;
      else { tt.x = nx; tt.y = ny; }
    }
    const o = (this.boat.y | 0) * WD + (this.boat.x | 0), fast = this.LANE[o] > 0 && this.boat.v > 0.9;
    this.pod.on = clamp(this.pod.on + (fast ? 0.015 : -0.02), 0, 1);
    if (this.pod.on > 0.5 && !this.pod.met) { this.pod.met = true; this.pop("DOLPHINS AT THE BOW", "+1 KNOT IN THE LANES", "#c7e4ff"); }
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
      for (const a of k.arms) { a.h = Math.min(1, a.h + 0.03); a.r = Math.max(16, 32 - k.t * 0.03); }
      for (const a of k.arms) {
        const ax = k.x + Math.cos(a.a) * a.r, ay = k.y + Math.sin(a.a) * a.r;
        if (Math.hypot(ax - this.boat.x, ay - this.boat.y) < 6 && a.h > 0.8) {
          const c = [...this.boat.cargo].sort((p, q) => WEIGHT[q.pr] - WEIGHT[p.pr])[0];
          if (c) { this.boat.cargo = this.boat.cargo.filter((x) => x !== c); this.crates.unshift(c); this.pop("THE KRAKEN TOOK", c.title, "#ff5e8a"); }
          else this.pop("THE KRAKEN", "FOUND YOUR HOLD EMPTY", "#e8b8e0");
          this.boat.v = -0.8;
          if (!this.calm) this.shake = 4;
          k.phase = "sink";
          k.t = 0;
          this.events.push("kraken");
          for (let i = 0; i < 20; i++) this.parts.push({ x: ax, y: ay, vx: this.rng(-1, 1), vy: this.rng(-1.5, -0.3), g: 0.06, life: 24, c: i % 2 ? "#e6f6ff" : "#a8509a" });
          return;
        }
      }
      const far = Math.hypot(this.boat.x - k.x, this.boat.y - k.y) > 60;
      if (far || k.t > 480) {
        if (far) { this.addScore(50); this.pop("ESCAPED THE KRAKEN", "+50", "#8dff9a"); this.events.push("escape"); }
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
    const idle = this.state === "sail" && !this.steer && Math.abs(this.boat.v) < 0.08 && this.kraken.phase === "none";
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
    if (this.crew.idle > 200 && this.crew.swim === "deck") { this.crew.swim = "dive"; this.crew.st = 0; this.crew.sa = 0; }
    if (this.crew.swim === "dive" && ++this.crew.st > 24) {
      this.crew.swim = "swim";
      this.crew.st = 0;
      const p = this.swimmerPos();
      for (let i = 0; i < 10; i++) this.parts.push({ x: p.x, y: p.y, vx: this.rng(-0.8, 0.8), vy: this.rng(-1.4, -0.4), g: 0.07, life: 18, c: "#e6f6ff" });
    }
    if (this.crew.swim === "swim") { this.crew.st++; this.crew.sa += 0.012; }
  }

  private catchSomething(): void {
    const CATCHES = ["A MACKEREL", "A SARDINE", "AN OLD BOOT", "A COD", "A TANGLE OF KELP"];
    const lost = this.islands.filter((i) => i.orphan && !i.charted), end = this.lineEnd();
    for (let i = 0; i < 8; i++) this.parts.push({ x: end.x, y: end.y, vx: this.rng(-0.6, 0.6), vy: this.rng(-1.4, -0.4), g: 0.07, life: 16, c: "#e6f6ff" });
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
    this.crew.cast = 0;
    this.crew.idle = 81;
  }

  private wake(lane: boolean): void {
    const bx = this.boat.x - Math.sin(this.boat.a) * 7, by = this.boat.y + Math.cos(this.boat.a) * 7;
    if (this.t % 2 === 0)
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

  private stepParts(): void {
    for (const p of this.parts) { p.vy += p.g; p.x += p.vx; p.y += p.vy; p.life--; }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const p of this.pops) p.t++;
    this.pops = this.pops.filter((p) => p.t < 110);
  }

  step(): void {
    this.t++;
    this.stateT++;
    if (this.state !== "map") {
      this.stepCreatures();
      this.stepKraken();
      this.stepCrew();
    }
    if (this.state === "title") {
      this.boat.a += 0.012;
      this.boat.x = WD / 2 + Math.sin(this.boat.a) * 40;
      this.boat.y = HD / 2 + 30 - Math.cos(this.boat.a) * 40;
      this.wake(false);
      this.stepParts();
      this.updateCamera();
      return;
    }
    if (this.state !== "sail") {
      this.stepParts();
      return;
    }

    this.clock++;
    if (this.steer) {
      const want = Math.atan2(this.steer.x + this.camX - this.boat.x, -(this.steer.y + this.camY - this.boat.y));
      let da = want - this.boat.a;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      this.boat.a += clamp(da, -0.06, 0.06);
    }

    const o = (this.boat.y | 0) * WD + (this.boat.x | 0), onLane = this.LANE[o] > 0;
    const load = this.boat.cargo.reduce((s, c) => s + WEIGHT[c.pr], 0);
    let top = (onLane ? 1.55 : 1) * (1 - load) * (1 + this.pod.on * 0.12);
    const inStorm = this.storms.find((s) => Math.hypot(s.x - this.boat.x, s.y - this.boat.y) < s.r);
    if (inStorm) {
      top *= 0.45;
      if (!this.calm && this.t % 20 === 0) this.shake = 2;
    }
    this.boat.v += ((this.steer ? top : 0) - this.boat.v) * 0.04;
    const nx = this.boat.x + Math.sin(this.boat.a) * this.boat.v, ny = this.boat.y - Math.cos(this.boat.a) * this.boat.v;
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
    this.reveal(this.boat.x, this.boat.y, 64);

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
      while (this.boat.cargo.length < 3 && this.crates.length) {
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
          for (let i = 0; i < 14; i++) this.parts.push({ x: h.x, y: h.y - h.lift - 6, vx: this.rng(-1, 1), vy: this.rng(-1.6, -0.4), g: 0.06, life: 26, c: [h.p!.accent, "#fff2a0", "#ffffff"][i % 3] });
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

    if (this.clock >= DAY_FRAMES || (!this.crates.length && !this.boat.cargo.length && this.charted === this.islands.length)) {
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
