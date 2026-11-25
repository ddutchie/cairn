/**
 * Task Force simulation — pure TypeScript, platform-agnostic.
 *
 * Vertical-scrolling arcade shooter over procedural islands: each project is a
 * biome mission, its tasks are enemy waves by priority, notes drop spread
 * upgrades, and carried-over tasks re-enter the wave if they slip past.
 */

import type { Priority } from "../../types/domain";
import { NO_HUD, type InputMode, type PixelHud } from "../pixel/hud";
import { clamp } from "../pixel/kinds";
import { makeCloud, type CloudSprite } from "../pixel/models";
import { CHUNK, Terrain, mulberry32 } from "../pixel/terrain";
import { DEMO_LEVELS, ENEMY_CFG, PRI_WEIGHT, type Level, type LevelTask } from "./models";

export const SCROLL = 0.7;
const FIRE_EVERY = 9;
const MAX_LIVES = 5;
const SPREAD_FRAMES = 540;
export const CLOUD_SPRITES = 10;

export function toScreen(px0: number, py0: number, ang: number, lx: number, ly: number): [number, number] {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [px0 + lx * c - ly * s, py0 + lx * s + ly * c];
}

export function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export interface Enemy {
  task: LevelTask;
  pr: Priority;
  x: number;
  x0: number;
  y: number;
  hp: number;
  r: number;
  t: number;
  ang: number;
  flash: number;
  ft: number;
  ph: number;
  mode: number;
  mt: number;
  ty: number;
}

export interface Boss {
  x: number;
  y: number;
  hp: number;
  max: number;
  t: number;
  ang: number;
  flash: number;
  r: number;
  dying: number;
}

export interface Pickup {
  x: number;
  y: number;
  ang: number;
  title: string;
  got?: boolean;
}

export interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dead?: boolean;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  l: number;
  m: number;
  s: number;
  k: number;
}

export interface Cloud {
  x: number;
  y: number;
  hi: boolean;
  sprite: number;
}

export interface FloatingText {
  s: string;
  x: number;
  y: number;
  c: string;
  l: number;
}

export interface Ring {
  x: number;
  y: number;
  r: number;
  max: number;
}

export interface TrailPoint {
  x: number;
  y: number;
  l: number;
}

export type TaskForceEvent =
  | "start"
  | "hit"
  | "over"
  | "kill"
  | "kill-big"
  | "carried"
  | "boss"
  | "boss-down"
  | "clear"
  | "pickup";

export interface TaskForceSpec {
  width: number;
  height: number;
  hud?: PixelHud;
  inputMode?: InputMode;
  best?: number;
  levels?: Level[];
  seed?: number;
  rand?: () => number;
}

export class TaskForceSim {
  W: number;
  H: number;
  hud: PixelHud;
  readonly inputMode: InputMode;
  readonly levels: Level[];
  readonly rand: () => number;

  terrain: Terrain;
  terrainGen = 1;
  cloudSprites: CloudSprite[];

  state: "title" | "intro" | "play" | "boss" | "clear" | "over" | "win" = "title";
  t = 0;
  camR = 0;
  score = 0;
  best = 0;
  lives = 3;
  levelIdx = 0;
  loop = 0;
  stateT = 0;
  shake = 0;
  hitstop = 0;
  hurt = 0;
  muzzle = 0;
  calm = false;

  player = { x: 90, y: 270, px: 90, tx: 90, ty: 270, ang: 0, inv: 0, fire: 0, spread: 0, dead: false };
  enemies: Enemy[] = [];
  boss: Boss | null = null;
  pickups: Pickup[] = [];
  pbul: Bullet[] = [];
  ebul: Bullet[] = [];
  parts: Particle[] = [];
  trail: TrailPoint[] = [];
  texts: FloatingText[] = [];
  rings: Ring[] = [];
  clouds: Cloud[] = [];

  queue: LevelTask[] = [];
  noteQ: string[] = [];
  total = 0;
  done = 0;
  spawnT = 0;
  noteT = 0;

  private keys: Record<string, boolean> = {};
  readonly events: TaskForceEvent[] = [];

