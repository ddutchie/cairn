/**
 * Powder Run simulation — 3D halfpipe snowboarding per Cairn project.
 * Pure TypeScript.
 *
 * The loop: carve the pipe for speed, launch off the lips and kickers, pick
 * tricks by direction (they take time to rotate), and land them to bank the
 * points you're holding. Land mid-rotation and you bail: the points are lost
 * and so is a heart. Tasks sit higher on the walls the more they matter, so
 * the valuable line is the risky one. Gems are the score and tricks multiply
 * them; gems taken in the air are held until a clean landing. Each project is
 * a run that ends with a grade; three bails and the run is over.
 */

import type { Priority } from "../../types/domain";
import { DEMO_DATA, type ArcadeProject } from "../pixel/arcade-data";
import { hudFrame, NO_HUD, type InputMode, type PixelHud } from "../pixel/hud";
import { clamp } from "../pixel/kinds";
import { mulberry32 } from "../pixel/terrain";

export const PIPE_HALF_W = 86;
export const PIPE_WALL_H = 44;
export const RUN_LEN = 3200;
export const MAX_HEARTS = 3;
export const GRAVITY = 0.14;
/** The chain keeps counting, but its multiplier stops here. */
export const MAX_CHAIN = 5;

/** Downhill speed: where it settles, and its limits. */
export const CRUISE = 3.6;
export const MIN_SPEED = 2.2;
export const MAX_SPEED = 6.8;

export type PowderState = "title" | "intro" | "ride" | "clear" | "over" | "win";
export type PowderEvent = "start" | "collect" | "note" | "trick" | "land" | "bail" | "hurt" | "clear" | "over" | "win";

export type TrickKind = "spin-l" | "spin-r" | "flip" | "grab";
export interface TrickDef {
  name: string;
  /** Frames to complete. Landing before the trick finishes is a bail. */
  frames: number;
  pts: number;
}
export const TRICK_DEFS: Record<TrickKind, TrickDef> = {
  "spin-l": { name: "360", frames: 30, pts: 40 },
  "spin-r": { name: "360", frames: 30, pts: 40 },
  flip: { name: "BACKFLIP", frames: 36, pts: 60 },
  grab: { name: "METHOD", frames: 16, pts: 25 },
};
/** Kept for the menu blurb and older callers. */
export const TRICKS = ["360", "720", "BACKFLIP", "METHOD", "SPIN FLIP"] as const;

/** What a gem is worth: the gems are the score, tricks only multiply them. */
export const TASK_PTS: Record<Priority, number> = { low: 100, medium: 200, high: 350, urgent: 600 };
export const NOTE_PTS = 500;
/**
 * How far a gem floats above the snow. Low ones you can scoop riding; high
 * and urgent ones are out of reach unless you jump, and anything taken in the
 * air is only banked by a clean landing.
 */
export const TASK_LIFT: Record<Priority, number> = { low: 6, medium: 6, high: 15, urgent: 26 };
export const NOTE_LIFT = 24;
const TASK_LINE: Record<Priority, number> = { low: 0.25, medium: 0.45, high: 0.62, urgent: 0.78 };

export type Grade = "S" | "A" | "B" | "C";
export const GRADE_BONUS: Record<Grade, number> = { S: 3000, A: 1500, B: 700, C: 200 };

/** Time of day per run, cycling through the projects. */
export type RunSky = "dawn" | "day" | "dusk" | "night";
export const RUN_SKIES: RunSky[] = ["day", "dusk", "night", "dawn"];

export interface PipeItem {
  id: number;
  kind: "task" | "note" | "boulder" | "ramp";
  x: number;
  y: number;
  pr: Priority;
  title: string;
  taken: boolean;
}

export interface PowderPop {
  text: string;
  color: string;
  x: number;
  y: number;
  z: number;
  life: number;
}

export interface RunResult {
  grade: Grade;
  collected: number;
  total: number;
  frames: number;
  bails: number;
  bestChain: number;
  bonus: number;
}

export interface PowderSpec {
  width: number;
  height: number;
  hud?: PixelHud;
  inputMode?: InputMode;
  best?: number;
  projects?: ArcadeProject[];
}

