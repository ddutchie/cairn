/**
 * Inbox Zero simulation (pure, no Skia). Each project is a wave; its open
 * tasks crawl down a centered serpentine Kanban flow toward the deadline.
 * Tap cells beside the flow to pin tag towers, or tap an existing tower to
 * upgrade it. Built to adapt to portrait iPhones and wide/folded iPhone Duo
 * layouts while keeping the path centered and game balance invariant.
 */

import type { Priority } from "@cairn/shared/types/domain";
import type { ArcadeProject } from "@/games/pixel/arcade-data";
import { NO_HUD, type PixelHud } from "@/games/pixel/hud";
import { clamp } from "@/games/pixel/kinds";
import { mulberry32 } from "@/games/pixel/terrain";
import { FIRE, PRIO, TAGS, type TagDef, type TagId } from "./models";

export const CELL = 12;
export const CORE_GX = 15;
export const CORE_GY = 21;
const MAX_WAVES = 5;
const MAX_SHOP_W = 72;
const SHOP_H = 32;

export const PATH_CELLS: readonly [number, number][] = [
  [1, -1], [1, 4], [13, 4], [13, 9], [1, 9], [1, 14], [13, 14], [13, 18], [7, 18], [7, 21],
];

const BASE_PATH = PATH_CELLS.map(([c, r]) => ({ x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 }));
export const CORE_SEG = BASE_PATH.slice(1).map((b, i) => {
  const a = BASE_PATH[i];
  return { a, b, len: Math.hypot(b.x - a.x, b.y - a.y) };
});
export const PATH_LEN = CORE_SEG.reduce((s, g) => s + g.len, 0);

const onPath = new Uint8Array(CORE_GX * CORE_GY);
for (const { a, b } of CORE_SEG) {
  const c0 = (Math.min(a.x, b.x) / CELL) | 0, c1 = (Math.max(a.x, b.x) / CELL) | 0;
  const r0 = (Math.min(a.y, b.y) / CELL) | 0, r1 = (Math.max(a.y, b.y) / CELL) | 0;
  for (let r = Math.max(0, r0); r <= Math.min(CORE_GY - 1, r1); r++) for (let c = c0; c <= c1; c++) onPath[r * CORE_GX + c] = 1;
}

export function isOnPath(c: number, r: number): boolean {
  return c >= 0 && c < CORE_GX && r >= 0 && r < CORE_GY && onPath[r * CORE_GX + c] === 1;
}

function distToSeg(px0: number, py0: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px0 - ax) * dx + (py0 - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px0 - (ax + t * dx), py0 - (ay + t * dy));
}

export function canBuildCore(c: number, r: number): boolean {
  if (r < 0 || r >= CORE_GY || isOnPath(c, r)) return false;
  if (c >= 0 && c < CORE_GX) return true;
  const x = c * CELL + CELL / 2, y = r * CELL + CELL / 2;
  const maxRange = TAGS[2].range; // #FOCUS base range (62 px)
  return CORE_SEG.some(({ a, b }) => distToSeg(x, y, a.x, a.y, b.x, b.y) <= maxRange);
}

export type InboxZeroState = "title" | "intro" | "wave" | "over" | "win";
export type InboxZeroEvent = "start" | "place" | "upgrade" | "error" | "triage" | "leak" | "wave" | "win" | "over";

export interface Card {
  title: string;
  pr: Priority;
  d: number;
  hp: number;
  max: number;
  slow: number;
  flash: number;
  x: number;
  y: number;
  dir: number;
  gone?: boolean;
}
export interface Tower {
  id: TagId;
  c: number;
  r: number;
  x: number;
  y: number;
  lvl: number;
  a: number;
  cd: number;
  kick: number;
}
export interface Shot {
  beam?: boolean;
  x: number;
  y: number;
  tx?: number;
  ty?: number;
  target?: Card;
  dmg?: number;
  T?: TagDef;
  v?: number;
  life: number;
  c: string;
}
export interface Particle { x: number; y: number; vx: number; vy: number; g: number; life: number; c: string }
export interface Pop { s: string; title: string; c: string; x: number; y: number; t: number }
export interface Ring { x: number; y: number; r: number; c: string }
export interface WaveDef { name: string; accent: string; tasks: { title: string; pr: Priority }[] }

export class InboxZeroSim {
  readonly W: number;
  readonly H: number;
  readonly hud: PixelHud;
  readonly topY: number;
  readonly shopY: number;
  readonly shopH = SHOP_H;
  readonly shopW: number;
  readonly shopX0: number;
  readonly coreX: number;
  readonly coreY: number;
  readonly minC: number;
  readonly maxC: number;
  readonly waves: WaveDef[];
  private readonly rand: () => number;

