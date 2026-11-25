/**
 * Angler simulation: a pixel aquarium you stock by fishing your workspace.
 * Pure TypeScript.
 *
 * The loop: the tank is home. GO FISH takes you to a pond, seen from above;
 * each project is its own fishing spot in its own biome. Tap the water to
 * cast, wait out the nibbles, and strike when the bobber plunges. A hooked
 * fish swims every which way: point the rod the way it swims to tire it
 * (point it anywhere else and the line strains). Once it tires, hold or crank
 * the reel to land it. Then keep it in the tank or let it go.
 *
 * Every fish is a task or a note: priority picks the species, notes are the
 * exotic ones, overdue tasks fight harder. A kept fish stays in the tank only
 * while its task is still open (or its note still exists), so finishing work
 * empties the tank over time.
 */

import type { Priority } from "../../types/domain";
import { DEMO_DATA, type ArcadeProject } from "../pixel/arcade-data";
import { hudFrame, NO_HUD, type InputMode, type PixelHud } from "../pixel/hud";
import { clamp } from "../pixel/kinds";
import { mulberry32, type BiomeName } from "../pixel/terrain";

export type Species = "minnow" | "perch" | "bass" | "pike" | "angel" | "puffer" | "koi";

export interface SpeciesDef {
  name: string;
  /** Body length in pixels at size 1. */
  len: number;
  /** Body height (side view) as a share of its length. */
  ratio: number;
  /** Body width (seen from above) as a share of its length. */
  girth: number;
  kg: number;
  /** How hard it pulls the line (tension). */
  pull: number;
  /** Frames of a perfect lean it takes to tire it. */
  stamina: number;
  /** Swim speed in the tank and on the line. */
  speed: number;
  pts: number;
}

export const SPECIES: Record<Species, SpeciesDef> = {
  minnow: { name: "MINNOW", len: 9, ratio: 0.34, girth: 0.3, kg: 0.2, pull: 0.6, stamina: 220, speed: 0.55, pts: 50 },
  perch: { name: "PERCH", len: 12, ratio: 0.44, girth: 0.34, kg: 0.6, pull: 0.8, stamina: 320, speed: 0.48, pts: 120 },
  bass: { name: "BASS", len: 15, ratio: 0.42, girth: 0.34, kg: 1.8, pull: 1, stamina: 430, speed: 0.44, pts: 250 },
  pike: { name: "PIKE", len: 21, ratio: 0.24, girth: 0.22, kg: 4, pull: 1.25, stamina: 560, speed: 0.6, pts: 450 },
  angel: { name: "ANGELFISH", len: 10, ratio: 0.9, girth: 0.26, kg: 0.3, pull: 0.7, stamina: 280, speed: 0.36, pts: 180 },
  puffer: { name: "PUFFER", len: 11, ratio: 0.78, girth: 0.66, kg: 0.8, pull: 0.9, stamina: 380, speed: 0.3, pts: 260 },
  koi: { name: "KOI", len: 18, ratio: 0.38, girth: 0.36, kg: 3, pull: 1.1, stamina: 500, speed: 0.4, pts: 400 },
};

export const TASK_SPECIES: Record<Priority, Species> = { low: "minnow", medium: "perch", high: "bass", urgent: "pike" };
/** Short notes are angelfish, longer ones puffers, the long reads koi. */
export const noteSpecies = (words: number): Species => (words < 400 ? "angel" : words < 1200 ? "puffer" : "koi");

export const TANK_MAX = 16;
/** Point the rod within about 75° of the fish's heading and it tires; wider and the line strains. */
export const MATCH = 0.25;
/** A tired fish left unreeled this long gets its second wind. */
export const RECOVER_FRAMES = 150;
/** Frames to strike once the bobber plunges. */
export const BITE_WINDOW = 48;
/** A strike this many frames early still counts when the plunge comes. */
export const STRIKE_BUFFER = 10;

/** A fish: one task or note. Also what the tank saves. */
export interface FishSpec {
  id: string;
  kind: "task" | "note";
  title: string;
  project: string;
  projectId?: string;
  accent: string;
  species: Species;
  priority?: Priority;
  overdue: boolean;
  kg: number;
  /** Body length in pixels. */
  size: number;
  pts: number;
  seed: number;
}

const MAX_FISH_SIZE = Math.ceil(Math.max(...Object.values(SPECIES).map((s) => s.len)) * 1.2) + 1;

/** A saved fish the sim and renderer can draw: an own species, a whole-pixel size in range, real numbers. */
function validFish(f: unknown): f is FishSpec {
  if (!f || typeof f !== "object") return false;
  const x = f as Partial<FishSpec>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return (
    typeof x.id === "string" &&
    (x.kind === "task" || x.kind === "note") &&
    typeof x.title === "string" &&
    typeof x.project === "string" &&
    typeof x.accent === "string" && /^#[0-9a-f]{6}$/i.test(x.accent) &&
    typeof x.species === "string" && Object.prototype.hasOwnProperty.call(SPECIES, x.species) &&
    Number.isInteger(x.size) && (x.size as number) >= 4 && (x.size as number) <= MAX_FISH_SIZE &&
    num(x.kg) && num(x.pts) && num(x.seed) &&
    typeof x.overdue === "boolean"
  );
}

/** What the host stores between visits: the fish in the tank. Where they swim is not kept. */
export interface AnglerSave {
  v: 1;
  fish: FishSpec[];
}

export interface Swimmer {
  spec: FishSpec;
  x: number;
  y: number;
  /** Depth in the tank: 0 against the front glass, 1 at the back wall. */
  z: number;
  tz: number;
  vx: number;
  vy: number;
  face: 1 | -1;
  /** Frames left of turning round (it narrows, then shows its other side). */
  turn: number;
  tx: number;
  ty: number;
  retarget: number;
  /** Frames left of the splash-down when it was just kept. */
  enter: number;
  /** Frames into leaving the tank (released, or its task is done); 0 while it lives here. */
  leaving: number;
  /** Why it is leaving: shown as it swims off. */
  why?: string;
}