/** U-shaped halfpipe cross-section height at lateral x (world Z). */
export function pipeWallZ(x: number): number {
  const u = clamp(Math.abs(x) / PIPE_HALF_W, 0, 1);
  return Math.pow(u, 2.3) * PIPE_WALL_H;
}

/** Halfpipe floor/wall Z at world (x, y) — gentle continuous downhill slope. */
export function pipeHeightAt(x: number, y: number): number {
  return Math.max(0, 380 - y * 0.11) + pipeWallZ(x);
}

/** A run's grade: how much of the project you collected, and how cleanly. */
export function gradeRun(collected: number, total: number, bails: number): Grade {
  const share = total > 0 ? collected / total : 1;
  if (share >= 0.85 && bails === 0) return "S";
  if (share >= 0.7 && bails <= 1) return "A";
  if (share >= 0.45) return "B";
  return "C";
}

export class PowderRunSim {
  W: number;
  H: number;
  hud: PixelHud;
  readonly inputMode: InputMode;
  readonly projects: ArcadeProject[];
  rand = mulberry32(42);

  state: PowderState = "title";
  stateT = 0;
  t = 0;
  calm = false;
  shake = 0;
  flash = 0;
  score = 0;
  best: number;
  levelIdx = 0;
  hearts = MAX_HEARTS;
  events: PowderEvent[] = [];

  rider = {
    x: 0,
    y: 40,
    z: pipeHeightAt(0, 40),
    vx: 0,
    /** Downhill speed (world units per frame). */
    vy: CRUISE,
    vz: 0,
    yaw: 0,
    roll: 0,
    pitch: 0,
    air: false,
    airT: 0,
    inv: 0,
  };

  /** The trick rotating right now, and how far through it is (0…1). */
  trick: TrickKind | null = null;
  trickT = 0;
  /** Tricks finished this jump, and the points they hold until landing. */
  held: string[] = [];
  heldPts = 0;
  /** Gems taken in the air: held with the tricks, banked on a clean landing. */
  heldGems = 0;
  /** Clean landings in a row; multiplies what each landing banks. */
  chain = 0;
  bestChain = 0;
  collected = 0;
  totalCollect = 0;
  runFrames = 0;
  /** Frame the line was crossed; an airborne rider finishes only once they land. */
  private finishAt: number | null = null;
  bails = 0;
  result: RunResult | null = null;
  items: PipeItem[] = [];
  pops: PowderPop[] = [];
  /** Score when this run began, restored on a retry. */
  private runStartScore = 0;

  private keys = new Set<string>();
  private steerTarget: number | null = null;
  private dragMoved = false;
  private downPos: { x: number; y: number } | null = null;
  private lastPos: { x: number; y: number } | null = null;

  constructor(spec: PowderSpec) {
    this.W = spec.width;
    this.H = spec.height;
    this.hud = spec.hud ?? NO_HUD;
    this.inputMode = spec.inputMode ?? "touch";
    this.best = spec.best ?? 0;
    this.projects = spec.projects?.length ? spec.projects : DEMO_DATA.projects;
    this.buildRun(0);
  }

  get project(): ArcadeProject {
    return this.projects[this.levelIdx % this.projects.length];
  }

  get sky(): RunSky {
    return RUN_SKIES[this.levelIdx % RUN_SKIES.length];
  }

  /** Back-compat: the chain multiplier. */
  get combo(): number {
    return this.chain;
  }

