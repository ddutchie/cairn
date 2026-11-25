/**
 * Inbox Zero simulation — pure TypeScript, platform-agnostic.
 *
 * Supports both touch (drag to preview cell + range ring, release to build,
 * drag to shop to cancel) and desktop pointer (hover to preview, click to build,
 * keys 1-4 to pick a tag), plus Duo asymmetrical rail insets and live resize.
 */

import type { Priority } from "../../types/domain";
import { DEMO_DATA, type ArcadeProject } from "../pixel/arcade-data";
import { NO_HUD, type InputMode, type PixelHud } from "../pixel/hud";
import { clamp } from "../pixel/kinds";
import { mulberry32 } from "../pixel/terrain";
import {
  CELL,
  CORE_GY,
  MAX_WAVES,
  PATH_LEN,
  PRIO,
  TAGS,
  alongFlow,
  canBuildCore,
  fullBoardLayout,
  isOnPath,
  type BoardLayout,
  type TagDef,
  type TagId,
} from "./models";

export { CELL, CORE_GX, CORE_GY, canBuildCore, isOnPath } from "./models";

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

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  life: number;
  c: string;
}

export interface Pop {
  s: string;
  title: string;
  c: string;
  x: number;
  y: number;
  t: number;
}

export interface Ring {
  x: number;
  y: number;
  r: number;
  c: string;
}

export interface Wave {
  name: string;
  accent: string;
  tasks: { title: string; pr: Priority }[];
}

export type InboxZeroEvent = "start" | "pick" | "place" | "upgrade" | "error" | "triage" | "leak" | "wave" | "win" | "over";

export interface InboxZeroSpec {
  width: number;
  height: number;
  hud?: PixelHud;
  inputMode?: InputMode;
  best?: number;
  projects?: ArcadeProject[];
  seed?: number;
}

export class InboxZeroSim {
  W: number;
  H: number;
  hud: PixelHud;
  readonly inputMode: InputMode;
  readonly rand: () => number;
  readonly waves: Wave[];

  lay: BoardLayout;
  boardGen = 1;

  state: "title" | "intro" | "wave" | "over" | "win" = "title";
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
  best = 0;
  shake = 0;
  calm = false;

  picked = 0;
  cursor: { x: number; y: number } | null = null;
  dragging = false;
  toast: { s: string; t: number } | null = null;
  readonly events: InboxZeroEvent[] = [];

  constructor(spec: InboxZeroSpec) {
    this.W = spec.width;
    this.H = spec.height;
    this.hud = spec.hud ?? NO_HUD;
    this.inputMode = spec.inputMode ?? "touch";
    this.best = spec.best ?? 0;
    this.rand = mulberry32(spec.seed ?? 42);
    const shopH = this.inputMode === "pointer" ? 40 : 32;
    this.lay = fullBoardLayout(this.W, this.H, this.hud.top, this.hud.bottom, this.hud.left, this.hud.right, shopH);

    const src = (spec.projects?.length ? spec.projects : DEMO_DATA.projects).filter((p) => p.tasks.length > 0);
    const nonEmpty = src.length ? src : DEMO_DATA.projects.filter((p) => p.tasks.length > 0);
    this.waves = nonEmpty
      .slice(0, MAX_WAVES)
      .sort((a, b) => a.tasks.length - b.tasks.length)
      .map((p) => ({
        name: p.name,
        accent: p.accent,
        tasks: p.tasks.map((t) => ({ title: t.title, pr: t.priority })),
      }));
  }

  get coreX(): number { return this.lay.coreX; }
  get coreY(): number { return this.lay.topY; }
  get topY(): number { return this.lay.topY; }
  get shopY(): number { return this.lay.shopY; }
  get shopH(): number { return this.lay.shopH; }
  get shopW(): number { return this.lay.shopW; }
  get shopX0(): number { return this.lay.shopX0; }
  get minC(): number { return this.lay.minC; }
  get maxC(): number { return this.lay.maxC; }

  private rr(a: number, b: number): number {
    return a + this.rand() * (b - a);
  }