/** A fish in the pond, seen from above: heading `a`, and how deep it swims (0 at the surface). */
export interface PondFish {
  spec: FishSpec;
  x: number;
  y: number;
  a: number;
  depth: number;
  tx: number;
  ty: number;
  flee: number;
}

export interface Hooked {
  spec: FishSpec;
  x: number;
  y: number;
  /** Heading, radians (0 = right, up is negative). */
  a: number;
  /** Where it is turning to. */
  ta: number;
  /** Frames until it turns; the renderer flags the last few. */
  turnT: number;
  /** 1 fresh … 0 spent. */
  stamina: number;
  /** 0 slack … 1 snaps. */
  tension: number;
  tired: boolean;
  /** Frames since it was last reeled, while tired. */
  idle: number;
  depth: number;
}

export interface Bobber {
  x: number;
  y: number;
  /** Cast flight: from (fx, fy), 0..CAST_FRAMES. */
  fly: number;
  fx: number;
  fy: number;
  dip: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  c: string;
}

/** A ring spreading on the water: a cast landing, a nibble, a thrash. */
export interface Ripple {
  x: number;
  y: number;
  t: number;
  max: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The pond's shore: an ellipse with a wobble, the same for the sim and the picture. */
export interface Lake {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  seed: number;
}

/** The shore's radius (as a share of the ellipse) at angle `th`. */
export function lakeShape(l: Lake, th: number): number {
  const s = (l.seed % 628) / 100;
  return 0.9 + 0.06 * Math.sin(3 * th + s) + 0.04 * Math.sin(5 * th + 2 * s);
}

/** How far inside the shore a point is: 1 at the centre, 0 on the shore, negative on land. */
export function lakeInside(l: Lake, x: number, y: number): number {
  const nx = (x - l.cx) / l.rx, ny = (y - l.cy) / l.ry;
  const r = lakeShape(l, Math.atan2(ny, nx));
  return 1 - Math.hypot(nx, ny) / r;
}

export type AnglerState = "tank" | "aim" | "cast" | "wait" | "fight" | "lost" | "catch";
export type AnglerEvent =
  | "start"
  | "cast"
  | "nibble"
  | "bite"
  | "hook"
  | "early"
  | "miss"
  | "tired"
  | "turn"
  | "strain"
  | "snap"
  | "catch"
  | "keep"
  | "release"
  | "select"
  | "spot"
  | "back";

export interface AnglerSpec {
  width: number;
  height: number;
  hud?: PixelHud;
  inputMode?: InputMode;
  best?: number;
  projects?: ArcadeProject[];
  /** The tank as it was saved last time (from storage). */
  save?: AnglerSave | null;
  /** Playing the demo workspace: keep saved fish even when their ids aren't in it. */
  demo?: boolean;
  /**
   * Every open task and live note in `projects`, uncapped. A saved fish whose id is here is still live
   * even if the game data left it out; without this, only the fish in `projects` count as live.
   */
  liveIds?: Iterable<string>;
  seed?: number;
}

const CAST_FRAMES = 26;
export const LEAP_FRAMES = 46;
const TURN_RATE = 0.07;

function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Turn `a` toward `b` by at most `max` radians. */
function turnToward(a: number, b: number, max: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + clamp(d, -max, max);
}

/** Every task and note in play, as fish. */
export function fishFromProjects(projects: ArcadeProject[]): FishSpec[] {
  const out: FishSpec[] = [];
  for (const p of projects) {
    for (const t of p.tasks) {
      const id = t.id ?? `${p.id}:${t.title}`;
      out.push(makeFish(id, "task", t.title, p, TASK_SPECIES[t.priority], t.overdue, t.priority));
    }
    for (const n of p.notes) out.push(makeFish(n.id, "note", n.title, p, noteSpecies(n.words), false));
  }
  return out;
}

function makeFish(id: string, kind: FishSpec["kind"], title: string, p: ArcadeProject, species: Species, overdue: boolean, priority?: Priority): FishSpec {
  const seed = strHash(id);
  const r = mulberry32(seed);
  const def = SPECIES[species];
  const g = r();
  const scale = 0.85 + g * 0.35;
  const kg = Math.round(def.kg * (0.7 + g * 0.7) * 10) / 10 || 0.1;
  return {
    id,
    kind,
    title,
    project: p.name,
    projectId: p.id,
    accent: p.accent,
    species,
    priority,
    overdue,
    kg,
    size: Math.round(def.len * scale),
    pts: Math.round((def.pts * (0.8 + g * 0.4) * (overdue ? 1.5 : 1)) / 5) * 5,
    seed,
  };
}

export class AnglerSim {
  W: number;
  H: number;
  hud: PixelHud;
  readonly inputMode: InputMode;
  readonly demo: boolean;
  readonly projects: ArcadeProject[];
  private rand: () => number;

  state: AnglerState = "tank";
  t = 0;
  stateT = 0;
  best: number;
  calm = false;
  readonly events: AnglerEvent[] = [];

  /** Fish that can still bite: the live tasks and notes not in the tank. */
  pool: FishSpec[];
  tank: FishSpec[];
  swimmers: Swimmer[] = [];
  /** Set when the tank changes; the host saves `tank` and clears it. */
  tankDirty = false;
  selected: Swimmer | null = null;
  banner: { text: string; sub: string; t: number } | null = null;

  // Fishing.
  /** Which project's pond you are at. */
  spot = -1;
  shadows: PondFish[] = [];
  bobber: Bobber | null = null;
  biter: PondFish | null = null;
  /** Frames until a fish comes for the bait. */
  biteT = 0;
  nibbles = 0;
  nibbleT = 0;
  /** Frames left to strike, once it bites. */
  biteWindow = 0;
  /** A strike pressed just before the plunge, still waiting to count. */
  strikeBuf = 0;
  hooked: Hooked | null = null;
  /** Today's fish for this workspace, by id: what a let-go fish goes back to the pond as. */
  private liveById = new Map<string, FishSpec>();
  /** The biter has already turned wary once; more early strikes don't hold it off again. */
  private wary = false;
  /** A crank movement arrived since the last fight step. */
  private cranked = false;
  /** Where the rod points, radians (0 = right, up is negative). */
  rodAng = -Math.PI / 2;
  /** Where the player is pointing it; the rod swings toward this. */
  rodAim = -Math.PI / 2;
  private keys = { l: false, r: false, u: false, d: false };
  private drag: { x: number; y: number } | null = null;
  reeling = false;
  reelAng = 0;
  /** Crank speed this frame, 0..1. */
  crank = 0;
  private reelPtr: number | null = null;
  private reelKey = false;
  caught: FishSpec | null = null;
  /** Where the fish left the water, for the leap. */
  leapFrom = { x: 0, y: 0 };
  catchChoice: 0 | 1 = 0;
  msg: { text: string; t: number } | null = null;
  parts: Particle[] = [];
  ripples: Ripple[] = [];
  shake = 0;

