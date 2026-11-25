/**
 * The Workspace: an idle pixel office that mirrors the open workspace. The
 * workspace is one room; each project is a desk whose paper pile grows with
 * its open tasks and whose book pile grows with its notes. The people cards
 * are assigned to sit at the desks they're busiest on and run small errands.
 * Clicking a desk opens that project from above: its board, or its notes.
 *
 * It never changes the workspace. A click on a card or note emits an `open`
 * event and the host shows the real thing. `setData` swaps in a fresh snapshot
 * whenever the workspace changes, keeping the workers where they are.
 */

import { clip, textWidth } from "../pixel/font";
import { hudFrame, NO_HUD, type InputMode, type PixelHud } from "../pixel/hud";
import { mulberry32 } from "../pixel/terrain";
import { CONTRACTOR, DEMO_OFFICE, type OfficeData, type OfficeProject } from "./data";
import { burstLabel, diffOffice, FLURRY, groupChanges, type Burst, type OfficeChange } from "./events";
import { inRect, layoutDesk, layoutFloor, layoutWeek, route, routeFree, type Desk, type DeskTab, type DeskView, type FloorLayout, type Pt, type Rect, type Ref, type Spot, type SpotKind, type WeekView } from "./layout";
import { bucketWeek, toDateKey, weekDates, withDemoDates, type WeekDay } from "./week";

export interface OfficeSpec {
  width: number;
  height: number;
  hud?: PixelHud;
  inputMode?: InputMode;
  office?: OfficeData;
  best?: number;
  seed?: number;
  /** Previously unlocked decor (host-persisted); new unlocks set decorDirty. */
  decor?: string[];
  /** Wall-clock source for the clock and daylight (tests pass a fixed one). */
  clock?: () => Date;
}

export type OfficeEvent = { k: "open"; ref: Ref } | { k: "openAgent" };

export interface Look {
  shirt: string;
  hair: string;
  skin: string;
}

export interface Worker {
  holder: string;
  look: Look;
  /** Desk index (into the office's projects) and where at it. */
  desk: number;
  spot: "seat" | "side";
  x: number;
  y: number;
  path: Pt[];
  mode: "sit" | "walk" | "stay";
  timer: number;
  /** Steps until this seated worker crumples another sheet (toss heartbeat). */
  tossIn: number;
  homeward: boolean;
  /** Last walking direction, for facing. */
  dx: number;
  dy: number;
  layoutKey: string;
  /** What the current walk is for: kept until they're back at their desk. */
  errand: Errand | null;
  /** The walkway at the errand's far end, for the walk back. */
  via: { aisleY: number; laneX: number } | null;
  /** A line they're saying, and the frame they started. */
  say: { text: string; t0: number } | null;
  /** Staying late after dark: their desk has overdue work. */
  late: boolean;
  /** Frame a celebration started (a few hops). */
  hop: number;
}

/** Why a worker left their desk. */
export type Errand =
  | { k: "coffee" }
  | { k: "chat"; text: string }
  | { k: "water"; plant: number }
  | { k: "print"; project: string }
  | { k: "deliver"; project: string }
  | { k: "visit" };

/** Anyone who walks the floor along a path. */
interface Walker {
  x: number;
  y: number;
  path: Pt[];
  dx: number;
  dy: number;
}

/** The night cleaner: comes in after dark, sweeps up missed paper, leaves at dawn. */
export interface Janitor extends Walker {
  mode: "walk" | "sweep" | "leave";
  timer: number;
  /** The floor paper it is walking to sweep up. */
  fetch: Paper | null;
  say: { text: string; t0: number } | null;
  layoutKey: string;
}

/** The office cat: wanders by day, curls up on a lit monitor at night. */
export interface Cat extends Walker {
  mode: "walk" | "sit" | "sleep";
  timer: number;
  /** The desk it sleeps on (index into the projects), or null on the floor. */
  perch: number | null;
  /** The desk it is walking to, to sleep on. */
  bed: number | null;
  /** Last petted (hearts). */
  petAt: number;
  layoutKey: string;
}

/** The done board's list: this week's done count per project. */
export interface BoardPanel {
  rect: Rect;
  title: string;
  rows: { index: number; name: string; n: number; accent: string; rect: Rect }[];
}

/** The agent's robot: docks by the cooler, walks to whatever its tool calls touch. */
export interface Robot {
  x: number;
  y: number;
  path: Pt[];
  /** Idle at the dock, walking, or working at a desk. */
  mode: "idle" | "walk" | "work";
  /** Desk index it is at (or heading to), null at the dock. */
  desk: number | null;
  /** Ref its current tool call touched, if any. */
  ref: Ref | null;
  timer: number;
  dx: number;
  dy: number;
  /** True while a tool call is in flight (glows). */
  active: boolean;
  /** The floor paper it is walking to pick up, if any. */
  fetch: Paper | null;
  /** Where it steps back to before shooting a fetched ball, if any. */
  windup: Pt | null;
  layoutKey: string;
}

/** A crumpled paper ball: arcs to the bin, or lands on the floor for the robot. */
export interface Paper {
  x: number;
  y: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  t: number;
  dur: number;
  /** Arc peak in pixels, from the throw distance. */
  arcH: number;
  state: "fly" | "floor";
  /** True when aimed at the bin (a swish removes it); a miss lands. */
  scores: boolean;
}

export type Hit =
  | { k: "desk"; desk: Desk }
  | { k: "worker"; worker: Worker }
  | { k: "robot" }
  | { k: "clock" }
  | { k: "clockMode" }
  | { k: "bin" }
  | { k: "coffee" }
  | { k: "cooler" }
  | { k: "printer" }
  | { k: "plant"; i: number }
  | { k: "board" }
  | { k: "boardRow"; index: number | null }
  | { k: "janitor" }
  | { k: "cat" }
  | { k: "lights" }
  | { k: "window"; i: number }
  | { k: "card"; ref: Ref; rect: Rect; text: string }
  | { k: "note"; ref: Ref; rect: Rect; text: string }
  | { k: "back" | "prev" | "next" | "notesPrev" | "notesNext" }
  | { k: "tab"; tab: DeskTab }
  | { k: "week" }
  | { k: "bubble"; ref: Ref | null };

export interface Bubble {
  worker: Worker;
  rect: Rect;
  lines: { ref: Ref; title: string; rect: Rect }[];
}

export interface Hover {
  text: string;
  /** Screen rect to outline, when the thing is clickable. */
  rect: Rect | null;
  /** The desk under the pointer, for its glow. */
  desk?: number;
}

/** A short-lived effect over the office, started by a change. */
export interface Fx {
  /** `label` floats text up from a desk; `paper` flies a sheet (down onto a pile, or off to the done board). */
  k: "label" | "paper";
  project: string;
  text: string;
  color: string;
  t0: number;
  life: number;
  /** Papers: which way it flies. */
  to?: "desk" | "board";
  /** Stagger, so several papers don't fly as one. */
  delay: number;
  /** True when the change followed an agent tool call for the same id (phase 3 attribution). */
  agent?: boolean;
}

/** A tool call started within this many frames of a change attributes it to the agent (~2 s). */
export const AGENT_WINDOW = 120;

const HEADER = 13;
const FX_CAP = 24;
const FRESH_FRAMES = 150;
/** Done cards that earn a project its plant (kept once unlocked). */
export const PLANT_MILESTONE = 10;
/** Extra plants on the floor, at most (two corners are always there). */
const MAX_EXTRA_PLANTS = 6;
const plantId = (projectId: string) => `plant:${projectId}`;

/** Flight time and arc height for a throw of `dist` pixels. */
const flightFor = (dist: number) => ({
  dur: Math.max(24, Math.min(60, Math.round(dist / 2.2))),
  arcH: Math.max(12, Math.min(34, dist * 0.18)),
});
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const KIND_COLOR: Record<OfficeChange["k"], string> = {
  "task.added": "#7cc46a",
  "task.moved": "#5b8dd6",
  "task.done": "#ffe066",
  "task.removed": "#d9483b",
  "task.updated": "#e3a23b",
  "note.added": "#7cc46a",
  "note.updated": "#e3a23b",
  "note.removed": "#d9483b",
};
const FOOTER = 12;
const WALK = 0.4;
/** How long a printout takes, a celebration lasts, and a spoken line shows. */
export const PRINT_FRAMES = 50;
export const PARTY_FRAMES = 90;
export const SAY_FRAMES = 160;
const REPLIES = ["NICE!", "NO WAY", "HA!", "SAME", "WOW", "TOLD YOU"];
const CLEANER_LINES = ["EVENING!", "MIND THE FLOOR", "ALL CLEAN", "LATE ONE?", "NIGHT NIGHT"];
const CLEANER: Look = { shirt: "#3b6e8f", hair: "#9aa3b8", skin: "#d9a57a" };
export const cleanerLook = (): Look => CLEANER;
export type Season = "snow" | "leaves" | null;
/** Snow from December to February, falling leaves from September to November. */
export const seasonAt = (d: Date): Season => {
  const m = d.getMonth();
  return m === 11 || m <= 1 ? "snow" : m >= 8 && m <= 10 ? "leaves" : null;
};
const SKINS = ["#f2c9a0", "#d9a57a", "#b97f56", "#8a5a3b", "#5e3d28"];
const HAIRS = ["#2b2118", "#5a3a22", "#a8743a", "#e0c070", "#c25a3a", "#7a7a86", "#1d2b4a"];
const SHIRTS = ["#d9483b", "#5b8dd6", "#7cc46a", "#e3a23b", "#c45aa8", "#2ec4b6", "#8f6ad6", "#e07a5f"];

