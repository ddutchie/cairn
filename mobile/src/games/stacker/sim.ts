/**
 * Cairn Stacker simulation (pure, no Skia): a stone slides back and forth
 * above the tower; tap to drop it. The part hanging past the stone below is
 * cut off and tumbles away; a drop within `PERFECT` px snaps into place and
 * builds a combo; a full miss topples the run. Each stone is one of the
 * workspace's projects, notes, tasks or tags.
 *
 * Stones keep the sprite they were made with (`sprite`) and which slice of it
 * they still are (`sx`, `w`), so a cut really slices the carved label in two.
 */

import type { PixelHud } from "@/games/pixel/hud";
import { NO_HUD } from "@/games/pixel/hud";
import { DEMO_LABELS, clamp, type EntityKind, type Label } from "@/games/pixel/kinds";

/** Stone height: 3px top face + 8px front. */
export const SH = 11;
/** Misalignment (px) that still counts as perfect. */
export const PERFECT = 2;
/** Stones of climb from day to full night. */
export const SKY_LEVELS = 70;

export type StackerState = "title" | "play" | "over";
export type StackerEvent = "start" | "drop" | "perfect" | "slice" | "over";

/** A carved stone sprite: drawn once at `w0` wide, sliced by the stones that use it. */
export interface StoneSprite {
  id: number;
  w0: number;
  kind: EntityKind;
  label: string;
  seed: number;
}

export interface Stone {
  sprite: StoneSprite;
  /** Slice of the sprite still in this stone. */
  sx: number;
  w: number;
  /** Left edge (screen x) and level (0 = the base). */
  x: number;
  lvl: number;
  /** Which edge was cut, so the renderer gives it a fresh outline. */
  cut: "left" | "right" | null;
}

export interface Debris {
  sprite: StoneSprite;
  sx: number;
  w: number;
  cut: "left" | "right" | null;
  /** Centre, velocity, angle. */
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

export class StackerSim {
  readonly W: number;
  readonly H: number;
  readonly hud: PixelHud;
  /** Screen y of the ground at camera 0. */
  readonly ground: number;
  readonly baseW: number;
  private readonly labels: Label[];
  private readonly rand: () => number;

  state: StackerState = "title";
  t = 0;
  stateT = 0;
  tower: Stone[] = [];
  mover: (Stone & { dir: number }) | null = null;
  debris: Debris[] = [];
  parts: Particle[] = [];
  /** Perfect-drop rings, aged per frame. */
  rings: { x: number; y: number; w: number; t: number }[] = [];
  /** Latest combo callout. */
  pop: { s: string; x: number; y: number; t: number } | null = null;
  score = 0;
  best: number;
  newBest = false;
  combo = 0;
  speed = 0;
  cam = 0;
  camT = 0;
  shake = 0;
  freeze = 0;
  squash = 0;
  calm = false;
  events: StackerEvent[] = [];
  private labelI = 0;
  private side = 0;
  private spriteId = 0;

  constructor(opts: { width: number; height: number; hud?: PixelHud; best?: number; labels?: Label[]; rand?: () => number }) {
    this.W = opts.width;
    this.H = opts.height;
    this.hud = opts.hud ?? NO_HUD;
    this.ground = this.H - Math.max(36, this.hud.bottom + 26);
    this.baseW = Math.min(132, Math.round(this.W * 0.58));
    this.best = opts.best ?? 0;
    this.labels = opts.labels?.length ? opts.labels : DEMO_LABELS;
    this.rand = opts.rand ?? Math.random;
  }

  private rr(a: number, b: number): number {
    return a + this.rand() * (b - a);
  }
  /** Sky progress, 0 (day) … 1 (night). */
  get altitude(): number {
    return clamp(this.cam / (SH * SKY_LEVELS), 0, 1);
  }
  /** Screen y of a stone's top edge. */
  levelY(lvl: number): number {
    return this.ground - (lvl + 1) * SH + this.cam;
  }
  get top(): Stone {
    return this.tower[this.tower.length - 1];
  }

  private sprite(w: number, l: Label, lvl: number): StoneSprite {
    return { id: ++this.spriteId, w0: Math.round(w), kind: l.kind, label: l.label, seed: lvl * 7 + 3 };
  }
  private nextLabel(): Label {
    return this.labels[this.labelI++ % this.labels.length];
  }