  // Layout.
  sandY = 0;
  lake: Lake = { cx: 0, cy: 0, rx: 1, ry: 1, seed: 0 };
  /** The angler, at the end of the dock. */
  angler = { x: 0, y: 0 };
  /** Where the dock meets the shore. */
  dockFoot = 0;
  reel = { x: 0, y: 0, r: 16 };
  goBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  tankBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  spotBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  keepBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  releaseBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  letGoBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  card: Rect = { x: 0, y: 0, w: 0, h: 0 };
  tankBox: Rect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(spec: AnglerSpec) {
    this.W = spec.width;
    this.H = spec.height;
    this.hud = spec.hud ?? NO_HUD;
    this.inputMode = spec.inputMode ?? "touch";
    this.best = spec.best ?? 0;
    this.demo = spec.demo ?? !spec.projects?.length;
    this.projects = spec.projects?.length ? spec.projects : DEMO_DATA.projects;
    this.rand = mulberry32(spec.seed ?? strHash(this.projects.map((p) => p.id).join("|")));
    this.relayout();

    const live = fishFromProjects(this.projects);
    const byId = new Map(live.map((f) => [f.id, f]));
    const save = spec.save && spec.save.v === 1 && Array.isArray(spec.save.fish) ? spec.save : null;
    // Bad entries are skipped one by one; the good catches around them stay.
    const saved = (save?.fish ?? []).filter(validFish);
    this.liveById = byId;
    const here = new Set(this.projects.map((p) => p.id));
    const stillLive = new Set(spec.liveIds ?? []);
    this.tank = [];
    const gone: FishSpec[] = [];
    for (const f of saved.slice(0, TANK_MAX)) {
      const now = byId.get(f.id);
      // A fish whose task is done (or whose note is gone) swims off. The demo keeps what it has, and so
      // does a fish from a project that isn't open here (another workspace): this one can't tell if it's done.
      if (now) this.tank.push({ ...f, title: now.title, project: now.project, projectId: now.projectId, accent: now.accent });
      // Still open, just past the cap on what the game shows: it stays as caught.
      else if (this.demo || stillLive.has(f.id) || !f.projectId || !here.has(f.projectId)) this.tank.push(f);
      else gone.push(f);
    }
    const kept = new Set(this.tank.map((f) => f.id));
    this.pool = live.filter((f) => !kept.has(f.id));
    for (const f of this.tank) this.swimmers.push(this.spawn(f, false));
    for (const f of gone) {
      const s = this.spawn(f, false);
      s.leaving = 1;
      s.why = f.kind === "task" ? "DONE!" : "GONE";
      this.swimmers.push(s);
    }
    if (gone.length) {
      this.tankDirty = true;
      const tasks = gone.filter((f) => f.kind === "task").length;
      this.banner = {
        text: `${gone.length} FISH SWAM HOME`,
        sub: tasks === gone.length ? "THEIR TASKS ARE DONE" : tasks ? "TASKS DONE, NOTES GONE" : "THEIR NOTES ARE GONE",
        t: 0,
      };
    }
  }

  private saveRetry = 0;

  /**
   * Call every frame with the host's writer: saves the tank when it changed. A failed write keeps the
   * change pending and tries again about every two seconds, rather than every frame or never.
   */
  persist(write: (save: AnglerSave) => boolean): void {
    if (!this.tankDirty) return;
    if (this.saveRetry > 0) {
      this.saveRetry--;
      return;
    }
    if (write(this.snapshot())) this.tankDirty = false;
    else this.saveRetry = 120;
  }

  /** The tank, for the host to store. */
  snapshot(): AnglerSave {
    return { v: 1, fish: this.tank.map((f) => ({ ...f })) };
  }

  get tankValue(): number {
    return this.tank.reduce((s, f) => s + f.pts, 0);
  }

  /** The project whose pond you are at. */
  get spotProject(): ArcadeProject {
    return this.projects[Math.max(0, this.spot) % this.projects.length];
  }

  get biome(): BiomeName {
    return this.spotProject.biome;
  }

  /** Whether anything is left to bite at this spot (no list built). */
  get spotHasFish(): boolean {
    const id = this.spotProject.id;
    return this.pool.some((f) => (f.projectId ?? id) === id);
  }

  /** What can bite at this spot. */
  get spotPool(): FishSpec[] {
    const id = this.spotProject.id;
    return this.pool.filter((f) => (f.projectId ?? id) === id);
  }

