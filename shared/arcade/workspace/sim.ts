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
import { inRect, layoutDesk, layoutFloor, layoutWeek, route, routeFree, type Desk, type DeskTab, type DeskView, type FloorLayout, type Pt, type Rect, type Ref, type WeekView } from "./layout";
import { bucketWeek, weekDates, withDemoDates, type WeekDay } from "./week";

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
  | { k: "hot"; text: string }
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
  /** Ids whose change followed an intent: shown with the agent colour. For tests and hosts. */
  agentMade = new Set<string>();
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
    this.layout();
    if (this.pointer) this.move(this.pointer.x, this.pointer.y);
  }

  /** Start the effects for a refresh's changes: a few per project and kind, and a sample of a flurry. */
  private react(changes: readonly OfficeChange[]): void {
    if (!changes.length) return;
    // Attribution: a change for an id the agent just touched is the agent's.
    // It is a timing guess, not an audit log (plan phase 3).
    for (const c of changes) {
      const id = "id" in c ? (c as { id: string }).id : null;
      if (id && this.intents.has(id) && this.t - (this.intents.get(id) ?? -9999) <= AGENT_WINDOW) this.agentMade.add(id);
    }
    const bursts = groupChanges(changes.length > FLURRY ? changes.slice(0, FLURRY) : changes);
    for (const b of bursts) {
      for (const id of b.ids) if (b.kind !== "task.removed" && b.kind !== "note.removed" && b.kind !== "task.done") this.fresh.set(id, this.t);
      this.spawn(b);
    }
    if (changes.some((c) => c.k === "task.done")) this.boardPulse = this.t + 60;
  }

  private spawn(b: Burst): void {
    const agent = b.ids.some((id) => this.agentMade.has(id));
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
    if (!this.night) {
      for (const d of this.floor.desks) {
        const places: [string | null, "seat" | "side"][] = [
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
            w = { holder, look: lookFor(holder), desk: d.index, spot, x: home.x, y: home.y, path: [], mode: spot === "seat" ? "sit" : "stay", timer: this.sitTime(), tossIn: 400 + Math.floor(this.rnd() * 800), homeward: false, dx: 0, dy: -1, layoutKey: at };
            this.workers.set(holder, w);
          }
          const moved = w.desk !== d.index || w.spot !== spot;
          const newRoom = !w.layoutKey.startsWith(`${key}@`);
          if (newRoom || (!moved && w.layoutKey !== at)) {
            Object.assign(w, { desk: d.index, spot, x: home.x, y: home.y, path: [], mode: spot === "seat" ? "sit" : "stay", homeward: false, layoutKey: at, dx: 0, dy: -1 });
          } else if (moved) {
            w.layoutKey = at;
            // Their work moved to another desk: walk over.
            const from = this.nearestDesk(w) ?? d;
            w.desk = d.index;
            w.spot = spot;
            w.path = route(w, home, from, d);
            w.mode = "walk";
            w.homeward = true;
          }
        }
      }
    }
    for (const k of [...this.workers.keys()]) if (!live.has(k)) this.workers.delete(k);
  }

  /** Mint plants for projects past the done milestone; returns the floor's extra plant count. */
  private syncDecor(): number {
    for (const p of this.projects) {
      if (p.doneTotal >= PLANT_MILESTONE && !this.decor.has(plantId(p.id))) {
        this.decor.add(plantId(p.id));
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
      this.syncWorkers();
    }
    if (this.opened && this.t - this.opened.t > 40) this.opened = null;
    if (this.fx.length) this.fx = this.fx.filter((f) => this.t - f.t0 < f.life + f.delay);
    if (this.pops.length) this.pops = this.pops.filter((p) => this.t - p.t0 < 40);
    if (this.fresh.size) for (const [id, t] of this.fresh) if (this.t - t > FRESH_FRAMES) this.fresh.delete(id);
    if (this.intents.size) for (const [id, t] of this.intents) if (this.t - t > AGENT_WINDOW + 600) this.intents.delete(id);
    for (const w of this.workers.values()) this.stepWorker(w);
    this.stepPapers();
    this.stepRobot();
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
    if (!r.active) {
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
    if (w.mode === "walk") {
      const next = w.path[0];
      if (!next) {
        if (w.homeward) {
          w.mode = w.spot === "seat" ? "sit" : "stay";
          w.timer = w.spot === "seat" ? this.sitTime() : 400 + Math.floor(this.rnd() * 600);
          w.homeward = false;
          w.dx = 0;
          w.dy = -1;
        } else {
          w.mode = "stay";
          w.timer = 120 + Math.floor(this.rnd() * 200);
        }
        return;
      }
      const dx = next.x - w.x;
      const dy = next.y - w.y;
      const dist = Math.hypot(dx, dy);
      w.dx = dx / (dist || 1);
      w.dy = dy / (dist || 1);
      if (dist <= WALK) {
        w.x = next.x;
        w.y = next.y;
        w.path.shift();
      } else {
        w.x += w.dx * WALK;
        w.y += w.dy * WALK;
      }
      return;
    }
    if (this.calm) return;
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
      // Back from an errand.
      const spot = this.floor.spots.find((s) => Math.abs(s.at.x - w.x) < 1 && Math.abs(s.at.y - w.y) < 1);
      const near = this.nearestDesk(w) ?? d;
      w.path = route(w, home, spot ?? near, d);
      w.mode = "walk";
      w.homeward = true;
      return;
    }
    // An errand: coffee, the water cooler, or a colleague's desk.
    const others = this.floor.desks.filter((x) => x.index !== d.index);
    if (this.rnd() < 0.7 || !others.length) {
      const s = this.floor.spots[Math.floor(this.rnd() * this.floor.spots.length)];
      w.path = route(w, s.at, d, s);
    } else {
      const o = others[Math.floor(this.rnd() * others.length)];
      w.path = route(w, { x: o.cx - Math.round(26 * (this.floor.zoom / 2)), y: o.cy + 6 }, d, o);
    }
    w.mode = "walk";
    w.homeward = false;
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
    // Workers first (they stand in front of desks), nearest the viewer first.
    // At night everyone went home; the robot still answers.
    const ws = this.night
      ? []
      : [...this.workers.values()].filter((w) => this.deskFor(w)).sort((a, b) => b.y - a.y);
    for (const w of ws) {
      const k = this.floor.zoom / 2;
      const tall = (w.mode === "sit" ? 10 : 24) * k;
      if (lx >= w.x - 6 * k && lx <= w.x + 6 * k && ly >= w.y - tall && ly <= w.y + 2) return { k: "worker", worker: w };
    }
    const desk = [...this.floor.desks].reverse().find((d) => inRect(d.hit, lx, ly));
    if (desk) return { k: "desk", desk };
    const F = this.floor;
    if (inRect(F.doneBoard, lx, ly)) return { k: "hot", text: `DONE THIS WEEK · ${this.projects.reduce((s, p) => s + p.doneThisWeek, 0)}` };
    if (Math.abs(lx - F.clock.x) <= 9 && Math.abs(ly - F.clock.y) <= 9) return { k: "clock" };
    if (Math.abs(lx - F.coffee.x) < 8 && ly > F.coffee.y - 26 && ly < F.coffee.y + 4) return { k: "hot", text: "COFFEE" };
    if (Math.abs(lx - F.cooler.x) < 7 && ly > F.cooler.y - 30 && ly < F.cooler.y + 4) return { k: "hot", text: "WATER COOLER" };
    if (Math.abs(lx - F.bin.x) < 7 && ly > F.bin.y - 12 && ly < F.bin.y + 4) return { k: "bin" };
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
    if (!h) return;
    switch (h.k) {
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
      case "hot":
        return;
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
      if (this.bubble) {
        this.bubble = null;
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
      const per = Math.max(1, Math.ceil(this.projects.length / this.floor.pageCount));
      this.page = Math.floor(this.lastFocus / per);
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
        const where = this.projects[h.worker.desk]?.name ?? "";
        return { text: `${who} · ${mine.length} IN PROGRESS${where ? ` · AT ${where}` : ""}`, rect: null };
      }
      case "robot": {
        const at = this.robot?.desk !== null && this.robot?.desk !== undefined
          ? (this.projects[this.robot.desk]?.name ?? "")
          : "";
        const what = this.robot?.active ? "WORKING" : "IDLE";
        return { text: `AGENT · ${what}${at ? ` · AT ${at}` : ""} · ${tap} TO OPEN CHAT`, rect: null };
      }
      case "hot":
        return { text: h.text, rect: null };
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