  state: InboxZeroState = "title";
  t = 0;
  stateT = 0;
  wave = 0;
  queue: { title: string; pr: Priority }[] = [];
  spawnT = 0;
  cards: Card[] = [];
  towers: Tower[] = [];
  shots: Shot[] = [];
  parts: Particle[] = [];
  pops: Pop[] = [];
  rings: Ring[] = [];
  hearts = 5;
  focus = 40;
  triaged = 0;
  leaked = 0;
  score = 0;
  best: number;
  shake = 0;
  picked = 0;
  cursor: { x: number; y: number } | null = null;
  toast: { s: string; t: number } | null = null;
  calm = false;
  events: InboxZeroEvent[] = [];

  constructor(opts: { width: number; height: number; projects: ArcadeProject[]; hud?: PixelHud; best?: number; seed?: number }) {
    this.W = opts.width;
    this.H = opts.height;
    this.hud = opts.hud ?? NO_HUD;
    this.best = opts.best ?? 0;
    this.rand = mulberry32(opts.seed ?? 42);

    this.topY = Math.max(22, this.hud.top + 22);
    this.shopY = this.H - this.hud.bottom - SHOP_H;
    const usableW = Math.max(CORE_GX * CELL, this.W - this.hud.left - this.hud.right);
    this.coreX = Math.floor(this.hud.left + (usableW - CORE_GX * CELL) / 2);
    const boardH = this.shopY - this.topY - 2;
    this.coreY = this.topY + Math.max(0, Math.floor((boardH - CORE_GY * CELL) / 2));
    this.minC = -Math.floor((this.coreX - this.hud.left) / CELL) || 0;
    this.maxC = CORE_GX - 1 + Math.floor((this.W - this.hud.right - this.coreX - CORE_GX * CELL) / CELL);
    this.shopW = Math.min(MAX_SHOP_W, Math.floor(usableW / TAGS.length));
    this.shopX0 = Math.round(this.hud.left + (usableW - this.shopW * TAGS.length) / 2);

    const built = opts.projects
      .filter((p) => p.tasks.length > 0)
      .slice(0, MAX_WAVES)
      .sort((a, b) => a.tasks.length - b.tasks.length)
      .map((p) => ({ name: p.name, accent: p.accent, tasks: p.tasks.map((t) => ({ title: t.title, pr: t.priority })) }));
    this.waves = built.length ? built : [{ name: "WORKSPACE", accent: "#2ec4b6", tasks: [{ title: "TRIAGE INBOX", pr: "medium" }] }];
  }

  along(d: number): { x: number; y: number; dir: number } {
    for (const g of CORE_SEG) {
      if (d <= g.len) {
        const f = d / g.len;
        return {
          x: this.coreX + g.a.x + (g.b.x - g.a.x) * f,
          y: this.coreY + g.a.y + (g.b.y - g.a.y) * f,
          dir: Math.atan2(g.b.x - g.a.x, -(g.b.y - g.a.y)),
        };
      }
      d -= g.len;
    }
    const e = BASE_PATH[BASE_PATH.length - 1];
    return { x: this.coreX + e.x, y: this.coreY + e.y, dir: Math.PI };
  }

  private rng(a: number, b: number): number {
    return a + this.rand() * (b - a);
  }
  private say(s: string): void {
    this.toast = { s, t: 0 };
  }
  private ring(x: number, y: number, c: string): void {
    this.rings.push({ x, y, r: 2, c });
  }
  private addScore(n: number): void {
    this.score += n;
    if (this.score > this.best) this.best = this.score;
  }
  private tagAt(c: number, r: number): Tower | undefined {
    return this.towers.find((tw) => tw.c === c && tw.r === r);
  }
  getTagAt(c: number, r: number): Tower | undefined {
    return this.tagAt(c, r);
  }

  private reset(): void {
    this.wave = 0;
    this.cards = [];
    this.towers = [];
    this.shots = [];
    this.parts = [];
    this.pops = [];
    this.rings = [];
    this.hearts = 5;
    this.focus = 40;
    this.triaged = 0;
    this.leaked = 0;
    this.score = 0;
    this.picked = 0;
    this.startWave();
  }

  private startWave(): void {
    this.queue = this.waves[this.wave].tasks.map((x) => ({ ...x }));
    this.queue.sort((a, b) => PRIO[a.pr].hp - PRIO[b.pr].hp + (this.rand() - 0.5) * 6);
    this.state = "intro";
    this.stateT = 0;
    this.spawnT = 0;
    this.events.push("wave");
  }