  // ── Flow ───────────────────────────────────────────────────────────────────
  private reset(): void {
    const base = this.sprite(this.baseW, { label: "Workspace", kind: "project" }, 0);
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
    const sp = this.sprite(top.w, this.nextLabel(), top.lvl + 1);
    this.mover = { sprite: sp, sx: 0, w: sp.w0, x: this.side ? -top.w * 0.6 : this.W - top.w * 0.4, lvl: top.lvl + 1, cut: null, dir: this.side ? 1 : -1 };
  }

  /** Tap: start, drop, or retry once the topple has settled. */
  tap(): void {
    if (this.state === "title" || (this.state === "over" && this.stateT > 40)) {
      this.state = "play";
      this.stateT = 0;
      this.reset();
      this.events.push("start");
    } else if (this.state === "play") this.drop();
  }

  private drop(): void {
    const top = this.top, m = this.mover;
    if (!m) return;
    if (Math.abs(m.x - top.x) <= PERFECT) {
      m.x = top.x;
      this.combo++;
      this.tower.push({ sprite: m.sprite, sx: 0, w: m.w, x: m.x, lvl: m.lvl, cut: null });
      const y = this.levelY(m.lvl);
      this.rings.push({ x: m.x, y, w: m.w, t: 0 });
      this.pop = { s: this.combo > 1 ? `PERFECT x${this.combo}` : "PERFECT", x: m.x + m.w / 2, y: y - 6, t: 0 };
      if (!this.calm) this.freeze = 3;
      for (let i = 0; i < 10; i++)
        this.parts.push({ x: m.x + this.rand() * m.w, y, vx: this.rr(-0.6, 0.6), vy: this.rr(-1.4, -0.4), life: 24, c: i % 2 ? "#ffb347" : "#fff2a0" });
      this.events.push("perfect");
    } else {
      const left = Math.max(m.x, top.x), right = Math.min(m.x + m.w, top.x + top.w), w = Math.round(right - left);
      this.combo = 0;
      if (w <= 0) return this.lose();
      // The overhang is on the left when the stone landed left of the one below.
      const overLeft = m.x < top.x, keepSx = overLeft ? m.w - w : 0, offW = m.w - w;
      const y = this.levelY(m.lvl);
      this.debris.push({
        sprite: m.sprite, sx: overLeft ? 0 : w, w: offW, cut: overLeft ? "right" : "left",
        x: (overLeft ? m.x : left + w) + offW / 2, y: y + SH / 2,
        vx: (overLeft ? -0.5 : 0.5) + m.dir * 0.3, vy: -0.6, a: 0, va: (overLeft ? -1 : 1) * this.rr(0.04, 0.08),
      });
      this.tower.push({ sprite: m.sprite, sx: keepSx, w, x: Math.round(left), lvl: m.lvl, cut: overLeft ? "left" : "right" });
      if (!this.calm) this.shake = 3;
      this.dust(overLeft ? left : left + w, y + SH - 2, "#c9b48a");
      this.events.push("slice");
    }
    this.score++;
    this.squash = 6;
    this.speed = Math.min(3.1 * (this.W / 180), this.speed + 0.045);
    // Keep the top of the tower a little below the middle of the screen.
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
    this.debris.push({ sprite: m.sprite, sx: 0, w: m.w, cut: null, x: m.x + m.w / 2, y: y + SH / 2, vx: m.dir * 0.8, vy: -0.4, a: 0, va: m.dir * 0.05 });
    this.mover = null;
    this.state = "over";
    this.stateT = 0;
    if (!this.calm) this.shake = 8;
    this.dust(m.x + m.w / 2, y + SH, "#c9b48a");
    this.events.push("over");
  }
  private dust(x: number, y: number, c: string): void {
    for (let i = 0; i < 12; i++)
      this.parts.push({ x: x + this.rr(-3, 3), y, vx: this.rr(-1, 1), vy: this.rr(-1, 0), life: 20 + (i % 8), c: i % 3 ? c : "#e8e0cc" });
  }

  // ── Step ───────────────────────────────────────────────────────────────────
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
      const lo = -m.w * 0.6, hi = this.W - m.w * 0.4;
      if (m.x < lo) {
        m.x = lo;
        m.dir = 1;
      } else if (m.x > hi) {
        m.x = hi;
        m.dir = -1;
      }
    }
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