  private relayout(): void {
    const f = hudFrame(this.hud, this.W, this.H);
    const lx = f.content.lx, rx = f.content.rx;
    this.sandY = Math.round(f.bottom.y - 30);
    this.tankBox = { x: lx + 4, y: f.top.y + 18, w: rx - lx - 8, h: this.sandY - f.top.y - 22 };
    this.goBtn = { x: f.bottom.cx - 34, y: f.bottom.y - 17, w: 68, h: 15 };
    this.letGoBtn = { x: f.bottom.cx - 26, y: this.goBtn.y - 40, w: 52, h: 12 };

    // The pond fills the middle; the dock comes in from the bottom shore.
    const top = f.top.y + 20, bottom = f.bottom.y - 10;
    const cy = Math.round(top + (bottom - top) * 0.44);
    this.lake = {
      cx: f.content.cx,
      cy,
      rx: Math.max(40, Math.round((rx - lx) / 2 - 6)),
      ry: Math.max(50, Math.round((bottom - top) * 0.46)),
      seed: this.lake.seed,
    };
    this.dockFoot = Math.round(cy + this.lake.ry * 0.92);
    this.angler = { x: f.content.cx - 14, y: Math.round(cy + this.lake.ry * 0.5) };
    this.reel = { x: f.bottom.rx - 20, y: f.bottom.y - 22, r: 17 };
    this.tankBtn = { x: f.top.lx, y: f.top.y, w: 30, h: 11 };
    this.spotBtn = { x: f.top.rx - 34, y: f.top.y, w: 34, h: 11 };
    const cw = Math.min(170, rx - lx - 12);
    const ch = 132;
    this.card = { x: Math.round((lx + rx - cw) / 2), y: Math.round(Math.max(f.top.y + 14, (this.H - ch) / 2 - 10)), w: cw, h: ch };
    const bw = Math.floor((cw - 18) / 2);
    this.keepBtn = { x: this.card.x + 6, y: this.card.y + ch - 20, w: bw, h: 14 };
    this.releaseBtn = { x: this.card.x + cw - 6 - bw, y: this.card.y + ch - 20, w: bw, h: 14 };
  }

  resize(width: number, height: number, hud?: PixelHud): void {
    if (this.W === width && this.H === height && !hud) return;
    const old = { ...this.lake };
    this.W = width;
    this.H = height;
    if (hud) this.hud = hud;
    this.relayout();
    const b = this.tankBox;
    for (const s of this.swimmers) {
      s.x = clamp(s.x, b.x + 6, b.x + b.w - 6);
      s.y = clamp(s.y, b.y + 4, b.y + b.h - 4);
      s.retarget = 0;
    }
    // Pond things keep their place relative to the pond.
    const map = (p: { x: number; y: number }) => {
      p.x = this.lake.cx + ((p.x - old.cx) / old.rx) * this.lake.rx;
      p.y = this.lake.cy + ((p.y - old.cy) / old.ry) * this.lake.ry;
    };
    for (const s of this.shadows) {
      map(s);
      s.tx = s.x;
      s.ty = s.y;
    }
    if (this.bobber) {
      map(this.bobber);
      this.bobber.fly = CAST_FRAMES;
    }
    if (this.hooked) map(this.hooked);
    this.ripples = [];
  }

  private rr(a: number, b: number): number {
    return a + this.rand() * (b - a);
  }

  private setState(s: AnglerState): void {
    this.state = s;
    this.stateT = 0;
  }

  private spawn(spec: FishSpec, drop: boolean): Swimmer {
    const b = this.tankBox;
    const x = this.rr(b.x + 10, b.x + b.w - 10);
    const z = drop ? 0.2 : this.rr(0, 1);
    return {
      spec,
      x,
      y: drop ? b.y - 6 : this.rr(b.y + 8, b.y + b.h - 8),
      z,
      tz: z,
      vx: 0,
      vy: drop ? 1.6 : 0,
      face: this.rand() < 0.5 ? 1 : -1,
      turn: 0,
      tx: x,
      ty: b.y + b.h / 2,
      retarget: 0,
      enter: drop ? 50 : 0,
      leaving: 0,
    };
  }

  /** The rod tip, seen from above (lifted a little off the angler). */
  rodTip(): { x: number; y: number } {
    const len = 17 - (this.hooked ? clamp(this.hooked.tension, 0, 1) * 4 : 0);
    return { x: Math.round(this.angler.x + Math.cos(this.rodAng) * len), y: Math.round(this.angler.y - 5 + Math.sin(this.rodAng) * len) };
  }

  /** A random point at least `margin` (share of the radius) inside the shore. */
  private pondPoint(margin = 0.15): { x: number; y: number } {
    const l = this.lake;
    for (let i = 0; i < 30; i++) {
      const x = this.rr(l.cx - l.rx, l.cx + l.rx), y = this.rr(l.cy - l.ry, l.cy + l.ry * 0.4);
      if (lakeInside(l, x, y) > margin) return { x, y };
    }
    return { x: l.cx, y: l.cy - l.ry * 0.3 };
  }

  // ── Loop ────────────────────────────────────────────────────────────────

  step(): void {
    this.t++;
    this.stateT++;
    if (this.shake > 0) this.shake--;
    if (this.msg && ++this.msg.t > 90) this.msg = null;
    if (this.banner && ++this.banner.t > 260) this.banner = null;
    this.stepParts();
    this.stepTank();
    if (this.state === "tank") return;
    this.stepRod();
    this.stepShadows();
    switch (this.state) {
      case "aim":
      case "cast":
      case "wait":
      case "lost":
        this.stepBobber();
        if (this.state === "lost" && this.stateT > 70) this.setState(this.bobber ? "wait" : "aim");
        break;
      case "fight":
        this.stepFight();
        break;
      default:
        break;
    }
    // Spent after the bobber has had its look, so a strike exactly STRIKE_BUFFER frames early still lands.
    if (this.strikeBuf > 0) this.strikeBuf--;
  }

  private stepParts(): void {
    for (const p of this.parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.12;
      p.life--;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const r of this.ripples) r.t++;
    this.ripples = this.ripples.filter((r) => r.t < r.max);
  }

  splash(x: number, y: number, n: number, c = "#d8f4ff"): void {
    for (let i = 0; i < n; i++) {
      this.parts.push({ x, y, vx: this.rr(-1.2, 1.2), vy: this.rr(-2.4, -0.6), life: Math.round(this.rr(16, 30)), c: i % 3 ? c : "#ffffff" });
    }
  }

  ripple(x: number, y: number, max = 30): void {
    if (this.ripples.length < 12) this.ripples.push({ x, y, t: 0, max });
  }

