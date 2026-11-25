/**
 * Tideglass simulation — a lighthouse-mountain traversal mystery.
 * Pure TypeScript, platform-agnostic: one long one-way descent, no loop.
 *
 * You start at the summit lighthouse and descend, Short Hike-style, through
 * alpine, forest and shore to the ebb flats below. Four islanders keep
 * regional routines. No grind, no quest markers — a brass notebook records
 * what happens so the player learns the mountain: jam the mill so the
 * bridge stays down, witness the argument to learn the flare frequency,
 * intercept the flare, trace who moved the cargo crate, crank the lamp,
 * cross the ebb causeway. Five secrets, one awakening at the lens vault.
 *
 * The island is dealt from the workspace: same projects, notes and tasks
 * give the same seed — same gear wash-up, same culprit, same flare
 * frequency, same crew colours. A different workspace deals a different
 * island, and the brass notebook always records this island's frequency.
 */

import { DEMO_DATA, type ArcadeProject } from "../pixel/arcade-data";
import { hudFrame, NO_HUD, type InputMode, type PixelHud } from "../pixel/hud";
import { clamp } from "../pixel/kinds";
import { mulberry32 } from "../pixel/terrain";
import { camFor, project, unproject } from "../pixel/volume";

export const WORLD_W = 1080;
export const WORLD_H = 1320;
/** Summit lighthouse and the start of the descent. */
export const LIGHTHOUSE_POS = { x: 496, y: 132 };
export const SUMMIT_START = { x: 540, y: 170 };
/** Tide mill on the west fork, radio mast on the east fork. */
export const MILL_POS = { x: 240, y: 420 };
export const RADIO_POS = { x: 840, y: 420 };
/** The mill channel the bridge spans (sluice gate). */
export const CHANNEL = { x0: 110, x1: 370, y: 428 };
/** Harbour hut ledger, lens vault, ferry dock, ebb flats. */
export const HUT_POS = { x: 540, y: 640 };
export const VAULT_POS = { x: 220, y: 900 };
export const DOCK_POS = { x: 850, y: 1030 };
export const FLAT_POS = { x: 540, y: 1180 };
export const CHEST_POS = { x: 540, y: 1188 };

/** One slow day, no loop: dawn holds at ebb once the day is spent. */
export const CYCLE_FRAMES = 60 * 720; // 12-minute day
export const LOCK_F = 0.22; // Mira locks the sluice
export const MOVE_F = 0.45; // crate is moved (or on first dock approach)
export const FLARE_F = 0.6; // flare window 0.60–0.78
export const FLARE_END_F = 0.78;
export const EBB_F = 0.8; // tide drops, causeway walkable

export const FREQS = ["84", "88", "91", "95"];

/**
 * The island's variation, seeded by the workspace: same projects, notes and
 * tasks give the same gear, culprit and flare frequency; a different
 * workspace deals a different island. FNV-1a over the stable content.
 */
export function seedFromWorkspace(projects: ArcadeProject[]): number {
  let h = 0x811c9dc5;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x9e3779b9;
    h = Math.imul(h, 0x01000193);
  };
  for (const p of projects) {
    mix(p.id);
    mix(p.name);
    mix(p.accent);
    for (const t of p.tasks) {
      mix(t.title);
      mix(t.priority);
      mix(t.overdue ? "!" : ".");
    }
    for (const n of p.notes) {
      mix(n.id);
      mix(n.title);
    }
  }
  return h >>> 0;
}

export type TideglassPhase = "calm" | "wind" | "squall" | "ebb";
export type TideglassState = "title" | "play";
export type SecretId = "stayed-bridge" | "missed-ferry" | "moved-crate" | "lit-beacon" | "tideglass";
export type TideglassEvent = "start" | "step" | "crank" | "tune" | "jam" | "lock" | "argue" | "flare" | "intercept" | "witness" | "secret" | "log" | "phase" | "shard" | "glass" | "drop" | "zone" | "win";

export type AltZone = "PEAK" | "ALPINE" | "FOREST" | "SHORE";

// ── Mountain ──────────────────────────────────────────────────────────
// Height falls from the summit lighthouse (north) to the ebb flats
// (south). Four terraced cliff walls force the descent through switchback
// passes: you keep going down and down, and can only climb back up on
// the trail.

function ridgeAt(x: number, y: number): number {
  return 0.35 * Math.sin(x * 0.03) * Math.sin(y * 0.025) + 0.2 * Math.sin(x * 0.07 + y * 0.05);
}

/** Below this altitude (ledges) the ground is under the sea. */
export const SEA_LEVEL = 0.034;

/** Altitude in "ledges" (0 shore … ~3 summit) at a world point. */
export function heightAt(x: number, y: number): number {
  const cx = clamp(x, 0, WORLD_W), cy = clamp(y, 0, WORLD_H);
  const base = (3 * (WORLD_H - 80 - cy)) / (WORLD_H - 160);
  // Conical island silhouette: outer east/west flanks and north headland taper into sea cliffs.
  const flank = Math.max(0, (Math.abs(cx - 540) - 320) / 220);
  const northDrop = cy < 95 ? (95 - cy) / 95 : 0;
  const islandDrop = flank * flank * 1.15 + northDrop * 0.75;
  // Real terrain cliff drops at each CliffWall (except inside its pass gap).
  let cliffStep = 0;
  for (const c of CLIFFS) {
    if (cx >= c.x0 && cx <= c.x1 && (cx < c.gap0 || cx > c.gap1)) {
      const d = (cy - c.y) / 10;
      cliffStep += clamp(d, -1, 1) * -0.18;
    }
  }
  const t = clamp(base + ridgeAt(cx, cy) * 0.42 + cliffStep - islandDrop, 0, 3.2);
  // Crisp voxel terraces: 70% flat plateau, 30% steep cliff riser.
  const L = 0.55, q = t / L, i = Math.floor(q), f = q - i;
  const r = clamp((f - 0.7) / 0.3, 0, 1);
  const s = r * r * (3 - 2 * r);
  // The lowest terrace is a beach that shelves gently into the sea instead of a flat at sea level.
  const beach = i === 0 ? (1 - s) * Math.min(f, 0.7) * 0.22 : 0;
  return i * L + s * L + beach;
}

/** Terrace the height sits on (0 … 5). Equal = same ledge. */
export function terraceAt(x: number, y: number): number {
  return Math.floor(heightAt(x, y) / 0.55);
}

export function altZone(h: number): AltZone {
  if (h > 2.2) return "PEAK";
  if (h > 1.4) return "ALPINE";
  if (h > 0.6) return "FOREST";
  return "SHORE";
}

/** Wavy boundary (world y) between elevation bands. */
export function bandY(h: number, x: number): number {
  return 360 - h * 100 + 18 * Math.sin(x * 0.03) + 10 * Math.sin(x * 0.07);
}

