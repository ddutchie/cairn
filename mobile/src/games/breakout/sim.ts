/**
 * Cairn Breakout simulation (pure, no Skia). One ball, +1 a brick, the streak
 * resets on the paddle, clear the board to win, drop the ball to lose. Bricks
 * are the workspace's projects, notes, tasks and tags; they float over a
 * slowly drifting island (a different biome each board). The ball waits on
 * the paddle until a tap; the paddle follows the finger.
 */

import type { PixelHud } from "@/games/pixel/hud";
import { NO_HUD } from "@/games/pixel/hud";
import { DEMO_LABELS, KINDS, clamp, type EntityKind, type Label } from "@/games/pixel/kinds";
import { BIOME_ORDER, CHUNK, Terrain } from "@/games/pixel/terrain";

/** Brick footprint (the hit box) and grid pitch. */
export const BW = 26;
export const BH = 10;
export const GAP_X = 28;
export const GAP_Y = 12;
export const ROWS = 7;
export const MIN_COLS = 6;
export const MAX_COLS = 10;
export const PAD_W = 32;
export const BALL_R = 2;
export const BASE_SPEED = 2.1;

export type BreakoutState = "title" | "play" | "over" | "win";
export type BreakoutEvent = "start" | "launch" | "brick" | "streak" | "paddle" | "over" | "win";

export interface Brick {
  x: number;
  y: number;
  kind: EntityKind;
  label: string;
  /** Idle bob phase. */
  ph: number;
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
  x: number;
  y: number;
  t: number;
  c: string;
  big: boolean;
}

export class BreakoutSim {
  readonly W: number;
  readonly H: number;
  readonly hud: PixelHud;
  /** Walls: the playfield between the side insets, below the HUD row. */
  readonly left: number;
  readonly right: number;
  readonly ceiling: number;
  readonly padY: number;
  readonly cols: number;
  private readonly labels: Label[];
  private readonly rand: () => number;

  state: BreakoutState = "title";
  t = 0;
  stateT = 0;
  bricks: Brick[] = [];
  ball = { x: 0, y: 0, vx: 0, vy: 0, stuck: true };
  pad = { x: 0, tx: 0, vx: 0 };
  trail: { x: number; y: number }[] = [];
  parts: Particle[] = [];
  pops: Pop[] = [];
  score = 0;
  best: number;
  newBest = false;
  streak = 0;
  shake = 0;
  freeze = 0;
  calm = false;
  camR = 0;
  terrain: Terrain;
  /** Bumped when `terrain` is replaced, so the renderer drops its chunk cache. */
  terrainGen = 0;
  private boards = 0;
  events: BreakoutEvent[] = [];

  constructor(opts: { width: number; height: number; hud?: PixelHud; best?: number; labels?: Label[]; rand?: () => number }) {
    this.W = opts.width;
    this.H = opts.height;
    this.hud = opts.hud ?? NO_HUD;
    this.left = this.hud.left;
    this.right = this.W - this.hud.right;
    this.ceiling = this.hud.top + 18;
    this.padY = this.H - Math.max(34, this.hud.bottom + 24);
    this.cols = clamp(Math.floor((this.right - this.left - 8) / GAP_X), MIN_COLS, MAX_COLS);
    this.best = opts.best ?? 0;
    this.labels = opts.labels?.length ? opts.labels : DEMO_LABELS;
    this.rand = opts.rand ?? Math.random;
    this.pad.x = this.pad.tx = (this.left + this.right) / 2;
    this.terrain = new Terrain(this.W, "tropic", 11);
    this.layout();
  }

  private rr(a: number, b: number): number {
    return a + this.rand() * (b - a);
  }

