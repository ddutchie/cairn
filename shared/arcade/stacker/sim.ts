/**
 * Cairn Stacker simulation — pure TypeScript, platform-agnostic.
 *
 * A stone slides horizontally; tap/click/Space drops it onto the tower below.
 * Overhang is sliced off into falling spinning debris; near-perfect alignment
 * snaps cleanly and builds a combo multiplier.
 */

import { NO_HUD, type InputMode, type PixelHud } from "../pixel/hud";
import { DEMO_LABELS, type Label } from "../pixel/kinds";
import { mulberry32 } from "../pixel/terrain";
import { BASE_W, PERFECT, SH } from "./sprites";

export type StackerEvent = "start" | "drop" | "perfect" | "slice" | "over";

export interface StoneSpec {
  id: number;
  w0: number;
  kind: Label["kind"];
  label: string;
  seed: number;
}

export interface Stone {
  sprite: StoneSpec;
  sx: number;
  w: number;
  x: number;
  lvl: number;
  cut: "left" | "right" | null;
}

export interface Mover extends Stone {
  dir: number;
}

export interface Debris {
  sprite: StoneSpec;
  sx: number;
  w: number;
  cut: "left" | "right" | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  a: number;
  va: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  c: string;
}

export interface Ring {
  x: number;
  y: number;
  w: number;
  t: number;
}

export interface Pop {
  s: string;
  x: number;
  y: number;
  t: number;
}

export { PERFECT, SH } from "./sprites";
export const SKY_LEVELS = 70;

export interface StackerSpec {
  width: number;
  height: number;
  hud?: PixelHud;
  inputMode?: InputMode;
  best?: number;
  labels?: Label[];
  seed?: number;
  rand?: () => number;
}

export class StackerSim {
  W: number;
  H: number;
  hud: PixelHud;
  readonly inputMode: InputMode;
  readonly labels: Label[];
  readonly rand: () => number;

  ground: number;
  baseW: number;

  state: "title" | "play" | "over" = "title";
  t = 0;
  stateT = 0;
  tower: Stone[] = [];
  mover: Mover | null = null;
  debris: Debris[] = [];
  parts: Particle[] = [];
  rings: Ring[] = [];
  pop: Pop | null = null;

  score = 0;
  best = 0;
  combo = 0;
  speed = 1.25;
  labelI = 0;
  side = 0;
  cam = 0;
  camT = 0;
  shake = 0;
  freeze = 0;
  squash = 0;
  newBest = false;
  calm = false;

  readonly demo: { spec: StoneSpriteSpec & { w0: number }; xOff: number }[];
  readonly events: StackerEvent[] = [];
  private nextSpriteId = 1;

  constructor(spec: StackerSpec) {
    this.W = spec.width;
    this.H = spec.height;
    this.hud = spec.hud ?? NO_HUD;
    this.inputMode = spec.inputMode ?? "touch";
    this.best = spec.best ?? 0;
    this.labels = spec.labels?.length ? spec.labels : DEMO_LABELS;
    this.rand = spec.rand ?? mulberry32(spec.seed ?? 90210);

    this.ground = this.H - Math.max(44, this.hud.bottom + 36);
    const topLvl = this.mover ? this.mover.lvl : this.tower.length ? this.tower[this.tower.length - 1].lvl + 1 : 1;
    const keepY = Math.round(this.H * 0.42);
    this.camT = Math.max(0, keepY - (this.ground - (topLvl + 1) * SH));
    this.cam = this.camT;
    this.baseW = Math.min(BASE_W, Math.round(this.W * 0.56));

    const demoSpecs: [string, Label["kind"], number][] = [
      ["WORKSPACE", "project", 104],
      ["RELEASE CHECKLIST", "note", 92],
      ["FIX SYNC CONFLICT", "card", 84],
      ["URGENT", "tag", 70],
      ["CAIRN", "project", 58],
    ];
    this.demo = demoSpecs.map(([label, kind, w], i) => {
      const l = i === 0 ? { label, kind } : this.labels.find((x) => x.kind === kind) ?? { label, kind };
      const wScaled = Math.min(w, Math.round(this.W * (w / 180)));
      return {
        spec: this.makeSpec(wScaled, l, i * 7 + 3),
        xOff: i % 2 ? 2 : -1,
      };
    });
  }