  private buildRun(idx: number): void {
    this.levelIdx = idx;
    const p = this.projects[idx % this.projects.length];
    this.rand = mulberry32(idx * 9973 + p.name.length * 131 + 7);
    const r = this.rider;
    Object.assign(r, { x: 0, y: 40, z: pipeHeightAt(0, 40), vx: 0, vy: CRUISE + Math.min(0.8, idx * 0.2), vz: 0, yaw: 0, roll: 0, pitch: 0, air: false, airT: 0, inv: 0 });
    this.trick = null;
    this.trickT = 0;
    this.held = [];
    this.heldPts = 0;
    this.heldGems = 0;
    this.chain = 0;
    this.bestChain = 0;
    this.collected = 0;
    this.runFrames = 0;
    this.finishAt = null;
    this.bails = 0;
    this.result = null;
    this.items = [];
    this.pops = [];
    this.runStartScore = this.score;

    let nextId = 1;
    const tasks = p.tasks.length ? p.tasks : [{ title: "SHIP BUILD", priority: "high" as Priority, dueMin: 0, overdue: false }];
    const notes = p.notes.length ? p.notes : [{ id: "n1", title: "PEAK NOTE" }];
    const span = RUN_LEN - 360;

    // Tasks ride the walls by priority, in short lines you can carve through.
    const count = Math.max(12, tasks.length * 2);
    for (let i = 0; i < count; i++) {
      const task = tasks[i % tasks.length];
      const y = 160 + (i / count) * span;
      const side = this.rand() > 0.5 ? 1 : -1;
      const x = side * TASK_LINE[task.priority] * PIPE_HALF_W + (this.rand() - 0.5) * 10;
      this.items.push({ id: nextId++, kind: "task", x, y, pr: task.priority, title: task.title, taken: false });
      // Overdue tasks drop a boulder across the easy line; jump it or go round.
      if (task.overdue || (idx >= 2 && i % 4 === 2)) {
        const bx = clamp(-x * 0.5 + (this.rand() - 0.5) * 30, -PIPE_HALF_W * 0.6, PIPE_HALF_W * 0.6);
        this.items.push({ id: nextId++, kind: "boulder", x: bx, y: y + 54, pr: "urgent", title: "", taken: false });
      }
    }
    // Notes float above the lips: only reachable in the air.
    const nNotes = Math.max(5, notes.length);
    for (let i = 0; i < nNotes; i++) {
      const note = notes[i % notes.length];
      const y = 260 + (i / nNotes) * (span - 120);
      const side = i % 2 === 0 ? 1 : -1;
      this.items.push({ id: nextId++, kind: "note", x: side * (PIPE_HALF_W * 0.9), y, pr: "low", title: note.title, taken: false });
    }
    // Kickers down the middle, each with a boulder just past it to clear.
    for (let y = 320; y < RUN_LEN - 260; y += 380) {
      const rx = (this.rand() * 2 - 1) * 30;
      this.items.push({ id: nextId++, kind: "ramp", x: rx, y, pr: "low", title: "", taken: false });
    }
    this.totalCollect = this.items.filter((it) => it.kind === "task" || it.kind === "note").length;
  }

  private addScore(pts: number): void {
    this.score += pts;
    if (this.score > this.best) this.best = this.score;
  }

  private pop(text: string, color: string, x: number, y: number, z: number): void {
    this.pops.push({ text, color, x, y, z, life: 55 });
    if (this.pops.length > 3) this.pops.shift();
  }

  resize(width: number, height: number, hud?: PixelHud): void {
    this.W = width;
    this.H = height;
    if (hud) this.hud = hud;
  }

  private startGame(): void {
    this.score = 0;
    this.hearts = MAX_HEARTS;
    this.buildRun(0);
    this.state = "intro";
    this.stateT = 80;
    this.events.push("start");
  }

  /** After a wipeout: ride the same project again, at its starting score. */
  private retryRun(): void {
    this.score = this.runStartScore;
    this.hearts = MAX_HEARTS;
    this.buildRun(this.levelIdx);
    this.state = "intro";
    this.stateT = 60;
    this.events.push("start");
  }

  /**
   * Start a trick in the air (a grab by default), or pop an ollie on the
   * snow. Returns false when nothing happened (already mid-trick).
   */
  triggerAirTrick(kind: TrickKind = "grab"): boolean {
    if (this.state !== "ride") return false;
    const r = this.rider;
    if (!r.air) {
      // A small hop: room for a grab, not a spin. Spins need the lips.
      this.launch(1.1, 2);
      return true;
    }
    if (this.trick) return false;
    this.trick = kind;
    this.trickT = 0;
    return true;
  }

  /**
   * Leave the snow with `lift` upward speed relative to the slope (the run
   * drops 0.11 per unit downhill, so the rider carries that fall with them).
   */
  private launch(lift: number, hop: number): void {
    const r = this.rider;
    r.vz = lift - 0.11 * r.vy;
    r.air = true;
    r.airT = 0;
    r.z += hop;
    // An air flick is measured from here, not from where the finger first touched the snow.
    if (this.downPos && this.lastPos) this.downPos = { ...this.lastPos };
  }

