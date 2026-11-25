/**
 * Basecamp simulation — keep the light. Pure TypeScript.
 *
 * Your workspace is a camp in a forest valley: each project a lodge with a
 * settler, each open task a bramble. By day you clear brambles for timber,
 * build up lodges and feed the hearth. By night the Twilight creeps out of
 * the forest as wisps that dim lodges, regrow brambles and drain the hearth.
 * Lit watchfires burn them, upgraded lodges keep a settler on watch, and the
 * Warden can swat them with an ember. If the hearth goes out the camp is
 * lost; every night is harder. The valley's old secrets (sluice, bell,
 * cairn) are side paths that pay in sparks.
 */

import { DEMO_DATA, type ArcadeProject } from "../pixel/arcade-data";
import { hudFrame, NO_HUD, type InputMode, type PixelHud } from "../pixel/hud";
import { clamp } from "../pixel/kinds";
import { hash2, mulberry32 } from "../pixel/terrain";

export const WORLD_W = 420;
export const WORLD_H = 420;
export const HEARTH_POS = { x: 210, y: 224 };
export const CAIRN_POS = { x: 210, y: 82 };
export const SLUICE_POS = { x: 96, y: 118 };
export const BELL_POS = { x: 338, y: 178 };
export const RADIO_POS = { x: 92, y: 326 };
export const POND_POS = { x: 326, y: 318 };
export const CHEST_POS = { x: 336, y: 332 };

export const CYCLE_FRAMES = 7200; // two minutes at 60 Hz; night is the last 35%
export const UPGRADE_TIMBER = 2;

/** The hearth: fuel 0…100, what a log adds, and how fast it burns by day and by night. */
export const HEARTH_MAX = 100;
export const HEARTH_START = 70;
export const FEED_FUEL = 25;
export const BURN_DAY = 0.008;
export const BURN_NIGHT = 0.014;
/** How far light reaches against wisps: a lit watchfire, a settler on watch, the Warden's ember. */
export const BRAZIER_REACH = 54;
export const WATCH_REACH = 34;
export const EMBER_REACH = 13;
/** Nights to see through for the camp to endure (play carries on after). */
export const ENDURE_NIGHTS = 5;

export type BasecampState = "title" | "play" | "over";
export type ClockPhase = "dawn" | "noon" | "dusk" | "night";
export type SecretId = "watchfires" | "causeway" | "dusk-bell" | "workshops" | "cairn";
export type BasecampEvent =
  | "start"
  | "step"
  | "chop"
  | "spark"
  | "ember"
  | "bell"
  | "sluice"
  | "build"
  | "secret"
  | "log"
  | "phase"
  | "feed"
  | "dispel"
  | "dim"
  | "endure"
  | "over";

/** A piece of the Twilight drifting toward the camp. */
export interface BasecampWisp {
  id: number;
  x: number;
  y: number;
  /** Burns down in the light; gone at 0. */
  hp: number;
  speed: number;
  wob: number;
}

export interface BasecampLodge {
  id: string;
  project: ArcadeProject;
  x: number;
  y: number;
  level: 1 | 2;
  notesCount: number;
}

export interface BasecampSettler {
  lodgeId: string;
  name: string;
  accent: string;
  x: number;
  y: number;
  a: number;
  homeX: number;
  homeY: number;
  say: string;
  sayTimer: number;
}

export interface BasecampBramble {
  id: string;
  title: string;
  x: number;
  y: number;
  cleared: boolean;
  overdue: boolean;
}

export interface BasecampBrazier {
  id: string;
  label: string;
  x: number;
  y: number;
  lit: boolean;
}

export interface BasecampPickup {
  id: number;
  kind: "timber" | "spark";
  x: number;
  y: number;
  bob: number;
}

export interface BasecampPop {
  text: string;
  color: string;
  x: number;
  y: number;
  life: number;
}

export interface BasecampParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  life: number;
  maxLife: number;
}

export interface SoundRing {
  x: number;
  y: number;
  r: number;
  color: string;
  life: number;
}

export interface InteractTarget {
  kind: "brazier" | "sluice" | "bell" | "radio" | "chest" | "lodge" | "bramble" | "cairn" | "settler" | "hearth";
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
  { id: "watchfires", title: "WATCHFIRES LIT", clue: "CARRY HEARTH EMBER TO ALL 3 BRAZIERS BEFORE DAWN" },
  { id: "causeway", title: "SUNKEN CAUSEWAY", clue: "OPEN MILL SLUICE, THEN CROSS THE POND AT NIGHT" },
  { id: "dusk-bell", title: "DUSK BROADCAST", clue: "RING EAST BELL AT DUSK, THEN TUNE SOUTH TOWER" },
  { id: "workshops", title: "CAMP THRIVING", clue: "CHOP BRAMBLES & UPGRADE PROJECT LODGES (LVL 2)" },
  { id: "cairn", title: "THE FIFTH CAIRN", clue: "BRING 3 SPARKS + 2 SECRETS TO THE NORTH CAIRN" },
];

export interface BasecampSpec {
  width: number;
  height: number;
  hud?: PixelHud;
  inputMode?: InputMode;
  best?: number;
  projects?: ArcadeProject[];
}

export const NIGHT_F = 0.65;

export function phaseAt(cycleTick: number): ClockPhase {
  const f = (cycleTick % CYCLE_FRAMES) / CYCLE_FRAMES;
  if (f < 0.15) return "dawn";
  if (f < 0.45) return "noon";
  if (f < NIGHT_F) return "dusk";
  return "night";
}

export class BasecampSim {
  W: number;
  H: number;
  hud: PixelHud;
  readonly inputMode: InputMode;
  private readonly projects: ArcadeProject[];
  private rand = mulberry32(4179);
  private nextPickupId = 1;