  down(x: number, y: number): void {
    if (this.state === "title" || ((this.state === "over" || this.state === "win") && this.stateT > 60)) {
      this.cards = [];
      this.cursor = null;
      this.reset();
      this.events.push("start");
      return;
    }
    if (this.state === "over" || this.state === "win") return;

    if (y >= this.shopY) {
      this.cursor = null;
      const i = Math.floor((x - this.shopX0) / this.shopW);
      if (x >= this.shopX0 && i >= 0 && i < TAGS.length) this.picked = i;
      return;
    }
    this.cursor = { x, y };
  }

  move(x: number, y: number): void {
    if (this.cursor) this.cursor = { x, y };
  }

  up(): void {
    const cur = this.cursor;
    this.cursor = null;
    if (!cur || this.state === "title" || this.state === "over" || this.state === "win") return;
    if (cur.y >= this.shopY) return;

    const c = Math.floor((cur.x - this.coreX) / CELL), r = Math.floor((cur.y - this.coreY) / CELL);
    if (c < this.minC || c > this.maxC || r < 0 || r >= CORE_GY) return;

    const tw = this.tagAt(c, r);
    if (tw) {
      const cost = Math.round(TAGS.find((tg) => tg.id === tw.id)!.cost * (tw.lvl + 1) * 0.8);
      if (tw.lvl >= 2) { this.say("MAXED"); this.events.push("error"); return; }
      if (this.focus < cost) { this.say(`NEED ${cost} FOCUS`); this.events.push("error"); return; }
      this.focus -= cost;
      tw.lvl++;
      this.ring(tw.x, tw.y, "#fff2a0");
      this.say("UPGRADED");
      this.events.push("upgrade");
      return;
    }
    if (isOnPath(c, r)) { this.say("THAT'S THE FLOW"); this.events.push("error"); return; }
    if (!canBuildCore(c, r)) { this.say("TOO FAR FROM FLOW"); this.events.push("error"); return; }
    const tag = TAGS[this.picked];
    if (this.focus < tag.cost) { this.say(`NEED ${tag.cost} FOCUS`); this.events.push("error"); return; }
    this.focus -= tag.cost;
    const tx = this.coreX + c * CELL + CELL / 2, ty = this.coreY + r * CELL + CELL / 2;
    this.towers.push({ id: tag.id, c, r, x: tx, y: ty + 2, lvl: 0, a: Math.PI, cd: 0, kick: 0 });
    this.ring(tx, ty, tag.c);
    this.events.push("place");
  }