function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A stable look per person. The contractor wears hi-vis. */
export function lookFor(holder: string): Look {
  const h = strHash(holder);
  if (holder === CONTRACTOR) return { shirt: "#f2d43a", hair: "#7a7a86", skin: SKINS[h % SKINS.length] };
  return { shirt: SHIRTS[h % SHIRTS.length], hair: HAIRS[(h >>> 4) % HAIRS.length], skin: SKINS[(h >>> 9) % SKINS.length] };
}

/** 0 at night, 1 in daylight, ramping at dawn (6–8) and dusk (17–20). */
export function daylightAt(d: Date): number {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 6 || h >= 20) return 0;
  if (h < 8) return (h - 6) / 2;
  if (h < 17) return 1;
  return 1 - (h - 17) / 3;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const ZERO: Rect = { x: 0, y: 0, w: 0, h: 0 };

export class OfficeSim {
  W: number;
  H: number;
  hud: PixelHud;
  readonly inputMode: InputMode;
  data: OfficeData;
  state: "floor" | "desk" = "floor";
  t = 0;
  best = 0;
  calm = false;
  page = 0;
  /** Index into `data.projects` of the open desk, or null on the floor. */
  focus: number | null = null;
  tab: DeskTab = "board";
  notesPage = 0;
  floor!: FloorLayout;
  view: DeskView | null = null;
  workers = new Map<string, Worker>();
  robot!: Robot;
  /** Calendar mode: the floor swaps for the week wall. */
  week = false;
  weekDays: WeekDay[] = [];
  weekView: WeekView | null = null;
  /** The week the wall shows; paging never moves today. */
  weekAnchor!: Date;
  /** Crumpled paper balls in flight or on the floor. */
  papers: Paper[] = [];
  /** Swish splashes where balls went in (ring + label, 40 frames). */
  pops: { x: number; y: number; t0: number }[] = [];
  /** Toss stats for tests and tuning: made, swished (thrown or robot-sunk). */
  tossMade = 0;
  tossScored = 0;
  /** Tool-call intents by id, with the frame they arrived (attribution window). */
  intents = new Map<string, number>();
  /** Unlocked decor ids (`plant:<projectId>`); the host persists these. */
  decor = new Set<string>();
  /** Set when a refresh unlocks new decor; the host saves `decor` and clears it. */
  decorDirty = false;
  /** The big pixel clock overlay (tap the wall clock). */
  clockOpen = false;
  /** The overlay shows the time digital instead of analogue. */
  clockDigital = false;
  private wasNight = false;
  hover: Hover | null = null;
  bubble: Bubble | null = null;
  events: OfficeEvent[] = [];
  /** The card or note just clicked, for a brief highlight. */
  opened: { ref: Ref; t: number } | null = null;
  clockText = "";
  daylight = 1;
  backBtn = ZERO;
  prevBtn = ZERO;
  nextBtn = ZERO;
  calBtn = ZERO;
  tabBtns: { tab: DeskTab; rect: Rect }[] = [];
  notesPrevBtn = ZERO;
  notesNextBtn = ZERO;
  /** Effects in flight, and what the last refresh changed (for tests and the host). */
  fx: Fx[] = [];
  lastChanges: OfficeChange[] = [];
  /** Ids of cards and notes that just arrived or changed, with the frame they did (a flash on an open desk). */
  fresh = new Map<string, number>();
  /** Notes the AI is writing right now, by id. */
  writing = new Set<string>();
  /** When the done board last counted up, for its pop. */
  boardPulse = -999;
  /** The night cleaner (after dark only) and the office cat. */
  janitor: Janitor | null = null;
  cat!: Cat;
  /** Papers the cleaner swept up (tests and tuning). */
  swept = 0;
  /** Cups of coffee made today; the counter resets with the date. */
  cups = 0;
  private cupsDay = "";
  /** When the coffee machine last brewed and the cooler last gurgled (steam, bubbles). */
  steamAt = -999;
  coolerAt = -999;
  /** Planters by floor index: when last touched (a sway) and watered (drops). */
  plantTouched = new Map<number, number>();
  plantWatered = new Map<number, number>();
  /** The printout in progress (a new note), and the ones waiting. */
  printing: { project: string; t0: number } | null = null;
  private printQueue: string[] = [];
  /** A celebration: a column emptied or a planter earned. */
  party: { project: string; t0: number } | null = null;
  /** Recent changes as lines of office gossip, newest last. */
  news: string[] = [];
  /**
   * The light switch: "auto" follows the daylight; tapping it switches the lights on or off
   * by hand, which holds until the next dusk or dawn.
   */
  lights: "auto" | "on" | "off" = "auto";
  /** Windows (by floor index) with the blinds down. */
  blinds = new Set<number>();
  /** What the windows show outside: snow, leaves or nothing. */
  season: Season = null;
  /** The done board's per-project list, while open. */
  boardPanel: BoardPanel | null = null;
  /** Decor the last layout unlocked (for the milestone celebration). */
  private unlocked: string[] = [];
  private lastFocus: number | null = null;
  private readonly rnd: () => number;
  private readonly clock: () => Date;
  private pointer: Pt | null = null;

  constructor(spec: OfficeSpec) {
    this.W = spec.width;
    this.H = spec.height;
    this.hud = spec.hud ?? NO_HUD;
    this.inputMode = spec.inputMode ?? "touch";
    this.data = spec.office && spec.office.projects.length ? spec.office : DEMO_OFFICE;
    this.rnd = mulberry32(spec.seed ?? 7);
    this.clock = spec.clock ?? (() => new Date());
    this.weekAnchor = this.clock();
    this.decor = new Set(spec.decor ?? []);
    this.tickClock();
    this.layout();
    this.wasNight = this.night;
  }

  /** After hours the office is empty: everyone went home (the robot keeps working). */
  get night(): boolean {
    return this.daylight <= 0;
  }

  /** How dark the room is: the dusk outside, mostly undone with the lights on, and dim by day with them off. */
  get gloom(): number {
    const dusk = 1 - this.daylight;
    if (this.lights === "on") return dusk * 0.2;
    if (this.lights === "off") return Math.max(dusk, 0.45);
    return dusk;
  }

  /** Whether the room reads as lit (the switch shows it). */
  get lightsOn(): boolean {
    return this.gloom < 0.4;
  }

  /** The done board: this week's done count and how many open cards are overdue. */
  get boardStats(): { done: number; overdue: number } {
    let overdue = 0;
    for (const p of this.projects) for (const c of p.cards) if (c.overdue) overdue++;
    return { done: this.projects.reduce((s, p) => s + p.doneThisWeek, 0), overdue };
  }

  /** The overlay panel, in screen coords (null when closed). Up to 300 px wide. */
  clockPanel(): { x: number; y: number; w: number; h: number } | null {
    if (!this.clockOpen) return null;
    const a = this.area;
    const w = Math.min(220, Math.max(120, a.w - 16));
    const h = Math.min(a.h - 24, Math.round(w * 0.85));
    return { x: Math.round(a.x + (a.w - w) / 2), y: Math.round(a.y + (a.h - h) / 2), w, h };
  }

  /** The overlay's analogue/digital toggle, in screen coords (null when closed). */
  clockToggleRect(): Rect | null {
    const p = this.clockPanel();
    if (!p) return null;
    const w = Math.min(120, p.w - 24), h = 12;
    return { x: Math.round(p.x + (p.w - w) / 2), y: p.y + p.h - h - 4, w, h };
  }

  /** "WED 25 NOV" for the big clock overlay. */
  get dateLine(): string {
    const d = this.clock();
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }

  /** Replace the unlocked decor (host load / workspace switch) and re-lay the floor. */
  setDecor(ids: string[]): void {
    this.decor = new Set(ids);
    this.decorDirty = false;
    this.layout();
  }

  get projects(): OfficeProject[] {
    return this.data.projects;
  }

  get frame() {
    return hudFrame(this.hud, this.W, this.H);
  }

  /** The room: everything between the header and the footer. */
  get area(): Rect {
    const f = this.frame;
    const top = f.top.y + HEADER;
    const bottom = f.bottom.y - FOOTER;
    return { x: f.content.lx, y: top, w: f.content.rx - f.content.lx, h: bottom - top };
  }

  /** The open project's board or notes area (inside the desk-top frame). */
  get deskArea(): Rect {
    const a = this.area;
    return { x: a.x + 8, y: a.y + 8, w: a.w - 16, h: a.h - 16 };
  }

  get focused(): OfficeProject | null {
    return this.focus === null ? null : (this.projects[this.focus] ?? null);
  }

  /** A fresh workspace snapshot: the layout follows, workers stay put where they still have a desk. */
  setData(d: OfficeData): void {
    const was = this.focused?.id;
    const prev = this.data;
    this.data = d.projects.length ? d : DEMO_OFFICE;
    this.lastChanges = diffOffice(prev, this.data);
    this.react(this.lastChanges);
    if (was) {
      const i = this.projects.findIndex((p) => p.id === was);
      this.focus = i >= 0 ? i : null;
      this.state = this.focus === null ? "floor" : "desk";
    }
    this.bubble = null;
    this.boardPanel = null;
    this.layout();
    // Something worth a high five: a column cleared, or a project earned its planter.
    if (this.lastChanges.length) {
      const earned = this.unlocked.map((id) => this.projects.find((p) => plantId(p.id) === id)).find((p) => p);
      const cleared = this.emptiedColumn(prev);
      if (earned) this.celebrate(earned.id, "MILESTONE!");
      else if (cleared) this.celebrate(cleared, "HIGH FIVE!");
    }
    if (this.pointer) this.move(this.pointer.x, this.pointer.y);
  }