  /** The brick grid, centred in the playfield. */
  layout(): void {
    const x0 = (this.left + this.right - (this.cols - 1) * GAP_X) / 2, y0 = this.ceiling + 26;
    this.bricks = [];
    for (let r = 0, i = 0; r < ROWS; r++)
      for (let c = 0; c < this.cols; c++, i++) {
        const l = this.labels[i % this.labels.length];
        this.bricks.push({ x: x0 + c * GAP_X, y: y0 + r * GAP_Y, kind: l.kind, label: l.label, ph: (c + r) * 0.7 });
      }
  }

  private reset(): void {
    this.layout();
    this.score = 0;
    this.streak = 0;
    this.parts = [];
    this.pops = [];
    this.trail = [];
    this.newBest = false;
    Object.assign(this.ball, { x: this.pad.x, y: this.padY - 8, vx: 0, vy: 0, stuck: true });
    // A new island under every board.
    this.boards++;
    this.terrain = new Terrain(this.W, BIOME_ORDER[this.boards % BIOME_ORDER.length], 11 + this.boards * 7);
    this.terrainGen++;
    this.camR = 0;
  }

  /** Tap: start, launch the waiting ball, or play again once the result has settled. */
  tap(): void {
    if (this.state === "title" || ((this.state === "over" || this.state === "win") && this.stateT > 40)) {
      this.state = "play";
      this.stateT = 0;
      this.reset();
      this.events.push("start");
    } else if (this.state === "play" && this.ball.stuck) {
      this.ball.stuck = false;
      this.ball.vx = BASE_SPEED * (this.pad.vx >= 0 ? 0.45 : -0.45);
      this.ball.vy = -BASE_SPEED;
      this.events.push("launch");
    }
  }

  /** Point the paddle at a finger x (game pixels). */
  aim(x: number): void {
    this.pad.tx = x;
  }

  step(): void {
    this.t++;
    this.stateT++;
    this.camR += 0.12;
    this.terrain.pump(Math.floor(this.camR) + this.H + CHUNK, 3);
    if (this.freeze > 0) {
      this.freeze--;
      return;
    }
    const pad = this.pad;
    const nx = pad.x + (clamp(pad.tx, this.left + PAD_W / 2 + 2, this.right - PAD_W / 2 - 2) - pad.x) * 0.45;
    pad.vx = nx - pad.x;
    pad.x = nx;
    for (const p of this.parts) {
      p.vy += p.g;
      p.x += p.vx;
      p.y += p.vy;
      p.life--;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const p of this.pops) p.t++;
    this.pops = this.pops.filter((p) => p.t < 46);
    if (this.shake > 0) this.shake -= 0.5;
    if (this.state !== "play") return;

    const b = this.ball;
    if (b.stuck) {
      b.x = pad.x;
      b.y = this.padY - 8;
      return;
    }
    this.trail.push({ x: b.x, y: b.y });
    if (this.trail.length > 6) this.trail.shift();
    // Two half-steps a frame so a fast ball can't skip a 10px brick.
    for (let s = 0; s < 2; s++) {
      b.x += b.vx / 2;
      b.y += b.vy / 2;
      if (b.x < this.left + BALL_R + 1) {
        b.x = this.left + BALL_R + 1;
        b.vx = Math.abs(b.vx);
        this.wallPing(b.x - 2, b.y);
      }
      if (b.x > this.right - BALL_R - 1) {
        b.x = this.right - BALL_R - 1;
        b.vx = -Math.abs(b.vx);
        this.wallPing(b.x + 2, b.y);
      }
      if (b.y < this.ceiling) {
        b.y = this.ceiling;
        b.vy = Math.abs(b.vy);
        this.wallPing(b.x, b.y - 2);
      }
      // Paddle: where it hits sets the angle.
      if (b.vy > 0 && b.y + BALL_R >= this.padY - 5 && b.y < this.padY + 2 && Math.abs(b.x - pad.x) <= PAD_W / 2 + BALL_R) {
        const hit = clamp((b.x - pad.x) / (PAD_W / 2), -1, 1);
        const sp = Math.hypot(b.vx, b.vy);
        b.vx = hit * BASE_SPEED * 1.15 + pad.vx * 0.15;
        b.vy = -Math.sqrt(Math.max(sp * sp - b.vx * b.vx, sp * sp * 0.3));
        b.y = this.padY - 5 - BALL_R;
        this.streak = 0;
        for (let i = 0; i < 5; i++)
          this.parts.push({ x: b.x + this.rr(-3, 3), y: this.padY - 4, vx: this.rr(-0.6, 0.6), vy: this.rr(-0.8, -0.2), g: 0.05, life: 12, c: i % 2 ? "#a8f4ff" : "#2ec4b6" });
        this.events.push("paddle");
      }
      if (this.hitBrick()) break;
    }
    if (b.y > this.H + 6) {
      this.state = "over";
      this.stateT = 0;
      if (!this.calm) this.shake = 6;
      this.trail = [];
      this.events.push("over");
    }
  }

