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
import { inRect, layoutDesk, layoutFloor, route, type Desk, type DeskTab, type DeskView, type FloorLayout, type Pt, type Rect, type Ref } from "./layout";

export interface OfficeSpec {
  width: number;
  height: number;
  hud?: PixelHud;
  inputMode?: InputMode;
  office?: OfficeData;
  best?: number;
  seed?: number;
  /** Wall-clock source for the clock and daylight (tests pass a fixed one). */
  clock?: () => Date;
}

export type OfficeEvent = { k: "open"; ref: Ref };

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
  homeward: boolean;
  /** Last walking direction, for facing. */
  dx: number;
  dy: number;
  layoutKey: string;
}

export type Hit =
  | { k: "desk"; desk: Desk }
  | { k: "worker"; worker: Worker }
  | { k: "hot"; text: string }
  | { k: "card"; ref: Ref; rect: Rect; text: string }
  | { k: "note"; ref: Ref; rect: Rect; text: string }
  | { k: "back" | "prev" | "next" | "notesPrev" | "notesNext" }
  | { k: "tab"; tab: DeskTab }
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

const HEADER = 13;
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
  tabBtns: { tab: DeskTab; rect: Rect }[] = [];
  notesPrevBtn = ZERO;
  notesNextBtn = ZERO;
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
    this.tickClock();
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
    this.data = d.projects.length ? d : DEMO_OFFICE;
    if (was) {
      const i = this.projects.findIndex((p) => p.id === was);
      this.focus = i >= 0 ? i : null;
      this.state = this.focus === null ? "floor" : "desk";
    }
    this.bubble = null;
    this.layout();
    if (this.pointer) this.move(this.pointer.x, this.pointer.y);
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
    this.floor = layoutFloor(this.projects, a.w, a.h, this.page);
    this.page = this.floor.page;
    const p = this.focused;
    this.view = p ? layoutDesk(p, this.deskArea, this.notesPage) : null;
    if (this.view) this.notesPage = this.view.notesPage;
    this.syncWorkers();
    this.layoutHeader();
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
    for (const d of this.floor.desks) {
      const places: [string | null, "seat" | "side"][] = [
        [d.holder, "seat"],
        [d.visitor, "side"],
      ];
      for (const [holder, spot] of places) {
        if (!holder) continue;
        live.add(holder);
        const home = spot === "seat" ? d.seat : d.side;
        let w = this.workers.get(holder);
        if (!w) {
          w = { holder, look: lookFor(holder), desk: d.index, spot, x: home.x, y: home.y, path: [], mode: spot === "seat" ? "sit" : "stay", timer: this.sitTime(), homeward: false, dx: 0, dy: -1, layoutKey: key };
          this.workers.set(holder, w);
        }
        const moved = w.desk !== d.index || w.spot !== spot;
        if (w.layoutKey !== key) {
          Object.assign(w, { desk: d.index, spot, x: home.x, y: home.y, path: [], mode: spot === "seat" ? "sit" : "stay", homeward: false, layoutKey: key, dx: 0, dy: -1 });
        } else if (moved) {
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
    for (const k of [...this.workers.keys()]) if (!live.has(k)) this.workers.delete(k);
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
    this.prevBtn = { x: this.nextBtn.x - 34, y, w: 9, h: 9 };
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
    if (this.opened && this.t - this.opened.t > 40) this.opened = null;
    for (const w of this.workers.values()) this.stepWorker(w);
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
    const b = this.bubble;
    if (b && inRect(b.rect, x, y)) {
      const line = b.lines.find((l) => inRect(l.rect, x, y));
      return { k: "bubble", ref: line?.ref ?? null };
    }
    const focused = this.focus !== null;
    if (focused && inRect(this.backBtn, x, y, 2)) return { k: "back" };
    const arrows = focused ? this.projects.length > 1 : this.floor.pageCount > 1;
    if (arrows && inRect(this.prevBtn, x, y, 2)) return { k: "prev" };
    if (arrows && inRect(this.nextBtn, x, y, 2)) return { k: "next" };
    for (const t of this.tabBtns) if (inRect(t.rect, x, y, 1)) return { k: "tab", tab: t.tab };
    if (focused) return this.hitDesk(x, y);

    const lx = x - this.area.x;
    const ly = y - this.area.y;
    // Workers first (they stand in front of desks), nearest the viewer first.
    const ws = [...this.workers.values()].filter((w) => this.deskFor(w)).sort((a, b) => b.y - a.y);
    for (const w of ws) {
      const k = this.floor.zoom / 2;
      const tall = (w.mode === "sit" ? 10 : 24) * k;
      if (lx >= w.x - 6 * k && lx <= w.x + 6 * k && ly >= w.y - tall && ly <= w.y + 2) return { k: "worker", worker: w };
    }
    const desk = [...this.floor.desks].reverse().find((d) => inRect(d.hit, lx, ly));
    if (desk) return { k: "desk", desk };
    const F = this.floor;
    if (inRect(F.doneBoard, lx, ly)) return { k: "hot", text: `DONE THIS WEEK · ${this.projects.reduce((s, p) => s + p.doneThisWeek, 0)}` };
    if (Math.abs(lx - F.coffee.x) < 8 && ly > F.coffee.y - 26 && ly < F.coffee.y + 4) return { k: "hot", text: "COFFEE" };
    if (Math.abs(lx - F.cooler.x) < 7 && ly > F.cooler.y - 30 && ly < F.cooler.y + 4) return { k: "hot", text: "WATER COOLER" };
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

  down(x: number, y: number): void {
    this.pointer = { x, y };
    const h = this.hit(x, y);
    if (h?.k !== "bubble") this.bubble = null;
    if (!h) return;
    switch (h.k) {
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
      if (this.bubble) {
        this.bubble = null;
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
      case "hot":
        return { text: h.text, rect: null };
      case "card":
        return { text: `TASK · ${h.text}`, rect: h.rect };
      case "note":
        return { text: `NOTE · ${h.text}`, rect: h.rect };
      case "back":
        return { text: "BACK TO THE OFFICE", rect: this.backBtn };
      case "prev":
      case "next":
        return { text: this.focus !== null ? `${h.k === "next" ? "NEXT" : "PREVIOUS"} DESK` : "MORE DESKS", rect: h.k === "prev" ? this.prevBtn : this.nextBtn };
      case "tab":
        return { text: h.tab === "board" ? "THE BOARD" : "THE NOTES", rect: this.tabBtns.find((t) => t.tab === h.tab)?.rect ?? null };
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
    if (this.focus === null) return `${tap} A DESK TO OPEN ITS PROJECT · ${tap} SOMEONE TO SEE THEIR WORK`;
    const what = this.tab === "board" ? "A CARD" : "A NOTE";
    return this.inputMode === "pointer" ? `${tap} ${what} TO OPEN IT · ESC: THE OFFICE` : `${tap} ${what} TO OPEN IT`;
  }
}