  state: BasecampState = "title";
  calm = false;
  t = 0;
  day = 1;
  cycleTick = 420; // start gently into Dawn morning light
  phase: ClockPhase = "dawn";
  score = 0;
  best: number;
  events: BasecampEvent[] = [];

  warden = {
    x: HEARTH_POS.x,
    y: HEARTH_POS.y + 34,
    vx: 0,
    vy: 0,
    a: 0,
    walkPhase: 0,
    hasEmber: false,
    emberTimer: 0,
  };

  camX = 0;
  camY = 0;
  timber = 0;
  sparks = 0;
  /** Hearth fuel; at 0 the camp is lost. */
  fuel = HEARTH_START;
  wisps: BasecampWisp[] = [];
  nightsSurvived = 0;
  dispelled = 0;
  shake = 0;
  overT = 0;
  private nextWispId = 1;
  private wispTimer = 0;

  lodges: BasecampLodge[] = [];
  settlers: BasecampSettler[] = [];
  brambles: BasecampBramble[] = [];
  braziers: BasecampBrazier[] = [];
  pickups: BasecampPickup[] = [];
  trees: { x: number; y: number }[] = [];
  pops: BasecampPop[] = [];
  particles: BasecampParticle[] = [];
  rings: SoundRing[] = [];

  // Clockwork mysteries & loop flags
  sluiceOpen = false;
  duskBellRung = false;
  bellCooldown = 0;
  radioTuned = false;
  chestOpened = false;
  cairnAwakened = false;
  auroraTimer = 0;
  secrets = new Set<SecretId>();

  showLog = false;
  bannerText = "";
  bannerColor = "#fff2a0";
  bannerTimer = 0;

  // Input state
  private keys = new Set<string>();
  dragOrigin: { x: number; y: number } | null = null;
  dragCurrent: { x: number; y: number } | null = null;
  private dragMoved = false;
  walkTarget: { x: number; y: number } | null = null;
  nearby: InteractTarget | null = null;

  constructor(spec: BasecampSpec) {
    this.W = spec.width;
    this.H = spec.height;
    this.hud = spec.hud ?? NO_HUD;
    this.inputMode = spec.inputMode ?? "touch";
    this.best = spec.best ?? 0;
    this.projects = spec.projects?.length ? spec.projects.slice(0, 5) : DEMO_DATA.projects.slice(0, 5);
    this.buildWorld();
    this.centerCamera();
  }

  private buildWorld(): void {
    const lodgeCoords: [number, number][] = [
      [134, 156],
      [286, 156],
      [112, 238],
      [304, 240],
      [210, 326],
    ];
    this.lodges = this.projects.map((p, i) => {
      const [x, y] = lodgeCoords[i % lodgeCoords.length];
      return {
        id: p.id,
        project: p,
        x,
        y,
        level: 1,
        notesCount: p.notes.length,
      };
    });

    this.settlers = this.lodges.map((l, i) => ({
      lodgeId: l.id,
      name: l.project.name.slice(0, 12),
      accent: l.project.accent,
      x: l.x + (i % 2 === 0 ? 16 : -16),
      y: l.y + 14,
      a: 0,
      homeX: l.x + (i % 2 === 0 ? 16 : -16),
      homeY: l.y + 14,
      say: "",
      sayTimer: 0,
    }));

    // West and east watchfires stand between two lodges each; the south one guards the southern lodge.
    this.braziers = [
      { id: "b-west", label: "WEST WATCHFIRE", x: 124, y: 198, lit: false },
      { id: "b-south", label: "SOUTH WATCHFIRE", x: 210, y: 292, lit: false },
      { id: "b-east", label: "EAST WATCHFIRE", x: 296, y: 198, lit: false },
    ];

    // Seed Twilight Brambles from real open/overdue tasks around perimeter paths
    const tasks = this.projects.flatMap((p) =>
      p.tasks.map((t) => ({ title: t.title, overdue: t.overdue, priority: t.priority })),
    );
    tasks.sort((a, b) => Number(b.overdue) - Number(a.overdue));
    const brambleSlots: [number, number][] = [
      [74, 174],
      [154, 102],
      [268, 104],
      [350, 134],
      [356, 232],
      [268, 344],
      [154, 346],
      [68, 272],
    ];
    this.brambles = brambleSlots.map(([x, y], i) => {
      const task = tasks[i];
      return {
        id: `br-${i}`,
        title: task ? task.title : `TANGLE ${i + 1}`,
        x,
        y,
        cleared: false,
        overdue: Boolean(task?.overdue),
      };
    });

    // Drop starter timber bundles near camp so early exploration immediately rewards
    this.spawnPickup("timber", 162, 242);
    this.spawnPickup("timber", 254, 214);
    this.spawnPickup("spark", 210, 168);

    // Forest perimeter pines (avoid blocking landmarks, pond, cairn, or lodges)
    this.trees = [];
    for (let gy = 26; gy <= WORLD_H - 24; gy += 30) {
      for (let gx = 24; gx <= WORLD_W - 24; gx += 30) {
        const edge = gx < 56 || gx > WORLD_W - 56 || gy < 54 || gy > WORLD_H - 52;
        if (!edge) continue;
        const px = gx + Math.round((hash2(gx, gy, 7) - 0.5) * 14);
        const py = gy + Math.round((hash2(gx, gy, 13) - 0.5) * 14);
        if (Math.hypot(px - CAIRN_POS.x, py - CAIRN_POS.y) < 42) continue;
        if (Math.hypot(px - SLUICE_POS.x, py - SLUICE_POS.y) < 42) continue;
        if (Math.hypot(px - RADIO_POS.x, py - RADIO_POS.y) < 44) continue;
        if (Math.hypot(px - BELL_POS.x, py - BELL_POS.y) < 44) continue;
        if (Math.hypot(px - POND_POS.x, py - POND_POS.y) < 58) continue;
        this.trees.push({ x: px, y: py });
      }
    }

    this.nearby = this.findNearbyTarget();
  }

