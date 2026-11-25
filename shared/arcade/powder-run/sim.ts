/**
 * Powder Run simulation — 3D halfpipe snowboarding per Cairn project.
 * Pure TypeScript: carving physics, halfpipe lip launches, random midair
 * tricks on click/tap/Space, and workspace-seeded task/note collectibles.
 */

import type { Priority } from "../../types/domain";
import { DEMO_DATA, type ArcadeProject } from "../pixel/arcade-data";
import { hudFrame, NO_HUD, type InputMode, type PixelHud } from "../pixel/hud";
import { clamp } from "../pixel/kinds";
import { mulberry32 } from "../pixel/terrain";

export const PIPE_HALF_W = 86;
export const PIPE_WALL_H = 44;
export const RUN_LEN = 2600;

export type PowderState = "title" | "intro" | "ride" | "clear" | "win";
export type PowderEvent = "start" | "collect" | "note" | "trick" | "land" | "hurt" | "clear" | "win";

export const TRICKS = ["360 SPIN", "BACKFLIP", "METHOD GRAB", "INDY GRAB", "RODEO 540", "NOSE GRAB"] as const;

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
  return Math.max(0, 320 - y * 0.11) + pipeWallZ(x);
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
  lives = 3;
  events: PowderEvent[] = [];

  rider = {
    x: 0,
    y: 40,
    z: pipeHeightAt(0, 40),
    vx: 0,
    vy: 3.6,
    vz: 0,
    yaw: 0,
    roll: 0,
    pitch: 0,
    air: false,
    trickCount: 0,
    inv: 0,
  };

  combo = 0;
  collected = 0;
  totalCollect = 0;
  items: PipeItem[] = [];
  pops: PowderPop[] = [];

  private keys = new Set<string>();
  private steerTarget: number | null = null;
  private dragMoved = false;
  private downPos: { x: number; y: number } | null = null;

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

  private buildRun(idx: number): void {
    this.levelIdx = idx;
    const p = this.projects[idx % this.projects.length];
    this.rand = mulberry32(idx * 9973 + p.name.length * 131 + 7);
    this.rider.x = 0;
    this.rider.y = 40;
    this.rider.z = pipeHeightAt(0, 40);
    this.rider.vx = 0;
    this.rider.vy = 3.6 + Math.min(1.2, idx * 0.25);
    this.rider.vz = 0;
    this.rider.yaw = 0;
    this.rider.roll = 0;
    this.rider.pitch = 0;
    this.rider.air = false;
    this.rider.trickCount = 0;
    this.rider.inv = 0;
    this.combo = 0;
    this.collected = 0;
    this.items = [];
    this.pops = [];

    let nextId = 1;
    const tasks = p.tasks.length ? p.tasks : [{ title: "SHIP BUILD", priority: "high" as Priority, dueMin: 0, overdue: false }];
    const notes = p.notes.length ? p.notes : [{ id: "n1", title: "PEAK NOTE" }];

    // Spawn tasks along the pipe floor & mid-walls.
    const count = Math.max(10, tasks.length * 2);
    for (let i = 0; i < count; i++) {
      const task = tasks[i % tasks.length];
      const y = 140 + (i / count) * (RUN_LEN - 260);
      const x = (this.rand() * 2 - 1) * (PIPE_HALF_W * 0.72);
      this.items.push({ id: nextId++, kind: "task", x, y, pr: task.priority, title: task.title, taken: false });
      if (task.overdue || i % 3 === 1) {
        const bx = clamp(-x * 0.7 + (this.rand() - 0.5) * 28, -PIPE_HALF_W * 0.65, PIPE_HALF_W * 0.65);
        this.items.push({ id: nextId++, kind: "boulder", x: bx, y: y + 48, pr: "urgent", title: "", taken: false });
      }
    }
    // Spawn notes high up on the halfpipe lips!
    for (let i = 0; i < Math.max(5, notes.length); i++) {
      const note = notes[i % notes.length];
      const y = 220 + (i / Math.max(5, notes.length)) * (RUN_LEN - 360);
      const side = i % 2 === 0 ? 1 : -1;
      this.items.push({ id: nextId++, kind: "note", x: side * (PIPE_HALF_W * 0.86), y, pr: "low", title: note.title, taken: false });
    }
    // Spawn kicker ramps along the pipe center/sides for big air.
    for (let y = 280; y < RUN_LEN - 220; y += 340) {
      const rx = (this.rand() * 2 - 1) * 38;
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
  }

  resize(width: number, height: number, hud?: PixelHud): void {
    this.W = width;
    this.H = height;
    if (hud) this.hud = hud;
  }

  private startGame(): void {
    this.score = 0;
    this.lives = 3;
    this.buildRun(0);
    this.state = "intro";
    this.stateT = 80;
    this.events.push("start");
  }

  /** Trigger a random midair trick (or hop if on snow). */
  triggerAirTrick(): boolean {
    if (this.state !== "ride") return false;
    if (this.rider.air) {
      this.combo++;
      this.rider.trickCount++;
      const trick = TRICKS[Math.floor(this.rand() * TRICKS.length)];
      this.rider.yaw += (this.rand() > 0.5 ? 1 : -1) * Math.PI * 1.8;
      this.rider.pitch += Math.PI * 1.6;
      const pts = 150 * this.combo;
      this.addScore(pts);
      this.events.push("trick");
      this.pop(`${trick} +${pts}`, "#fff2a0", this.rider.x, this.rider.y, this.rider.z + 18);
      return true;
    }
    // Ollie pop on snow!
    this.rider.vz = Math.max(this.rider.vz, 1.55);
    this.rider.air = true;
    this.rider.z += 2;
    return true;
  }

  down(x: number, y: number): void {
    if (this.state === "title") {
      this.startGame();
      return;
    }
    if (this.state === "win" && this.stateT <= 0) {
      this.startGame();
      return;
    }
    if (this.state !== "ride") return;
    this.downPos = { x, y };
    this.dragMoved = false;
    if (this.rider.air) {
      this.triggerAirTrick();
    } else {
      this.steer(x);
    }
  }

  move(x: number, y: number): void {
    if (this.state !== "ride" || !this.downPos) return;
    if (Math.hypot(x - this.downPos.x, y - this.downPos.y) > 6) this.dragMoved = true;
    this.steer(x);
  }

  up(): void {
    if (this.state === "ride" && this.downPos && !this.dragMoved && !this.rider.air) {
      // Quick tap while grounded pops an ollie!
      this.triggerAirTrick();
    }
    this.downPos = null;
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
      if (this.state === "title" || (this.state === "win" && this.stateT <= 0)) {
        this.startGame();
        return true;
      }
      if (this.state === "ride") {
        return this.triggerAirTrick();
      }
    }
    if (code === "ArrowLeft" || code === "KeyA" || code === "ArrowRight" || code === "KeyD") {
      if (isDown) this.keys.add(code);
      else this.keys.delete(code);
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
    if (this.state === "title") {
      // Gently carve in demo preview on title screen
      this.rider.y = 40 + ((this.t * 1.8) % 600);
      this.rider.x = Math.sin(this.t * 0.03) * 44;
      this.rider.z = pipeHeightAt(this.rider.x, this.rider.y);
      this.rider.roll = Math.cos(this.t * 0.03) * 0.35;
      return;
    }
    if (this.state === "intro") {
      if (--this.stateT <= 0) this.state = "ride";
      return;
    }
    if (this.state === "clear") {
      if (--this.stateT <= 0) {
        if (this.levelIdx + 1 < this.projects.length) {
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
    if (this.state === "win") {
      if (this.stateT > 0) this.stateT--;
      return;
    }

    // ── Ride step ──
    const r = this.rider;
    if (r.inv > 0) r.inv--;

    let ax = 0;
    if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) ax -= 0.28;
    if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) ax += 0.28;
    if (ax === 0 && this.steerTarget !== null) {
      ax = clamp((this.steerTarget - r.x) * 0.02, -0.3, 0.3);
    }

    // Halfpipe gravity pulls back toward center (x = 0) when grounded.
    const pipeSlope = (r.x / PIPE_HALF_W) * -0.14;
    r.vx = clamp((r.vx + ax + (r.air ? 0 : pipeSlope)) * (r.air ? 0.99 : 0.94), -4.2, 4.2);
    r.x = clamp(r.x + r.vx, -PIPE_HALF_W * 1.05, PIPE_HALF_W * 1.05);
    r.y += r.vy;

    // Launch off the halfpipe lip if carving fast up the wall!
    const groundZ = pipeHeightAt(r.x, r.y);
    if (!r.air && Math.abs(r.x) >= PIPE_HALF_W * 0.84 && Math.abs(r.vx) > 1.2) {
      r.vz = Math.abs(r.vx) * 0.95 + 0.6;
      r.air = true;
      r.z += 2;
    }

    if (r.air) {
      r.vz -= 0.085;
      r.z += r.vz;
      r.yaw *= 0.92;
      r.pitch *= 0.92;
      if (r.z <= groundZ) {
        r.z = groundZ;
        r.vz = 0;
        r.air = false;
        r.yaw = 0;
        r.pitch = 0;
        if (r.trickCount > 0) {
          this.events.push("land");
          if (!this.calm) this.shake = Math.max(this.shake, 2);
          this.pop(`CLEAN LANDING x${this.combo}!`, "#8dff9a", r.x, r.y, r.z + 16);
          r.trickCount = 0;
        } else {
          this.combo = 0;
        }
      }
    } else {
      r.z = groundZ;
      r.roll = clamp(r.vx * 0.16, -0.55, 0.55);
      r.yaw = clamp(-r.vx * 0.14, -0.45, 0.45);
      r.pitch = 0;
    }

    // Collectibles, ramps, and hazards
    for (const it of this.items) {
      if (it.taken) continue;
      if (Math.abs(it.y - r.y) > 16 || Math.abs(it.x - r.x) > 15) continue;
      const iz = pipeHeightAt(it.x, it.y);
      if (it.kind === "ramp") {
        if (!r.air) {
          r.vz = 2.4;
          r.air = true;
          r.z += 3;
          this.pop("BIG AIR!", "#a8f4e8", r.x, r.y, r.z + 14);
        }
        continue;
      }
      if (it.kind === "boulder") {
        // Can soar cleanly over boulders when airborne!
        if (r.z > iz + 10 || r.inv > 0) continue;
        it.taken = true;
        r.inv = 45;
        this.combo = 0;
        if (!this.calm) {
          this.shake = 4;
          this.flash = 5;
        }
        this.events.push("hurt");
        this.pop("WIPEOUT!", "#ff5e8a", r.x, r.y, r.z + 14);
        continue;
      }
      if (Math.abs(r.z - iz) > 26) continue;
      it.taken = true;
      this.collected++;
      if (it.kind === "note") {
        this.addScore(200);
        this.events.push("note");
        this.pop(`NOTE: ${it.title.slice(0, 14)}`, "#fff2a0", it.x, it.y, iz + 16);
      } else {
        this.addScore(100);
        this.events.push("collect");
        this.pop(it.title.slice(0, 16), "#a8f4e8", it.x, it.y, iz + 14);
      }
    }

    if (r.y >= RUN_LEN) {
      this.addScore(300);
      this.state = "clear";
      this.stateT = 90;
      this.events.push("clear");
    }
  }
}