  /** Brick hit box: the block's footprint, raised 2px for its stacked height. */
  static box(br: Brick): { l: number; r: number; t: number; b: number } {
    return { l: br.x - BW / 2, r: br.x + BW / 2, t: br.y - BH / 2 - 2, b: br.y + BH / 2 - 2 };
  }

  private hitBrick(): boolean {
    const b = this.ball;
    for (let i = 0; i < this.bricks.length; i++) {
      const box = BreakoutSim.box(this.bricks[i]);
      if (b.x + BALL_R < box.l || b.x - BALL_R > box.r || b.y + BALL_R < box.t || b.y - BALL_R > box.b) continue;
      // A side hit if the ball came in mostly sideways, else top / bottom.
      const ox = Math.min(b.x + BALL_R - box.l, box.r - (b.x - BALL_R)), oy = Math.min(b.y + BALL_R - box.t, box.b - (b.y - BALL_R));
      if (ox < oy) b.vx = -b.vx;
      else b.vy = -b.vy;
      const [br] = this.bricks.splice(i, 1);
      this.breakBrick(br);
      return true;
    }
    return false;
  }

  breakBrick(br: Brick): void {
    this.score++;
    this.streak++;
    if (this.score > this.best) {
      this.best = this.score;
      this.newBest = true;
    }
    const K = KINDS[br.kind];
    for (let i = 0; i < 16; i++)
      this.parts.push({ x: br.x + this.rr(-11, 11), y: br.y + this.rr(-4, 2), vx: this.rr(-1.2, 1.2), vy: this.rr(-1.6, 0.2), g: 0.09, life: 22 + (i % 10), c: [K.l, K.h, K.d, "#ffffff"][i % 4] });
    this.pops.push({ s: `${K.name}: ${br.label}`, x: br.x, y: br.y - 8, t: 0, c: K.l, big: false });
    if (this.streak >= 3) this.pops.push({ s: `x${this.streak}`, x: br.x, y: br.y + 2, t: 0, c: this.streak >= 6 ? "#ffb347" : "#fff2a0", big: true });
    if (this.pops.length > 4) this.pops.splice(0, this.pops.length - 4);
    if (!this.calm) {
      this.shake = Math.min(4, 1.5 + this.streak * 0.3);
      this.freeze = this.streak >= 5 ? 3 : 1;
    }
    // A gentle speed-up keeps the late game from dragging.
    const b = this.ball, sp = Math.hypot(b.vx, b.vy);
    if (sp > 0) {
      const k = Math.min(BASE_SPEED * 1.45, sp + 0.02) / sp;
      b.vx *= k;
      b.vy *= k;
    }
    this.events.push(this.streak >= 3 ? "streak" : "brick");
    if (!this.bricks.length) {
      this.state = "win";
      this.stateT = 0;
      this.freeze = 10;
      this.events.push("win");
    }
  }

  private wallPing(x: number, y: number): void {
    for (let i = 0; i < 3; i++) this.parts.push({ x, y, vx: this.rr(-0.5, 0.5), vy: this.rr(-0.5, 0.5), g: 0, life: 8, c: "#c7d0e6" });
  }
}