  private stepTank(): void {
    const b = this.tankBox;
    for (const s of this.swimmers) {
      const sp = SPECIES[s.spec.species];
      if (s.turn > 0) s.turn--;
      if (s.leaving) {
        s.leaving++;
        s.vy -= 0.02;
        s.vx += s.face * 0.03;
        s.x += s.vx;
        s.y += s.vy;
        continue;
      }
      if (s.enter > 0) {
        s.enter--;
        s.vy *= 0.94;
        s.y += s.vy;
        if (s.enter === 44) this.splash(s.x, b.y, 10);
        continue;
      }
      if (--s.retarget <= 0 || Math.hypot(s.tx - s.x, s.ty - s.y) < 4) {
        s.tx = this.rr(b.x + 10, b.x + b.w - 10);
        // Bottom feeders (puffers) keep low; the rest roam the middle.
        const lo = s.spec.species === "puffer" ? 0.55 : 0.1;
        s.ty = b.y + b.h * this.rr(lo, 0.92);
        s.tz = this.rr(0, 1);
        s.retarget = Math.round(this.rr(120, 300));
      }
      // Further back, slower across the glass.
      const max = sp.speed * 0.55 * (1 - s.z * 0.35);
      s.vx = clamp(s.vx + Math.sign(s.tx - s.x) * 0.01, -max, max);
      s.vy = clamp(s.vy + Math.sign(s.ty - s.y) * 0.006, -max * 0.4, max * 0.4);
      if (Math.abs(s.tx - s.x) < 10) s.vx *= 0.96;
      s.x = clamp(s.x + s.vx, b.x + 6, b.x + b.w - 6);
      s.y = clamp(s.y + s.vy, b.y + 4, b.y + b.h - 4);
      s.z += clamp(s.tz - s.z, -0.003, 0.003);
      if (Math.abs(s.vx) > 0.06) {
        const face = s.vx > 0 ? 1 : -1;
        if (face !== s.face) {
          s.face = face;
          s.turn = 12;
        }
      }
    }
    const before = this.swimmers.length;
    this.swimmers = this.swimmers.filter((s) => s.leaving < 140);
    if (this.selected && !this.swimmers.includes(this.selected)) this.selected = null;
    if (before !== this.swimmers.length && this.selected?.leaving) this.selected = null;
  }

  private stepRod(): void {
    const k = this.keys;
    const vx = (k.r ? 1 : 0) - (k.l ? 1 : 0), vy = (k.d ? 1 : 0) - (k.u ? 1 : 0);
    if ((vx || vy) && !this.drag) this.rodAim = Math.atan2(vy, vx);
    this.rodAng = turnToward(this.rodAng, this.rodAim, 0.14);
  }

  private refillShadows(): void {
    const pool = this.spotPool;
    const want = Math.min(4, pool.length);
    while (this.shadows.length < want) {
      // The hooked fish stays in the pool (it comes back after a snap) but isn't in the water twice.
      const taken = new Set(this.shadows.map((s) => s.spec.id));
      if (this.hooked) taken.add(this.hooked.spec.id);
      const free = pool.filter((f) => !taken.has(f.id));
      if (!free.length) break;
      const spec = free[Math.floor(this.rand() * free.length)];
      const p = this.pondPoint(0.2);
      const q = this.pondPoint(0.2);
      this.shadows.push({ spec, x: p.x, y: p.y, a: Math.atan2(q.y - p.y, q.x - p.x), depth: this.rr(0.5, 1), tx: q.x, ty: q.y, flee: 0 });
    }
  }

  private stepShadows(): void {
    if (this.state !== "catch") this.refillShadows();
    for (const s of this.shadows) {
      const sp = SPECIES[s.spec.species];
      const tx = s.tx, ty = s.ty;
      let speed = sp.speed * 0.6;
      if (s.flee) {
        s.flee++;
        speed = 1.4;
        s.depth = Math.min(1.2, s.depth + 0.01);
        s.x += Math.cos(s.a) * speed;
        s.y += Math.sin(s.a) * speed;
        continue;
      }
      if (s === this.biter && this.bobber) {
        // Straight to the bait, stopping with its nose on it.
        const b = this.bobber;
        s.depth += (0.35 - s.depth) * 0.04;
        const d = Math.hypot(b.x - s.x, b.y - s.y), want = s.spec.size / 2;
        const toward = Math.atan2(b.y - s.y, b.x - s.x);
        s.a = turnToward(s.a, toward, 0.14);
        if (d <= want + 1) continue;
        speed = Math.min(sp.speed * 1.4, (d - want) * 0.15 + 0.15);
        s.x += Math.cos(s.a) * speed;
        s.y += Math.sin(s.a) * speed;
        continue;
      } else if (Math.hypot(tx - s.x, ty - s.y) < 6 || this.rand() < 0.003) {
        const q = this.pondPoint(0.2);
        s.tx = q.x;
        s.ty = q.y;
      }
      s.a = turnToward(s.a, Math.atan2(ty - s.y, tx - s.x), 0.05);
      s.x += Math.cos(s.a) * speed;
      s.y += Math.sin(s.a) * speed;
    }
    this.shadows = this.shadows.filter((s) => s.flee < 80);
  }

  private stepBobber(): void {
    const b = this.bobber;
    if (!b) return;
    if (b.fly < CAST_FRAMES) {
      b.fly++;
      if (b.fly === CAST_FRAMES) {
        this.ripple(b.x, b.y, 34);
        this.splash(b.x, b.y, 5);
        this.setState("wait");
        this.biteT = Math.round(this.rr(40, 120));
        this.biter = null;
      }
      return;
    }
    b.dip *= 0.8;
    if (this.state !== "wait") return;
    // A fish comes to the bait, nibbles, then takes it.
    if (!this.biter) {
      if (--this.biteT > 0) return;
      const live = this.shadows.filter((s) => !s.flee);
      if (!live.length) {
        this.biteT = 30;
        return;
      }
      live.sort((a, c) => Math.hypot(a.x - b.x, a.y - b.y) - Math.hypot(c.x - b.x, c.y - b.y));
      this.biter = live[0];
      this.nibbles = 1 + Math.floor(this.rand() * 3);
      this.nibbleT = 0;
      this.wary = false;
      this.biteWindow = 0;
      return;
    }
    const s = this.biter;
    const mx = s.x + Math.cos(s.a) * (s.spec.size / 2), my = s.y + Math.sin(s.a) * (s.spec.size / 2);
    const close = Math.hypot(mx - b.x, my - b.y) < 4.5;
    if (this.biteWindow > 0) {
      b.dip = 5;
      if (--this.biteWindow === 0) {
        this.flee("IT GOT AWAY");
        this.events.push("miss");
      }
      return;
    }
    if (!close) return;
    if (++this.nibbleT % 26 === 0) {
      if (this.nibbles > 0) {
        this.nibbles--;
        b.dip = 2;
        this.ripple(b.x, b.y, 14);
        this.events.push("nibble");
      } else {
        this.biteWindow = BITE_WINDOW;
        b.dip = 5;
        this.ripple(b.x, b.y, 30);
        this.splash(b.x, b.y, 4);
        this.events.push("bite");
        // A strike pressed just before the plunge counts.
        if (this.strikeBuf > 0) this.strike();
      }
    }
  }