  private canInput(): boolean {
    return this.state === "title" || ((this.state === "win" || this.state === "over") && this.stateT <= 0);
  }

  down(x: number, y: number): void {
    if (this.canInput()) {
      if (this.state === "over") this.retryRun();
      else this.startGame();
      return;
    }
    if (this.state !== "ride") return;
    this.downPos = { x, y };
    this.lastPos = { x, y };
    this.dragMoved = false;
    if (!this.rider.air) this.steer(x);
  }

  move(x: number, y: number): void {
    if (this.state !== "ride" || !this.downPos) return;
    const d = this.downPos;
    if (Math.hypot(x - d.x, y - d.y) > 6) this.dragMoved = true;
    // In the air, a flick picks the trick; on the snow, dragging steers.
    if (this.rider.air && this.lastPos) {
      const dx = x - d.x, dy = y - d.y;
      if (!this.trick && Math.hypot(dx, dy) > 14) {
        this.triggerAirTrick(Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "spin-l" : "spin-r") : dy < 0 ? "flip" : "grab");
        this.downPos = { x, y };
      }
    } else {
      this.steer(x);
    }
    this.lastPos = { x, y };
  }

  up(): void {
    if (this.state === "ride" && this.downPos && !this.dragMoved) {
      // A tap: ollie on the snow, a grab in the air.
      this.triggerAirTrick("grab");
    }
    this.downPos = null;
    this.lastPos = null;
    this.steerTarget = null;
    this.dragMoved = false;
  }

  steer(screenX: number): void {
    const f = hudFrame(this.hud, this.W, this.H);
    const norm = clamp((screenX - f.content.cx) / Math.max(40, (f.content.rx - f.content.lx) * 0.45), -1, 1);
    this.steerTarget = norm * (PIPE_HALF_W * 0.94);
  }

  setKey(code: string, isDown: boolean): boolean {
    if (isDown && (code === "Space" || code === "Enter")) {
      if (this.canInput()) {
        if (this.state === "over") this.retryRun();
        else this.startGame();
        return true;
      }
      if (this.state === "ride") return this.triggerAirTrick("grab") || true;
    }
    const left = code === "ArrowLeft" || code === "KeyA", right = code === "ArrowRight" || code === "KeyD";
    const upK = code === "ArrowUp" || code === "KeyW", downK = code === "ArrowDown" || code === "KeyS";
    if (left || right || upK || downK) {
      if (isDown) this.keys.add(code);
      else this.keys.delete(code);
      // In the air the arrows throw tricks instead of steering.
      if (isDown && this.state === "ride" && this.rider.air) {
        this.triggerAirTrick(left ? "spin-l" : right ? "spin-r" : upK ? "flip" : "grab");
      }
      return true;
    }
    return false;
  }

  step(): void {
    this.t++;
    if (!this.calm) {
      if (this.shake > 0) this.shake = Math.max(0, this.shake - 0.25);
      if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.5);
    } else {
      this.shake = 0;
      this.flash = 0;
    }
    for (let i = this.pops.length - 1; i >= 0; i--) {
      this.pops[i].z += 0.35;
      if (--this.pops[i].life <= 0) this.pops.splice(i, 1);
    }
    const r = this.rider;
    if (this.state === "title") {
      // Gently carve in demo preview on title screen
      r.y = 40 + ((this.t * 1.8) % 600);
      r.x = Math.sin(this.t * 0.03) * 44;
      r.z = pipeHeightAt(r.x, r.y);
      r.roll = Math.cos(this.t * 0.03) * 0.35;
      return;
    }
    if (this.state === "intro") {
      if (--this.stateT <= 0) this.state = "ride";
      return;
    }
    if (this.state === "clear") {
      if (--this.stateT <= 0) {
        if (this.levelIdx + 1 < this.projects.length) {
          this.hearts = Math.min(MAX_HEARTS, this.hearts + 1);
          this.buildRun(this.levelIdx + 1);
          this.state = "intro";
          this.stateT = 75;
        } else {
          this.state = "win";
          this.stateT = 40;
          this.events.push("win");
        }
      }
      return;
    }
    if (this.state === "win" || this.state === "over") {
      if (this.stateT > 0) this.stateT--;
      return;
    }

    // ── Ride step ──
    this.runFrames++;
    if (r.inv > 0) r.inv--;

    let ax = 0;
    if (!r.air) {
      if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) ax -= 0.3;
      if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) ax += 0.3;
      if (ax === 0 && this.steerTarget !== null) ax = clamp((this.steerTarget - r.x) * 0.022, -0.32, 0.32);
    }

    // Halfpipe gravity pulls back toward the centre when grounded.
    const pipeSlope = (r.x / PIPE_HALF_W) * -0.15;
    r.vx = clamp((r.vx + ax + (r.air ? 0 : pipeSlope)) * (r.air ? 0.995 : 0.95), -4.6, 4.6);
    r.x = clamp(r.x + r.vx, -PIPE_HALF_W * 1.05, PIPE_HALF_W * 1.05);
    r.y += r.vy;

    const groundZ = pipeHeightAt(r.x, r.y);
    if (!r.air) {
      // Pumping: dropping down a wall (not the slope) turns height into speed.
      const wallDrop = pipeWallZ(r.x) - pipeWallZ(r.x - r.vx);
      if (wallDrop < 0) r.vy += -wallDrop * 0.03;
      r.vy += (CRUISE - r.vy) * 0.004;
      r.vy = clamp(r.vy, MIN_SPEED, MAX_SPEED);
      // Off the lip when carving fast up the wall: the sideways speed goes
      // vertical and the rider drifts back in to land on the same wall.
      if (Math.abs(r.x) >= PIPE_HALF_W * 0.84 && r.vx * r.x > 0 && Math.abs(r.vx) > 1.2) {
        r.z = groundZ;
        this.launch(Math.abs(r.vx) * 0.7 + 0.6 + (r.vy - CRUISE) * 0.3, 2);
        r.vx = -Math.sign(r.x) * 0.35;
      }
    }

    if (r.air) {
      r.airT++;
      r.vz -= GRAVITY;
      r.z += r.vz;
      this.stepTrick();
      if (r.z <= groundZ) this.land(groundZ);
    } else {
      r.z = groundZ;
      r.roll = clamp(r.vx * 0.16, -0.55, 0.55);
      r.yaw = clamp(-r.vx * 0.14, -0.45, 0.45);
      r.pitch = 0;
    }

    // A landing that cost the last heart ends the run here: nothing more to pick up.
    if (this.state !== "ride") return;
    this.stepItems();

    if (r.y >= RUN_LEN && this.state === "ride") {
      this.finishAt ??= this.runFrames;
      // Land the last jump first: a bail still costs its heart, and a clean one banks its points.
      if (!r.air) this.finishRun();
    }
  }

  private stepTrick(): void {
    const r = this.rider;
    if (!this.trick) {
      // Settle back to neutral between tricks.
      r.yaw *= 0.85;
      r.pitch *= 0.85;
      r.roll *= 0.85;
      return;
    }
    const def = TRICK_DEFS[this.trick];
    this.trickT = Math.min(1, this.trickT + 1 / def.frames);
    const e = this.trickT;
    if (this.trick === "spin-l") r.yaw = -e * Math.PI * 2;
    else if (this.trick === "spin-r") r.yaw = e * Math.PI * 2;
    else if (this.trick === "flip") r.pitch = e * Math.PI * 2;
    else r.roll = Math.sin(e * Math.PI) * 0.9;
    if (this.trickT >= 1) {
      // Spins in the same jump stack up: 360, 720, 1080.
      const spins = this.held.filter((h) => /^\d+$/.test(h)).length;
      let name = def.name;
      if (this.trick === "spin-l" || this.trick === "spin-r") {
        name = String(360 * (spins + 1));
        if (spins) this.held = this.held.filter((h) => !/^\d+$/.test(h));
      }
      this.held.push(name);
      this.heldPts += def.pts * this.held.length;
      this.events.push("trick");
      this.trick = null;
      this.trickT = 0;
      r.yaw = r.pitch = r.roll = 0;
    }
  }

  private land(groundZ: number): void {
    const r = this.rider;
    r.z = groundZ;
    r.vz = 0;
    r.air = false;
    // Mid-rotation (more than a sliver left) is a bail; a grab can be let go late.
    const unfinished = this.trick && !(this.trick === "grab" || this.trickT > 0.85);
    if (unfinished) {
      this.bail("BAILED!");
    } else if (this.held.length || this.heldGems) {
      // Tricks multiply the gems you carried down; a clean landing banks both.
      this.chain++;
      this.bestChain = Math.max(this.bestChain, this.chain);
      const pts = (this.heldPts + this.heldGems) * Math.min(MAX_CHAIN, this.chain);
      this.addScore(pts);
      r.vy = clamp(r.vy + 0.3 * this.held.length, MIN_SPEED, MAX_SPEED);
      this.events.push("land");
      if (!this.calm) this.shake = Math.max(this.shake, 2);
      this.pop(`${this.held.length ? this.held.join(" + ") : "CLEAN"} +${pts}`, "#8dff9a", r.x, r.y, r.z + 16);
    }
    this.trick = null;
    this.trickT = 0;
    this.held = [];
    this.heldPts = 0;
    this.heldGems = 0;
    r.yaw = 0;
    r.pitch = 0;
  }

  private bail(text: string): void {
    const r = this.rider;
    this.bails++;
    this.chain = 0;
    this.held = [];
    this.heldPts = 0;
    this.heldGems = 0;
    this.trick = null;
    r.vy = Math.max(MIN_SPEED, r.vy * 0.5);
    r.vx *= 0.3;
    r.inv = 60;
    this.hearts--;
    if (!this.calm) {
      this.shake = 4;
      this.flash = 5;
    }
    this.events.push(text === "BAILED!" ? "bail" : "hurt");
    this.pop(text, "#ff5e8a", r.x, r.y, r.z + 14);
    if (this.hearts <= 0) {
      this.state = "over";
      this.stateT = 50;
      this.events.push("over");
    }
  }

  private stepItems(): void {
    const r = this.rider;
    for (const it of this.items) {
      if (it.taken) continue;
      if (Math.abs(it.y - r.y) > Math.max(16, r.vy + 4) || Math.abs(it.x - r.x) > 15) continue;
      const iz = pipeHeightAt(it.x, it.y);
      if (it.kind === "ramp") {
        if (!r.air) this.launch(2.7 + (r.vy - CRUISE) * 0.3, 3);
        continue;
      }
      if (it.kind === "boulder") {
        if (r.z > iz + 10 || r.inv > 0) continue;
        it.taken = true;
        this.bail("WIPEOUT!");
        if (this.state !== "ride") return;
        continue;
      }
      // Notes float high: only a jump reaches them.
      const note = it.kind === "note";
      if (note && !r.air) continue;
      const lift = note ? NOTE_LIFT : TASK_LIFT[it.pr];
      if (Math.abs(r.z - (iz + lift)) > 14) continue;
      it.taken = true;
      this.collected++;
      const pts = note ? NOTE_PTS : TASK_PTS[it.pr];
      this.events.push(note ? "note" : "collect");
      if (r.air) {
        // Carried until you land it: a bail drops them.
        this.heldGems += pts;
        this.pop(`${note ? "NOTE" : it.title.slice(0, 12)} +${pts}?`, "#fff2a0", it.x, it.y, iz + 16);
      } else {
        const got = pts * Math.max(1, Math.min(MAX_CHAIN, this.chain));
        this.addScore(got);
        this.pop(`${it.title.slice(0, 12)} +${got}`, "#a8f4e8", it.x, it.y, iz + 14);
      }
    }
  }

  private finishRun(): void {
    const frames = this.finishAt ?? this.runFrames;
    const grade = gradeRun(this.collected, this.totalCollect, this.bails);
    const bonus = GRADE_BONUS[grade];
    this.addScore(bonus);
    this.result = { grade, collected: this.collected, total: this.totalCollect, frames, bails: this.bails, bestChain: this.bestChain, bonus };
    this.state = "clear";
    this.stateT = 150;
    this.events.push("clear");
  }
}