  /** Start over after the hearth goes out: same valley, fresh camp. */
  private restart(): void {
    this.day = 1;
    this.cycleTick = 420;
    this.phase = phaseAt(this.cycleTick);
    this.score = 0;
    this.timber = 0;
    this.sparks = 0;
    this.fuel = HEARTH_START;
    this.wisps = [];
    this.nightsSurvived = 0;
    this.dispelled = 0;
    this.pickups = [];
    this.secrets.clear();
    this.sluiceOpen = false;
    this.duskBellRung = false;
    this.radioTuned = false;
    this.chestOpened = false;
    this.cairnAwakened = false;
    Object.assign(this.warden, { x: HEARTH_POS.x, y: HEARTH_POS.y + 34, hasEmber: false, emberTimer: 0 });
    // The last camp's tap waypoint and drag don't carry over.
    this.walkTarget = null;
    this.dragOrigin = null;
    this.dragCurrent = null;
    this.dragMoved = false;
    this.buildWorld();
    this.state = "play";
    this.events.push("start");
    this.banner("A NEW FIRE · KEEP IT BURNING", "#a8f4e8");
  }

  /** Overdue tasks in the workspace: they feed the dark. */
  private get overdueCount(): number {
    return this.projects.reduce((n, p) => n + p.tasks.filter((t) => t.overdue).length, 0);
  }

  private spawnPickup(kind: "timber" | "spark", x: number, y: number): void {
    this.pickups.push({ id: this.nextPickupId++, kind, x, y, bob: this.rand() * Math.PI * 2 });
  }

  private addScore(pts: number): void {
    this.score += pts;
    if (this.score > this.best) this.best = this.score;
  }

  private pop(text: string, color: string, x: number, y: number): void {
    this.pops.push({ text, color, x, y, life: 68 });
  }

  private banner(text: string, color = "#fff2a0"): void {
    this.bannerText = text;
    this.bannerColor = color;
    this.bannerTimer = 170;
  }