  private rr(a: number, b: number): number {
    return a + this.rand() * (b - a);
  }

  private makeSpec(w0: number, l: Label, seed: number): StoneSpec {
    return { id: this.nextSpriteId++, w0: Math.max(1, Math.round(w0)), kind: l.kind, label: l.label, seed };
  }

  private nextLabel(): Label {
    return this.labels[this.labelI++ % this.labels.length];
  }

  get top(): Stone {
    return this.tower[this.tower.length - 1];
  }

  get altitude(): number {
    return Math.max(0, Math.min(1, this.cam / (SH * SKY_LEVELS)));
  }

  levelY(lvl: number): number {
    return this.ground - (lvl + 1) * SH + this.cam;
  }

  resize(width: number, height: number): void {
    const prevW = this.W;
    if (prevW === width && this.H === height) return;
    const dx = (width - prevW) / 2;
    this.W = width;
    this.H = height;
    this.ground = this.H - Math.max(44, this.hud.bottom + 36);
    const topLvl = this.mover ? this.mover.lvl : this.tower.length ? this.tower[this.tower.length - 1].lvl + 1 : 1;
    const keepY = Math.round(this.H * 0.42);
    this.camT = Math.max(0, keepY - (this.ground - (topLvl + 1) * SH));
    this.cam = this.camT;
    if (dx) {
      for (const s of this.tower) s.x += dx;
      if (this.mover) this.mover.x += dx;
      for (const d of this.debris) d.x += dx;
      for (const r of this.rings) r.x += dx;
      for (const p of this.parts) p.x += dx;
      if (this.pop) this.pop.x += dx;
    }
  }

  private reset(): void {
    const base = this.makeSpec(this.baseW, { label: "WORKSPACE", kind: "project" }, 0);
    this.tower = [{ sprite: base, sx: 0, w: base.w0, x: Math.round((this.W - base.w0) / 2), lvl: 0, cut: null }];
    this.debris = [];
    this.parts = [];
    this.rings = [];
    this.pop = null;
    this.score = 0;
    this.combo = 0;
    this.speed = 1.25 * (this.W / 180);
    this.labelI = 0;
    this.side = 0;
    this.cam = this.camT = 0;
    this.newBest = false;
    this.spawn();
  }

  private spawn(): void {
    const top = this.top;
    this.side ^= 1;
    const sp = this.makeSpec(top.w, this.nextLabel(), (top.lvl + 1) * 7 + 3);
    this.mover = {
      sprite: sp,
      sx: 0,
      w: sp.w0,
      x: this.side ? -top.w * 0.6 : this.W - top.w * 0.4,
      lvl: top.lvl + 1,
      cut: null,
      dir: this.side ? 1 : -1,
    };
  }

  /** Tap/Space: start, drop, or retry once the topple has settled. */
  tap(): void {
    if (this.state === "title" || (this.state === "over" && this.stateT > 40)) {
      this.state = "play";
      this.stateT = 0;
      this.reset();
      this.events.push("start");
    } else if (this.state === "play") {
      this.drop();
    }
  }