  /** A project whose open column just emptied through work finished or moved on (not deletions). */
  private emptiedColumn(prev: OfficeData): string | null {
    const worked = new Set(this.lastChanges.filter((c) => c.k === "task.done" || c.k === "task.moved").map((c) => c.project));
    for (const p of this.projects) {
      if (!worked.has(p.id)) continue;
      const was = prev.projects.find((q) => q.id === p.id);
      if (!was) continue;
      for (const col of p.columns) {
        if (col.zone === "done") continue;
        const before = was.cards.filter((c) => c.columnId === col.id).length;
        if (before > 0 && !p.cards.some((c) => c.columnId === col.id)) return p.id;
      }
    }
    return null;
  }

  /** Everyone in the room hops, confetti falls over the desk, and a label rises. */
  private celebrate(project: string, text: string): void {
    this.party = { project, t0: this.t };
    for (const w of this.workers.values()) if (w.mode !== "walk") w.hop = this.t;
    if (this.fx.length < FX_CAP) this.fx.push({ k: "label", project, text, color: "#ffe066", t0: this.t, life: PARTY_FRAMES, delay: 0 });
  }

  /** Start the effects for a refresh's changes: a few per project and kind, and a sample of a flurry. */
  private react(changes: readonly OfficeChange[]): void {
    if (!changes.length) return;
    // Attribution: a change for an id the agent just touched is the agent's.
    // It is a timing guess, not an audit log (plan phase 3).
    const mine = new Set<string>();
    for (const c of changes) {
      const id = "id" in c ? (c as { id: string }).id : null;
      if (id && this.t - (this.intents.get(id) ?? -Infinity) <= AGENT_WINDOW) mine.add(id);
    }
    const bursts = groupChanges(changes.length > FLURRY ? changes.slice(0, FLURRY) : changes);
    for (const b of bursts) {
      for (const id of b.ids) if (b.kind !== "task.removed" && b.kind !== "note.removed" && b.kind !== "task.done") this.fresh.set(id, this.t);
      this.spawn(b, mine);
      // The office talks about it at the water cooler.
      const name = this.projects.find((p) => p.id === b.project)?.name;
      if (name) this.news.push(`${name}: ${burstLabel(b)}`);
      // A new note comes off the printer (a few at most).
      if (b.kind === "note.added" && this.printQueue.length < 3) this.printQueue.push(b.project);
    }
    if (this.news.length > 6) this.news.splice(0, this.news.length - 6);
    if (changes.some((c) => c.k === "task.done")) this.boardPulse = this.t + 60;
  }

  private spawn(b: Burst, mine: ReadonlySet<string>): void {
    const agent = b.ids.some((id) => mine.has(id));
    const color = agent ? "#8fe0ff" : KIND_COLOR[b.kind];
    const room = FX_CAP - this.fx.length;
    if (room <= 0) return;
    this.fx.push({ k: "label", project: b.project, text: burstLabel(b), color, t0: this.t, life: 90, delay: 0, agent });
    // A few sheets fly: down onto the pile for a new task, up to the done board for a finished one.
    const sheets = Math.min(3, b.ids.length, room - 1);
    if (b.kind === "task.added") for (let i = 0; i < sheets; i++) this.fx.push({ k: "paper", project: b.project, text: "", color, t0: this.t, life: 36, to: "desk", delay: i * 8, agent });
    if (b.kind === "task.done") for (let i = 0; i < sheets; i++) this.fx.push({ k: "paper", project: b.project, text: "", color, t0: this.t, life: 70, to: "board", delay: i * 10, agent });
  }

  /** The agent started a tool call touching a task or note: the robot walks to its desk. */
  agentIntent(ref: Ref): void {
    this.intents.set(ref.id, this.t);
    if (this.intents.size > 60) this.intents.delete(this.intents.keys().next().value!);
    const i = this.projects.findIndex((p) => p.cards.some((c) => c.id === ref.id) || p.notes.some((n) => n.id === ref.id));
    const desk = i >= 0 ? this.floor.desks.find((d) => d.index === i) : null;
    const r = this.robot;
    r.ref = ref;
    r.active = true;
    r.fetch = null;
    r.windup = null;
    if (!desk) {
      r.timer = 240;
      if (r.mode === "idle") r.mode = "work";
      return;
    }
    if (r.desk === desk.index && (r.mode === "work" || r.mode === "idle")) {
      r.mode = "work";
      r.timer = 300;
      return;
    }
    r.desk = desk.index;
    r.path = this.robotPath({ x: desk.side.x, y: desk.side.y });
    r.mode = "walk";
    r.timer = 300;
  }

  /** The agent's turn ended with no more tool calls in flight: the robot powers down. */
  agentIdle(): void {
    const r = this.robot;
    if (!r) return;
    r.active = false;
    r.ref = null;
    if (r.mode === "work") r.timer = Math.min(r.timer, 120);
  }

  /** The AI started (or finished) writing a note: its desk shows a writing bubble while it lasts. */
  setNoteWriting(noteId: string, on: boolean): void {
    if (on) this.writing.add(noteId);
    else this.writing.delete(noteId);
  }

  /** The desk (project id) a note sits at, if it's in this office. */
  projectOfNote(noteId: string): OfficeProject | undefined {
    return this.projects.find((p) => p.notes.some((n) => n.id === noteId));
  }

  /** True while an effect or flash is still playing, so a host can stop redrawing a still office. */
  get busy(): boolean {
    return this.fx.length > 0 || this.writing.size > 0 || this.fresh.size > 0 || (this.robot?.mode === "walk" && this.robot.path.length > 0);
  }

  resize(width: number, height: number, hud?: PixelHud): void {
    this.W = width;
    this.H = height;
    if (hud) this.hud = hud;
    this.bubble = null;
    this.boardPanel = null;
    this.layout();
  }

  layout(): void {
    const a = this.area;
    const extra = this.syncDecor();
    this.floor = layoutFloor(this.projects, a.w, a.h, this.page, extra);
    this.page = this.floor.page;
    const p = this.focused;
    this.view = p ? layoutDesk(p, this.deskArea, this.notesPage) : null;
    if (this.view) this.notesPage = this.view.notesPage;
    this.syncWorkers();
    this.syncRobot();
    this.syncJanitor();
    this.syncCat();
    this.syncWeek();
    this.layoutHeader();
  }

  private syncWeek(): void {
    if (!this.week || this.focus !== null) {
      this.weekView = null;
      return;
    }
    const today = this.clock();
    // The demo office has no dates of its own, so its wall is dated around today.
    const projects = this.data.demo ? withDemoDates(this.projects, today) : this.projects;
    const { days, overdue } = bucketWeek(projects, today, this.weekAnchor);
    this.weekDays = days;
    this.weekView = layoutWeek(days, overdue, this.area);
  }

  /** The week wall, or the office floor. Opening the wall returns to this week. */
  setWeek(on: boolean): void {
    if (this.focus !== null) return;
    this.week = on;
    if (on) this.weekAnchor = this.clock();
    this.bubble = null;
    this.hover = null;
    this.layout();
  }

  /** Step the wall a week at a time (‹ › and arrow keys while it is open). */
  shiftWeek(d: number): void {
    const a = this.weekAnchor;
    this.weekAnchor = new Date(a.getFullYear(), a.getMonth(), a.getDate() + d * 7);
    this.bubble = null;
    this.hover = null;
    this.layout();
  }

  /** "NOV 22-28": the week on the wall, for the header. */
  get weekLabel(): string {
    const [s, e] = [weekDates(this.weekAnchor)[0], weekDates(this.weekAnchor)[6]];
    const sm = MONTHS[s.getMonth()], em = MONTHS[e.getMonth()];
    return sm === em ? `${sm} ${s.getDate()}-${e.getDate()}` : `${sm} ${s.getDate()}-${em} ${e.getDate()}`;
  }

  /** Floor-local to screen. */
  sx(x: number): number {
    return this.area.x + x;
  }
  sy(y: number): number {
    return this.area.y + y;
  }

  private syncWorkers(): void {
    const key = `${this.floor.w}x${this.floor.h}p${this.page}`;
    const live = new Set<string>();
    const night = this.night;
    for (const d of this.floor.desks) {
      // After dark only whoever has overdue work stays on, at their own desk.
      if (night && !d.project.cards.some((c) => c.overdue)) continue;
      const places: [string | null, "seat" | "side"][] = night
        ? [[d.holder, "seat"]]
        : [
            [d.holder, "seat"],
            [d.visitor, "side"],
          ];
      for (const [holder, spot] of places) {
        if (!holder) continue;
        live.add(holder);
        const home = spot === "seat" ? d.seat : d.side;
        // The room and this place in it: a desk can move without the room changing size.
        const at = `${key}@${home.x},${home.y}`;
        let w = this.workers.get(holder);
        if (!w) {
          w = { holder, look: lookFor(holder), desk: d.index, spot, x: home.x, y: home.y, path: [], mode: spot === "seat" ? "sit" : "stay", timer: this.sitTime(), tossIn: 400 + Math.floor(this.rnd() * 800), homeward: false, dx: 0, dy: -1, layoutKey: at, errand: null, via: null, say: null, late: night, hop: -999 };
          this.workers.set(holder, w);
        }
        w.late = night;
        const moved = w.desk !== d.index || w.spot !== spot;
        const newRoom = !w.layoutKey.startsWith(`${key}@`);
        if (newRoom || (!moved && w.layoutKey !== at)) {
          Object.assign(w, { desk: d.index, spot, x: home.x, y: home.y, path: [], mode: spot === "seat" ? "sit" : "stay", homeward: false, layoutKey: at, dx: 0, dy: -1, errand: null, via: null, say: null });
        } else if (moved) {
          w.layoutKey = at;
          // Their work moved to another desk: walk over.
          const from = this.nearestDesk(w) ?? d;
          w.desk = d.index;
          w.spot = spot;
          w.path = route(w, home, from, d);
          w.mode = "walk";
          w.homeward = true;
          w.errand = null;
        }
      }
    }
    for (const k of [...this.workers.keys()]) if (!live.has(k)) this.workers.delete(k);
  }