  resize(width: number, height: number, hud?: PixelHud): void {
    const prevCoreX = this.lay.coreX;
    const prevTopY = this.lay.topY;
    if (this.W === width && this.H === height && !hud) return;
    if (hud) this.hud = hud;
    this.W = width;
    this.H = height;
    const shopH = this.inputMode === "pointer" ? 40 : 32;
    this.lay = fullBoardLayout(this.W, this.H, this.hud.top, this.hud.bottom, this.hud.left, this.hud.right, shopH);
    this.boardGen++;
    const dx = this.lay.coreX - prevCoreX;
    const dy = this.lay.topY - prevTopY;
    if (!dx && !dy) return;
    for (const c of this.cards) {
      c.x += dx;
      c.y += dy;
    }
    for (const tw of this.towers) {
      tw.x = this.lay.coreX + tw.c * CELL + CELL / 2;
      tw.y = this.lay.topY + tw.r * CELL + CELL / 2 + 2;
    }
    for (const s of this.shots) {
      s.x += dx;
      s.y += dy;
      if (s.tx !== undefined) s.tx += dx;
      if (s.ty !== undefined) s.ty += dy;
    }
    for (const p of this.parts) {
      p.x += dx;
      p.y += dy;
    }
    for (const p of this.pops) {
      p.x += dx;
      p.y += dy;
    }
    for (const r of this.rings) {
      r.x += dx;
      r.y += dy;
    }
    if (this.cursor) {
      this.cursor.x += dx;
      this.cursor.y += dy;
    }
  }

  tagAt(c: number, r: number): Tower | undefined {
    return this.towers.find((tw) => tw.c === c && tw.r === r);
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
    this.dragging = false;
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

  selectTag(idx: number): void {
    if (idx >= 0 && idx < TAGS.length) {
      this.picked = idx;
      this.events.push("pick");
    }
  }

  setKey(code: string, down: boolean): boolean {
    if (!down) return false;
    const n = /^Digit([1-4])$/.exec(code);
    if (n) {
      this.selectTag(Number(n[1]) - 1);
      return true;
    }
    if ((code === "Space" || code === "Enter") && (this.state === "title" || ((this.state === "over" || this.state === "win") && this.stateT > 60))) {
      this.cards = [];
      this.reset();
      this.events.push("start");
      return true;
    }
    return false;
  }

  private placeOrUpgradeAt(x: number, y: number): void {
    if (y >= this.lay.shopY) {
      const i = Math.floor((x - this.lay.shopX0) / this.lay.shopW);
      if (x >= this.lay.shopX0 && i >= 0 && i < TAGS.length) {
        this.picked = i;
        this.events.push("pick");
      }
      return;
    }
    const c = Math.floor((x - this.lay.coreX) / CELL);
    const r = Math.floor((y - this.lay.topY) / CELL);
    if (c < this.lay.minC || c > this.lay.maxC || r < 0 || r >= CORE_GY) return;

    const tw = this.tagAt(c, r);
    if (tw) {
      const cost = Math.round(TAGS.find((t) => t.id === tw.id)!.cost * (tw.lvl + 1) * 0.8);
      if (tw.lvl >= 2) {
        this.say("MAXED");
        this.events.push("error");
        return;
      }
      if (this.focus < cost) {
        this.say(`NEED ${cost} FOCUS`);
        this.events.push("error");
        return;
      }
      this.focus -= cost;
      tw.lvl++;
      this.ring(tw.x, tw.y, "#fff2a0");
      this.say("UPGRADED");
      this.events.push("upgrade");
      return;
    }
    if (isOnPath(c, r)) {
      this.say("THAT'S THE FLOW");
      this.events.push("error");
      return;
    }
    if (!canBuildCore(c, r)) {
      this.say("TOO FAR FROM FLOW");
      this.events.push("error");
      return;
    }
    const tag = TAGS[this.picked];
    if (this.focus < tag.cost) {
      this.say(`NEED ${tag.cost} FOCUS`);
      this.events.push("error");
      return;
    }
    this.focus -= tag.cost;
    const tx = this.lay.coreX + c * CELL + CELL / 2;
    const ty = this.lay.topY + r * CELL + CELL / 2;
    this.towers.push({ id: tag.id, c, r, x: tx, y: ty + 2, lvl: 0, a: Math.PI, cd: 0, kick: 0 });
    this.ring(tx, ty, tag.c);
    this.events.push("place");
  }

  down(x: number, y: number): void {
    this.cursor = { x, y };
    if (this.state === "title" || ((this.state === "over" || this.state === "win") && this.stateT > 60)) {
      this.cards = [];
      this.reset();
      this.events.push("start");
      return;
    }
    if (this.state === "over" || this.state === "win") return;
    if (this.inputMode === "pointer") {
      this.placeOrUpgradeAt(x, y);
      return;
    }
    if (y >= this.lay.shopY) {
      const i = Math.floor((x - this.lay.shopX0) / this.lay.shopW);
      if (x >= this.lay.shopX0 && i >= 0 && i < TAGS.length) {
        this.picked = i;
        this.events.push("pick");
      }
      this.dragging = false;
      return;
    }
    this.dragging = true;
  }

  move(x: number, y: number): void {
    this.cursor = { x, y };
  }

  cancel(): void {
    this.dragging = false;
    this.cursor = null;
  }

  up(): void {
    if (this.inputMode !== "touch" || !this.dragging || !this.cursor) {
      this.dragging = false;
      return;
    }
    const { x, y } = this.cursor;
    this.dragging = false;
    this.cursor = null;
    if (this.state !== "intro" && this.state !== "wave") return;
    if (y >= this.lay.shopY) return;
    this.placeOrUpgradeAt(x, y);
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
      this.parts.push({ x: c.x, y: c.y - 3, vx: this.rr(-1, 1), vy: this.rr(-1.6, -0.2), g: 0.08, life: 20 + (i % 8), c: ["#fffaf0", "#efe6d0", P.h][i % 3] });
    }
    this.ring(c.x, c.y - 2, "#8dff9a");
    this.events.push("triage");
  }