/** Switchback trail from the summit to the flats, threading every pass. */
export const TRAIL: { x: number; y: number }[] = [
  { x: 540, y: 170 },
  { x: 452, y: 242 },
  { x: 530, y: 330 },
  { x: 650, y: 430 },
  { x: 560, y: 520 },
  { x: 460, y: 590 },
  { x: 360, y: 680 },
  { x: 300, y: 760 },
  { x: 360, y: 830 },
  { x: 470, y: 930 },
  { x: 600, y: 990 },
  { x: 680, y: 1050 },
  { x: 600, y: 1140 },
  { x: 540, y: 1180 },
];

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * vx + (py - ay) * vy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Distance from a world point to the switchback trail. */
export function trailDist(x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < TRAIL.length - 1; i++) {
    const a = TRAIL[i], b = TRAIL[i + 1];
    const d = distToSegment(x, y, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Open water, judged on the ground averaged over a few steps so tide pools
 * and the wet edge are wadeable and the shoreline doesn't flicker.
 */
export function isSea(x: number, y: number): boolean {
  const r = 6;
  const avg = (heightAt(x, y) + heightAt(x - r, y) + heightAt(x + r, y) + heightAt(x, y - r) + heightAt(x, y + r)) / 5;
  return avg < SEA_LEVEL * 0.6;
}

/** The drowned end of the trail: stepping stones bared at ebb. */
export function onCauseway(x: number, y: number): boolean {
  return y > 960 && trailDist(x, y) < 16;
}

interface CliffWall {
  y: number;
  x0: number;
  x1: number;
  gap0: number;
  gap1: number;
}
/** Terraced cliffs: impassable upward except through the gap (pass). */
export const CLIFFS: CliffWall[] = [
  { y: 330, x0: 140, x1: 700, gap0: 470, gap1: 590 },
  { y: 590, x0: 360, x1: 940, gap0: 400, gap1: 520 },
  { y: 830, x0: 120, x1: 700, gap0: 300, gap1: 420 },
  { y: 1050, x0: 420, x1: 1020, gap0: 620, gap1: 740 },
];

export interface Npc {
  id: "mira" | "ios" | "june" | "piotr";
  name: string;
  role: string;
  accent: string;
  x: number;
  y: number;
  a: number;
  homeX: number;
  homeY: number;
  say: string;
  sayTimer: number;
  /** Trail-following route to the current schedule stop. */
  path: { x: number; y: number }[];
  repath: number;
  gx: number;
  gy: number;
}

export interface Pickup {
  id: number;
  kind: "gear" | "shard" | "glass";
  x: number;
  y: number;
  bob: number;
  taken: boolean;
}

export interface NoteEntry {
  loop: number;
  f: number;
  text: string;
}

export interface InteractTarget {
  kind: "sluice" | "lamp" | "radio" | "dock" | "chest" | "vault" | "hut" | "npc" | "gear";
  id: string;
  x: number;
  y: number;
  prompt: string;
  urgent?: boolean;
}

export interface SecretInfo {
  id: SecretId;
  title: string;
  clue: string;
  unlocked: boolean;
}

export const SECRET_DEFS: Omit<SecretInfo, "unlocked">[] = [
  { id: "stayed-bridge", title: "BRIDGE HELD", clue: "JAM THE MILL SLUICE WITH DRIFTWOOD BEFORE IT LOCKS" },
  { id: "missed-ferry", title: "FERRY MISSED", clue: "LEARN THE FLARE FREQ AT THE ARGUMENT, TUNE IT, CATCH THE FLARE" },
  { id: "moved-crate", title: "CRATE TRACED", clue: "SEE WHO MOVES THE CARGO (OR ASK AROUND), THEN REPORT AT THE HUT" },
  { id: "lit-beacon", title: "BEACON HELD", clue: "CRANK THE LAMP TO FULL AND KEEP IT THROUGH THE SQUALL" },
  { id: "tideglass", title: "TIDEGLASS LIT", clue: "BRING 3 SHARDS + 2 SECRETS TO THE LENS VAULT" },
];

export interface TideglassSpec {
  width: number;
  height: number;
  hud?: PixelHud;
  inputMode?: InputMode;
  best?: number;
  projects?: ArcadeProject[];
}

export function phaseAt(cycleTick: number): TideglassPhase {
  // One-way day: dawn holds at ebb once the day is spent, no loop.
  const f = Math.min(cycleTick / CYCLE_FRAMES, 1);
  if (f < 0.3) return "calm";
  if (f < 0.55) return "wind";
  if (f < EBB_F) return "squall";
  return "ebb";
}

export function loopClock(cycleTick: number): string {
  const s = Math.floor((cycleTick % CYCLE_FRAMES) / 60);
  return `${String((s / 60) | 0).padStart(1, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ── Sea glass & glide ───────────────────────────────────────────────
// Sea glass sits on cliff lips and ridge tops off the trail: the reward for
// hopping and gliding instead of walking the switchbacks. Every few pieces
// lengthen the oilskin glide, which opens longer lines down the mountain.

export const GLASS_COUNT = 24;
export const GLASS_PER_TIER = 4;
/** Frames of glide on a full oilskin, and what each tier of sea glass adds. */
export const GLIDE_BASE = 75;
export const GLIDE_PER_TIER = 30;

// ── Leads ───────────────────────────────────────────────────────────
// Places the Wick has seen or been told about. They sit on the compass and
// glow when their moment in the day is close. Nothing is marked until
// it's known.

export type LeadId = "lamp" | "mill" | "radio" | "hut" | "dock" | "vault" | "flats";
export const LEAD_DEFS: Record<LeadId, { x: number; y: number; label: string }> = {
  lamp: { x: LIGHTHOUSE_POS.x, y: LIGHTHOUSE_POS.y, label: "LAMP" },
  mill: { x: MILL_POS.x, y: MILL_POS.y, label: "MILL" },
  radio: { x: RADIO_POS.x, y: RADIO_POS.y, label: "MAST" },
  hut: { x: HUT_POS.x, y: HUT_POS.y, label: "HUT" },
  dock: { x: DOCK_POS.x, y: DOCK_POS.y, label: "DOCK" },
  vault: { x: VAULT_POS.x, y: VAULT_POS.y, label: "VAULT" },
  flats: { x: FLAT_POS.x, y: FLAT_POS.y, label: "FLATS" },
};
/** How close the Wick must come to spot a place without being told. */
export const SIGHT_RANGE = 210;

export interface Lead {
  id: LeadId;
  x: number;
  y: number;
  label: string;
  /** Its moment is now or soon. */
  hot: boolean;
}

const NPC_DEFS: Omit<Npc, "x" | "y" | "a" | "homeX" | "homeY" | "say" | "sayTimer" | "path" | "repath" | "gx" | "gy">[] = [
  { id: "mira", name: "MIRA", role: "HABOURMASTER", accent: "#e3a23b" },
  { id: "ios", name: "IOS", role: "KEEPER", accent: "#47a3e6" },
  { id: "june", name: "JUNE", role: "OPERATOR", accent: "#2ec4b6" },
  { id: "piotr", name: "PIOTR", role: "FERRYMAN", accent: "#c45aa8" },
];

export class TideglassSim {
  W: number;
  H: number;
  hud: PixelHud;
  readonly inputMode: InputMode;
  private readonly projects: ArcadeProject[];
  /** Workspace seed: same workspace deals the same island. */
  readonly seed: number;
  readonly islandAccent: string;
  rand: () => number = mulberry32(1);
  private nextPickupId = 1;

  state: TideglassState = "title";
  calm = false;
  /** Screen shake + white flash, decaying per step; suppressed when calm. */
  shake = 0;
  flash = 0;
  t = 0;
  loop = 1;
  cycleTick = 0;
  phase: TideglassPhase = "calm";
  score = 0;
  best: number;
  events: TideglassEvent[] = [];

  wick = { x: SUMMIT_START.x, y: SUMMIT_START.y, z: 2.7, vx: 0, vy: 0, vz: 0, a: 0, walkPhase: 0, air: 0, gliding: false, glide: GLIDE_BASE };
  /** Sea glass found, and the places the Wick knows about. */
  glass = 0;
  known = new Set<LeadId>(["lamp"]);
  /** Top-left of the viewport in volume pixels (the renderer pans here). */
  camVX = 0;
  camVY = 0;

  npcs: Npc[] = [];
  pickups: Pickup[] = [];
  pops: { text: string; color: string; x: number; y: number; life: number }[] = [];
  rings: { x: number; y: number; r: number; color: string; life: number }[] = [];
  notes: NoteEntry[] = [];
  secrets = new Set<SecretId>();

  // Clockwork flags (jam + notebook persist across loops)
  sluiceOpen = true;
  jammed = false;
  lockedFired = false;
  hasGear = false;
  lampCrank = 0; // 0..3
  beaconHeld = false;
  freq = 0;
  /** This island's flare frequency, dealt by the workspace seed. */
  flareFreq = 1;
  freqKnown = false;
  argueFired = false;
  flareActive = false;
  flareFiredLoop = 0;
  intercepted = false;
  ferryGone = false;
  crateAtDock = true;
  moveFired = false;
  /** Progress trigger: the crate moves shortly after you first reach the dock. */
  moveAt = -1;
  witnessedMove = false;
  culprit = 0;
  shards = 0;
  chestOpened = false;
  vaultLit = false;
  causewaySeen = false;
  dayEnded = false;
  won = false;
  showWin = false;

  showLog = false;
  bannerText = "";
  bannerColor = "#fff2a0";
  bannerTimer = 0;

  private keys = new Set<string>();
  dragOrigin: { x: number; y: number } | null = null;
  dragCurrent: { x: number; y: number } | null = null;
  private dragMoved = false;
  /** Tap-to-walk route: cliff-aware waypoints, not a straight line. */
  walkPath: { x: number; y: number }[] = [];
  nearby: InteractTarget | null = null;
  /** Optional 3D screen-to-world raycast provided by the 3D renderer. */
  raycast: ((sx: number, sy: number) => { x: number; y: number } | null) | null = null;

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return this.raycast?.(sx, sy) ?? unproject(sx + this.camVX, sy + this.camVY, heightAt);
  }

  constructor(spec: TideglassSpec) {
    this.W = spec.width;
    this.H = spec.height;
    this.hud = spec.hud ?? NO_HUD;
    this.inputMode = spec.inputMode ?? "touch";
    this.best = spec.best ?? 0;
    this.projects = spec.projects?.length ? spec.projects.slice(0, 4) : DEMO_DATA.projects.slice(0, 4);
    this.islandAccent = this.projects[0]?.accent ?? "#e3a23b";
    this.seed = seedFromWorkspace(this.projects);
    this.rand = mulberry32(this.seed);
    this.culprit = Math.floor(this.rand() * NPC_DEFS.length);
    this.flareFreq = this.seed % FREQS.length;
    this.buildWorld();
    this.centerCamera();
  }

  /** The cargo manifest names the most pressing real task: overdue first. */
  manifestTask(): string {
    for (const p of this.projects) {
      const overdue = p.tasks.find((t) => t.overdue);
      if (overdue) return overdue.title;
    }
    return this.projects[0]?.tasks[0]?.title ?? "SALT PORK";
  }

  // Descent tracking: which bands you've dropped through this loop.
  visitedZones = new Set<AltZone>(["PEAK"]);
  deepest = 2.7;

  private buildWorld(): void {
    this.wick.x = SUMMIT_START.x;
    this.wick.y = SUMMIT_START.y;
    this.wick.z = heightAt(SUMMIT_START.x, SUMMIT_START.y);
    this.wick.air = 0;
    this.deepest = this.wick.z;
    this.npcs = NPC_DEFS.map((d, i) => {
      const hx = [MILL_POS.x + 20, LIGHTHOUSE_POS.x + 18, RADIO_POS.x - 18, DOCK_POS.x - 16][i];
      const hy = [MILL_POS.y + 16, LIGHTHOUSE_POS.y + 22, RADIO_POS.y + 12, DOCK_POS.y + 6][i];
      // Islanders wear their project's colours: same workspace, same crew.
      const accent = this.projects[i % this.projects.length]?.accent ?? d.accent;
      return { ...d, accent, x: hx, y: hy, a: 0, homeX: hx, homeY: hy, say: "", sayTimer: 0, path: [], repath: 0, gx: hx, gy: hy };
    });
    // Driftwood gears washed up along the upper trail and by the mill.
    const jx1 = (this.rand() - 0.5) * 16, jy1 = (this.rand() - 0.5) * 12;
    this.spawnPickup("gear", 470 + jx1, 250 + jy1);
    const jx2 = (this.rand() - 0.5) * 16, jy2 = (this.rand() - 0.5) * 12;
    this.spawnPickup("gear", MILL_POS.x - 22 + jx2, MILL_POS.y + 26 + jy2);
    // One tide shard already glints on the flats, for whoever gets down early.
    this.spawnPickup("shard", FLAT_POS.x + 18, FLAT_POS.y + 8);
    this.placeGlass();
  }

  /**
   * Scatter sea glass on cliff lips and ridges away from the trail, a quota
   * per altitude band so every stretch of the descent has some. Its own
   * stream from the seed, so the rest of the island deals the same.
   */
  private placeGlass(): void {
    const rand = mulberry32(this.seed ^ 0x51ea55);
    const quota: Record<AltZone, number> = { PEAK: 4, ALPINE: 7, FOREST: 7, SHORE: 6 };
    const avoid = [LIGHTHOUSE_POS, MILL_POS, RADIO_POS, HUT_POS, VAULT_POS, DOCK_POS, FLAT_POS];
    const placed: { x: number; y: number }[] = [];
    for (let tries = 0; tries < 6000 && placed.length < GLASS_COUNT; tries++) {
      const x = 60 + rand() * (WORLD_W - 120);
      const y = 120 + rand() * (WORLD_H - 200);
      const h = heightAt(x, y);
      if (h < 0.25) continue;
      const zone = altZone(h);
      if (quota[zone] <= 0) continue;
      if (trailDist(x, y) < 34) continue;
      if (avoid.some((p) => Math.hypot(x - p.x, y - p.y) < 46)) continue;
      if (placed.some((p) => Math.hypot(x - p.x, y - p.y) < 70)) continue;
      // A lip: the ground falls away just south (where gliding starts).
      const lip = h - heightAt(x, y + 16) > 0.3 || h - Math.min(heightAt(x - 16, y), heightAt(x + 16, y)) > 0.4;
      if (!lip && rand() > 0.15) continue;
      quota[zone]--;
      placed.push({ x, y });
      this.spawnPickup("glass", x, y);
    }
  }

  /** Glide frames on a full oilskin, from the sea glass found. */
  get glideMax(): number {
    return GLIDE_BASE + Math.floor(this.glass / GLASS_PER_TIER) * GLIDE_PER_TIER;
  }

  private learn(id: LeadId): void {
    if (this.known.has(id)) return;
    this.known.add(id);
    this.log(`NOTED THE ${LEAD_DEFS[id].label} ON THE COMPASS.`);
  }

  /** Known places, with the ones whose moment is near marked hot. */
  leads(): Lead[] {
    const f = Math.min(this.cycleTick / CYCLE_FRAMES, 1);
    const hot: Record<LeadId, boolean> = {
      lamp: (!this.argueFired && f < 0.5) || (this.phase === "squall" && this.lampCrank < 3) || (f > 0.45 && f < EBB_F && this.lampCrank < 3),
      mill: !this.lockedFired && (this.hasGear || f > LOCK_F - 0.08),
      radio: this.flareActive || (f > FLARE_F - 0.06 && f < FLARE_END_F && !this.intercepted),
      hut: this.moveFired && !this.secrets.has("moved-crate"),
      dock: !this.moveFired && f > MOVE_F - 0.08,
      vault: !this.vaultLit && this.shards >= 3 && this.secrets.size >= 2,
      flats: this.causewayOpen && (!this.chestOpened || this.pickups.some((p) => p.kind === "shard" && !p.taken)),
    };
    return [...this.known].map((id) => ({ id, ...LEAD_DEFS[id], hot: hot[id] }));
  }

  /** The next beat of the day the Wick knows about, for the HUD. */
  nextBeat(): { label: string; at: string } | null {
    const f = Math.min(this.cycleTick / CYCLE_FRAMES, 1);
    const at = (x: number) => loopClock(Math.round(x * CYCLE_FRAMES));
    if (!this.lockedFired && this.known.has("mill")) return { label: "SLUICE LOCKS", at: at(LOCK_F) };
    if (!this.moveFired && this.known.has("dock") && f < MOVE_F) return { label: "CRATE MOVES", at: at(MOVE_F) };
    if (f < FLARE_F && this.freqKnown) return { label: `FLARE ON ${FREQS[this.flareFreq]}`, at: at(FLARE_F) };
    if (this.phase !== "squall" && f < 0.55) return { label: "SQUALL", at: at(0.55) };
    if (f < EBB_F) return { label: "EBB TIDE", at: at(EBB_F) };
    return null;
  }

  private spawnPickup(kind: Pickup["kind"], x: number, y: number): void {
    this.pickups.push({ id: this.nextPickupId++, kind, x, y, bob: this.rand() * Math.PI * 2, taken: false });
  }

  private addScore(pts: number): void {
    this.score += pts;
    if (this.score > this.best) this.best = this.score;
  }

  private pop(text: string, color: string, x: number, y: number): void {
    this.pops.push({ text, color, x, y, life: 70 });
  }

  private banner(text: string, color = "#fff2a0"): void {
    this.bannerText = text;
    this.bannerColor = color;
    this.bannerTimer = 180;
  }

  log(text: string): void {
    const f = (this.cycleTick % CYCLE_FRAMES) / CYCLE_FRAMES;
    this.notes.push({ loop: this.loop, f, text });
    if (this.notes.length > 40) this.notes.shift();
  }

  private unlock(id: SecretId, pts: number, label: string, x: number, y: number): void {
    if (this.secrets.has(id)) return;
    this.secrets.add(id);
    this.addScore(pts);
    this.events.push("secret");
    this.log(`SECRET — ${label} +${pts}`);
    this.banner(`SECRET: ${label} +${pts}`, "#fff2a0");
    this.pop(`SECRET +${pts}`, "#fff2a0", x, y - 14);
  }

  get causewayOpen(): boolean {
    return this.phase === "ebb" && this.sluiceOpen;
  }

  get bridgeDown(): boolean {
    return this.sluiceOpen;
  }

  getSecretList(): SecretInfo[] {
    return SECRET_DEFS.map((d) => ({ ...d, unlocked: this.secrets.has(d.id) }));
  }

  culpritName(): string {
    return this.npcs[this.culprit].name;
  }

  logButtonRect(): { x: number; y: number; w: number; h: number } {
    const f = hudFrame(this.hud, this.W, this.H);
    return { x: f.top.rx - 44, y: f.top.y - 1, w: 44, h: 11 };
  }

  /** Touch only: hop (tap) and glide (hold), bottom-right of the content. */
  hopButtonRect(): { x: number; y: number; w: number; h: number } {
    const f = hudFrame(this.hud, this.W, this.H);
    return { x: f.bottom.rx - 30, y: f.bottom.y - 32, w: 30, h: 30 };
  }

  private hopHeld = false;
  private stuck = 0;
  private lastWalk = { x: 0, y: 0 };

  actButtonRect(): { x: number; y: number; w: number; h: number } {
    const f = hudFrame(this.hud, this.W, this.H);
    const w = Math.min(156, Math.max(96, f.content.rx - f.content.lx - 16));
    return { x: Math.round(f.content.cx - w / 2), y: f.bottom.y - 22, w, h: 20 };
  }

  resize(width: number, height: number, hud?: PixelHud): void {
    if (this.W === width && this.H === height && !hud) return;
    this.W = width;
    this.H = height;
    if (hud) this.hud = hud;
    this.centerCamera();
  }

  private centerCamera(): void {
    const p = project(this.wick.x, this.wick.y, this.wick.z);
    const f = hudFrame(this.hud, this.W, this.H);
    const cx = (f.content.lx + f.content.rx) / 2;
    const cy = this.H / 2;
    // Volume-space pan that keeps the wick under the viewport's content box.
    const c = camFor(p.vx - (this.W / 2 - cx), p.vy - (this.H / 2 - cy), this.W, this.H);
    this.camVX = c.cx;
    this.camVY = c.cy;
  }

  down(x: number, y: number): void {
    if (this.state === "title") {
      this.state = "play";
      this.events.push("start");
      this.banner("ONE MOUNTAIN, ONE DAY — HEAD DOWN", "#a8f4e8");
      this.log("STARTED AT THE SUMMIT. HEAD DOWN AND DOWN.");
      return;
    }
    if (this.showWin) {
      this.showWin = false;
      this.events.push("log");
      return;
    }
    const lb = this.logButtonRect();
    if (x >= lb.x - 4 && x <= lb.x + lb.w + 4 && y >= lb.y - 4 && y <= lb.y + lb.h + 4) {
      this.showLog = !this.showLog;
      this.events.push("log");
      return;
    }
    if (this.showLog) {
      this.showLog = false;
      this.events.push("log");
      return;
    }
    if (this.inputMode === "touch") {
      const hb = this.hopButtonRect();
      if (x >= hb.x - 6 && x <= hb.x + hb.w + 6 && y >= hb.y - 6 && y <= hb.y + hb.h + 6) {
        // Hop now; keep holding to open the oilskin. Any walk route carries on.
        this.hopHeld = true;
        this.keys.add("Jump");
        this.tryJump();
        return;
      }
    }
    const ab = this.actButtonRect();
    if (this.nearby && x >= ab.x - 6 && x <= ab.x + ab.w + 6 && y >= ab.y - 6 && y <= ab.y + ab.h + 6) {
      this.interact();
      return;
    }
    // Screen tap -> world (3D raycast if renderer attached, else volume unproject).
    const w = this.screenToWorld(x, y);
    if (this.nearby && Math.hypot(w.x - this.nearby.x, w.y - this.nearby.y) <= 24) {
      this.interact();
      return;
    }
    this.dragOrigin = { x, y };
    this.dragCurrent = { x, y };
    this.dragMoved = false;
  }

  move(x: number, y: number): void {
    if (this.state !== "play" || this.showLog || !this.dragOrigin) return;
    this.dragCurrent = { x, y };
    if (Math.hypot(x - this.dragOrigin.x, y - this.dragOrigin.y) >= 6) {
      this.dragMoved = true;
      this.walkPath = [];
    }
  }

  up(): void {
    if (this.hopHeld) {
      this.hopHeld = false;
      this.keys.delete("Jump");
      return;
    }
    if (this.state === "play" && !this.showLog && this.dragOrigin && !this.dragMoved) {
      // Quick tap -> route around cliffs via the passes, not straight at them.
      const w = this.screenToWorld(this.dragOrigin.x, this.dragOrigin.y);
      const tx = clamp(w.x, 24, WORLD_W - 24);
      const ty = clamp(w.y, 30, WORLD_H - 24);
      this.walkPath = this.findPath(this.wick.x, this.wick.y, tx, ty);
      if (!this.walkPath.length) this.walkPath = [{ x: tx, y: ty }];
    }
    this.dragOrigin = null;
    this.dragCurrent = null;
    this.dragMoved = false;
  }

  setKey(code: string, isDown: boolean): boolean {
    if (isDown && this.state === "title") {
      if (code === "Space" || code === "Enter") {
        this.state = "play";
        this.events.push("start");
        this.log("STARTED AT THE SUMMIT. HEAD DOWN AND DOWN.");
        return true;
      }
      return false;
    }
    if (isDown && this.showWin && (code === "Space" || code === "Enter" || code === "Escape")) {
      this.showWin = false;
      this.events.push("log");
      return true;
    }
    if (isDown && (code === "KeyL" || code === "Tab")) {
      this.showLog = !this.showLog;
      this.events.push("log");
      return true;
    }
    if (isDown && code === "Escape") {
      if (this.showLog) {
        this.showLog = false;
        this.events.push("log");
        return true;
      }
      return false;
    }
    if (isDown && (code === "Space" || code === "Enter" || code === "KeyE")) {
      if (this.showLog) {
        this.showLog = false;
        return true;
      }
      if (this.nearby) return this.interact();
      if (code === "Space") {
        this.keys.add("Jump");
        this.tryJump();
        return true;
      }
      return false;
    }
    if (!isDown && code === "Space") {
      this.keys.delete("Jump");
      return true;
    }
    if (code === "KeyJ" || code === "ShiftLeft" || code === "ShiftRight") {
      if (isDown) {
        this.keys.add("Jump");
        this.tryJump();
      } else {
        this.keys.delete("Jump");
      }
      return true;
    }
    if (
      code === "ArrowUp" || code === "ArrowDown" || code === "ArrowLeft" || code === "ArrowRight" ||
      code === "KeyW" || code === "KeyA" || code === "KeyS" || code === "KeyD"
    ) {
      if (isDown) {
        this.keys.add(code);
        this.walkPath = [];
      } else this.keys.delete(code);
      return true;
    }
    return false;
  }

  /** Advance the day clock (also used by tests). One way: no reset. */
  advanceClock(frames: number): void {
    this.cycleTick = Math.min(this.cycleTick + frames, CYCLE_FRAMES);
    const p = phaseAt(this.cycleTick);
    if (p !== this.phase) {
      this.phase = p;
      this.events.push("phase");
      if (p === "wind") this.banner("WIND RISES · FERRY LOADS AT THE DOCK", "#fff2a0");
      if (p === "squall") this.banner("SQUALL — HOLD THE BEACON", "#ff9e44");
      if (p === "ebb") {
        this.banner(this.sluiceOpen ? "EBB TIDE · CAUSEWAY STONES BARE!" : "EBB TIDE · CHANNEL STILL FLOODED", "#8fb8ff");
        if (this.causewayOpen && !this.causewaySeen) {
          this.causewaySeen = true;
          this.log("LOW WATER REVEALS THE SUNKEN CAUSEWAY.");
        }
      }
    }
    if (this.cycleTick >= CYCLE_FRAMES && !this.dayEnded) {
      this.dayEnded = true;
      this.log("THE DAY HOLDS AT EBB. FINISH THE DESCENT.");
    }
    this.fireTimeline(false);
  }

  /** Fire one-shot beats: day fractions plus progress triggers. No reset. */
  private fireTimeline(fromStep: boolean): void {
    const f = Math.min(this.cycleTick / CYCLE_FRAMES, 1);
    void fromStep;
    if (!this.lockedFired && f >= LOCK_F) {
      this.lockedFired = true;
      if (this.jammed) {
        this.sluiceOpen = true;
        this.log("MIRA LOCKS THE SLUICE — THE GEAR HOLDS IT OPEN.");
        this.pop("GEAR HOLDS!", "#8dff9a", MILL_POS.x, MILL_POS.y - 14);
        this.unlock("stayed-bridge", 300, "BRIDGE HELD", MILL_POS.x, MILL_POS.y);
      } else {
        this.sluiceOpen = false;
        this.log("MIRA LOCKED THE SLUICE. THE BRIDGE IS UP.");
        this.pop("SLUICE LOCKED", "#ff9a6b", MILL_POS.x, MILL_POS.y - 12);
        this.banner("SLUICE LOCKED · FIND ANOTHER WAY DOWN", "#ff9a6b");
      }
      this.events.push("lock");
    }
    // The crate moves on schedule — or shortly after you first reach the dock.
    if (!this.moveFired && this.moveAt < 0 && Math.hypot(this.wick.x - DOCK_POS.x, this.wick.y - DOCK_POS.y) < 150) {
      this.moveAt = this.cycleTick + 900;
    }
    if (!this.moveFired && (f >= MOVE_F || (this.moveAt > 0 && this.cycleTick >= this.moveAt))) {
      this.moveFired = true;
      this.crateAtDock = false;
      const near = Math.hypot(this.wick.x - DOCK_POS.x, this.wick.y - DOCK_POS.y) < 70;
      if (near) {
        this.witnessedMove = true;
        this.log(`${this.culpritName()} MOVED THE CARGO CRATE. REPORT AT THE HUT.`);
        this.pop(`${this.culpritName()} MOVED IT!`, "#fff2a0", DOCK_POS.x, DOCK_POS.y - 14);
        this.events.push("witness");
      } else {
        this.log("THE CARGO CRATE IS GONE FROM THE DOCK.");
        this.pop("CRATE GONE?", "#c7e4ff", DOCK_POS.x, DOCK_POS.y - 14);
      }
    }
    if (!this.argueFired && f >= 0.06 && f <= 0.8) {
      const nearLight = Math.hypot(this.wick.x - LIGHTHOUSE_POS.x, this.wick.y - LIGHTHOUSE_POS.y) < 90;
      if (nearLight) {
        this.argueFired = true;
        this.freqKnown = true;
        this.log(`ARGUMENT OVERHEARD — JUNE: "FLARE ON ${FREQS[this.flareFreq]}!"`);
        this.pop(`FLARE ON ${FREQS[this.flareFreq]}!`, "#fff2a0", LIGHTHOUSE_POS.x, LIGHTHOUSE_POS.y - 16);
        this.rings.push({ x: LIGHTHOUSE_POS.x, y: LIGHTHOUSE_POS.y, r: 6, color: "#fff2a0", life: 50 });
        this.events.push("argue");
        this.learn("radio");
      }
    }
    if (f >= FLARE_F && f <= FLARE_END_F) {
      if (!this.flareActive) {
        this.flareActive = true;
        this.flareFiredLoop = this.loop;
        this.log(`SIGNAL FLARE UP OVER THE SUMMIT.`);
        this.rings.push({ x: LIGHTHOUSE_POS.x, y: LIGHTHOUSE_POS.y - 10, r: 5, color: "#ff5e8a", life: 60 });
        this.events.push("flare");
      }
    } else if (this.flareActive && f > FLARE_END_F) {
      this.flareActive = false;
      if (!this.intercepted && !this.ferryGone) {
        this.ferryGone = true;
        this.log("THE FERRY SAILED ON TIME WITH THE FLARE SEEN.");
      }
    }
    // Beacon check: full crank held through the squall.
    if (this.phase === "squall" && this.lampCrank >= 3 && !this.beaconHeld) {
      this.beaconHeld = true;
      this.log("SQUALL — LAMP AT FULL. THE BEACON HOLDS.");
      this.pop("BEACON HOLDS!", "#ffe9a8", LIGHTHOUSE_POS.x, LIGHTHOUSE_POS.y - 18);
      this.shards++;
      this.addScore(100);
      this.events.push("shard");
      if (!this.calm) {
        this.flash = Math.max(this.flash, 6);
        this.shake = Math.max(this.shake, 3);
      }
      this.unlock("lit-beacon", 350, "BEACON HELD", LIGHTHOUSE_POS.x, LIGHTHOUSE_POS.y);
    }
  }

  private findNearby(): InteractTarget | null {
    const wx = this.wick.x, wy = this.wick.y;
    const out: { d: number; t: InteractTarget }[] = [];
    const push = (d: number, maxR: number, t: InteractTarget) => {
      if (d <= maxR) out.push({ d, t });
    };
    if (!this.hasGear) {
      for (const p of this.pickups) {
        if (p.kind === "gear" && !p.taken) {
          push(Math.hypot(wx - p.x, wy - p.y), 22, { kind: "gear", id: `gear-${p.id}`, x: p.x, y: p.y, prompt: "TAKE DRIFTWOOD GEAR", urgent: true });
        }
      }
    }
    push(Math.hypot(wx - MILL_POS.x, wy - MILL_POS.y), 30, {
      kind: "sluice", id: "sluice", x: MILL_POS.x, y: MILL_POS.y,
      prompt: this.jammed ? "SLUICE JAMMED OPEN" : this.hasGear ? "JAM THE SLUICE" : this.sluiceOpen ? "CLOSE SLUICE" : "OPEN SLUICE",
      urgent: !this.jammed && Math.min(this.cycleTick / CYCLE_FRAMES, 1) < LOCK_F,
    });
    push(Math.hypot(wx - LIGHTHOUSE_POS.x, wy - LIGHTHOUSE_POS.y), 32, {
      kind: "lamp", id: "lamp", x: LIGHTHOUSE_POS.x, y: LIGHTHOUSE_POS.y,
      prompt: this.lampCrank >= 3 ? "LAMP AT FULL" : `CRANK THE LAMP (${this.lampCrank}/3)`,
      urgent: this.phase === "squall" && this.lampCrank < 3,
    });
    push(Math.hypot(wx - RADIO_POS.x, wy - RADIO_POS.y), 30, {
      kind: "radio", id: "radio", x: RADIO_POS.x, y: RADIO_POS.y,
      prompt: this.flareActive ? `CATCH FLARE ON ${FREQS[this.freq]}` : `TUNE DIAL (${FREQS[this.freq]})`,
      urgent: this.flareActive && this.freq === this.flareFreq,
    });
    push(Math.hypot(wx - DOCK_POS.x, wy - DOCK_POS.y), 28, {
      kind: "dock", id: "dock", x: DOCK_POS.x, y: DOCK_POS.y,
      prompt: this.crateAtDock ? "INSPECT CARGO CRATE" : this.witnessedMove ? "CRATE MOVED — REPORT!" : "ASK PIOTR",
    });
    if (this.causewayOpen && !this.chestOpened) {
      push(Math.hypot(wx - CHEST_POS.x, wy - CHEST_POS.y), 26, {
        kind: "chest", id: "chest", x: CHEST_POS.x, y: CHEST_POS.y, prompt: "PRY SUNKEN CHEST", urgent: true,
      });
    }
    push(Math.hypot(wx - VAULT_POS.x, wy - VAULT_POS.y), 28, {
      kind: "vault", id: "vault", x: VAULT_POS.x, y: VAULT_POS.y,
      prompt: this.vaultLit ? "TIDEGLASS SHINES" : `FIT THE LENS (${this.shards}/3)`,
      urgent: !this.vaultLit && this.shards >= 3 && this.secrets.size >= 2,
    });
    push(Math.hypot(wx - HUT_POS.x, wy - HUT_POS.y), 30, {
      kind: "hut", id: "hut", x: HUT_POS.x, y: HUT_POS.y,
      prompt: this.moveFired && !this.secrets.has("moved-crate") ? (this.witnessedMove ? `REPORT: ${this.culpritName()} MOVED IT` : "CHECK THE LEDGER") : "READ HARBOUR LEDGER",
    });
    for (const n of this.npcs) {
      push(Math.hypot(wx - n.x, wy - n.y), 22, { kind: "npc", id: n.id, x: n.x, y: n.y, prompt: `TALK: ${n.name}` });
    }
    if (!out.length) return null;
    out.sort((a, b) => Number(Boolean(b.t.urgent)) - Number(Boolean(a.t.urgent)) || a.d - b.d);
    return out[0].t;
  }

  interact(): boolean {
    if (this.state !== "play") return false;
    const t = this.nearby ?? this.findNearby();
    if (!t) return false;
    switch (t.kind) {
      case "gear": {
        const p = this.pickups.find((q) => q.kind === "gear" && !q.taken);
        if (!p) return false;
        p.taken = true;
        this.hasGear = true;
        this.addScore(25);
        this.events.push("step");
        this.pop("+ DRIFTWOOD GEAR", "#d9b078", p.x, p.y - 10);
        this.log(`FOUND DRIFTWOOD GEAR. JAM THE MILL SLUICE BEFORE ${loopClock(Math.round(LOCK_F * CYCLE_FRAMES))}.`);
        this.learn("mill");
        return true;
      }
      case "sluice": {
        if (this.jammed) {
          this.pop("JAMMED OPEN", "#8dff9a", MILL_POS.x, MILL_POS.y - 12);
          return true;
        }
        if (this.hasGear) {
          this.hasGear = false;
          this.jammed = true;
          this.sluiceOpen = true;
          this.addScore(50);
          this.events.push("jam");
          if (!this.calm) this.shake = Math.max(this.shake, 3);
          this.pop("SLUICE JAMMED!", "#8dff9a", MILL_POS.x, MILL_POS.y - 12);
          this.log("JAMMED THE SLUICE. IT WILL HOLD PAST THE LOCK.");
          if (Math.min(this.cycleTick / CYCLE_FRAMES, 1) >= LOCK_F) {
            this.unlock("stayed-bridge", 300, "BRIDGE HELD", MILL_POS.x, MILL_POS.y);
          }
          return true;
        }
        this.sluiceOpen = !this.sluiceOpen;
        this.events.push("step");
        this.pop(this.sluiceOpen ? "SLUICE OPEN" : "SLUICE SHUT", "#47a3e6", MILL_POS.x, MILL_POS.y - 12);
        return true;
      }
      case "lamp": {
        if (this.lampCrank >= 3) {
          this.pop("LAMP AT FULL", "#ffe9a8", LIGHTHOUSE_POS.x, LIGHTHOUSE_POS.y - 12);
          return true;
        }
        this.lampCrank++;
        this.events.push("crank");
        this.rings.push({ x: LIGHTHOUSE_POS.x, y: LIGHTHOUSE_POS.y - 8, r: 4, color: "#ffe9a8", life: 30 });
        this.pop(`CRANK ${this.lampCrank}/3`, "#ffe9a8", LIGHTHOUSE_POS.x, LIGHTHOUSE_POS.y - 12);
        if (this.lampCrank >= 3) this.log("LAMP CRANKED TO FULL. HOLD IT THROUGH THE SQUALL.");
        return true;
      }
      case "radio": {
        if (this.flareActive && this.freq === this.flareFreq && this.intercepted) {
          this.pop("ALREADY CAUGHT", "#c7d0e6", RADIO_POS.x, RADIO_POS.y - 12);
          return true;
        }
        if (this.flareActive && this.freq === this.flareFreq) {
          this.intercepted = true;
          this.ferryGone = true;
          this.shards++;
          this.addScore(100);
          this.events.push("intercept");
          if (!this.calm) this.shake = Math.max(this.shake, 2);
          this.pop("FLARE CAUGHT!", "#ff5e8a", RADIO_POS.x, RADIO_POS.y - 12);
          this.log(`INTERCEPTED THE FLARE ON ${FREQS[this.freq]} — PIOTR MISSED THE FERRY.`);
          this.unlock("missed-ferry", 350, "FERRY MISSED", RADIO_POS.x, RADIO_POS.y);
          return true;
        }
        if (this.flareActive) {
          this.pop(`WRONG FREQ (${FREQS[this.freq]})`, "#8fb8ff", RADIO_POS.x, RADIO_POS.y - 12);
          this.log(`FLARE SLIPPED — DIAL ON ${FREQS[this.freq]}, NEED ${this.freqKnown ? FREQS[this.flareFreq] : "??"}.`);
          return true;
        }
        this.freq = (this.freq + 1) % FREQS.length;
        this.events.push("tune");
        this.pop(`DIAL ${FREQS[this.freq]}`, "#2ec4b6", RADIO_POS.x, RADIO_POS.y - 12);
        return true;
      }
      case "dock": {
        if (this.crateAtDock) {
          const title = this.manifestTask();
          this.pop(title.slice(0, 18), "#d9b078", DOCK_POS.x, DOCK_POS.y - 12);
          this.log(`MANIFEST: "${title.slice(0, 24)}" SAILS AT THE FLARE.`);
        } else if (this.witnessedMove) {
          this.pop("REPORT AT THE HUT!", "#fff2a0", DOCK_POS.x, DOCK_POS.y - 12);
        } else {
          const p = this.npcs.find((n) => n.id === "piotr")!;
          p.say = this.intercepted ? "NO FLARE... MISSED HER." : "FLARE MEANS SAIL, FRIEND.";
          p.sayTimer = 180;
        }
        this.events.push("log");
        return true;
      }
      case "chest": {
        if (!this.causewayOpen || this.chestOpened) return false;
        this.chestOpened = true;
        this.shards++;
        this.addScore(100);
        this.events.push("shard");
        this.pop("+ TIDE SHARD", "#a8f4e8", CHEST_POS.x, CHEST_POS.y - 12);
        this.log("EBB — PRIED THE SUNKEN CHEST. A SHARD OF CALM GLASS.");
        return true;
      }
      case "vault": {
        if (this.vaultLit) {
          this.pop("TIDEGLASS SHINES", "#a8f4e8", VAULT_POS.x, VAULT_POS.y - 12);
          return true;
        }
        if (this.shards >= 3 && this.secrets.size >= 2) {
          this.shards -= 3;
          this.vaultLit = true;
          this.won = true;
          this.showWin = true;
          if (!this.calm) {
            this.flash = 8;
            this.shake = 4;
          }
          this.unlock("tideglass", 600, "TIDEGLASS LIT!", VAULT_POS.x, VAULT_POS.y);
          this.banner("THE LENS TAKES THE LIGHT — DESCENT COMPLETE", "#a8f4e8");
          this.log("THE LENS TAKES THE LIGHT. THE MOUNTAIN IS MAPPED.");
          this.events.push("win");
        } else {
          this.pop(`NEED 3 SHARDS (${this.shards}/3) + 2 SECRETS`, "#c7e4ff", VAULT_POS.x, VAULT_POS.y - 12);
        }
        return true;
      }
      case "hut": {
        // Missed the move? The harbour ledger names who signed for the crate, which counts as the report.
        if (this.moveFired && !this.witnessedMove) {
          this.witnessedMove = true;
          this.log(`LEDGER: ${this.culpritName()} SIGNED FOR THE CRATE.`);
        }
        if (this.witnessedMove && !this.secrets.has("moved-crate")) {
          this.unlock("moved-crate", 300, `CRATE TRACED: ${this.culpritName()}`, HUT_POS.x, HUT_POS.y);
          this.addScore(50);
        } else {
          const hint = this.witnessedMove
            ? `LEDGER: ${this.culpritName()} SIGNED FOR IT.`
            : this.freqKnown
              ? `LEDGER: FLARE ON ${FREQS[this.flareFreq]}. TUNE THE MAST.`
              : "LEDGER: WATCH THE DOCK. LISTEN AT THE SUMMIT.";
          this.pop(hint.slice(0, 26), "#c7e4ff", HUT_POS.x, HUT_POS.y - 12);
          this.log(hint);
          this.learn("dock");
          this.learn("radio");
        }
        this.events.push("log");
        return true;
      }
      case "npc": {
        const n = this.npcs.find((q) => q.id === t.id);
        if (!n) return false;
        n.say = this.npcHint(n.id);
        n.sayTimer = 200;
        // What they talk about goes on the compass.
        const teaches: Record<Npc["id"], LeadId[]> = { mira: ["mill", "flats"], ios: ["lamp", "vault"], june: ["radio"], piotr: ["dock", "hut"] };
        for (const id of teaches[n.id]) this.learn(id);
        this.events.push("log");
        return true;
      }
      default:
        return false;
    }
  }

  private npcHint(id: Npc["id"]): string {
    const f = (this.cycleTick % CYCLE_FRAMES) / CYCLE_FRAMES;
    switch (id) {
      case "mira":
        return f < LOCK_F ? "THE SLUICE LOCKS EARLY. JAM IT IF YOU DARE." : this.jammed ? "THE GEAR HOLDS. CLEVER." : "BRIDGE IS UP. THE TIDE WILL TELL.";
      case "ios":
        return this.phase === "squall" ? "CRANK HER TO FULL, HOLD HER!" : "JUNE NEVER LISTENS. BRING HER UP HERE.";
      case "june":
        return this.freqKnown ? `FLARE'S ON ${FREQS[this.flareFreq]}. YOU HEARD IT.` : "CATCH OUR ARGUMENT AT THE SUMMIT IF YOU WANT THE FREQ.";
      case "piotr":
        return this.crateAtDock ? `CRATE SAILS AT THE FLARE. SOMEONE MOVES IT ABOUT ${loopClock(Math.round(MOVE_F * CYCLE_FRAMES))}.` : this.witnessedMove ? "SAW WHO TOOK IT? TELL THE HUT." : "CRATE'S GONE. SOMEONE SIGNED. ASK THE HUT.";
    }
  }

  /**
   * Can anything step from (fx,fy) to (tx,ty)? Cliffs are one-way: dropping
   * south off a lip is always fine, climbing north back up only works on the
   * trail or through a pass. Water rules are shared by all walkers unless
   * `ignoreWater` (locals know the fords; the wick does not).
   */
  canStep(fx: number, fy: number, tx: number, ty: number, ignoreWater = false): boolean {
    if (tx < 18 || tx > WORLD_W - 18 || ty < 26 || ty > WORLD_H - 18) return false;
    if (Math.hypot(tx - LIGHTHOUSE_POS.x, ty - LIGHTHOUSE_POS.y) < 12) return false;
    if (!ignoreWater) {
      const toFlats = Math.hypot(tx - FLAT_POS.x, ty - FLAT_POS.y);
      if (!this.causewayOpen && toFlats < 40) return false;
      // Open sea: the Wick can't swim. At ebb the flats around the causeway are bare.
      if (isSea(tx, ty) && !(this.causewayOpen && (toFlats < 64 || onCauseway(tx, ty)))) return false;
      if (!this.bridgeDown && tx > CHANNEL.x0 && tx < CHANNEL.x1 && Math.abs(ty - CHANNEL.y) < 12) return false;
    }
    // Terraced cliff walls: climbing north through one only works inside
    // the pass gap. The trail threads the gaps by design; anywhere else
    // along the wall the climb is refused even if the trail is near.
    if (ty < fy) {
      for (const c of CLIFFS) {
        if (fy >= c.y && ty < c.y && tx >= c.x0 && tx <= c.x1 && (tx < c.gap0 || tx > c.gap1)) {
          return false;
        }
      }
      const rise = heightAt(tx, ty) - heightAt(fx, fy);
      if (rise > 0.55 && trailDist(tx, ty) > 16) return false;
    }
    return true;
  }

  private blockedAt(x: number, y: number): boolean {
    return !this.canStep(this.wick.x, this.wick.y, x, y);
  }

  // ── Pathfinding ─────────────────────────────────────────────────────
  // Coarse-grid BFS over the mountain. Edges are directed (cliffs fall one
  // way), so straight-line walkers get rerouted through the passes.

  private cellOf(x: number, y: number): [number, number] {
    return [clamp(Math.floor(x / 20), 0, 53), clamp(Math.floor((y - 26) / 20), 0, 64)];
  }

  private cellCenter(gx: number, gy: number): { x: number; y: number } {
    return { x: gx * 20 + 10, y: 26 + gy * 20 + 10 };
  }

  private los(ax: number, ay: number, bx: number, by: number, ignoreWater: boolean): boolean {
    // 4-unit samples: narrower than the gap any open water leaves (see isSea).
    const d = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(d / 4));
    let px = ax, py = ay;
    for (let i = 1; i <= steps; i++) {
      const qx = ax + ((bx - ax) * i) / steps, qy = ay + ((by - ay) * i) / steps;
      if (!this.canStep(px, py, qx, qy, ignoreWater)) return false;
      px = qx;
      py = qy;
    }
    return true;
  }

  /** Furthest-line-of-sight smoothing over a cell path. */
  private smoothPath(sx: number, sy: number, pts: { x: number; y: number }[], ignoreWater: boolean): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    let ax = sx, ay = sy, idx = 0;
    while (idx < pts.length) {
      let far = idx;
      for (let j = idx; j < pts.length; j++) {
        if (this.los(ax, ay, pts[j].x, pts[j].y, ignoreWater)) far = j;
        else break;
      }
      out.push(pts[far]);
      ax = pts[far].x;
      ay = pts[far].y;
      idx = far + 1;
    }
    return out;
  }

  /** Waypoints from (sx,sy) to (tx,ty). Falls back to the nearest reachable cell when the target itself is blocked (flooded flat, solid rock). */
  findPath(sx: number, sy: number, tx: number, ty: number, ignoreWater = false): { x: number; y: number }[] {
    if (this.los(sx, sy, tx, ty, ignoreWater)) return [{ x: tx, y: ty }];
    const [si, sj] = this.cellOf(sx, sy);
    const [ti, tj] = this.cellOf(tx, ty);
    if (si === ti && sj === tj) return [{ x: tx, y: ty }];
    const key = (i: number, j: number): number => j * 54 + i;
    const prev = new Map<number, number>();
    const seen = new Set<number>([key(si, sj)]);
    const queue: [number, number][] = [[si, sj]];
    const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    let found = false;
    let best = key(si, sj), bestD = Infinity;
    const cellDist = (i: number, j: number): number => Math.hypot(i - ti, j - tj);
    while (queue.length) {
      const [ci, cj] = queue.shift()!;
      const dd = cellDist(ci, cj);
      if (dd < bestD) {
        bestD = dd;
        best = key(ci, cj);
      }
      if (ci === ti && cj === tj) {
        found = true;
        break;
      }
      const cc = this.cellCenter(ci, cj);
      for (const [di, dj] of DIRS) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || ni > 53 || nj < 0 || nj > 64 || seen.has(key(ni, nj))) continue;
        const nc = this.cellCenter(ni, nj);
        // Check halfway too: a narrow strip of sea between two dry cell centres still blocks.
        const mx = (cc.x + nc.x) / 2, my = (cc.y + nc.y) / 2;
        if (!this.canStep(cc.x, cc.y, mx, my, ignoreWater) || !this.canStep(mx, my, nc.x, nc.y, ignoreWater)) continue;
        if (di !== 0 && dj !== 0) {
          const ox = this.cellCenter(ci + di, cj), oy = this.cellCenter(ci, cj + dj);
          if (!this.canStep(cc.x, cc.y, ox.x, ox.y, ignoreWater) || !this.canStep(cc.x, cc.y, oy.x, oy.y, ignoreWater)) continue;
        }
        seen.add(key(ni, nj));
        prev.set(key(ni, nj), key(ci, cj));
        queue.push([ni, nj]);
      }
    }
    const end = found ? key(ti, tj) : best;
    if (end === key(si, sj)) return [];
    const cells: [number, number][] = [];
    let k = end;
    while (k !== key(si, sj)) {
      cells.push([k % 54, Math.floor(k / 54)]);
      const p = prev.get(k);
      if (p === undefined) return [];
      k = p;
    }
    cells.reverse();
    const pts = cells.map(([i, j]) => this.cellCenter(i, j));
    if (found) pts.push({ x: tx, y: ty });
    return this.smoothPath(sx, sy, pts, ignoreWater);
  }

  private tryJump(): boolean {
    if (this.state !== "play" || this.showLog || this.showWin) return false;
    const h = heightAt(this.wick.x, this.wick.y);
    if (this.wick.z <= h + 0.08 && this.wick.air === 0) {
      this.wick.vz = 0.22;
      this.wick.z = h + 0.09;
      this.wick.air = 18;
      this.events.push("step");
      this.rings.push({ x: this.wick.x, y: this.wick.y, r: 3, color: "#a8f4e8", life: 16 });
      return true;
    }
    return false;
  }

  private stepWarden(): void {
    let dx = 0, dy = 0;
    if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) dx -= 1;
    if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) dx += 1;
    if (this.keys.has("ArrowUp") || this.keys.has("KeyW")) dy -= 1;
    if (this.keys.has("ArrowDown") || this.keys.has("KeyS")) dy += 1;
    if (dx === 0 && dy === 0 && this.dragOrigin && this.dragCurrent && this.dragMoved) {
      // Screen drag -> world direction through the same projection as taps,
      // so downhill on screen stays downhill in the sim.
      const a = this.screenToWorld(this.dragOrigin.x, this.dragOrigin.y);
      const b = this.screenToWorld(this.dragCurrent.x, this.dragCurrent.y);
      const vx = b.x - a.x, vy = b.y - a.y;
      const len = Math.hypot(vx, vy);
      if (len > 4) {
        dx = vx / len;
        dy = vy / len;
      }
    } else if (dx === 0 && dy === 0 && this.walkPath.length) {
      // A route that stops making progress gets one re-plan from here, then is dropped.
      if (Math.hypot(this.wick.x - this.lastWalk.x, this.wick.y - this.lastWalk.y) < 0.5) {
        if (++this.stuck === 20) {
          const goal = this.walkPath[this.walkPath.length - 1];
          this.walkPath = this.findPath(this.wick.x, this.wick.y, goal.x, goal.y);
        } else if (this.stuck > 50) {
          this.walkPath = [];
          this.stuck = 0;
        }
      } else this.stuck = 0;
      this.lastWalk = { x: this.wick.x, y: this.wick.y };
    }
    if (dx === 0 && dy === 0 && !(this.dragOrigin && this.dragMoved) && this.walkPath.length) {
      const wp = this.walkPath[0];
      const vx = wp.x - this.wick.x;
      const vy = wp.y - this.wick.y;
      if (Math.hypot(vx, vy) > 3) {
        dx = vx / Math.hypot(vx, vy);
        dy = vy / Math.hypot(vx, vy);
      } else {
        this.walkPath.shift();
      }
    }
    const hBefore = heightAt(this.wick.x, this.wick.y);
    const airborne = this.wick.z > hBefore + 0.06 || this.wick.air > 0;
    const jumpHeld = this.keys.has("Jump");
    this.wick.gliding = airborne && jumpHeld && this.wick.vz <= 0.04 && this.wick.glide > 0;
    if (this.wick.gliding) this.wick.glide--;
    else if (!airborne) this.wick.glide = Math.min(this.glideMax, this.wick.glide + 3);

    const len = Math.hypot(dx, dy);
    if (len > 0.01) {
      // Slope shapes the descent: downhill hurries, uphill drags; gliding boosts airspeed.
      const h0 = hBefore;
      const probeX = this.wick.x + dx / len, probeY = this.wick.y + dy / len;
      const dh = heightAt(probeX, probeY) - h0;
      const glideMul = this.wick.gliding ? 1.35 : 1.0;
      const spd = 2.6 * glideMul * (airborne ? 1.05 : dh < -0.2 ? 1.25 : dh > 0.2 ? 0.55 : 1.0);
      const nx = (dx / len) * spd, ny = (dy / len) * spd;
      const px = this.wick.x + nx, py = this.wick.y + ny;
      const wasAir = this.wick.air > 0;
      if (!this.blockedAt(px, this.wick.y)) this.wick.x = px;
      if (!this.blockedAt(this.wick.x, py)) this.wick.y = py;
      // Stepping south off a cliff lip: launch into real parabolic air.
      let dropped = false;
      for (const c of CLIFFS) {
        if (this.wick.y >= c.y && py >= c.y - 1 && this.wick.y < c.y + 6 && ny > 0) {
          const hAbove = heightAt(this.wick.x, c.y - 6), hBelow = heightAt(this.wick.x, c.y + 6);
          if (hAbove - hBelow > 0.5) dropped = true;
        }
      }
      const hNow = heightAt(this.wick.x, this.wick.y);
      if (this.wick.z - hNow > 0.35 || dropped) {
        if (!wasAir) {
          this.events.push("drop");
          this.rings.push({ x: this.wick.x, y: this.wick.y, r: 3, color: "#ffffff", life: 22 });
          if (dropped) this.wick.vz = Math.max(this.wick.vz, 0.08);
        }
        this.wick.air = Math.max(this.wick.air, 12);
      }
      this.wick.a = Math.atan2(ny, nx) + Math.PI / 2;
      if (!airborne) {
        this.wick.walkPhase += 0.22 * (dh < -0.2 ? 1.3 : 1);
        if (this.t % 18 === 0) this.events.push("step");
      }
    } else this.wick.walkPhase *= 0.8;

    // Vertical physics: gravity + optional oilskin glide, then soft landing.
    const h = heightAt(this.wick.x, this.wick.y);
    const wasAir = this.wick.air > 0 || this.wick.z > h + 0.08;
    if (this.wick.z > h + 0.02 || this.wick.vz > 0) {
      const grav = this.wick.gliding ? 0.004 : 0.015;
      this.wick.vz -= grav;
      if (this.wick.gliding && this.wick.vz < -0.025) this.wick.vz = -0.025;
      this.wick.z += this.wick.vz;
      if (this.wick.z <= h) {
        const hardDrop = this.wick.vz < -0.18;
        this.wick.z = h;
        this.wick.vz = 0;
        this.wick.air = 0;
        this.wick.gliding = false;
        if (wasAir && hardDrop) {
          this.rings.push({ x: this.wick.x, y: this.wick.y, r: 5, color: "#d9c48a", life: 26 });
          if (!this.calm) this.shake = Math.max(this.shake, 1.5);
          this.pop("DROPPED", "#ffffff", this.wick.x, this.wick.y - 14);
        }
      } else {
        this.wick.air = Math.max(1, Math.round((this.wick.z - h) * 16));
      }
    } else {
      this.wick.z += (h - this.wick.z) * 0.35;
      if (Math.abs(this.wick.z - h) < 0.05) this.wick.z = h;
      this.wick.vz = 0;
      this.wick.air = 0;
      this.wick.gliding = false;
    }
    // Zone tracking: log each band the first time you drop into it.
    const zone = altZone(h);
    if (!this.visitedZones.has(zone)) {
      this.visitedZones.add(zone);
      this.events.push("zone");
      const label = zone === "ALPINE" ? "DOWN INTO THE ALPINE." : zone === "FOREST" ? "DOWN INTO THE FOREST." : "DOWN TO THE SHORE. THE SEA SMELLS CLOSE.";
      this.log(label);
      if (zone === "SHORE") this.addScore(50);
    }
    if (h < this.deepest) this.deepest = h;
    if (this.t % 15 === 0) {
      for (const id of Object.keys(LEAD_DEFS) as LeadId[]) {
        const d = LEAD_DEFS[id];
        if (!this.known.has(id) && Math.hypot(this.wick.x - d.x, this.wick.y - d.y) < SIGHT_RANGE) this.learn(id);
      }
    }
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.bob += 0.08;
      if (p.taken) continue;
      if (p.kind === "glass") {
        if (Math.hypot(this.wick.x - p.x, this.wick.y - p.y) <= 13 && this.wick.z >= heightAt(p.x, p.y) - 0.1) {
          p.taken = true;
          const tierBefore = Math.floor(this.glass / GLASS_PER_TIER);
          this.glass++;
          this.addScore(30);
          this.events.push("glass");
          this.rings.push({ x: p.x, y: p.y, r: 4, color: "#8ff0ff", life: 24 });
          if (Math.floor(this.glass / GLASS_PER_TIER) > tierBefore) {
            this.wick.glide = this.glideMax;
            this.banner(`SEA GLASS ${this.glass}/${GLASS_COUNT} - THE OILSKIN GLIDES LONGER`, "#8ff0ff");
            this.log(`${this.glass} PIECES OF SEA GLASS. THE OILSKIN CATCHES MORE AIR.`);
          } else {
            this.pop(`SEA GLASS ${this.glass}/${GLASS_COUNT}`, "#8ff0ff", p.x, p.y - 10);
          }
        }
        continue;
      }
      if (p.kind !== "shard") continue;
      if (!(this.phase === "ebb" && this.causewayOpen)) continue;
      if (Math.hypot(this.wick.x - p.x, this.wick.y - p.y) <= 16) {
        p.taken = true;
        if (p.kind === "shard") {
          this.shards++;
          this.addScore(100);
          this.events.push("shard");
          this.pop("+ TIDE SHARD", "#a8f4e8", p.x, p.y - 10);
          this.log("POCKETED A TIDE SHARD.");
        }
      }
    }
  }

  private stepNpcs(): void {
    const f = Math.min(this.cycleTick / CYCLE_FRAMES, 1);
    for (let i = 0; i < this.npcs.length; i++) {
      const n = this.npcs[i];
      if (n.sayTimer > 0) n.sayTimer--;
      let tx = n.homeX, ty = n.homeY;
      if (n.id === "mira") {
        // Harbourmaster: the mill until the lock, the dock afterwards.
        if (this.lockedFired && !this.jammed) {
          tx = DOCK_POS.x - 20;
          ty = DOCK_POS.y - 6;
        } else {
          tx = MILL_POS.x + 14;
          ty = MILL_POS.y + 18;
        }
      } else if (n.id === "ios") {
        // The keeper waits at the summit until the argument is heard.
        if (!this.argueFired) {
          tx = LIGHTHOUSE_POS.x - 24;
          ty = LIGHTHOUSE_POS.y + 30;
        } else {
          tx = LIGHTHOUSE_POS.x + 18;
          ty = LIGHTHOUSE_POS.y + 22;
        }
      } else if (n.id === "june") {
        // The operator minds the summit relay until the argument, then her mast.
        if (!this.argueFired) {
          tx = 610;
          ty = 210;
        } else {
          tx = RADIO_POS.x - 18;
          ty = RADIO_POS.y + 12;
        }
      } else {
        // Piotr: at the dock until the ferry sails, then gone (or waiting if missed).
        if (this.ferryGone && !this.intercepted) {
          tx = WORLD_W + 40;
          ty = DOCK_POS.y;
        } else if (f >= MOVE_F - 0.03 && f <= MOVE_F + 0.03 && this.npcs[this.culprit].id === "piotr") {
          tx = DOCK_POS.x + 6;
          ty = DOCK_POS.y - 14;
        } else {
          tx = DOCK_POS.x - 16;
          ty = DOCK_POS.y + 6;
        }
      }
      // Whoever the culprit is visits the dock around the move beat (covers the early, dock-triggered move too).
      const driftWindow = (f >= MOVE_F - 0.03 && f <= MOVE_F + 0.03) ||
        (this.moveAt > 0 && !this.moveFired && this.cycleTick >= this.moveAt - 600);
      if (n.id === this.npcs[this.culprit].id && driftWindow) {
        tx = DOCK_POS.x - 6;
        ty = DOCK_POS.y - 10;
      }
      // Walk the trail: recompute the route when the stop changes or the
      // old route runs out, then follow it waypoint by waypoint.
      if (--n.repath <= 0 || Math.hypot(tx - n.gx, ty - n.gy) > 30) {
        n.path = this.findPath(n.x, n.y, tx, ty, true);
        n.repath = 120;
        n.gx = tx;
        n.gy = ty;
      }
      const wp = n.path[0];
      if (wp) {
        const vx = wp.x - n.x, vy = wp.y - n.y, d = Math.hypot(vx, vy);
        if (d < 3) n.path.shift();
        else {
          n.x += (vx / d) * 1.0;
          n.y += (vy / d) * 1.0;
          n.a = Math.atan2(vy, vx) + Math.PI / 2;
        }
      }
      void i;
    }
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
    if (this.bannerTimer > 0) this.bannerTimer--;
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.y -= 0.18;
      if (--p.life <= 0) this.pops.splice(i, 1);
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.r += 1.6;
      if (--r.life <= 0) this.rings.splice(i, 1);
    }
    if (this.state === "title") {
      this.stepNpcs();
      this.centerCamera();
      return;
    }
    if (!this.showLog) {
      this.advanceClock(1);
      this.stepWarden();
      this.stepNpcs();
    }
    this.nearby = this.findNearby();
    this.centerCamera();
  }
}