  step(): void {
    this.t++;
    this.stateT++;
    for (const p of this.parts) { p.vy += p.g; p.x += p.vx; p.y += p.vy; p.life--; }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const r of this.rings) r.r += 0.8;
    this.rings = this.rings.filter((r) => r.r < 14);
    for (const p of this.pops) p.t++;
    this.pops = this.pops.filter((p) => p.t < 60);
    if (this.toast && ++this.toast.t > 70) this.toast = null;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - 0.4);

    if (this.state === "title") {
      if (this.t % 60 === 0) {
        const pr = (["low", "medium", "high", "urgent"] as const)[((this.t / 60) | 0) % 4];
        const p0 = this.along(0);
        this.cards.push({ title: "", pr, d: 0, hp: 1, max: 1, slow: 0, flash: 0, x: p0.x, y: p0.y, dir: 0 });
      }
      for (const c of this.cards) {
        c.d += 0.6;
        const p = this.along(c.d);
        c.x = p.x; c.y = p.y; c.dir = p.dir;
      }
      this.cards = this.cards.filter((c) => c.d < PATH_LEN);
      return;
    }

    if (this.state === "intro" && this.stateT > 120) {
      this.state = "wave";
      this.stateT = 0;
    }
    if (this.state !== "wave" && this.state !== "intro") return;

    if (this.state === "wave" && this.queue.length && --this.spawnT <= 0) {
      const q = this.queue.shift()!, P = PRIO[q.pr], hp = P.hp * (1 + this.wave * 0.15);
      const p0 = this.along(0);
      this.cards.push({ ...q, d: 0, hp, max: hp, slow: 0, flash: 0, x: p0.x, y: p0.y, dir: Math.PI });
      this.spawnT = 70 - this.wave * 6;
    }

    for (const c of this.cards) {
      c.d += PRIO[c.pr].v * (c.slow > 0 ? 0.45 : 1);
      if (c.slow > 0) c.slow--;
      if (c.flash > 0) c.flash--;
      const p = this.along(c.d);
      c.x = p.x; c.y = p.y; c.dir = p.dir;
      if (c.d >= PATH_LEN) {
        c.gone = true;
        this.hearts--;
        this.leaked++;
        if (!this.calm) this.shake = 4;
        this.pops.push({ s: "OVERDUE", title: c.title, c: "#ff5e8a", x: c.x, y: c.y - 10, t: 0 });
        this.events.push("leak");
        if (this.hearts <= 0) {
          this.state = "over";
          this.stateT = 0;
          this.events.push("over");
        }
      }
    }

    for (const tw of this.towers) {
      const T = TAGS.find((x) => x.id === tw.id)!, range = T.range * (1 + tw.lvl * 0.15);
      if (tw.kick > 0) tw.kick--;
      let target: Card | null = null;
      for (const c of this.cards) if (!c.gone && Math.hypot(c.x - tw.x, c.y - tw.y) <= range && (!target || c.d > target.d)) target = c;
      if (!target) continue;
      let da = Math.atan2(target.x - tw.x, -(target.y - tw.y)) - tw.a;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      tw.a += clamp(da, -0.25, 0.25);
      if (--tw.cd > 0 || Math.abs(da) > 0.4) continue;
      tw.cd = T.rate * (1 - tw.lvl * 0.15);
      tw.kick = 4;
      const dmg = T.dmg * (1 + tw.lvl * 0.6);
      if (T.id === "focus") {
        this.hit(target, dmg);
        this.shots.push({ beam: true, x: tw.x, y: tw.y - 6, tx: target.x, ty: target.y, life: 6, c: T.l });
      } else {
        this.shots.push({
          x: tw.x + Math.sin(tw.a) * 5,
          y: tw.y - 5 - Math.cos(tw.a) * 5,
          target, dmg, T, v: T.id === "batch" ? 1.8 : 3, life: 90, c: T.l,
        });
      }
    }

    for (const s of this.shots) {
      s.life--;
      if (s.beam || !s.target || !s.T) continue;
      const tg = s.target, T = s.T;
      if (tg.gone && !T.splash) { s.life = 0; continue; }
      const dx = tg.x - s.x, dy = tg.y - s.y, d = Math.hypot(dx, dy), v = s.v ?? 3;
      if (d < v + 1) {
        s.life = 0;
        if (T.splash) {
          this.ring(tg.x, tg.y, "#ffb347");
          for (let i = 0; i < 10; i++) this.parts.push({ x: tg.x, y: tg.y, vx: this.rng(-1.2, 1.2), vy: this.rng(-1.2, 1.2), g: 0, life: 14, c: FIRE[1 + (i % 3)] });
          for (const c of this.cards) if (!c.gone && Math.hypot(c.x - tg.x, c.y - tg.y) <= T.splash) this.hit(c, s.dmg ?? 0);
        } else {
          this.hit(tg, s.dmg ?? 0);
          if (T.slow) {
            tg.slow = T.slow;
            for (let i = 0; i < 4; i++) this.parts.push({ x: tg.x, y: tg.y, vx: this.rng(-0.6, 0.6), vy: this.rng(-0.6, 0.3), g: 0.02, life: 16, c: "#ffd2f0" });
          }
        }
      } else {
        s.x += (dx / d) * v;
        s.y += (dy / d) * v;
      }
    }

    this.shots = this.shots.filter((s) => s.life > 0);
    this.cards = this.cards.filter((c) => !c.gone);
    if (this.state === "wave" && !this.queue.length && !this.cards.length) {
      this.focus += 15;
      if (++this.wave >= this.waves.length) {
        this.state = "win";
        this.stateT = 0;
        this.events.push("win");
      } else {
        this.startWave();
      }
    }
  }

  private hit(c: Card, dmg: number): void {
    if (c.gone) return;
    c.hp -= dmg;
    c.flash = 4;
    if (c.hp > 0) return;
    c.gone = true;
    this.triaged++;
    const P = PRIO[c.pr];
    this.focus += P.reward;
    this.addScore(P.reward * 10);
    this.pops.push({ s: "DONE", title: c.title, c: "#8dff9a", x: c.x, y: c.y - 10, t: 0 });
    for (let i = 0; i < 12; i++) {
      this.parts.push({ x: c.x, y: c.y - 3, vx: this.rng(-1, 1), vy: this.rng(-1.6, -0.2), g: 0.08, life: 20 + (i % 8), c: ["#fffaf0", "#efe6d0", P.h][i % 3] });
    }
    this.ring(c.x, c.y - 2, "#8dff9a");
    this.events.push("triage");
  }
}