  private flee(text: string): void {
    if (this.biter) this.biter.flee = 1;
    this.biter = null;
    this.biteWindow = 0;
    this.biteT = Math.round(this.rr(90, 200));
    this.msg = { text, t: 0 };
  }

  private cast(x: number, y: number): void {
    const l = this.lake;
    // Keep the cast on the water.
    let px = x, py = y;
    for (let i = 0; i < 20 && lakeInside(l, px, py) < 0.08; i++) {
      px += (l.cx - px) * 0.15;
      py += (l.cy - py) * 0.15;
    }
    const tip = this.rodTip();
    this.rodAim = Math.atan2(py - this.angler.y, px - this.angler.x);
    this.bobber = { x: Math.round(px), y: Math.round(py), fly: 0, fx: tip.x, fy: tip.y, dip: 0 };
    this.biter = null;
    this.setState("cast");
    this.events.push("cast");
  }

  /** The strike: hooks a biting fish. Too early only makes it wary; a strike just before the plunge is held. */
  private strike(): void {
    const s = this.biter;
    const b = this.bobber;
    if (!s || !b) return;
    if (this.biteWindow <= 0) {
      this.strikeBuf = STRIKE_BUFFER;
      // Pressed a beat before the plunge: no harm done, the buffer catches it.
      const plungeSoon = this.nibbles === 0 && 26 - (this.nibbleT % 26) <= STRIKE_BUFFER;
      if (this.nibbleT > 0 && !plungeSoon) {
        // Wary once per fish: one more nibble, never an endless wait however often you press.
        if (!this.wary) {
          this.wary = true;
          this.nibbles++;
        }
        this.msg = { text: "NOT YET... WAIT FOR THE PLUNGE", t: 0 };
        this.events.push("early");
      }
      return;
    }
    this.shadows = this.shadows.filter((x) => x !== s);
    this.biter = null;
    this.biteWindow = 0;
    this.strikeBuf = 0;
    // It bolts away from the angler.
    const away = Math.atan2(s.y - this.angler.y, s.x - this.angler.x);
    this.hooked = {
      spec: s.spec,
      x: b.x,
      y: b.y,
      a: away,
      ta: away,
      turnT: Math.round(this.rr(70, 130)),
      stamina: 1,
      tension: 0.15,
      tired: false,
      idle: 0,
      depth: 0.4,
    };
    this.reeling = false;
    this.ripple(b.x, b.y, 40);
    this.splash(b.x, b.y, 10);
    this.bobber = null;
    this.setState("fight");
    this.events.push("hook");
    if (!this.calm) this.shake = 6;
  }

  /** 1 when the rod points the way the fish swims, -1 dead against it. */
  get match(): number {
    const h = this.hooked;
    return h ? Math.cos(this.rodAng - h.a) : 0;
  }