  private titleTick(): void {
    if (this.t % 60 === 0) {
      const pr = (["low", "medium", "high", "urgent"] as const)[((this.t / 60) | 0) % 4];
      const p0 = alongFlow(0, this.lay);
      this.cards.push({ title: "", pr, d: 0, hp: 1, max: 1, slow: 0, flash: 0, x: p0.x, y: p0.y, dir: 0 });
    }
    for (const c of this.cards) {
      c.d += 0.6;
      const p = alongFlow(c.d, this.lay);
      c.x = p.x;
      c.y = p.y;
      c.dir = p.dir;
    }
    this.cards = this.cards.filter((c) => c.d < PATH_LEN);
  }

  step(): void {
    this.t++;
    this.stateT++;
    for (const p of this.parts) {
      p.vy += p.g;
      p.x += p.vx;
      p.y += p.vy;
      p.life--;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const r of this.rings) r.r += 0.8;
    this.rings = this.rings.filter((r) => r.r < 14);
    for (const p of this.pops) p.t++;
    this.pops = this.pops.filter((p) => p.t < 60);
    if (this.toast && ++this.toast.t > 70) this.toast = null;
    if (this.shake > 0) this.shake -= 0.4;
    if (this.state === "title") {
      this.titleTick();
      return;
    }
    if (this.state === "intro" && this.stateT > 120) {
      this.state = "wave";
      this.stateT = 0;
    }
    if (this.state !== "wave" && this.state !== "intro") return;

    if (this.state === "wave" && this.queue.length && --this.spawnT <= 0) {
      const q = this.queue.shift()!;
      const P = PRIO[q.pr];
      const hp = P.hp * (1 + this.wave * 0.15);
      const p0 = alongFlow(0, this.lay);
      this.cards.push({ ...q, d: 0, hp, max: hp, slow: 0, flash: 0, x: p0.x, y: p0.y, dir: Math.PI });
      this.spawnT = 70 - this.wave * 6;
    }
    for (const c of this.cards) {
      c.d += PRIO[c.pr].v * (c.slow > 0 ? 0.45 : 1);
      if (c.slow > 0) c.slow--;
      if (c.flash > 0) c.flash--;
      const p = alongFlow(c.d, this.lay);
      c.x = p.x;
      c.y = p.y;
      c.dir = p.dir;
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
      const T = TAGS.find((x) => x.id === tw.id)!;
      const range = T.range * (1 + tw.lvl * 0.15);
      if (tw.kick > 0) tw.kick--;
      let target: Card | null = null;
      for (const c of this.cards) {
        if (!c.gone && Math.hypot(c.x - tw.x, c.y - tw.y) <= range && (!target || c.d > target.d)) target = c;
      }
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
          target,
          dmg,
          T,
          v: T.id === "batch" ? 1.8 : 3,
          life: 90,
          c: T.l,
        });
      }
    }

    for (const s of this.shots) {
      s.life--;
      if (s.beam || !s.target || !s.T) continue;
      const tg = s.target, T = s.T;
      if (tg.gone && !T.splash) {
        s.life = 0;
        continue;
      }
      const dx = tg.x - s.x, dy = tg.y - s.y, d = Math.hypot(dx, dy), v = s.v ?? 3;
      if (d < v + 1) {
        s.life = 0;
        if (T.splash) {
          this.ring(tg.x, tg.y, "#ffb347");
          for (let i = 0; i < 10; i++) {
            this.parts.push({ x: tg.x, y: tg.y, vx: this.rr(-1.2, 1.2), vy: this.rr(-1.2, 1.2), g: 0, life: 14, c: ["#fff2a0", "#ffb347", "#ef5a24"][i % 3] });
          }
          for (const c of this.cards) if (!c.gone && Math.hypot(c.x - tg.x, c.y - tg.y) <= T.splash) this.hit(c, s.dmg ?? 0);
        } else {
          this.hit(tg, s.dmg ?? 0);
          if (T.slow) {
            tg.slow = T.slow;
            for (let i = 0; i < 4; i++) {
              this.parts.push({ x: tg.x, y: tg.y, vx: this.rr(-0.6, 0.6), vy: this.rr(-0.6, 0.3), g: 0.02, life: 16, c: "#ffd2f0" });
            }
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
}