  private drop(): void {
    const top = this.top;
    const m = this.mover;
    if (!m) return;
    if (Math.abs(m.x - top.x) <= PERFECT) {
      m.x = top.x;
      this.combo++;
      this.tower.push({ sprite: m.sprite, sx: 0, w: m.w, x: m.x, lvl: m.lvl, cut: null });
      const y = this.levelY(m.lvl);
      this.rings.push({ x: m.x, y, w: m.w, t: 0 });
      this.pop = { s: this.combo > 1 ? `PERFECT x${this.combo}` : "PERFECT", x: m.x + m.w / 2, y: y - 6, t: 0 };
      if (!this.calm) this.freeze = 3;
      for (let i = 0; i < 10; i++) {
        this.parts.push({ x: m.x + this.rand() * m.w, y, vx: this.rr(-0.6, 0.6), vy: this.rr(-1.4, -0.4), life: 24, c: i % 2 ? "#ffb347" : "#fff2a0" });
      }
      this.events.push("perfect");
    } else {
      const left = Math.max(m.x, top.x);
      const right = Math.min(m.x + m.w, top.x + top.w);
      const w = Math.round(right - left);
      this.combo = 0;
      if (w <= 0) return this.lose();
      const overLeft = m.x < top.x;
      const keepSx = overLeft ? m.w - w : 0;
      const offW = m.w - w;
      const y = this.levelY(m.lvl);
      this.debris.push({
        sprite: m.sprite,
        sx: overLeft ? 0 : w,
        w: offW,
        cut: overLeft ? "right" : "left",
        x: (overLeft ? m.x : left + w) + offW / 2,
        y: y + SH / 2,
        vx: (overLeft ? -0.5 : 0.5) + m.dir * 0.3,
        vy: -0.6,
        a: 0,
        va: (overLeft ? -1 : 1) * this.rr(0.04, 0.08),
      });
      this.tower.push({ sprite: m.sprite, sx: keepSx, w, x: Math.round(left), lvl: m.lvl, cut: overLeft ? "left" : "right" });
      if (!this.calm) this.shake = 3;
      this.dust(overLeft ? left : left + w, y + SH - 2, "#c9b48a");
      this.events.push("slice");
    }
    this.score++;
    this.squash = 6;
    this.speed = Math.min(3.1 * (this.W / 180), this.speed + 0.045);
    this.camT = Math.max(0, (this.tower.length - 1) * SH - (this.ground - Math.round(this.H * 0.47)));
    if (this.score > this.best) {
      this.best = this.score;
      this.newBest = true;
    }
    this.events.push("drop");
    this.spawn();
  }

  private lose(): void {
    const m = this.mover!;
    const y = this.levelY(m.lvl);
    this.debris.push({
      sprite: m.sprite,
      sx: 0,
      w: m.w,
      cut: null,
      x: m.x + m.w / 2,
      y: y + SH / 2,
      vx: m.dir * 0.8,
      vy: -0.4,
      a: 0,
      va: m.dir * 0.05,
    });
    this.mover = null;
    this.state = "over";
    this.stateT = 0;
    if (!this.calm) this.shake = 8;
    this.dust(m.x + m.w / 2, y + SH, "#c9b48a");
    this.events.push("over");
  }

  private dust(x: number, y: number, c: string): void {
    for (let i = 0; i < 12; i++) {
      this.parts.push({ x: x + this.rr(-3, 3), y, vx: this.rr(-1, 1), vy: this.rr(-1, 0), life: 20 + (i % 8), c: i % 3 ? c : "#e8e0cc" });
    }
  }

  step(): void {
    this.t++;
    this.stateT++;
    if (this.freeze > 0) {
      this.freeze--;
      return;
    }
    const m = this.mover;
    if (this.state === "play" && m) {
      m.x += m.dir * this.speed;
      const lo = -m.w * 0.6;
      const hi = this.W - m.w * 0.4;
      if (m.x < lo) {
        m.x = lo;
        m.dir = 1;
      } else if (m.x > hi) {
        m.x = hi;
        m.dir = -1;
      }
    }
    if (this.state === "title") this.camT = 0;
    this.cam += (this.camT - this.cam) * 0.12;
    for (const d of this.debris) {
      d.vy += 0.16;
      d.x += d.vx;
      d.y += d.vy;
      d.a += d.va;
    }
    this.debris = this.debris.filter((d) => d.y < this.H + 40);
    for (const p of this.parts) {
      p.vy += 0.06;
      p.x += p.vx;
      p.y += p.vy;
      p.life--;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const r of this.rings) r.t++;
    this.rings = this.rings.filter((r) => r.t < 16);
    if (this.pop && ++this.pop.t >= 50) this.pop = null;
    if (this.shake > 0) this.shake -= 0.5;
    if (this.squash > 0) this.squash--;
  }
}

type StoneSpriteSpec = StoneSpec;