  private stepFight(): void {
    const h = this.hooked;
    if (!h) return;
    const sp = SPECIES[h.spec.species];
    const pull = sp.pull * (h.spec.overdue ? 1.25 : 1);
    const l = this.lake;
    const tip = this.rodTip();

    this.reeling = this.reelPtr !== null || this.reelKey;
    // Cranking keeps the rate up; stop turning (held or not) and it eases back to a plain hold.
    if (!this.cranked) this.crank *= this.reelPtr === null ? 0.8 : 0.9;
    this.cranked = false;

    if (--h.turnT <= 0) {
      const side = this.rand() < 0.5 ? -1 : 1;
      h.ta = h.a + side * this.rr(1.1, 2.4);
      h.turnT = Math.round(h.tired ? this.rr(140, 220) : this.rr(60, 140) / (h.spec.overdue ? 1.2 : 1));
      if (!h.tired) this.events.push("turn");
    }
    // Near the shore it turns back to open water.
    const ahead = { x: h.x + Math.cos(h.a) * 10, y: h.y + Math.sin(h.a) * 10 };
    if (lakeInside(l, ahead.x, ahead.y) < 0.12 && h.turnT > 20) {
      h.ta = Math.atan2(l.cy - l.ry * 0.25 - h.y, l.cx - h.x) + this.rr(-0.6, 0.6);
      h.turnT = Math.round(this.rr(60, 120));
      if (!h.tired) this.events.push("turn");
    }
    h.a = turnToward(h.a, h.ta, TURN_RATE * (h.tired ? 0.5 : 1));

    const match = this.match;
    if (!h.tired) {
      if (match > MATCH) {
        h.stamina -= match / sp.stamina;
        h.tension = Math.max(0, h.tension - 0.018);
      } else {
        h.tension += (MATCH - match) * 0.011 * pull;
        h.stamina = Math.min(1, h.stamina + 0.0006);
        if (match < -0.2 && this.t % 20 === 0) this.events.push("strain");
      }
      if (h.stamina <= 0.2) {
        h.tired = true;
        h.idle = 0;
        h.turnT = Math.round(this.rr(150, 220));
        this.events.push("tired");
        this.msg = { text: "TIRED! REEL IT IN", t: 0 };
      }
    } else {
      h.tension = Math.max(0, h.tension - 0.006);
      if (!this.reeling && ++h.idle > RECOVER_FRAMES) {
        h.tired = false;
        h.stamina = 0.45;
        h.turnT = Math.round(this.rr(40, 90));
        this.msg = { text: "SECOND WIND!", t: 0 };
        this.events.push("turn");
      }
    }

    // It swims its heading; a fresh fish fought badly takes line; reeling draws it to the rod.
    const speed = sp.speed * (h.tired ? 0.25 : 1.1);
    let nx = h.x + Math.cos(h.a) * speed, ny = h.y + Math.sin(h.a) * speed;
    const dx = nx - tip.x, dy = ny - tip.y, d = Math.hypot(dx, dy) || 1;
    if (!h.tired && match <= MATCH) {
      nx += (dx / d) * 0.12 * pull;
      ny += (dy / d) * 0.12 * pull;
    }
    if (this.reeling) {
      h.idle = 0;
      // The handle turns on its own when held (or on the key); a crank turns it with the finger.
      if (this.reelPtr === null || this.crank < 0.1) this.reelAng += this.reelPtr === null ? 0.18 : 0.05;
      const rate = (0.3 + this.crank * 1.1) * (h.tired ? 1 : 0.3);
      nx -= (dx / d) * rate;
      ny -= (dy / d) * rate;
      // Reeling a fresh fish strains the line hard; a tired one barely.
      h.tension += h.tired ? 0.0015 + this.crank * 0.002 : 0.016 * pull;
    }
    // The shore stops it.
    if (lakeInside(l, nx, ny) > 0.03 || Math.hypot(nx - tip.x, ny - tip.y) < d) {
      h.x = nx;
      h.y = ny;
    }
    h.tension = Math.max(0, h.tension);
    h.depth += ((h.tired ? 0 : 0.45) - h.depth) * 0.03;
    if (!h.tired && this.t % 30 === 0 && match <= MATCH) this.ripple(h.x, h.y, 22);
    if (h.tired && this.t % 40 === 0) this.ripple(h.x, h.y, 18);

    if (h.tension >= 1) {
      this.events.push("snap");
      this.msg = { text: "LINE SNAPPED!", t: 0 };
      this.ripple(h.x, h.y, 40);
      this.hooked = null;
      this.reelPtr = null;
      this.reeling = false;
      this.drag = null;
      if (!this.calm) this.shake = 10;
      this.setState("lost");
      return;
    }
    if (Math.hypot(h.x - tip.x, h.y - tip.y) < 9) {
      this.caught = h.spec;
      this.leapFrom = { x: h.x, y: h.y };
      this.hooked = null;
      this.reelPtr = null;
      this.reeling = false;
      this.drag = null;
      // A full tank can't take it: start on LET GO.
      this.catchChoice = this.tankFull ? 1 : 0;
      this.splash(tip.x, tip.y + 4, 18);
      this.ripple(tip.x, tip.y + 4, 40);
      this.events.push("catch");
      this.setState("catch");
    }
  }

  /** Where the leaping fish is during the catch: 0..1 through the leap. */
  get leap(): number {
    return this.state === "catch" ? Math.min(1, this.stateT / LEAP_FRAMES) : 0;
  }

  get tankFull(): boolean {
    return this.tank.length >= TANK_MAX;
  }

  private keep(): void {
    const f = this.caught;
    if (!f || this.tankFull) return;
    this.tank.push(f);
    this.pool = this.pool.filter((p) => p.id !== f.id);
    this.swimmers.push(this.spawn(f, true));
    this.tankDirty = true;
    this.best = Math.max(this.best, this.tankValue);
    this.caught = null;
    this.bobber = null;
    this.shadows = [];
    this.setState("tank");
    this.events.push("keep");
  }

  private release(): void {
    if (!this.caught) return;
    const tip = this.rodTip();
    this.splash(tip.x, tip.y + 6, 14);
    this.ripple(tip.x, tip.y + 6, 36);
    this.caught = null;
    this.msg = { text: "BACK IT GOES", t: 0 };
    this.setState("aim");
    this.events.push("release");
  }

  private letGo(s: Swimmer): void {
    s.leaving = 1;
    s.why = "BYE!";
    this.tank = this.tank.filter((f) => f.id !== s.spec.id);
    // Back to the pond as the task is now (its priority may have changed since the catch);
    // a fish from another workspace just swims off.
    const now = this.liveById.get(s.spec.id);
    if (now && !this.pool.some((f) => f.id === now.id)) this.pool.push(now);
    else if (!now && this.demo) this.pool.push(s.spec);
    this.tankDirty = true;
    this.selected = null;
    this.events.push("release");
  }

  /** Move to the next project's pond that still has fish (or the next one at all). */
  private nextSpot(): void {
    const n = this.projects.length;
    for (let i = 1; i <= n; i++) {
      const s = (this.spot + i + n) % n;
      const id = this.projects[s].id;
      if (this.pool.some((f) => (f.projectId ?? id) === id) || i === n) {
        this.spot = s;
        break;
      }
    }
    this.lake.seed = (this.spot + 1) * 7919;
    this.shadows = [];
    this.bobber = null;
    this.biter = null;
    this.ripples = [];
  }

  private goFish(): void {
    this.selected = null;
    if (this.spot < 0 || !this.spotPool.length) this.nextSpot();
    else {
      this.shadows = [];
      this.bobber = null;
    }
    this.rodAng = this.rodAim = -Math.PI / 2;
    this.setState("aim");
    this.events.push("start");
  }

  private backToTank(): void {
    this.hooked = null;
    this.bobber = null;
    this.biter = null;
    this.reelPtr = null;
    this.drag = null;
    this.setState("tank");
    this.events.push("back");
  }

  // ── Input ───────────────────────────────────────────────────────────────

  private static hit(r: Rect, x: number, y: number, pad = 3): boolean {
    return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
  }

  private onReel(x: number, y: number): boolean {
    return Math.hypot(x - this.reel.x, y - this.reel.y) <= this.reel.r + 6;
  }