  constructor(spec: TaskForceSpec) {
    this.W = spec.width;
    this.H = spec.height;
    this.hud = spec.hud ?? NO_HUD;
    this.inputMode = spec.inputMode ?? "touch";
    this.best = spec.best ?? 0;
    this.levels = spec.levels?.length ? spec.levels : DEMO_LEVELS;
    this.rand = spec.rand ?? mulberry32(spec.seed ?? 1337);
    this.cloudSprites = Array.from({ length: CLOUD_SPRITES }, () => makeCloud(this.rand));
    const lv0 = this.levels[0];
    this.terrain = new Terrain(this.W, lv0.biome, 3);
    this.clouds = Array.from({ length: 12 }, (_, i) => ({
      x: this.rr(-20, this.W - 10),
      y: this.rr(-40, this.H),
      hi: i >= 6,
      sprite: i % CLOUD_SPRITES,
    }));
    this.resetPlayer();
  }

  private rr(a: number, b: number): number {
    return a + this.rand() * (b - a);
  }

  get level(): Level {
    return this.levels[this.levelIdx % this.levels.length];
  }

  get hudTop(): number {
    return Math.max(16, this.hud.top + 14);
  }

  get hudBottom(): number {
    return Math.max(0, this.hud.bottom);
  }

  private resetPlayer(): void {
    const p = this.player;
    p.x = p.px = p.tx = this.W / 2;
    p.y = p.ty = this.H - 46 - this.hudBottom;
    p.ang = 0;
    p.inv = 100;
    p.fire = 0;
    p.spread = 0;
    p.dead = false;
  }

  resize(width: number, height: number): void {
    const prevW = this.W;
    if (prevW === width && this.H === height) return;
    const dx = (width - prevW) / 2;
    this.W = width;
    this.H = height;
    const p = this.player;
    p.x += dx;
    p.px += dx;
    p.tx = clamp(p.tx + dx, 8, this.W - 8);
    p.ty = clamp(p.ty, this.hudTop + 40, this.H - 16 - this.hudBottom);
    for (const e of this.enemies) {
      e.x = clamp(e.x + dx, 14, this.W - 14);
      e.x0 = clamp(e.x0 + dx, 14, this.W - 14);
    }
    if (this.boss) this.boss.x += dx;
    for (const pk of this.pickups) pk.x += dx;
    for (const b of this.pbul) b.x += dx;
    for (const b of this.ebul) b.x += dx;
    for (const pt of this.parts) pt.x += dx;
    for (const tr of this.trail) tr.x += dx;
    for (const tx of this.texts) tx.x += dx;
    for (const rg of this.rings) rg.x += dx;
    for (const c of this.clouds) c.x += dx;
    if (this.terrain.resize(this.W)) this.terrainGen++;
  }

  /** Tap/Space: start from title, retry after over, or continue after win. */
  tap(): void {
    if (this.state === "title" || (this.state === "over" && this.stateT <= 0)) {
      this.score = 0;
      this.lives = 3;
      this.levelIdx = 0;
      this.loop = 0;
      this.startLevel();
      this.events.push("start");
    } else if (this.state === "win" && this.stateT <= 0) {
      this.startLevel();
      this.events.push("start");
    }
  }

  /** Touch drag by delta in game pixels. */
  nudge(dx: number, dy: number): void {
    const p = this.player;
    p.tx = clamp(p.tx + dx, 8, this.W - 8);
    p.ty = clamp(p.ty + dy, this.hudTop + 40, this.H - 16 - this.hudBottom);
  }

  /** Absolute pointer target in game pixels (desktop pointer follow). */
  steer(x: number, y: number): void {
    const p = this.player;
    p.tx = clamp(x, 8, this.W - 8);
    p.ty = clamp(y, this.hudTop + 40, this.H - 16 - this.hudBottom);
  }

  setKey(code: string, down: boolean): boolean {
    if (code === "ArrowLeft" || code === "KeyA" || code === "ArrowRight" || code === "KeyD" || code === "ArrowUp" || code === "KeyW" || code === "ArrowDown" || code === "KeyS") {
      this.keys[code] = down;
      return true;
    }
    if (down && (code === "Space" || code === "Enter")) {
      this.tap();
      return true;
    }
    return false;
  }