  /** The cleaner comes in at the door (bottom left) after dark and leaves by it at dawn. */
  private door(): Pt {
    return { x: 4, y: this.floor.h - 34 };
  }

  private syncJanitor(): void {
    const j = this.janitor;
    if (!j) return;
    const key = `${this.floor.w}x${this.floor.h}p${this.page}`;
    if (j.layoutKey === key) return;
    const at = this.door();
    Object.assign(j, { x: at.x, y: at.y, path: [], mode: j.mode === "leave" ? "leave" : "sweep", timer: 60, fetch: null, layoutKey: key });
  }

  private syncCat(): void {
    const key = `${this.floor.w}x${this.floor.h}p${this.page}`;
    const home = { x: Math.round(this.floor.w * 0.62), y: this.floor.h - 24 };
    if (!this.cat) {
      this.cat = { x: home.x, y: home.y, path: [], dx: 0, dy: 1, mode: "sit", timer: 300, perch: null, bed: null, petAt: -999, layoutKey: key };
      return;
    }
    const c = this.cat;
    if (c.layoutKey === key) {
      if (c.perch !== null && !this.floor.desks.some((d) => d.index === c.perch)) c.perch = null;
      return;
    }
    Object.assign(c, { x: home.x, y: home.y, path: [], mode: c.mode === "walk" ? "sit" : c.mode, timer: 200, perch: null, bed: null, layoutKey: key });
  }

  /** Mint plants for projects past the done milestone; returns the floor's extra plant count. */
  private syncDecor(): number {
    this.unlocked = [];
    for (const p of this.projects) {
      if (p.doneTotal >= PLANT_MILESTONE && !this.decor.has(plantId(p.id))) {
        this.decor.add(plantId(p.id));
        this.unlocked.push(plantId(p.id));
        this.decorDirty = true;
      }
    }
    return Math.min(MAX_EXTRA_PLANTS, this.decor.size);
  }

  /** Where the robot docks: a charging pad in the bottom-left corner. */
  private dock(): Pt {
    return { x: 24, y: this.floor.h - 22 };
  }

  /** The charging pad, in floor coords, for the renderer. */
  dockHome(): Pt {
    return this.dock();
  }

  private syncRobot(): void {
    const key = `${this.floor.w}x${this.floor.h}p${this.page}`;
    const home = this.dock();
    if (!this.robot) {
      this.robot = { x: home.x, y: home.y, path: [], mode: "idle", desk: null, ref: null, timer: 0, dx: 0, dy: -1, active: false, fetch: null, windup: null, layoutKey: key };
      return;
    }
    const r = this.robot;
    if (r.layoutKey !== key) {
      // A new room: dock unless it was working a desk still on this page.
      const still = r.desk !== null && this.floor.desks.some((d) => d.index === r.desk);
      if (still) {
        const d = this.floor.desks.find((d) => d.index === r.desk)!;
        r.x = d.side.x;
        r.y = d.side.y;
        r.path = [];
      } else {
        Object.assign(r, { x: home.x, y: home.y, path: [], mode: "idle" as const, desk: null, dx: 0, dy: -1 });
      }
      r.layoutKey = key;
    }
  }

  private nearestDesk(p: Pt): Desk | null {
    let best: Desk | null = null;
    let bd = Infinity;
    for (const d of this.floor.desks) {
      const dd = Math.abs(d.cx - p.x) + Math.abs(d.cy - p.y);
      if (dd < bd) {
        bd = dd;
        best = d;
      }
    }
    return best;
  }

  private layoutHeader(): void {
    const f = this.frame;
    const y = f.top.y + 2;
    this.backBtn = { x: f.top.lx + 2, y, w: textWidth("< OFFICE") + 6, h: 9 };
    this.nextBtn = { x: f.top.rx - 11, y, w: 9, h: 9 };
    // Room between the arrows for the week range ("NOV 30-DEC 6" needs ~48px).
    this.prevBtn = { x: this.nextBtn.x - (this.week && this.focus === null ? 66 : 34), y, w: 9, h: 9 };
    this.tabBtns = [];
    if (this.focus !== null) {
      let x = this.prevBtn.x - 6;
      for (const tab of ["notes", "board"] as const) {
        const label = this.tabLabel(tab);
        const w = textWidth(label) + 8;
        x -= w;
        this.tabBtns.unshift({ tab, rect: { x, y, w, h: 9 } });
        x -= 3;
      }
    } else {
      // The week wall toggle sits left of the page arrows.
      const label = this.week ? "OFFICE" : "WEEK";
      const w = textWidth(label) + 8;
      this.calBtn = { x: this.prevBtn.x - 6 - w, y, w, h: 9 };
    }
    const d = this.deskArea;
    this.notesNextBtn = { x: d.x + d.w - 10, y: d.y + d.h - 10, w: 9, h: 9 };
    this.notesPrevBtn = { x: this.notesNextBtn.x - 34, y: this.notesNextBtn.y, w: 9, h: 9 };
  }

  tabLabel(tab: DeskTab): string {
    return tab === "board" ? `BOARD ${this.focused?.cards.length ?? 0}` : `NOTES ${this.focused?.notes.length ?? 0}`;
  }

  private sitTime(): number {
    return 600 + Math.floor(this.rnd() * 1500);
  }

  private tickClock(): void {
    const d = this.clock();
    this.clockText = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    this.daylight = daylightAt(d);
    this.season = seasonAt(d);
  }

  deskFor(w: Worker): Desk | undefined {
    return this.floor.desks.find((d) => d.index === w.desk);
  }

  step(): void {
    this.t++;
    if (this.t % 60 === 0) this.tickClock();
    const night = this.night;
    if (night !== this.wasNight) {
      this.wasNight = night;
      // Dusk and dawn hand the lights back to the daylight.
      this.lights = "auto";
      this.syncWorkers();
    }
    if (this.party && this.t - this.party.t0 > PARTY_FRAMES) this.party = null;
    if (this.opened && this.t - this.opened.t > 40) this.opened = null;
    if (this.fx.length) this.fx = this.fx.filter((f) => this.t - f.t0 < f.life + f.delay);
    if (this.pops.length) this.pops = this.pops.filter((p) => this.t - p.t0 < 40);
    if (this.fresh.size) for (const [id, t] of this.fresh) if (this.t - t > FRESH_FRAMES) this.fresh.delete(id);
    if (this.intents.size) for (const [id, t] of this.intents) if (this.t - t > AGENT_WINDOW) this.intents.delete(id);
    for (const w of this.workers.values()) this.stepWorker(w);
    this.stepPapers();
    this.stepRobot();
    this.stepPrinter();
    this.stepJanitor();
    this.stepCat();
  }

  /** One step along a walker's path; true once it has arrived. */
  private walkOn(e: Walker, speed = WALK): boolean {
    const next = e.path[0];
    if (!next) return true;
    const dx = next.x - e.x;
    const dy = next.y - e.y;
    const dist = Math.hypot(dx, dy);
    e.dx = dx / (dist || 1);
    e.dy = dy / (dist || 1);
    if (dist <= speed) {
      e.x = next.x;
      e.y = next.y;
      e.path.shift();
    } else {
      e.x += e.dx * speed;
      e.y += e.dy * speed;
    }
    return false;
  }

  /** A walk around the desks (cleaner and cat), like the robot's. */
  private freePath(from: Pt, to: Pt): Pt[] {
    if (!this.floor.desks.length) return [{ x: Math.round(to.x), y: Math.round(to.y) }];
    return routeFree(from, to, this.floor.desks.map((d) => d.hit), this.floor.w, this.floor.h);
  }

  /** A random clear spot on the floor, away from the desks. */
  private freeSpot(): Pt {
    const F = this.floor;
    for (let i = 0; i < 12; i++) {
      const p = { x: Math.round(12 + this.rnd() * (F.w - 24)), y: Math.round(F.wall.h + 14 + this.rnd() * (F.h - F.wall.h - 26)) };
      if (!F.desks.some((d) => inRect(d.hit, p.x, p.y, 5))) return p;
    }
    return { x: Math.round(F.w / 2), y: F.h - 24 };
  }

  // ── Errands and props ────────────────────────────────────────────────

  private spot(kind: SpotKind): Spot | undefined {
    return this.floor.spots.find((s) => s.kind === kind);
  }

  /** Where someone stands to water planter `i`: just left of it, on the front strip. */
  plantSpot(i: number): Pt | null {
    const p = this.floor.plants[i];
    return p ? { x: Math.max(6, p.x - 12), y: p.y + 1 } : null;
  }

  /** Planter `i`'s name: the corner one is the office's, the rest are projects' milestones. */
  plantLabel(i: number): string {
    if (i === 0) return "OFFICE PLANT";
    const id = [...this.decor][i - 1];
    const p = id ? this.projects.find((q) => plantId(q.id) === id) : undefined;
    return p ? `${p.name} · ${p.doneTotal} DONE` : "A FINISHED PROJECT";
  }