  down(x: number, y: number): void {
    switch (this.state) {
      case "tank": {
        if (this.selected && AnglerSim.hit(this.letGoBtn, x, y)) return this.letGo(this.selected);
        if (AnglerSim.hit(this.goBtn, x, y)) return this.goFish();
        let pick: Swimmer | null = null, bestD = 1e9;
        for (const s of this.swimmers) {
          if (s.leaving) continue;
          const d = Math.hypot(s.x - x, s.y - y);
          if (d < s.spec.size / 2 + 8 && d < bestD) {
            bestD = d;
            pick = s;
          }
        }
        this.selected = pick === this.selected ? null : pick;
        if (pick) this.events.push("select");
        return;
      }
      case "aim":
      case "wait":
      case "lost":
        if (AnglerSim.hit(this.tankBtn, x, y)) return this.backToTank();
        if (AnglerSim.hit(this.spotBtn, x, y) && this.state !== "lost") {
          this.nextSpot();
          this.setState("aim");
          this.events.push("spot");
          return;
        }
        // Once a fish is at the bait, any tap is a strike (never a re-cast).
        if (this.state === "wait" && this.biter) return this.strike();
        if (this.state !== "lost" && lakeInside(this.lake, x, y) > -0.05) this.cast(x, y);
        return;
      case "cast":
        if (AnglerSim.hit(this.tankBtn, x, y)) this.backToTank();
        return;
      case "fight":
        if (this.onReel(x, y)) {
          this.reelPtr = Math.atan2(y - this.reel.y, x - this.reel.x);
          return;
        }
        this.drag = { x, y };
        return;
      case "catch":
        if (this.stateT < LEAP_FRAMES) return;
        if (AnglerSim.hit(this.keepBtn, x, y)) return this.keep();
        if (AnglerSim.hit(this.releaseBtn, x, y)) return this.release();
        return;
    }
  }

  move(x: number, y: number): void {
    if (this.state !== "fight") return;
    if (this.reelPtr !== null) {
      // Cranking: each turn of the handle reels faster than just holding.
      const a = Math.atan2(y - this.reel.y, x - this.reel.x);
      let d = a - this.reelPtr;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      this.reelPtr = a;
      this.reelAng += d;
      this.crank = Math.max(this.crank * 0.7, Math.min(1, Math.abs(d) / 0.35));
      if (Math.abs(d) > 0.01) this.cranked = true;
      return;
    }
    // Swipe the way the fish swims: the rod follows the drag.
    if (this.drag) {
      const dx = x - this.drag.x, dy = y - this.drag.y;
      if (Math.hypot(dx, dy) >= 5) {
        this.rodAim = Math.atan2(dy, dx);
        if (Math.hypot(dx, dy) > 24) this.drag = { x: x - (dx / Math.hypot(dx, dy)) * 24, y: y - (dy / Math.hypot(dx, dy)) * 24 };
      }
    }
  }

  up(): void {
    this.drag = null;
    this.reelPtr = null;
  }

  cancel(): void {
    this.up();
  }

  /** The point the cast goes to without a pointer: straight ahead of the rod, halfway across. */
  private keyCastPoint(): { x: number; y: number } {
    const l = this.lake;
    const d = l.ry * 0.85;
    return { x: this.angler.x + Math.cos(this.rodAim) * d, y: this.angler.y + Math.sin(this.rodAim) * d };
  }

  setKey(code: string, isDown: boolean): boolean {
    const left = code === "ArrowLeft" || code === "KeyA";
    const right = code === "ArrowRight" || code === "KeyD";
    const upK = code === "ArrowUp" || code === "KeyW";
    const downK = code === "ArrowDown" || code === "KeyS";
    const act = code === "Space" || code === "Enter";
    const arrow = left || right || upK || downK;
    // Releases always let go, whatever screen the press started on (a reel key held into the catch card).
    if (!isDown) {
      if (left) this.keys.l = false;
      if (right) this.keys.r = false;
      if (upK) this.keys.u = false;
      if (downK) this.keys.d = false;
      if (act || code === "KeyR") this.reelKey = false;
      return act || arrow || code === "KeyR";
    }
    if (arrow && this.state !== "tank" && this.state !== "catch") {
      if (left) this.keys.l = isDown;
      if (right) this.keys.r = isDown;
      if (upK) this.keys.u = isDown;
      if (downK) this.keys.d = isDown;
      return true;
    }
    if (this.state === "fight") {
      if (act || code === "KeyR") {
        this.reelKey = isDown;
        if (isDown) this.crank = Math.max(this.crank, 0.5);
        return true;
      }
      return false;
    }
    if (!isDown) return act || arrow;
    switch (this.state) {
      case "tank":
        if (act) {
          this.goFish();
          return true;
        }
        if ((code === "Delete" || code === "Backspace" || code === "KeyR") && this.selected) {
          this.letGo(this.selected);
          return true;
        }
        if (left || right) {
          const live = this.swimmers.filter((s) => !s.leaving);
          if (!live.length) return true;
          const i = this.selected ? live.indexOf(this.selected) : -1;
          this.selected = live[(i + (right ? 1 : -1) + live.length) % live.length];
          this.events.push("select");
          return true;
        }
        return false;
      case "aim":
      case "wait":
      case "lost":
      case "cast":
        if (code === "KeyT" || code === "Backspace") {
          this.backToTank();
          return true;
        }
        if (code === "KeyN" || code === "Tab") {
          if (this.state === "lost" || this.state === "cast") return true;
          this.nextSpot();
          this.setState("aim");
          this.events.push("spot");
          return true;
        }
        if (!act) return false;
        if (this.state === "wait" && this.biter) this.strike();
        else if (this.state === "aim" || this.state === "wait") {
          const p = this.keyCastPoint();
          this.cast(p.x, p.y);
        }
        return true;
      case "catch":
        if (this.stateT < LEAP_FRAMES) return act;
        if (left || right) {
          this.catchChoice = left ? 0 : 1;
          return true;
        }
        if (code === "KeyK") this.keep();
        else if (code === "KeyR") this.release();
        else if (act) {
          // KEEP reads TANK FULL then: pressing it does nothing, as clicking it does.
          if (this.catchChoice === 0) {
            if (!this.tankFull) this.keep();
          } else this.release();
        } else return false;
        return true;
      default:
        return false;
    }
  }
}