  private burst(x: number, y: number, color: string, count = 10): void {
    for (let i = 0; i < count; i++) {
      const ang = (Math.PI * 2 * i) / count + this.rand() * 0.4;
      const spd = 0.5 + this.rand() * 1.4;
      this.particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 0.5,
        color,
        life: 26 + Math.floor(this.rand() * 16),
        maxLife: 42,
      });
    }
  }

  private unlockSecret(id: SecretId, pts: number, label: string, x: number, y: number): void {
    if (this.secrets.has(id)) return;
    this.secrets.add(id);
    this.addScore(pts);
    this.events.push("secret");
    this.banner(`SECRET: ${label} +${pts}`, "#fff2a0");
    this.pop(`SECRET +${pts}`, "#fff2a0", x, y - 16);
    this.burst(x, y, "#fff2a0", 16);
  }

  get causewayOpen(): boolean {
    return (this.phase === "night" && this.sluiceOpen) || this.secrets.has("causeway");
  }

  get upgradedLodgesCount(): number {
    return this.lodges.filter((l) => l.level === 2).length;
  }

  get litBraziersCount(): number {
    return this.braziers.filter((b) => b.lit).length;
  }

  getSecretList(): SecretInfo[] {
    return SECRET_DEFS.map((d) => ({ ...d, unlocked: this.secrets.has(d.id) }));
  }

  /** Button rect for top-right Field Log pill in screen pixels. */
  logButtonRect(): { x: number; y: number; w: number; h: number } {
    const f = hudFrame(this.hud, this.W, this.H);
    return { x: f.top.rx - 44, y: f.top.y - 1, w: 44, h: 11 };
  }

  /** Button rect for bottom centered contextual ACT pill in screen pixels. */
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
    // A drag in progress was measured in the old screen: drop it (not a tap), and the next touch starts fresh.
    this.dragOrigin = null;
    this.dragCurrent = null;
    this.dragMoved = false;
  }

  private centerCamera(): void {
    const f = hudFrame(this.hud, this.W, this.H);
    const cx = (f.content.lx + f.content.rx) / 2;
    const cy = this.H / 2;
    this.camX = clamp(this.warden.x - cx, 0, Math.max(0, WORLD_W - this.W));
    this.camY = clamp(this.warden.y - cy, 0, Math.max(0, WORLD_H - this.H));
  }

  down(x: number, y: number): void {
    if (this.state === "over") {
      if (this.overT <= 0) this.restart();
      return;
    }
    if (this.state === "title") {
      this.state = "play";
      this.events.push("start");
      this.banner("DAWN BREAKS OVER BASECAMP", "#a8f4e8");
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

    const ab = this.actButtonRect();
    if (this.nearby && x >= ab.x - 6 && x <= ab.x + ab.w + 6 && y >= ab.y - 6 && y <= ab.y + ab.h + 6) {
      this.interact();
      return;
    }

    // Direct tap on the nearby highlighted object in world space
    const wx = x + this.camX;
    const wy = y + this.camY;
    if (this.nearby && Math.hypot(wx - this.nearby.x, wy - this.nearby.y) <= 22) {
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
      this.walkTarget = null;
    }
  }

  up(): void {
    if (this.state === "play" && !this.showLog && this.dragOrigin && !this.dragMoved) {
      // Quick tap -> walk directly to tapped world coordinate
      this.walkTarget = {
        x: clamp(this.dragOrigin.x + this.camX, 24, WORLD_W - 24),
        y: clamp(this.dragOrigin.y + this.camY, 30, WORLD_H - 24),
      };
    }
    this.dragOrigin = null;
    this.dragCurrent = null;
    this.dragMoved = false;
  }

  setKey(code: string, isDown: boolean): boolean {
    if (isDown && this.state === "over") {
      if ((code === "Space" || code === "Enter") && this.overT <= 0) {
        this.restart();
        return true;
      }
      return false;
    }
    if (isDown && this.state === "title") {
      if (code === "Space" || code === "Enter") {
        this.state = "play";
        this.events.push("start");
        this.banner("DAWN BREAKS OVER BASECAMP", "#a8f4e8");
        return true;
      }
      return false;
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
        this.events.push("log");
        return true;
      }
      return this.interact();
    }

    if (
      code === "ArrowUp" ||
      code === "ArrowDown" ||
      code === "ArrowLeft" ||
      code === "ArrowRight" ||
      code === "KeyW" ||
      code === "KeyA" ||
      code === "KeyS" ||
      code === "KeyD"
    ) {
      if (isDown) {
        this.keys.add(code);
        this.walkTarget = null;
      } else {
        this.keys.delete(code);
      }
      return true;
    }

    return false;
  }

  /** Advance clockwork time directly (also useful for deterministic testing). */
  advanceClock(frames: number): void {
    const prevPhase = this.phase;
    const prevCycle = Math.floor(this.cycleTick / CYCLE_FRAMES);
    this.cycleTick += frames;
    const nextCycle = Math.floor(this.cycleTick / CYCLE_FRAMES);
    if (nextCycle > prevCycle) {
      for (let c = prevCycle; c < nextCycle; c++) {
        this.onDawnReset();
      }
    }
    const nextPhase = phaseAt(this.cycleTick);
    if (nextPhase !== prevPhase) {
      this.phase = nextPhase;
      this.onPhaseEnter(nextPhase);
    }
  }

  private onPhaseEnter(p: ClockPhase): void {
    this.events.push("phase");
    if (p === "noon") this.banner("HIGH NOON · CLEAR, BUILD, FEED THE FIRE", "#fff2a0");
    if (p === "dusk") this.banner("DUSK · CARRY EMBER TO THE WATCHFIRES", "#ff9e44");
    if (p === "night") {
      this.wispTimer = 30;
      // Brambles left standing feed the dark: every second one sends a wisp now.
      this.brambles.filter((b) => !b.cleared).forEach((b, i) => { if (i % 2 === 0) this.spawnWisp(b.x, b.y); });
      this.banner(this.sluiceOpen ? "NIGHT · THE TWILIGHT COMES · POND STONES BARE" : "NIGHT · THE TWILIGHT COMES", "#c45aa8");
    }
  }

  private onDawnReset(): void {
    this.day++;
    this.duskBellRung = false;
    this.radioTuned = false;

    // The night is over: what's left of the Twilight fades.
    this.wisps = [];
    if (this.state === "play") {
      this.nightsSurvived++;
      const intact = this.upgradedLodgesCount;
      const bonus = 100 * this.nightsSurvived + 50 * intact;
      this.addScore(bonus);
      this.pop(`NIGHT ${this.nightsSurvived} SURVIVED +${bonus}`, "#fff2a0", HEARTH_POS.x, HEARTH_POS.y - 16);
      if (this.nightsSurvived === ENDURE_NIGHTS) {
        this.addScore(1000);
        this.events.push("endure");
        this.banner(`${ENDURE_NIGHTS} NIGHTS · THE CAMP ENDURES +1000`, "#fff2a0");
      }
    }
    // Watchfires burn out by morning; relight them each dusk.
    for (const b of this.braziers) b.lit = false;

    // Workshops turn out timber and a spark; deadfall drops at the forest edge.
    for (const l of this.lodges) {
      if (l.level === 2 && this.pickups.length < 18) {
        this.spawnPickup("spark", l.x + (this.rand() - 0.5) * 18, l.y + 18);
        this.spawnPickup("timber", l.x + (this.rand() - 0.5) * 18, l.y + 22);
      }
    }
    for (let i = 0; i < 2 && this.pickups.length < 20; i++) {
      const a = this.rand() * Math.PI * 2;
      this.spawnPickup("timber", clamp(HEARTH_POS.x + Math.cos(a) * 150, 40, WORLD_W - 40), clamp(HEARTH_POS.y + Math.sin(a) * 140, 50, WORLD_H - 40));
    }
    // Tasks left undone grow back: one bramble, plus one per overdue task (up to 3).
    const regrow = 1 + Math.min(3, this.overdueCount);
    const cleared = this.brambles.filter((b) => b.cleared);
    for (let i = 0; i < regrow && cleared.length; i++) {
      cleared.splice(Math.floor(this.rand() * cleared.length), 1)[0].cleared = false;
    }
    if (!this.secrets.has("causeway")) {
      this.sluiceOpen = false;
    }
    if (this.nightsSurvived !== ENDURE_NIGHTS) this.banner(`DAY ${this.day} · DAWN · THE FIRE NEEDS WOOD`, "#a8f4e8");
  }

  // ── The Twilight ────────────────────────────────────────────────────

  /** A wisp out of the forest: from `x,y` if given, else a random point on the treeline. */
  private spawnWisp(x?: number, y?: number): void {
    if (x === undefined || y === undefined) {
      const a = this.rand() * Math.PI * 2;
      x = clamp(HEARTH_POS.x + Math.cos(a) * 200, 14, WORLD_W - 14);
      y = clamp(HEARTH_POS.y + Math.sin(a) * 200, 18, WORLD_H - 14);
    }
    this.wisps.push({ id: this.nextWispId++, x, y, hp: 1, speed: 0.28 + this.day * 0.05 + this.rand() * 0.08, wob: this.rand() * 6 });
  }

  /** The wisp's mark: the nearest lodge, or the hearth when it is nearer. */
  private wispTarget(w: BasecampWisp): { x: number; y: number; lodge: BasecampLodge | null } {
    let best: BasecampLodge | null = null, bd = Math.hypot(w.x - HEARTH_POS.x, w.y - HEARTH_POS.y);
    for (const l of this.lodges) {
      const d = Math.hypot(w.x - l.x, w.y - l.y);
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    return best ? { x: best.x, y: best.y, lodge: best } : { x: HEARTH_POS.x, y: HEARTH_POS.y, lodge: null };
  }

  private stepTwilight(): void {
    if (this.phase === "night" && --this.wispTimer <= 0) {
      this.spawnWisp();
      this.wispTimer = Math.max(45, 240 - this.day * 30);
    }
    for (let i = this.wisps.length - 1; i >= 0; i--) {
      const w = this.wisps[i];
      w.wob += 0.08;
      const tg = this.wispTarget(w);
      const dx = tg.x - w.x, dy = tg.y - w.y, d = Math.hypot(dx, dy) || 1;
      w.x += (dx / d) * w.speed + Math.cos(w.wob) * 0.25;
      w.y += (dy / d) * w.speed + Math.sin(w.wob * 1.3) * 0.25;

      // Light burns it down.
      let burn = 0;
      for (const b of this.braziers) if (b.lit && Math.hypot(w.x - b.x, w.y - b.y) < BRAZIER_REACH) burn += 1 / 45;
      for (const l of this.lodges) if (l.level === 2 && Math.hypot(w.x - l.x, w.y - l.y) < WATCH_REACH) burn += 1 / 70;
      w.hp -= burn;
      if (this.warden.hasEmber && Math.hypot(w.x - this.warden.x, w.y - (this.warden.y - 4)) < EMBER_REACH) w.hp = 0;
      if (w.hp <= 0) {
        this.wisps.splice(i, 1);
        this.dispelled++;
        this.addScore(20);
        this.events.push("dispel");
        this.burst(w.x, w.y, "#c45aa8", 8);
        continue;
      }

      if (d < 10) {
        this.wisps.splice(i, 1);
        if (!this.calm) this.shake = Math.max(this.shake, 2.5);
        this.events.push("dim");
        if (tg.lodge) {
          const l = tg.lodge;
          if (l.level === 2) {
            l.level = 1;
            this.pop(`${l.project.name.slice(0, 10)} DIMMED`, "#c45aa8", l.x, l.y - 16);
          } else {
            // A lodge with no light left gets overgrown: a cleared bramble nearby grows back.
            const near = this.brambles.filter((b) => b.cleared).sort((a, b) => Math.hypot(a.x - l.x, a.y - l.y) - Math.hypot(b.x - l.x, b.y - l.y))[0];
            if (near) near.cleared = false;
            this.fuel -= 4;
            this.pop("OVERGROWN", "#c45aa8", l.x, l.y - 16);
          }
        } else {
          this.fuel -= 12;
          this.pop("THE FIRE GUTTERS", "#c45aa8", HEARTH_POS.x, HEARTH_POS.y - 16);
        }
        this.burst(w.x, w.y, "#3a1a52", 10);
      }
    }
  }

  private stepHearth(): void {
    this.fuel -= this.phase === "night" ? BURN_NIGHT : BURN_DAY;
    if (this.fuel <= 0 && this.state === "play") {
      this.fuel = 0;
      this.state = "over";
      this.overT = 90;
      this.showLog = false;
      this.events.push("over");
      this.banner("THE HEARTH WENT OUT", "#c45aa8");
    }
  }

  private findNearbyTarget(): InteractTarget | null {
    const wx = this.warden.x;
    const wy = this.warden.y;
    const candidates: { dist: number; t: InteractTarget }[] = [];
    const push = (dist: number, maxR: number, t: InteractTarget) => {
      if (dist <= maxR) candidates.push({ dist, t });
    };

    for (const b of this.brambles) {
      if (b.cleared) continue;
      push(Math.hypot(wx - b.x, wy - b.y), 26, {
        kind: "bramble",
        id: b.id,
        x: b.x,
        y: b.y,
        prompt: "CLEAR BRAMBLE",
        urgent: true,
      });
    }

    for (const br of this.braziers) {
      if (!br.lit && this.warden.hasEmber) {
        push(Math.hypot(wx - br.x, wy - br.y), 26, {
          kind: "brazier",
          id: br.id,
          x: br.x,
          y: br.y,
          prompt: "LIGHT WATCHFIRE",
          urgent: true,
        });
      }
    }

    for (const l of this.lodges) {
      if (l.level === 1 && this.timber >= UPGRADE_TIMBER) {
        push(Math.hypot(wx - l.x, wy - l.y), 30, {
          kind: "lodge",
          id: l.id,
          x: l.x,
          y: l.y,
          prompt: `BUILD WORKSHOP (${UPGRADE_TIMBER} WOOD)`,
          urgent: true,
        });
      }
    }

    if (this.causewayOpen && !this.chestOpened) {
      push(Math.hypot(wx - CHEST_POS.x, wy - CHEST_POS.y), 26, {
        kind: "chest",
        id: "chest",
        x: CHEST_POS.x,
        y: CHEST_POS.y,
        prompt: "OPEN SUNKEN CHEST",
        urgent: true,
      });
    }

    if (this.timber > 0 && this.fuel < HEARTH_MAX - 8) {
      push(Math.hypot(wx - HEARTH_POS.x, wy - HEARTH_POS.y), 30, {
        kind: "hearth",
        id: "hearth",
        x: HEARTH_POS.x,
        y: HEARTH_POS.y,
        prompt: "FEED THE HEARTH (1 WOOD)",
        urgent: this.fuel < 40,
      });
    }

    push(Math.hypot(wx - SLUICE_POS.x, wy - SLUICE_POS.y), 28, {
      kind: "sluice",
      id: "sluice",
      x: SLUICE_POS.x,
      y: SLUICE_POS.y,
      prompt: this.sluiceOpen ? "CLOSE SLUICE" : "OPEN MILL SLUICE",
    });

    push(Math.hypot(wx - BELL_POS.x, wy - BELL_POS.y), 28, {
      kind: "bell",
      id: "bell",
      x: BELL_POS.x,
      y: BELL_POS.y,
      prompt: this.phase === "dusk" ? "RING DUSK BELL" : "RING BRONZE BELL",
      urgent: this.phase === "dusk" && !this.duskBellRung,
    });

    push(Math.hypot(wx - RADIO_POS.x, wy - RADIO_POS.y), 28, {
      kind: "radio",
      id: "radio",
      x: RADIO_POS.x,
      y: RADIO_POS.y,
      prompt: this.duskBellRung && !this.radioTuned ? "TUNE DUSK SIGNAL" : "INSPECT TOWER",
      urgent: this.duskBellRung && !this.radioTuned,
    });

    push(Math.hypot(wx - CAIRN_POS.x, wy - CAIRN_POS.y), 28, {
      kind: "cairn",
      id: "cairn",
      x: CAIRN_POS.x,
      y: CAIRN_POS.y,
      prompt: this.cairnAwakened ? "VALLEY BEACON" : "AWAKEN CAIRN",
      urgent: !this.cairnAwakened && this.sparks >= 3 && this.secrets.size >= 2,
    });

    for (const s of this.settlers) {
      push(Math.hypot(wx - s.x, wy - s.y), 22, {
        kind: "settler",
        id: s.lodgeId,
        x: s.x,
        y: s.y,
        prompt: `TALK: ${s.name}`,
      });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => Number(Boolean(b.t.urgent)) - Number(Boolean(a.t.urgent)) || a.dist - b.dist);
    return candidates[0].t;
  }

  /** Perform the contextual action for `this.nearby`. Returns true if an action fired. */
  interact(): boolean {
    if (this.state !== "play") return false;
    const t = this.nearby ?? this.findNearbyTarget();
    if (!t) return false;

    switch (t.kind) {
      case "bramble": {
        const b = this.brambles.find((item) => item.id === t.id && !item.cleared);
        if (!b) return false;
        b.cleared = true;
        const pts = b.overdue ? 80 : 50;
        this.addScore(pts);
        this.events.push("chop");
        this.pop(`CLEARED +${pts}`, "#7cc46a", b.x, b.y - 10);
        this.burst(b.x, b.y, "#c45aa8", 10);
        this.spawnPickup("timber", b.x - 4, b.y + 4);
        if (b.overdue || this.rand() < 0.45) this.spawnPickup("spark", b.x + 6, b.y - 2);
        return true;
      }

      case "brazier": {
        const br = this.braziers.find((item) => item.id === t.id && !item.lit);
        if (!br || !this.warden.hasEmber) return false;
        br.lit = true;
        this.addScore(75);
        this.events.push("ember");
        this.pop("WATCHFIRE LIT +75", "#ffb347", br.x, br.y - 12);
        this.burst(br.x, br.y, "#ffb347", 12);
        if (this.braziers.every((item) => item.lit)) {
          this.unlockSecret("watchfires", 250, "WATCHFIRES LIT", br.x, br.y);
        }
        return true;
      }

      case "lodge": {
        const l = this.lodges.find((item) => item.id === t.id && item.level === 1);
        if (!l || this.timber < UPGRADE_TIMBER) return false;
        this.timber -= UPGRADE_TIMBER;
        l.level = 2;
        this.addScore(150);
        this.events.push("build");
        this.pop(`${l.project.name.slice(0, 10)} LVL 2!`, l.project.accent, l.x, l.y - 14);
        this.burst(l.x, l.y, l.project.accent, 14);
        this.spawnPickup("spark", l.x, l.y + 18);
        const goal = Math.min(this.lodges.length, 3);
        if (this.upgradedLodgesCount >= goal) {
          this.unlockSecret("workshops", 250, "CAMP THRIVING", l.x, l.y);
        }
        return true;
      }

      case "sluice": {
        this.sluiceOpen = !this.sluiceOpen;
        this.events.push("sluice");
        this.burst(SLUICE_POS.x, SLUICE_POS.y, "#47a3e6", 8);
        this.pop(this.sluiceOpen ? "CREEK DIVERTED" : "SLUICE CLOSED", "#47a3e6", SLUICE_POS.x, SLUICE_POS.y - 12);
        if (this.sluiceOpen) {
          this.banner("MILL SLUICE OPEN · WATCH SE POND AT NIGHT", "#47a3e6");
        }
        return true;
      }

      case "bell": {
        if (this.bellCooldown > 0) return false;
        this.bellCooldown = 40;
        this.events.push("bell");
        this.rings.push({ x: BELL_POS.x, y: BELL_POS.y, r: 6, color: "#fff2a0", life: 45 });
        if (this.phase === "dusk") {
          this.duskBellRung = true;
          this.addScore(80);
          this.pop("DUSK CHIME +80", "#fff2a0", BELL_POS.x, BELL_POS.y - 14);
          this.banner("BELL RESONATES TO SOUTH RADIO TOWER!", "#ff9e44");
        } else {
          this.pop("CLANG! TRY AT DUSK", "#e3a23b", BELL_POS.x, BELL_POS.y - 12);
        }
        return true;
      }

      case "radio": {
        if (this.duskBellRung && !this.radioTuned) {
          this.radioTuned = true;
          this.sparks += 2;
          this.events.push("spark");
          this.rings.push({ x: RADIO_POS.x, y: RADIO_POS.y, r: 5, color: "#2ec4b6", life: 45 });
          this.unlockSecret("dusk-bell", 350, "DUSK BROADCAST", RADIO_POS.x, RADIO_POS.y);
        } else if (this.secrets.has("dusk-bell")) {
          this.pop("SIGNAL LOCKED", "#2ec4b6", RADIO_POS.x, RADIO_POS.y - 12);
        } else {
          this.pop("NEEDS DUSK BELL ECHO", "#8fb8ff", RADIO_POS.x, RADIO_POS.y - 12);
        }
        return true;
      }

      case "chest": {
        if (!this.causewayOpen || this.chestOpened) return false;
        this.chestOpened = true;
        this.sparks += 2;
        this.timber += 1;
        this.unlockSecret("causeway", 300, "SUNKEN RELIC", CHEST_POS.x, CHEST_POS.y);
        return true;
      }

      case "cairn": {
        if (this.cairnAwakened) {
          this.pop("VALLEY BEACON SHINES", "#a8f4e8", CAIRN_POS.x, CAIRN_POS.y - 14);
          return true;
        }
        if (this.sparks >= 3 && this.secrets.size >= 2) {
          this.sparks -= 3;
          this.cairnAwakened = true;
          this.auroraTimer = 420;
          this.unlockSecret("cairn", 600, "THE FIFTH CAIRN!", CAIRN_POS.x, CAIRN_POS.y);
          this.banner("VALLEY AWAKENED! KEEP EXPLORING FOR HIGH SCORE", "#a8f4e8");
        } else {
          this.pop(`NEED 3 SPARKS (${this.sparks}/3) & 2 SECRETS`, "#c7e4ff", CAIRN_POS.x, CAIRN_POS.y - 14);
        }
        return true;
      }

      case "hearth": {
        if (this.timber <= 0 || this.fuel >= HEARTH_MAX - 8) return false;
        this.timber--;
        this.fuel = Math.min(HEARTH_MAX, this.fuel + FEED_FUEL);
        this.addScore(10);
        this.events.push("feed");
        this.pop(`FIRE ${Math.round(this.fuel)}`, "#ffb347", HEARTH_POS.x, HEARTH_POS.y - 14);
        this.burst(HEARTH_POS.x, HEARTH_POS.y - 4, "#ffb347", 12);
        return true;
      }

      case "settler": {
        const s = this.settlers.find((item) => item.lodgeId === t.id);
        if (!s) return false;
        s.say = this.settlerHint(s);
        s.sayTimer = 180;
        this.events.push("log");
        return true;
      }

      default:
        return false;
    }
  }

  private settlerHint(s: BasecampSettler): string {
    const lodge = this.lodges.find((l) => l.id === s.lodgeId);
    if (lodge && lodge.level === 1 && this.timber >= UPGRADE_TIMBER) {
      return `UPGRADE ${s.name} WITH WOOD!`;
    }
    if (this.fuel < 40) return "THE FIRE'S LOW. BRING WOOD!";
    switch (this.phase) {
      case "dawn":
        return this.day > 1 ? "THE BRAMBLES GREW BACK" : "OPEN THE SLUICE BEFORE NIGHT";
      case "noon":
        return lodge && lodge.level === 1 ? "A WORKSHOP KEEPS ONE ON WATCH" : "THE BELL SINGS AT DUSK";
      case "dusk":
        return "LIGHT THE WATCHFIRES. IT'S COMING.";
      case "night":
        return this.sluiceOpen ? "THE POND STONES ARE BARE" : "SWAT THEM WITH YOUR EMBER";
    }
  }

  private blockedAt(x: number, y: number): boolean {
    if (x < 18 || x > WORLD_W - 18 || y < 22 || y > WORLD_H - 18) return true;
    // South-east pond blocks walking unless causeway stepping stones are raised
    // (A Warden already inside when it closes may still wade toward shore.)
    if (!this.causewayOpen && Math.hypot(x - POND_POS.x, y - POND_POS.y) < 34) {
      const w = this.warden;
      if (Math.hypot(w.x - POND_POS.x, w.y - POND_POS.y) >= 34 || Math.hypot(x - POND_POS.x, y - POND_POS.y) < Math.hypot(w.x - POND_POS.x, w.y - POND_POS.y)) return true;
    }
    // Central Hearthfire pit solid core
    if (Math.hypot(x - HEARTH_POS.x, y - HEARTH_POS.y) < 12) return true;
    return false;
  }

  private stepWarden(): void {
    let dx = 0;
    let dy = 0;
    if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) dx -= 1;
    if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) dx += 1;
    if (this.keys.has("ArrowUp") || this.keys.has("KeyW")) dy -= 1;
    if (this.keys.has("ArrowDown") || this.keys.has("KeyS")) dy += 1;

    if (dx === 0 && dy === 0 && this.dragOrigin && this.dragCurrent && this.dragMoved) {
      const vx = this.dragCurrent.x - this.dragOrigin.x;
      const vy = this.dragCurrent.y - this.dragOrigin.y;
      const len = Math.hypot(vx, vy);
      if (len > 4) {
        dx = vx / len;
        dy = vy / len;
      }
    } else if (dx === 0 && dy === 0 && this.walkTarget) {
      const vx = this.walkTarget.x - this.warden.x;
      const vy = this.walkTarget.y - this.warden.y;
      const len = Math.hypot(vx, vy);
      if (len > 3) {
        dx = vx / len;
        dy = vy / len;
      } else {
        this.walkTarget = null;
      }
    }

    const len = Math.hypot(dx, dy);
    const spd = 1.65;
    if (len > 0.01) {
      const nx = (dx / len) * spd;
      const ny = (dy / len) * spd;
      const candX = this.warden.x + nx;
      const candY = this.warden.y + ny;
      if (!this.blockedAt(candX, this.warden.y)) this.warden.x = candX;
      if (!this.blockedAt(this.warden.x, candY)) this.warden.y = candY;
      this.warden.a = Math.atan2(ny, nx) + Math.PI / 2;
      this.warden.walkPhase += 0.22;
      if (this.t % 18 === 0) this.events.push("step");
    } else {
      this.warden.walkPhase *= 0.8;
    }

    // Refuel Ember near central Hearthfire
    if (Math.hypot(this.warden.x - HEARTH_POS.x, this.warden.y - HEARTH_POS.y) <= 26) {
      if (!this.warden.hasEmber) {
        this.warden.hasEmber = true;
        this.events.push("ember");
        this.pop("EMBER LIT", "#ffb347", this.warden.x, this.warden.y - 12);
      }
      this.warden.emberTimer = 720;
    } else if (this.warden.emberTimer > 0) {
      this.warden.emberTimer--;
      if (this.warden.emberTimer === 0) this.warden.hasEmber = false;
    }

    // Auto-collect timber & sparks
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.bob += 0.08;
      if (Math.hypot(this.warden.x - p.x, this.warden.y - p.y) <= 16) {
        this.pickups.splice(i, 1);
        if (p.kind === "timber") {
          this.timber++;
          this.addScore(25);
          this.events.push("chop");
          this.pop("+1 WOOD", "#d9b078", p.x, p.y - 10);
        } else {
          this.sparks++;
          this.addScore(40);
          this.events.push("spark");
          this.pop("+1 SPARK", "#fff2a0", p.x, p.y - 10);
        }
        this.burst(p.x, p.y, p.kind === "spark" ? "#fff2a0" : "#d9b078", 6);
      }
    }
  }

  private stepSettlers(): void {
    for (let i = 0; i < this.settlers.length; i++) {
      const s = this.settlers[i];
      if (s.sayTimer > 0) s.sayTimer--;
      // Clockwork waypoint schedule per phase
      let tx = s.homeX;
      let ty = s.homeY;
      if (this.phase === "dawn") {
        if (i === 0) {
          tx = SLUICE_POS.x + 14;
          ty = SLUICE_POS.y + 18;
        } else {
          tx = s.homeX + Math.sin(this.t * 0.015 + i) * 14;
          ty = s.homeY + 10;
        }
      } else if (this.phase === "noon") {
        const ang = (Math.PI * 2 * i) / Math.max(1, this.settlers.length) + this.t * 0.004;
        tx = HEARTH_POS.x + Math.cos(ang) * 30;
        ty = HEARTH_POS.y + Math.sin(ang) * 26;
      } else if (this.phase === "dusk") {
        if (i === 1 % this.settlers.length) {
          tx = BELL_POS.x - 16;
          ty = BELL_POS.y + 12;
        } else if (i === 2 % this.settlers.length) {
          tx = RADIO_POS.x + 18;
          ty = RADIO_POS.y - 8;
        }
      } else {
        // Night: workshop settlers keep watch at their lodge; the rest huddle by the hearth.
        const lodge = this.lodges.find((l) => l.id === s.lodgeId);
        const ang = (Math.PI * 2 * i) / Math.max(1, this.settlers.length);
        if (lodge && lodge.level === 2) {
          tx = lodge.x + Math.cos(this.t * 0.02 + i) * 14;
          ty = lodge.y + 12 + Math.sin(this.t * 0.02 + i) * 6;
        } else {
          tx = HEARTH_POS.x + Math.cos(ang) * 20;
          ty = HEARTH_POS.y + Math.sin(ang) * 18;
        }
      }

      const vx = tx - s.x;
      const vy = ty - s.y;
      const d = Math.hypot(vx, vy);
      if (d > 2) {
        const spd = 0.55;
        s.x += (vx / d) * spd;
        s.y += (vy / d) * spd;
        s.a = Math.atan2(vy, vx) + Math.PI / 2;
      }
    }
  }

  step(): void {
    this.t++;
    this.shake = this.calm ? 0 : Math.max(0, this.shake - 0.2);
    if (this.bellCooldown > 0) this.bellCooldown--;
    if (this.bannerTimer > 0) this.bannerTimer--;
    if (this.auroraTimer > 0) this.auroraTimer--;

    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.y -= 0.18;
      if (--p.life <= 0) this.pops.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.04;
      if (--p.life <= 0) this.particles.splice(i, 1);
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.r += 1.6;
      if (--r.life <= 0) this.rings.splice(i, 1);
    }

    if (this.state === "title") {
      // Cozy animated campfire scene behind the title overlay
      this.stepSettlers();
      this.centerCamera();
      return;
    }

    if (this.state === "over") {
      if (this.overT > 0) this.overT--;
      this.stepSettlers();
      this.centerCamera();
      return;
    }

    if (!this.showLog) {
      this.advanceClock(1);
      this.stepWarden();
      this.stepSettlers();
      this.stepTwilight();
      this.stepHearth();
    }
    this.nearby = this.findNearbyTarget();
    this.centerCamera();
  }
}