  /** The seated worker nearest `near` who is free to get up (not staying late, not already out). */
  private idleWorker(near: Pt, except?: Worker): Worker | null {
    let best: Worker | null = null;
    let bd = Infinity;
    for (const w of this.workers.values()) {
      if (w === except || w.mode !== "sit" || w.late || w.errand || !this.deskFor(w)) continue;
      const d = Math.abs(w.x - near.x) + Math.abs(w.y - near.y);
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    return best;
  }

  /** Send a worker from their desk to `to` (reached by walkway `via`) on an errand. */
  private sendTo(w: Worker, to: Pt, via: { aisleY: number; laneX: number }, errand: Errand): void {
    const d = this.deskFor(w);
    if (!d) return;
    w.path = route(w, to, d, via);
    w.mode = "walk";
    w.homeward = false;
    w.errand = errand;
    w.via = { aisleY: via.aisleY, laneX: via.laneX };
    w.say = null;
  }

  /** The walkway along the front strip, for the planters. */
  private plantWalk(at: Pt, d: Desk): { aisleY: number; laneX: number } {
    return { aisleY: at.y, laneX: d.laneX };
  }

  /** A worker reached the far end of an errand. */
  private arrive(w: Worker): void {
    const e = w.errand;
    if (!e) return;
    switch (e.k) {
      case "coffee":
        this.brew();
        w.timer = 150;
        return;
      case "chat":
        if (e.text) w.say = { text: e.text, t0: this.t };
        w.timer = SAY_FRAMES + 20;
        return;
      case "water":
        this.plantWatered.set(e.plant, this.t);
        this.plantTouched.set(e.plant, this.t);
        w.timer = 110;
        return;
      case "print": {
        // Collect the printout and take it to its desk.
        const i = this.projects.findIndex((p) => p.id === e.project);
        const desk = this.floor.desks.find((d) => d.index === i);
        const from = this.spot("printer");
        if (!desk || !from) {
          w.errand = { k: "deliver", project: e.project };
          w.timer = 60;
          return;
        }
        w.errand = { k: "deliver", project: e.project };
        w.path = route(w, { x: desk.side.x, y: desk.side.y }, from, desk);
        w.via = { aisleY: desk.aisleY, laneX: desk.laneX };
        w.mode = "walk";
        return;
      }
      case "deliver":
        w.timer = 60;
        w.errand = null;
        return;
      case "visit":
        return;
    }
  }

  /** The coffee machine makes a cup: steam, and one more on today's count. */
  private brew(): void {
    const day = toDateKey(this.clock());
    if (day !== this.cupsDay) {
      this.cupsDay = day;
      this.cups = 0;
    }
    this.cups++;
    this.steamAt = this.t;
  }

  /** Today's cups (zero once the date has moved on). */
  get cupsToday(): number {
    return this.cupsDay === toDateKey(this.clock()) ? this.cups : 0;
  }

  /** Office gossip for the water cooler: mostly the latest changes, else how the week is going. */
  gossip(): string {
    if (this.news.length && this.rnd() < 0.7) return `HEARD? ${this.news[Math.floor(this.rnd() * this.news.length)]}`;
    const { done, overdue } = this.boardStats;
    const busiest = [...this.projects].sort((a, b) => b.cards.length - a.cards.length)[0];
    const lines = [
      done ? `${done} DONE THIS WEEK!` : "SLOW WEEK, HUH?",
      overdue ? `${overdue} OVERDUE...` : "ALL ON TIME!",
      busiest ? `${busiest.name} IS BUSY` : "QUIET TODAY",
    ];
    return lines[Math.floor(this.rnd() * lines.length)];
  }

  private tapCoffee(): void {
    const s = this.spot("coffee");
    const w = s && !this.calm ? this.idleWorker(s.at) : null;
    // Someone gets up for it; with nobody free the machine just brews.
    if (w && s) this.sendTo(w, s.at, s, { k: "coffee" });
    else this.brew();
  }

  private tapCooler(): void {
    const s = this.spot("cooler");
    this.coolerAt = this.t;
    if (!s || this.calm) return;
    const a = this.idleWorker(s.at);
    if (!a) return;
    const b = this.idleWorker(s.at, a);
    this.sendTo(a, s.at, s, { k: "chat", text: this.gossip() });
    // A second person a step further along answers (they arrive a moment later).
    if (b) this.sendTo(b, { x: s.at.x + 12, y: s.at.y }, s, { k: "chat", text: REPLIES[Math.floor(this.rnd() * REPLIES.length)] });
  }

  private tapPlant(i: number): void {
    this.plantTouched.set(i, this.t);
    const at = this.plantSpot(i);
    const w = at && !this.calm ? this.idleWorker(at) : null;
    const d = w && this.deskFor(w);
    if (w && at && d) this.sendTo(w, at, this.plantWalk(at, d), { k: "water", plant: i });
  }

  private openBoard(): void {
    const a = this.area;
    const F = this.floor;
    const rows = this.projects
      .map((p, index) => ({ p, index }))
      .filter((r) => r.p.doneThisWeek > 0)
      .sort((x, y) => y.p.doneThisWeek - x.p.doneThisWeek || x.index - y.index)
      .slice(0, 8);
    const title = `DONE THIS WEEK · ${this.boardStats.done}`;
    const names = rows.map((r) => clip(r.p.name, 16));
    const width = Math.min(a.w - 8, Math.max(textWidth(title) + 8, textWidth("NOTHING YET") + 8, ...rows.map((r, i) => textWidth(names[i]) + textWidth(`${r.p.doneThisWeek}`) + 22)));
    const height = 12 + Math.max(1, rows.length) * 9 + 3;
    const cx = this.sx(F.doneBoard.x + F.doneBoard.w / 2);
    const x = Math.round(Math.max(a.x + 2, Math.min(a.x + a.w - width - 2, cx - width / 2)));
    const y = Math.round(Math.max(a.y + 2, Math.min(a.y + a.h - height - 2, this.sy(F.doneBoard.y + F.doneBoard.h + 3))));
    this.boardPanel = {
      rect: { x, y, w: width, h: height },
      title,
      rows: rows.map((r, i) => ({ index: r.index, name: names[i], n: r.p.doneThisWeek, accent: r.p.accent, rect: { x: x + 2, y: y + 12 + i * 9, w: width - 4, h: 9 } })),
    };
  }

  /** New notes print one at a time; then someone carries each to its desk. */
  private stepPrinter(): void {
    if (!this.printing) {
      const project = this.printQueue.shift();
      if (project) this.printing = { project, t0: this.t };
      return;
    }
    if (this.t - this.printing.t0 < PRINT_FRAMES) return;
    const { project } = this.printing;
    this.printing = null;
    if (!project) return;
    const s = this.spot("printer");
    const w = s && !this.calm ? this.idleWorker(s.at) : null;
    if (w && s) this.sendTo(w, s.at, s, { k: "print", project });
  }

  private stepJanitor(): void {
    if (!this.janitor) {
      if (!this.night) return;
      const at = this.door();
      this.janitor = { x: at.x, y: at.y, path: [], dx: 1, dy: 0, mode: "sweep", timer: 30, fetch: null, say: null, layoutKey: `${this.floor.w}x${this.floor.h}p${this.page}` };
    }
    const j = this.janitor;
    if (j.say && this.t - j.say.t0 > SAY_FRAMES) j.say = null;
    // Dawn: head for the door.
    if (!this.night && j.mode !== "leave") {
      j.mode = "leave";
      j.fetch = null;
      j.path = this.freePath(j, this.door());
    }
    if (j.mode === "leave") {
      if (this.walkOn(j, WALK * 0.8)) this.janitor = null;
      return;
    }
    if (j.mode === "walk") {
      if (!this.walkOn(j, WALK * 0.8)) return;
      const p = j.fetch;
      j.fetch = null;
      if (p && p.state === "floor" && this.papers.includes(p)) {
        this.papers.splice(this.papers.indexOf(p), 1);
        this.swept++;
      }
      j.mode = "sweep";
      j.timer = 90 + Math.floor(this.rnd() * 120);
      return;
    }
    if (this.calm || --j.timer > 0) return;
    // Next: a missed paper ball if there is one, else another patch of floor.
    let target: Pt | null = null;
    let bd = Infinity;
    for (const p of this.papers) {
      if (p.state !== "floor") continue;
      const d = Math.abs(p.x - j.x) + Math.abs(p.y - j.y);
      if (d < bd) {
        bd = d;
        target = p;
        j.fetch = p;
      }
    }
    j.path = this.freePath(j, target ?? this.freeSpot());
    j.mode = "walk";
  }

  /** Where the cat is drawn and clicked: on the floor, or curled on top of a desk's monitor. */
  catAt(): Pt & { lift: number } {
    const c = this.cat;
    const d = c.perch !== null ? this.floor.desks.find((x) => x.index === c.perch) : undefined;
    if (!d) return { x: c.x, y: c.y, lift: 0 };
    const z = this.floor.zoom;
    return { x: d.cx, y: d.cy - Math.round(3.5 * z), lift: 10 * z };
  }

  private stepCat(): void {
    const c = this.cat;
    if (!c) return;
    if (c.mode === "walk") {
      if (!this.walkOn(c, WALK * 0.9)) return;
      if (c.bed !== null && this.floor.desks.some((d) => d.index === c.bed)) {
        c.perch = c.bed;
        c.mode = "sleep";
        c.timer = 2400 + Math.floor(this.rnd() * 2400);
      } else {
        c.mode = this.rnd() < 0.35 ? "sleep" : "sit";
        c.timer = c.mode === "sleep" ? 900 + Math.floor(this.rnd() * 1200) : 300 + Math.floor(this.rnd() * 600);
      }
      c.bed = null;
      return;
    }
    if (this.calm || --c.timer > 0) return;
    // Hop down off a desk before going anywhere.
    if (c.perch !== null) {
      const d = this.floor.desks.find((x) => x.index === c.perch);
      if (d) {
        c.x = d.side.x;
        c.y = d.side.y;
      }
      c.perch = null;
    }
    // After dark it looks for a warm monitor to sleep on.
    const lit = this.night ? this.floor.desks.filter((d) => d.holder) : [];
    if (lit.length) {
      const d = lit[Math.floor(this.rnd() * lit.length)];
      c.bed = d.index;
      c.path = this.freePath(c, { x: d.side.x, y: d.side.y });
    } else {
      c.path = this.freePath(c, this.freeSpot());
    }
    c.mode = "walk";
  }

  private petCat(): void {
    const c = this.cat;
    c.petAt = this.t;
    // A pet wakes it; it sits a while, purring.
    if (c.mode !== "walk") {
      c.mode = "sit";
      c.timer = 240;
    }
  }

  /** Tapping the bin makes a seated worker shoot one (misses included). */
  private forceToss(): void {
    if (this.focus !== null || this.week || this.papers.length >= 12) return;
    const sitters = [...this.workers.values()].filter((w) => w.mode === "sit" && this.deskFor(w));
    if (!sitters.length) return;
    this.toss(sitters[Math.floor(this.rnd() * sitters.length)]);
  }

  /** A seated worker shoots a crumpled paper ball at the bin; most land, some miss. */
  private toss(w: Worker): void {
    const F = this.floor;
    const k = F.zoom / 2;
    const sx = w.x, sy = w.y - 8 * k;
    const scores = this.rnd() >= 0.35;
    let tx = F.bin.x + (scores ? (this.rnd() - 0.5) * 4 : 0);
    let ty = F.bin.y + (scores ? (this.rnd() - 0.5) * 4 : 0);
    if (!scores) {
      const a = this.rnd() * Math.PI * 2, r = 10 + this.rnd() * 14;
      tx = F.bin.x + Math.cos(a) * r;
      ty = F.bin.y + Math.sin(a) * r * 0.6;
    }
    tx = Math.max(4, Math.min(F.w - 4, tx));
    ty = Math.max(F.wall.h + 8, Math.min(F.h - 4, ty));
    const dist = Math.hypot(tx - sx, ty - sy);
    const arcH = Math.max(12, Math.min(34, dist * 0.18));
    this.papers.push({ x: sx, y: sy, sx, sy, tx, ty, t: 0, dur: Math.max(24, Math.min(60, Math.round(dist / 2.2))), arcH, state: "fly", scores });
    this.tossMade++;
  }

  private stepPapers(): void {
    for (let i = this.papers.length - 1; i >= 0; i--) {
      const p = this.papers[i];
      if (p.state !== "floor") {
        p.t++;
        const f = Math.min(1, p.t / p.dur);
        p.x = p.sx + (p.tx - p.sx) * f;
        p.y = p.sy + (p.ty - p.sy) * f;
        if (f < 1) continue;
        if (p.scores) {
          this.papers.splice(i, 1);
          this.tossScored++;
          this.pops.push({ x: p.tx, y: p.ty, t0: this.t });
        } else {
          p.state = "floor";
        }
      }
    }
  }

  private stepRobot(): void {
    const r = this.robot;
    if (!r) return;
    if (r.mode === "walk") {
      const next = r.path[0];
      if (!next) {
        // Arrived: take the shot from the windup spot, collect a fetched ball, or start work.
        if (r.windup) {
          r.windup = null;
          this.robotShoot();
        } else if (r.fetch) {
          const p = r.fetch;
          r.fetch = null;
          if (p.state === "floor" && this.papers.includes(p)) {
            this.papers.splice(this.papers.indexOf(p), 1);
            // Back off a step and shoot it back; the robot never misses.
            const away = Math.atan2(p.y - this.floor.bin.y, p.x - this.floor.bin.x);
            const d = 20 + this.rnd() * 12;
            const to = {
              x: Math.max(4, Math.min(this.floor.w - 4, p.x + Math.cos(away) * d)),
              y: Math.max(this.floor.wall.h + 8, Math.min(this.floor.h - 4, p.y + Math.sin(away) * d)),
            };
            r.windup = to;
            r.path = this.robotPath(to);
            r.mode = "walk";
            return;
          }
        } else if (r.desk !== null) {
          r.mode = "work";
          r.timer = r.active ? 300 : 120;
          r.dx = 0;
          r.dy = -1;
          return;
        }
        r.mode = "idle";
        r.timer = 0;
        r.dx = 0;
        r.dy = -1;
        this.decideRobot();
        return;
      }
      const dx = next.x - r.x;
      const dy = next.y - r.y;
      const dist = Math.hypot(dx, dy);
      r.dx = dx / (dist || 1);
      r.dy = dy / (dist || 1);
      if (dist <= WALK) {
        r.x = next.x;
        r.y = next.y;
        r.path.shift();
      } else {
        r.x += r.dx * WALK;
        r.y += r.dy * WALK;
      }
      return;
    }
    if (r.mode === "work" && !this.calm) {
      if (--r.timer > 0) return;
      // Done working: stay while a tool call is in flight, else find the next job.
      if (r.active && r.desk !== null) {
        r.timer = 300;
        return;
      }
      r.desk = null;
      r.mode = "idle";
    }
    if (r.mode === "idle") this.decideRobot();
    else if (r.active && r.desk !== null) r.mode = "work";
  }

  /** The robot's next job: fetch a missed paper, or dock. */
  private decideRobot(): void {
    const r = this.robot;
    if (!r || r.mode !== "idle") return;
    if (r.active && r.desk !== null) {
      r.mode = "work";
      r.timer = 300;
      return;
    }
    // After dark the cleaner sweeps up; the robot stays on its pad unless the agent needs it.
    if (!r.active && !this.night) {
      const paper = this.nearestPaper(r);
      if (paper) {
        r.fetch = paper;
        this.routeRobot({ x: paper.x, y: paper.y });
        return;
      }
    }
    const home = this.dock();
    if (r.desk === null && Math.abs(r.x - home.x) < 0.5 && Math.abs(r.y - home.y) < 0.5) return;
    if (!this.floor.desks.length) {
      r.x = home.x;
      r.y = home.y;
      r.desk = null;
      return;
    }
    r.desk = null;
    r.fetch = null;
    r.windup = null;
    r.path = this.robotPath(home);
    r.mode = "walk";
  }

  private routeRobot(to: Pt): void {
    const r = this.robot;
    r.path = this.robotPath(to);
    r.mode = "walk";
  }

  /** The robot's walk to a point, around desks instead of through them. */
  private robotPath(to: Pt): Pt[] {
    const r = this.robot;
    if (!this.floor.desks.length) return [{ x: Math.round(to.x), y: Math.round(to.y) }];
    const blocks = this.floor.desks.map((d) => d.hit);
    return routeFree({ x: r.x, y: r.y }, to, blocks, this.floor.w, this.floor.h);
  }

  /** The robot's own shot: a guaranteed swish from where it stands. */
  private robotShoot(): void {
    const r = this.robot;
    const F = this.floor;
    const jx = (this.rnd() - 0.5) * 4, jy = (this.rnd() - 0.5) * 4;
    const tx = F.bin.x + jx, ty = F.bin.y + jy;
    const dist = Math.hypot(tx - r.x, ty - r.y);
    const f = flightFor(dist);
    this.papers.push({ x: r.x, y: r.y - 8, sx: r.x, sy: r.y - 8, tx, ty, t: 0, dur: f.dur, arcH: f.arcH, state: "fly", scores: true });
    this.tossMade++;
  }

  private nearestPaper(r: Robot): Paper | null {
    let best: Paper | null = null;
    let bd = Infinity;
    for (const p of this.papers) {
      if (p.state !== "floor") continue;
      const d = Math.abs(p.x - r.x) + Math.abs(p.y - r.y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  private stepWorker(w: Worker): void {
    const d = this.deskFor(w);
    if (!d) return;
    const home = w.spot === "seat" ? d.seat : d.side;
    if (w.say && this.t - w.say.t0 > SAY_FRAMES) w.say = null;
    if (w.mode === "walk") {
      if (!this.walkOn(w)) return;
      if (w.homeward) {
        w.mode = w.spot === "seat" ? "sit" : "stay";
        w.timer = w.spot === "seat" ? this.sitTime() : 400 + Math.floor(this.rnd() * 600);
        w.homeward = false;
        w.errand = null;
        w.via = null;
        w.dx = 0;
        w.dy = -1;
      } else {
        w.mode = "stay";
        w.timer = 120 + Math.floor(this.rnd() * 200);
        this.arrive(w);
      }
      return;
    }
    if (this.calm) return;
    // Working late: no errands and no paper toss, and anyone caught out walks straight back.
    if (w.late) {
      if (w.mode === "sit") return;
      w.timer = Math.min(w.timer, 1);
    }
    // A seated worker's own cadence: a crumpled sheet at the bin every so often.
    if (w.mode === "sit" && this.focus === null && !this.week &&
        Math.abs(w.x - home.x) < 0.5 && Math.abs(w.y - home.y) < 0.5) {
      if (--w.tossIn <= 0) {
        w.tossIn = 500 + Math.floor(this.rnd() * 1000);
        if (this.papers.length < 12 && this.rnd() < 0.75) this.toss(w);
      }
    }
    if (--w.timer > 0) return;
    const atHome = Math.abs(w.x - home.x) < 0.5 && Math.abs(w.y - home.y) < 0.5;
    if (!atHome) {
      // Back from an errand, by the walkway that reached it.
      const near = this.nearestDesk(w) ?? d;
      w.path = route(w, home, w.via ?? near, d);
      w.mode = "walk";
      w.homeward = true;
      return;
    }
    // An errand: coffee, the water cooler, a planter that needs water, or a colleague's desk.
    const roll = this.rnd();
    const others = this.floor.desks.filter((x) => x.index !== d.index);
    const plants = this.floor.plants.length;
    if (roll < 0.12 && plants) {
      const i = Math.floor(this.rnd() * plants);
      const at = this.plantSpot(i)!;
      this.sendTo(w, at, this.plantWalk(at, d), { k: "water", plant: i });
    } else if (roll < 0.7 || !others.length) {
      const spots = this.floor.spots.filter((s) => s.kind !== "printer");
      const s = spots[Math.floor(this.rnd() * spots.length)];
      this.sendTo(w, s.at, s, s.kind === "coffee" ? { k: "coffee" } : { k: "chat", text: this.rnd() < 0.5 ? this.gossip() : "" });
    } else {
      const o = others[Math.floor(this.rnd() * others.length)];
      this.sendTo(w, { x: o.cx - Math.round(26 * (this.floor.zoom / 2)), y: o.cy + 6 }, o, { k: "visit" });
    }
  }

  // ── Input ────────────────────────────────────────────────────────────

  hit(x: number, y: number): Hit | null {
    // The open clock overlay eats every tap; only its toggle answers.
    if (this.clockOpen) {
      const t = this.clockToggleRect();
      return t && inRect(t, x, y) ? { k: "clockMode" } : null;
    }
    const b = this.bubble;
    if (b && inRect(b.rect, x, y)) {
      const line = b.lines.find((l) => inRect(l.rect, x, y));
      return { k: "bubble", ref: line?.ref ?? null };
    }
    const bp = this.boardPanel;
    if (bp && inRect(bp.rect, x, y)) return { k: "boardRow", index: bp.rows.find((r) => inRect(r.rect, x, y))?.index ?? null };
    const focused = this.focus !== null;
    if (focused && inRect(this.backBtn, x, y, 2)) return { k: "back" };
    const arrows = focused ? this.projects.length > 1 : this.week || this.floor.pageCount > 1;
    if (arrows && inRect(this.prevBtn, x, y, 2)) return { k: "prev" };
    if (arrows && inRect(this.nextBtn, x, y, 2)) return { k: "next" };
    for (const t of this.tabBtns) if (inRect(t.rect, x, y, 1)) return { k: "tab", tab: t.tab };
    if (!focused && inRect(this.calBtn, x, y, 1)) return { k: "week" };
    if (focused) return this.hitDesk(x, y);
    if (this.week) return this.hitWeek(x, y);

    const lx = x - this.area.x;
    const ly = y - this.area.y;
    // The robot first (it stands in front of desks), then workers, nearest the viewer first.
    const r = this.robot;
    if (r) {
      const k = this.floor.zoom / 2;
      if (lx >= r.x - 6 * k && lx <= r.x + 6 * k && ly >= r.y - 22 * k && ly <= r.y + 2) return { k: "robot" };
    }
    const k = this.floor.zoom / 2;
    // The cat (small, and it may be curled up on a desk).
    if (this.cat) {
      const c = this.catAt();
      if (Math.abs(lx - c.x) <= 6 * k && ly >= c.y - c.lift - 9 * k && ly <= c.y - c.lift + 3) return { k: "cat" };
    }
    // Workers (they stand in front of desks), nearest the viewer first.
    // At night only whoever stays late is here; the robot still answers.
    const ws = [...this.workers.values()].filter((w) => this.deskFor(w)).sort((a, b) => b.y - a.y);
    for (const w of ws) {
      const tall = (w.mode === "sit" ? 10 : 24) * k;
      if (lx >= w.x - 6 * k && lx <= w.x + 6 * k && ly >= w.y - tall && ly <= w.y + 2) return { k: "worker", worker: w };
    }
    const j = this.janitor;
    if (j && lx >= j.x - 6 * k && lx <= j.x + 6 * k && ly >= j.y - 24 * k && ly <= j.y + 2) return { k: "janitor" };
    const desk = [...this.floor.desks].reverse().find((d) => inRect(d.hit, lx, ly));
    if (desk) return { k: "desk", desk };
    const F = this.floor;
    if (inRect(F.doneBoard, lx, ly)) return { k: "board" };
    if (Math.abs(lx - F.clock.x) <= 9 && Math.abs(ly - F.clock.y) <= 9) return { k: "clock" };
    if (Math.abs(lx - F.coffee.x) < 8 && ly > F.coffee.y - 26 && ly < F.coffee.y + 4) return { k: "coffee" };
    if (Math.abs(lx - F.cooler.x) < 7 && ly > F.cooler.y - 30 && ly < F.cooler.y + 4) return { k: "cooler" };
    if (Math.abs(lx - F.bin.x) < 7 && ly > F.bin.y - 12 && ly < F.bin.y + 4) return { k: "bin" };
    if (Math.abs(lx - F.printer.x) < 9 && ly > F.printer.y - 16 && ly < F.printer.y + 4) return { k: "printer" };
    for (let i = F.plants.length - 1; i >= 0; i--) {
      const p = F.plants[i];
      const tall = i % 2 ? 20 : 30;
      if (Math.abs(lx - p.x) < 9 && ly > p.y - tall && ly < p.y + 5) return { k: "plant", i };
    }
    if (inRect(F.lightSwitch, lx, ly, 3)) return { k: "lights" };
    const win = F.windows.findIndex((r) => inRect(r, lx, ly, 1));
    if (win >= 0) return { k: "window", i: win };
    return null;
  }

  private hitDesk(x: number, y: number): Hit | null {
    const v = this.view;
    if (!v) return null;
    if (this.tab === "board") {
      for (const c of v.columns) {
        const s = c.stickies.find((k) => inRect(k, x, y));
        if (!s) continue;
        const card = s.card;
        const bits = [card.title];
        if (card.assignee) bits.push(card.assignee);
        if (card.overdue) bits.push("OVERDUE");
        else if (card.dueToday) bits.push("DUE TODAY");
        if (card.priority === "urgent" || card.priority === "high") bits.push(card.priority.toUpperCase());
        return { k: "card", ref: { type: "task", id: card.id }, rect: s, text: bits.join(" · ") };
      }
      return null;
    }
    if (v.notesPages > 1 && inRect(this.notesPrevBtn, x, y, 2)) return { k: "notesPrev" };
    if (v.notesPages > 1 && inRect(this.notesNextBtn, x, y, 2)) return { k: "notesNext" };
    const n = v.notes.find((r) => inRect(r, x, y));
    return n ? { k: "note", ref: n.ref, rect: n, text: `${n.title}${n.pinned ? " · PINNED" : ""}` } : null;
  }

  private hitWeek(x: number, y: number): Hit | null {
    const v = this.weekView;
    if (!v) return null;
    for (const c of v.cols) {
      const p = c.pins.find((k) => inRect(k, x, y));
      if (p) return { k: "card", ref: p.ref, rect: { ...p }, text: `${p.title} · ${c.label}` };
    }
    const t = v.tray.pins.find((k) => inRect(k, x, y));
    if (t) return { k: "card", ref: t.ref, rect: { ...t }, text: `${t.title} · OVERDUE` };
    return null;
  }

  down(x: number, y: number): void {
    this.pointer = { x, y };
    // The big clock covers the room: the toggle switches it, any other tap closes it.
    if (this.clockOpen) {
      const h = this.hit(x, y);
      if (h?.k === "clockMode") this.clockDigital = !this.clockDigital;
      else this.clockOpen = false;
      this.bubble = null;
      return;
    }
    const h = this.hit(x, y);
    if (h?.k !== "bubble") this.bubble = null;
    if (h?.k !== "boardRow") this.boardPanel = null;
    if (!h) return;
    switch (h.k) {
      case "board":
        this.openBoard();
        return;
      case "boardRow":
        if (h.index !== null) {
          this.boardPanel = null;
          this.setFocus(h.index);
        }
        return;
      case "coffee":
        this.tapCoffee();
        return;
      case "cooler":
        this.tapCooler();
        return;
      case "plant":
        this.tapPlant(h.i);
        return;
      case "printer":
        // A test page: it prints, and nobody comes for it.
        if (!this.printing) this.printing = { project: "", t0: this.t };
        return;
      case "janitor":
        if (this.janitor) this.janitor.say = { text: CLEANER_LINES[Math.floor(this.rnd() * CLEANER_LINES.length)], t0: this.t };
        return;
      case "cat":
        this.petCat();
        return;
      case "lights":
        this.lights = this.lightsOn ? "off" : "on";
        return;
      case "window":
        if (this.blinds.has(h.i)) this.blinds.delete(h.i);
        else this.blinds.add(h.i);
        return;
      case "clock":
        this.bubble = null;
        this.clockOpen = true;
        return;
      case "bubble":
        if (h.ref) this.open(h.ref);
        return;
      case "card":
      case "note":
        this.open(h.ref);
        return;
      case "desk":
        this.setFocus(h.desk.index);
        return;
      case "worker":
        this.openBubble(h.worker);
        return;
      case "robot":
        this.bubble = null;
        this.opened = null;
        this.events.push({ k: "openAgent" });
        return;
      case "bin":
        this.forceToss();
        return;
      case "back":
        this.setFocus(null);
        return;
      case "prev":
      case "next":
        this.cycle(h.k === "next" ? 1 : -1);
        return;
      case "tab":
        this.setTab(h.tab);
        return;
      case "week":
        this.setWeek(!this.week);
        return;
      case "notesPrev":
      case "notesNext": {
        const n = this.view?.notesPages ?? 1;
        this.notesPage = (this.notesPage + (h.k === "notesNext" ? 1 : -1) + n) % n;
        this.layout();
        return;
      }
    }
  }

  move(x: number, y: number): void {
    this.pointer = { x, y };
    this.hover = this.describe(this.hit(x, y));
  }

  up(): void {}

  cancel(): void {}

  setKey(code: string, down: boolean): boolean {
    if (!down) return false;
    if (code === "Escape") {
      if (this.clockOpen) {
        this.clockOpen = false;
        return true;
      }
      if (this.bubble || this.boardPanel) {
        this.bubble = null;
        this.boardPanel = null;
        return true;
      }
      if (this.week && this.focus === null) {
        this.setWeek(false);
        return true;
      }
      if (this.focus !== null) {
        this.setFocus(null);
        return true;
      }
      return false;
    }
    if (code === "ArrowRight" || code === "ArrowLeft") {
      this.cycle(code === "ArrowRight" ? 1 : -1);
      return true;
    }
    if (this.focus !== null && (code === "KeyB" || code === "KeyN")) {
      this.setTab(code === "KeyB" ? "board" : "notes");
      return true;
    }
    if (code === "KeyC" && this.focus === null) {
      this.setWeek(!this.week);
      return true;
    }
    return false;
  }

  setFocus(i: number | null): void {
    if (i !== null) this.lastFocus = i;
    this.focus = i;
    this.state = i === null ? "floor" : "desk";
    this.notesPage = 0;
    this.bubble = null;
    this.hover = null;
    if (i === null && this.lastFocus !== null && this.floor.pageCount > 1) {
      // Back on the floor, on the page that holds the desk you left.
      this.page = Math.floor(this.lastFocus / this.floor.perPage);
    }
    this.layout();
  }

  setTab(tab: DeskTab): void {
    this.tab = tab;
    this.hover = null;
    this.layout();
  }

  private cycle(d: number): void {
    if (this.focus !== null) {
      const n = this.projects.length;
      this.setFocus((this.focus + d + n) % n);
    } else if (this.week) {
      this.shiftWeek(d);
    } else if (this.floor.pageCount > 1) {
      this.page = (this.page + d + this.floor.pageCount) % this.floor.pageCount;
      this.hover = null;
      this.layout();
    }
  }

  private open(ref: Ref): void {
    this.bubble = null;
    this.opened = { ref, t: this.t };
    this.events.push({ k: "open", ref });
  }

  /** Cards this person has in progress, across every project. */
  cardsOf(holder: string) {
    return this.projects.flatMap((p) => p.cards.filter((c) => c.zone === "doing" && (c.assignee ?? CONTRACTOR) === holder).map((c) => ({ c, p })));
  }

  private openBubble(w: Worker): void {
    const cards = this.cardsOf(w.holder).slice(0, 6);
    const tap = this.inputMode === "pointer" ? "CLICK" : "TAP";
    const a = this.area;
    const width = Math.min(a.w - 8, Math.max(textWidth(w.holder) + 8, ...cards.map(({ c }) => textWidth(c.title) + 12), textWidth(`${tap} ONE TO OPEN`) + 8));
    const height = 10 + cards.length * 8 + 9;
    const ax = this.sx(w.x);
    const ay = this.sy(w.y) - 26 * (this.floor.zoom / 2);
    const x = Math.round(Math.max(a.x + 2, Math.min(a.x + a.w - width - 2, ax - width / 2)));
    const y = Math.round(Math.max(a.y + 2, Math.min(a.y + a.h - height - 2, ay - height)));
    const maxChars = Math.floor((width - 12) / 4);
    this.bubble = {
      worker: w,
      rect: { x, y, w: width, h: height },
      lines: cards.map(({ c }, i) => ({ ref: { type: "task", id: c.id }, title: clip(c.title, maxChars), rect: { x: x + 2, y: y + 10 + i * 8, w: width - 4, h: 8 } })),
    };
  }

  private describe(h: Hit | null): Hover | null {
    if (!h) return null;
    const tap = this.inputMode === "pointer" ? "CLICK" : "TAP";
    switch (h.k) {
      case "desk": {
        const p = h.desk.project;
        const doing = p.cards.filter((c) => c.zone === "doing").length;
        const late = p.cards.filter((c) => c.overdue).length;
        const bits = [p.name, `${p.cards.length} OPEN`, `${doing} IN PROGRESS`, `${p.notes.length} NOTES`];
        if (late) bits.push(`${late} OVERDUE`);
        return { text: bits.join(" · "), rect: null, desk: h.desk.index };
      }
      case "worker": {
        const mine = this.cardsOf(h.worker.holder);
        const who = h.worker.holder === CONTRACTOR ? "UNASSIGNED WORK" : h.worker.holder;
        const p = this.projects[h.worker.desk];
        if (h.worker.late && p) return { text: `${who} · WORKING LATE · ${p.cards.filter((c) => c.overdue).length} OVERDUE AT ${p.name}`, rect: null };
        const where = p?.name ?? "";
        return { text: `${who} · ${mine.length} IN PROGRESS${where ? ` · AT ${where}` : ""}`, rect: null };
      }
      case "board":
        return { text: `DONE THIS WEEK · ${this.boardStats.done} · ${tap} FOR EACH PROJECT`, rect: null };
      case "boardRow":
        return h.index !== null ? { text: `${tap} TO OPEN ${this.projects[h.index]?.name ?? "THE DESK"}`, rect: this.boardPanel?.rows.find((r) => r.index === h.index)?.rect ?? null } : null;
      case "coffee": {
        const n = this.cupsToday;
        return { text: `COFFEE · ${n} ${n === 1 ? "CUP" : "CUPS"} TODAY · ${tap} FOR ANOTHER`, rect: null };
      }
      case "cooler":
        return { text: `WATER COOLER · ${tap} FOR A CHAT`, rect: null };
      case "printer":
        return { text: this.printing ? "PRINTER · PRINTING..." : "PRINTER · NEW NOTES PRINT HERE", rect: null };
      case "plant":
        return { text: `${this.plantLabel(h.i)} · ${tap} TO WATER`, rect: null };
      case "janitor":
        return { text: `NIGHT CLEANER · ${this.swept} SWEPT UP · ${tap} TO SAY HI`, rect: null };
      case "cat":
        return { text: this.cat.mode === "sleep" ? `OFFICE CAT · ASLEEP · ${tap} TO PET` : `OFFICE CAT · ${tap} TO PET`, rect: null };
      case "lights":
        return { text: `LIGHTS ${this.lightsOn ? "ON" : "OFF"} · ${tap} TO SWITCH`, rect: null };
      case "window": {
        const outside = this.blinds.has(h.i) ? "BLINDS DOWN" : this.season === "snow" ? "SNOWING" : this.season === "leaves" ? "LEAVES FALLING" : this.daylight > 0 ? "SUNNY" : "STARRY";
        return { text: `WINDOW · ${outside} · ${tap} FOR THE BLINDS`, rect: null };
      }
      case "robot": {
        const at = this.robot?.desk !== null && this.robot?.desk !== undefined
          ? (this.projects[this.robot.desk]?.name ?? "")
          : "";
        const what = this.robot?.active ? "WORKING" : "IDLE";
        return { text: `AGENT · ${what}${at ? ` · AT ${at}` : ""} · ${tap} TO OPEN CHAT`, rect: null };
      }
      case "clock":
        return { text: `TIME · ${tap} TO ENLARGE`, rect: null };
      case "clockMode":
        return { text: `SHOW ${this.clockDigital ? "ANALOGUE" : "DIGITAL"}`, rect: this.clockToggleRect() };
      case "bin":
        return { text: `PAPER BIN · ${tap} FOR A TOSS`, rect: null };
      case "card":
        return { text: `TASK · ${h.text}`, rect: h.rect };
      case "note":
        return { text: `NOTE · ${h.text}`, rect: h.rect };
      case "back":
        return { text: "BACK TO THE OFFICE", rect: this.backBtn };
      case "prev":
      case "next":
        return { text: this.focus !== null ? `${h.k === "next" ? "NEXT" : "PREVIOUS"} DESK` : this.week ? `${h.k === "next" ? "NEXT" : "PREVIOUS"} WEEK` : "MORE DESKS", rect: h.k === "prev" ? this.prevBtn : this.nextBtn };
      case "tab":
        return { text: h.tab === "board" ? "THE BOARD" : "THE NOTES", rect: this.tabBtns.find((t) => t.tab === h.tab)?.rect ?? null };
      case "week":
        return { text: this.week ? "BACK TO THE OFFICE" : "THE WEEK WALL", rect: this.calBtn };
      case "notesPrev":
      case "notesNext":
        return { text: "MORE NOTES", rect: h.k === "notesPrev" ? this.notesPrevBtn : this.notesNextBtn };
      case "bubble":
        return h.ref ? { text: `${tap} TO OPEN`, rect: null } : null;
    }
  }

  /** The footer line when nothing is hovered. */
  get hint(): string {
    if (this.data.demo && this.focus === null) return "A DEMO OFFICE · ADD TASKS AND NOTES TO FILL YOURS";
    const tap = this.inputMode === "pointer" ? "CLICK" : "TAP";
    if (this.focus === null && this.week) return `${tap} A PIN TO OPEN ITS TASK · C: THE OFFICE`;
    if (this.focus === null) return `${tap} A DESK TO OPEN ITS PROJECT · ${tap} SOMEONE TO SEE THEIR WORK`;
    const what = this.tab === "board" ? "A CARD" : "A NOTE";
    return this.inputMode === "pointer" ? `${tap} ${what} TO OPEN IT · ESC: THE OFFICE` : `${tap} ${what} TO OPEN IT`;
  }
}