  startLevel(): void {
    const lv = this.level;
    const seed = this.levelIdx * 1013 + this.loop * 77 + 3;
    if (this.terrain.biome !== lv.biome || this.terrain.seed !== seed) {
      this.terrain = new Terrain(this.W, lv.biome, seed);
      this.terrainGen++;
      this.camR = 0;
    }
    this.queue = lv.tasks
      .map((task) => ({ task, k: PRI_WEIGHT[task.priority] + this.rand() * 2.2 }))
      .sort((a, b) => a.k - b.k)
      .map((e) => e.task);
    this.total = this.queue.length;
    this.done = 0;
    this.noteQ = lv.notes.slice();
    this.enemies = [];
    this.pbul = [];
    this.ebul = [];
    this.pickups = [];
    this.texts = [];
    this.boss = null;
    this.resetPlayer();
    this.spawnT = 30;
    this.noteT = 360;
    this.state = "intro";
    this.stateT = 150;
  }

  private settleBest(): void {
    if (this.score > this.best) this.best = this.score;
  }

  private addText(s: string, x: number, y: number, c: string, life = 70): void {
    this.texts.push({ s, x, y, c, l: life });
  }

  explode(x: number, y: number, size: number): void {
    const R = this.rand;
    for (let i = 0; i < 8 + size * 8; i++) {
      const a = R() * 6.283, sp = R() * (0.6 + size * 0.55), l = (14 + R() * 16 * (0.6 + size * 0.3)) | 0;
      this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, l, m: l, s: R() < 0.3 ? 2 : 1, k: 0 });
    }
    for (let i = 0; i < size * 4; i++) {
      const l = 40 + ((R() * 30) | 0);
      this.parts.push({ x: x + this.rr(-4, 4), y: y + this.rr(-4, 4), vx: this.rr(-0.3, 0.3), vy: this.rr(-0.3, 0.3), l, m: l, s: 2 + ((R() * 2) | 0), k: 1 });
    }
    for (let i = 0; i < size * 3; i++) {
      const a = R() * 6.283, sp = 1 + R() * 2;
      this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, l: 30, m: 30, s: 1, k: 2 });
    }
    this.rings.push({ x, y, r: 2, max: 6 + size * 6 });
    if (!this.calm) this.shake = Math.max(this.shake, size * 2.2);
  }

  private sparks(x: number, y: number): void {
    for (let i = 0; i < 3; i++) this.parts.push({ x, y, vx: this.rr(-1, 1), vy: this.rr(-1.5, 0), l: 8, m: 8, s: 1, k: 0 });
  }

  private aimAt(x: number, y: number): number {
    return Math.atan2(this.player.x - x, -(this.player.y - y));
  }

  private shoot(x: number, y: number, a: number, sp: number): void {
    this.ebul.push({ x, y, vx: Math.sin(a) * sp, vy: -Math.cos(a) * sp });
  }

  private aimShot(e: { x: number; y: number }, sp: number): void {
    this.shoot(e.x, e.y, this.aimAt(e.x, e.y), sp * (1 + this.loop * 0.15));
  }

  private fan(e: { x: number; y: number }, n: number, arc: number, sp: number): void {
    const b = this.aimAt(e.x, e.y);
    for (let i = 0; i < n; i++) this.shoot(e.x, e.y, b + (i / (n - 1) - 0.5) * arc, sp * (1 + this.loop * 0.15));
  }

  private ringShot(e: { x: number; y: number }, n: number, sp: number): void {
    const o = this.rand();
    for (let i = 0; i < n; i++) this.shoot(e.x, e.y, ((i + o) / n) * 6.283, sp);
  }

  private spawn(task: LevelTask): void {
    const c = ENEMY_CFG[task.priority];
    const x = this.rr(24, this.W - 24);
    this.enemies.push({
      task,
      pr: task.priority,
      x,
      x0: x,
      y: this.hudTop - 16,
      hp: Math.ceil(c.hp * (1 + this.loop * 0.5)),
      r: c.r,
      t: 0,
      ang: Math.PI,
      flash: 0,
      ft: this.rr(60, 100),
      ph: this.rr(0, 6.28),
      mode: 0,
      mt: 0,
      ty: this.hudTop + this.rr(50, 100),
    });
  }

  private spawnBoss(): void {
    const hp = Math.ceil(70 * (1 + this.loop * 0.5));
    this.boss = { x: this.W / 2, y: this.hudTop - 30, hp, max: hp, t: 0, ang: Math.PI, flash: 0, r: 17, dying: 0 };
    this.state = "boss";
    this.stateT = 120;
    this.events.push("boss");
  }

  private hitPlayer(): void {
    const p = this.player;
    if (p.inv > 0 || p.dead) return;
    this.lives--;
    this.explode(p.x, p.y, 2);
    p.inv = 120;
    this.hurt = 14;
    if (!this.calm) {
      this.shake = 9;
      this.hitstop = 5;
    }
    this.events.push("hit");
    if (this.lives <= 0) {
      p.dead = true;
      this.explode(p.x, p.y, 3);
      this.state = "over";
      this.stateT = 60;
      this.settleBest();
      this.events.push("over");
    }
  }

  private killEnemy(e: Enemy): void {
    const c = ENEMY_CFG[e.pr];
    this.explode(e.x, e.y, c.size);
    this.score += c.score * (1 + this.loop);
    this.done++;
    if (c.size >= 2 && !this.calm) this.hitstop = c.size >= 3 ? 6 : 3;
    this.events.push(c.size >= 2 ? "kill-big" : "kill");
    this.addText("DONE: " + e.task.title, e.x, e.y - 12, "#8dff9a", 80);
  }

  private updEnemy(e: Enemy): void {
    e.t++;
    const L = 1 + this.loop * 0.2, ox = e.x, oy = e.y;
    switch (e.pr) {
      case "low":
        e.y += 1.0 * L;
        e.x = e.x0 + Math.sin(e.t * 0.045 + e.ph) * 22;
        e.ang = Math.atan2(e.x - ox, -(e.y - oy));
        break;
      case "medium":
        if (e.mode === 0) {
          e.y += 1.3 * L;
          e.ang = Math.PI;
          if (e.y > e.ty) {
            e.mode = 1;
            this.aimShot(e, 1.6);
          }
        } else {
          if (++e.mt < 50) e.ang += angDiff(this.aimAt(e.x, e.y), e.ang) * 0.08;
          const sp = 2.1 * L;
          e.x += Math.sin(e.ang) * sp;
          e.y -= Math.cos(e.ang) * sp;
        }
        break;
      case "high":
        if (e.mode === 0) {
          e.y += Math.max(0.4, (e.ty - e.y) * 0.04) * L;
          e.ang = Math.PI;
          if (e.y >= e.ty - 1) e.mode = 1;
        } else if (e.mode === 1) {
          e.mt++;
          const vx = Math.sin(e.mt * 0.03 + e.ph) * 1.1;
          e.x = clamp(e.x + vx, 14, this.W - 14);
          e.ang = Math.PI - vx * 0.4;
          if (--e.ft <= 0) {
            this.aimShot(e, 1.7);
            e.ft = 70 / L;
          }
          if (e.mt > 300) e.mode = 2;
        } else {
          e.y += 1.6 * L;
          e.ang += angDiff(Math.PI, e.ang) * 0.1;
        }
        break;
      case "urgent":
        e.y += 0.38 * L;
        e.x += clamp((this.player.x - e.x) * 0.004, -0.3, 0.3);
        e.ang += clamp(angDiff(this.aimAt(e.x, e.y), e.ang), -0.6, 0.6) * 0.02;
        if (--e.ft <= 0) {
          this.fan(e, 5, 0.9, 1.4);
          e.ft = 110 / L;
        }
        break;
    }
    if (e.flash > 0) e.flash--;
  }

  step(): void {
    this.t++;
    if (this.hurt > 0) this.hurt--;
    if (this.muzzle > 0) this.muzzle--;
    if (this.hitstop > 0) {
      this.hitstop--;
      return;
    }
    this.camR += SCROLL;
    this.terrain.pump(Math.floor(this.camR) + this.H + CHUNK, 3);
    for (const c of this.clouds) {
      c.y += c.hi ? SCROLL * 2.6 : SCROLL * 1.5;
      if (c.y > this.H + 30) {
        c.sprite = (this.rand() * CLOUD_SPRITES) | 0;
        c.y = -40 - this.rr(0, 140);
        c.x = this.rr(-30, this.W - 10);
      }
    }
    this.updParts();
    if (this.shake > 0) {
      this.shake *= 0.86;
      if (this.shake < 0.4) this.shake = 0;
    }
    if (this.state === "title") return;
    if (this.state === "over" || this.state === "win") {
      if (this.stateT > 0) this.stateT--;
      this.updBullets();
      return;
    }

    const p = this.player;
    const kx = (this.keys.ArrowRight || this.keys.KeyD ? 1 : 0) - (this.keys.ArrowLeft || this.keys.KeyA ? 1 : 0);
    const ky = (this.keys.ArrowDown || this.keys.KeyS ? 1 : 0) - (this.keys.ArrowUp || this.keys.KeyW ? 1 : 0);
    if (kx || ky) {
      const sp = kx && ky ? 1.9 : 2.6;
      p.tx = clamp(p.tx + kx * sp, 8, this.W - 8);
      p.ty = clamp(p.ty + ky * sp, this.hudTop + 40, this.H - 16 - this.hudBottom);
    }
    p.px = p.x;
    p.x += (p.tx - p.x) * 0.35;
    p.y += (p.ty - p.y) * 0.35;
    p.ang += (clamp((p.x - p.px) * 0.14, -0.4, 0.4) - p.ang) * 0.2;
    if (p.inv > 0) p.inv--;
    if (p.spread > 0) p.spread--;
    for (const s of [-1, 1]) {
      const [wx, wy] = toScreen(p.x, p.y, p.ang, 0.5 + s * 6.5, 4);
      this.trail.push({ x: wx - 0.5, y: wy, l: 26 });
    }
    if (this.state !== "intro" && --p.fire <= 0) {
      p.fire = FIRE_EVERY;
      this.muzzle = 2;
      const ca = Math.cos(p.ang), sa = Math.sin(p.ang);
      for (const s of [-3, 3]) this.pbul.push({ x: p.x + s * ca, y: p.y - 8 + s * sa, vx: 0, vy: -5 });
      if (p.spread > 0) for (const s of [-1, 1]) this.pbul.push({ x: p.x, y: p.y - 6, vx: s * 1.2, vy: -4.6 });
    }

    if (this.state === "intro" && --this.stateT <= 0) this.state = "play";
    if (this.state === "play") {
      if (--this.spawnT <= 0 && this.queue.length) {
        const task = this.queue.shift()!;
        this.spawn(task);
        this.spawnT = ENEMY_CFG[task.priority].gap / (1 + this.loop * 0.25);
      }
      if (!this.queue.length && !this.enemies.length) this.spawnBoss();
    }
    if ((this.state === "play" || this.state === "boss") && --this.noteT <= 0 && this.noteQ.length) {
      this.pickups.push({ x: this.rr(20, this.W - 20), y: this.hudTop - 10, ang: 0, title: this.noteQ.shift()! });
      this.noteT = this.rr(420, 620);
    }

    for (const e of this.enemies) this.updEnemy(e);
    this.enemies = this.enemies.filter((e) => {
      if (e.hp <= 0) return false;
      if (e.y > this.H + 24 || e.y < this.hudTop - 36 || e.x < -30 || e.x > this.W + 30) {
        this.queue.push(e.task);
        this.addText("CARRIED OVER", clamp(e.x, 28, this.W - 28), this.H - 34 - this.hudBottom, "#ff9a6b", 60);
        this.events.push("carried");
        return false;
      }
      return true;
    });

    const b = this.boss;
    if (b) {
      b.t++;
      if (b.flash > 0) b.flash--;
      if (b.dying > 0) {
        b.dying--;
        if (b.dying % 6 === 0) this.explode(b.x + this.rr(-16, 16), b.y + this.rr(-12, 12), 2);
        if (b.dying === 0) {
          this.explode(b.x, b.y, 5);
          this.boss = null;
          this.state = "clear";
          this.stateT = 200;
          this.score += 1000 * (1 + this.loop);
          this.lives = Math.min(MAX_LIVES, this.lives + 1);
          this.events.push("clear");
        }
      } else {
        const restY = this.hudTop + 50;
        if (b.y < restY) b.y += 0.6;
        else {
          b.x = this.W / 2 + Math.sin(b.t * 0.012) * Math.min(48, this.W / 2 - 24);
          if (b.t % 55 === 0) this.fan(b, 3, 0.5, 1.8);
          if (b.t % 150 === 0) this.ringShot(b, 14, 1.2);
        }
        b.ang = Math.PI + Math.sin(b.t * 0.025) * 0.28;
      }
      if (this.state === "boss" && this.stateT > 0) this.stateT--;
    }
    if (this.state === "clear" && --this.stateT <= 0) {
      this.levelIdx++;
      if (this.levelIdx >= this.levels.length) {
        this.levelIdx = 0;
        this.loop++;
        this.state = "win";
        this.stateT = 60;
        this.settleBest();
        return;
      }
      this.startLevel();
    }

    for (const pk of this.pickups) {
      pk.y += SCROLL * 1.8;
      pk.ang += 0.05;
      if (!p.dead && Math.hypot(pk.x - p.x, pk.y - p.y) < 12) {
        pk.got = true;
        p.spread = SPREAD_FRAMES;
        this.score += 50;
        this.addText("NOTE: " + pk.title, pk.x, pk.y - 10, "#9fd2ff", 80);
        this.events.push("pickup");
        for (let i = 0; i < 10; i++) {
          this.parts.push({ x: pk.x, y: pk.y, vx: this.rr(-1.5, 1.5), vy: this.rr(-1.5, 1.5), l: 20, m: 20, s: 1, k: 3 });
        }
      }
    }
    this.pickups = this.pickups.filter((pk) => !pk.got && pk.y < this.H + 12);
    this.updBullets();
    for (const tr of this.trail) {
      tr.y += 2.2;
      tr.l--;
    }
    this.trail = this.trail.filter((tr) => tr.l > 0);
  }

  private updBullets(): void {
    for (const b of this.pbul) {
      b.x += b.vx;
      b.y += b.vy;
    }
    for (const b of this.ebul) {
      b.x += b.vx;
      b.y += b.vy;
    }
    for (const b of this.pbul) {
      for (const e of this.enemies) {
        if (e.hp > 0 && Math.abs(b.x - e.x) < e.r && Math.abs(b.y - e.y) < e.r) {
          b.dead = true;
          e.hp--;
          e.flash = 3;
          this.sparks(b.x, b.y);
          if (e.hp <= 0) this.killEnemy(e);
          break;
        }
      }
      const boss = this.boss;
      if (!b.dead && boss && !boss.dying && Math.hypot(b.x - boss.x, b.y - boss.y) < boss.r) {
        b.dead = true;
        boss.hp--;
        boss.flash = 3;
        this.sparks(b.x, b.y);
        if (boss.hp <= 0) {
          boss.dying = 70;
          this.ebul = [];
          this.addText("PROJECT SHIPPED!", boss.x, boss.y - 24, "#8dff9a", 120);
          this.events.push("boss-down");
        }
      }
    }
    const p = this.player;
    if (!p.dead) {
      for (const b of this.ebul) {
        if (Math.abs(b.x - p.x) < 4 && Math.abs(b.y - p.y) < 5) {
          b.dead = true;
          this.hitPlayer();
        }
      }
      for (const e of this.enemies) {
        if (e.hp > 0 && Math.hypot(e.x - p.x, e.y - p.y) < e.r + 5) {
          e.hp -= 3;
          e.flash = 3;
          this.hitPlayer();
          if (e.hp <= 0) this.killEnemy(e);
        }
      }
    }
    const W = this.W, H = this.H;
    this.pbul = this.pbul.filter((b) => !b.dead && b.y > -8 && b.x > -8 && b.x < W + 8);
    this.ebul = this.ebul.filter((b) => !b.dead && b.y > -10 && b.y < H + 10 && b.x > -10 && b.x < W + 10);
  }

  private updParts(): void {
    for (const p of this.parts) {
      p.x += p.vx;
      p.y += p.vy + SCROLL * 0.6;
      p.l--;
      const damp = p.k === 1 ? 0.96 : 0.93;
      p.vx *= damp;
      p.vy *= damp;
    }
    this.parts = this.parts.filter((p) => p.l > 0);
    for (const r of this.rings) r.r += 1;
    this.rings = this.rings.filter((r) => r.r <= r.max);
    for (const x of this.texts) {
      x.y -= 0.3;
      x.l--;
    }
    this.texts = this.texts.filter((x) => x.l > 0);
  }
}

export { DEMO_LEVELS, type Level, type LevelTask } from "./models";
export { mulberry32 };
