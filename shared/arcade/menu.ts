/**
 * The Cairn Arcade: pixel cartridge picker shared across mobile and desktop.
 * Five cartridges in a centred column, clear of iPhone Duo side rails and safe
 * areas, with keyboard (Arrows + Enter) and pointer hover selection on desktop.
 */

import { NO_HUD, type InputMode, type PixelHud } from "./pixel/hud";

export type ArcadeGameId =
  | "task-force"
  | "wayfinder"
  | "inbox-zero"
  | "stacker"
  | "breakout"
  | "basecamp"
  | "tideglass"
  | "powder-run";
export type ArcadeEvent = "select" | "page" | `open:${ArcadeGameId}`;

export interface Cartridge {
  id: ArcadeGameId;
  name: string;
  title: string;
  blurb: string;
  accent: string;
  best: number;
  bestKey: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CARD_H = 48;
export const PER_PAGE = 4;
const GAP = 6;
const BLINK = 14;

export const CARTRIDGES: Omit<Cartridge, "best" | "x" | "y" | "w" | "h">[] = [
  { id: "task-force", name: "TASK FORCE", title: "TASK FORCE", blurb: "SHOOT DOWN YOUR BACKLOG", accent: "#2ec4b6", bestKey: "taskforce_best" },
  { id: "wayfinder", name: "WAYFINDER", title: "WAYFINDER", blurb: "SAIL YOUR NOTES", accent: "#47a3e6", bestKey: "wayfinder_best" },
  { id: "inbox-zero", name: "INBOX ZERO", title: "INBOX ZERO", blurb: "DEFEND YOUR BOARD", accent: "#7cc46a", bestKey: "inboxzero_best" },
  { id: "stacker", name: "CAIRN STACKER", title: "STACKER", blurb: "BUILD A CAIRN OF WORK", accent: "#e3a23b", bestKey: "stacker_best" },
  { id: "breakout", name: "BRICK BREAKER", title: "BREAKOUT", blurb: "BREAK THROUGH IT ALL", accent: "#5b8dd6", bestKey: "breakout_best" },
  { id: "basecamp", name: "BASECAMP", title: "BASECAMP", blurb: "CLOCKWORK CAMP & MYSTERY", accent: "#ff9e44", bestKey: "basecamp_best" },
  { id: "tideglass", name: "TIDEGLASS", title: "TIDEGLASS", blurb: "3D MOUNTAIN DESCENT", accent: "#a8f4e8", bestKey: "tideglass_best" },
  { id: "powder-run", name: "POWDER RUN", title: "POWDER RUN", blurb: "3D HALFPIPE & AIR TRICKS", accent: "#ff7242", bestKey: "powderrun_best" },
];

export interface MenuSpec {
  width: number;
  height: number;
  hud?: PixelHud;
  inputMode?: InputMode;
  bests?: Partial<Record<ArcadeGameId, number>>;
  onSelect?: (id: ArcadeGameId) => void;
  onPick?: (id: ArcadeGameId) => void;
}

export class ArcadeMenu {
  W: number;
  H: number;
  hud: PixelHud;
  readonly inputMode: InputMode;
  private bests: Partial<Record<ArcadeGameId, number>>;
  private readonly onSelect?: (id: ArcadeGameId) => void;
  private readonly onPick?: (id: ArcadeGameId) => void;

  cards: Cartridge[] = [];
  titleY = 8;
  pageY = 260;
  page = 0;
  readonly pageCount = Math.ceil(CARTRIDGES.length / PER_PAGE);
  t = 0;
  selected = 0;
  chosen: number | null = null;
  blink = 0;
  calm = false;
  events: ArcadeEvent[] = [];
  readonly best: number;

  constructor(opts: MenuSpec) {
    this.W = opts.width;
    this.H = opts.height;
    this.hud = opts.hud ?? NO_HUD;
    this.inputMode = opts.inputMode ?? "touch";
    this.bests = opts.bests ?? {};
    this.onSelect = opts.onSelect;
    this.onPick = opts.onPick;
    this.relayout();
    this.best = Math.max(0, ...CARTRIDGES.map((c) => this.bests[c.id] ?? 0));
  }

  private relayout(): void {
    const left = this.hud.left + 8;
    const right = this.W - this.hud.right - 8;
    const w = Math.min(220, Math.max(120, right - left));
    const x = Math.round((left + right - w) / 2);
    const slice = CARTRIDGES.slice(this.page * PER_PAGE, (this.page + 1) * PER_PAGE);
    const topMargin = this.hud.top + 44;
    const botMargin = this.hud.bottom + 34;
    const avail = Math.max(160, this.H - topMargin - botMargin);
    const cardH = Math.min(CARD_H, Math.floor((avail - (slice.length - 1) * GAP) / Math.max(1, slice.length)));
    const total = slice.length * cardH + Math.max(0, slice.length - 1) * GAP;
    const y0 = Math.max(topMargin, Math.round((this.H - total) / 2) + 4);
    this.titleY = y0 - 38;
    this.pageY = y0 + total + 8;
    this.cards = slice.map((c, i) => ({
      ...c,
      best: this.bests[c.id] ?? 0,
      x,
      y: y0 + i * (cardH + GAP),
      w,
      h: cardH,
    }));
    if (this.selected >= this.cards.length) this.selected = Math.max(0, this.cards.length - 1);
  }

  prevRect(): { x: number; y: number; w: number; h: number } {
    const cx = Math.round((this.hud.left + this.W - this.hud.right) / 2);
    return { x: cx - 54, y: this.pageY, w: 28, h: 14 };
  }

  nextRect(): { x: number; y: number; w: number; h: number } {
    const cx = Math.round((this.hud.left + this.W - this.hud.right) / 2);
    return { x: cx + 26, y: this.pageY, w: 28, h: 14 };
  }

  setPage(next: number): void {
    if (this.chosen !== null) return;
    const p = (next + this.pageCount) % this.pageCount;
    if (p === this.page) return;
    this.page = p;
    this.selected = 0;
    this.relayout();
    this.events.push("page");
    if (this.cards[0]) this.onSelect?.(this.cards[0].id);
  }

  resize(width: number, height: number, hud?: PixelHud): void {
    if (this.W === width && this.H === height && !hud) return;
    this.W = width;
    this.H = height;
    if (hud) this.hud = hud;
    this.relayout();
  }

  /** Finger / pointer down: pick the cartridge or page arrow under it. */
  down(x: number, y: number): void {
    if (this.chosen !== null) return;
    if (this.pageCount > 1) {
      const pr = this.prevRect();
      if (x >= pr.x - 4 && x <= pr.x + pr.w + 4 && y >= pr.y - 4 && y <= pr.y + pr.h + 4) {
        this.setPage(this.page - 1);
        return;
      }
      const nr = this.nextRect();
      if (x >= nr.x - 4 && x <= nr.x + nr.w + 4 && y >= nr.y - 4 && y <= nr.y + nr.h + 4) {
        this.setPage(this.page + 1);
        return;
      }
    }
    const i = this.cards.findIndex((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
    if (i < 0) return;
    this.selected = i;
    this.onSelect?.(this.cards[i].id);
    this.chosen = i;
    this.blink = this.calm ? 1 : BLINK;
    this.events.push("select");
  }

  move(x: number, y: number): void {
    if (this.chosen !== null) return;
    const i = this.cards.findIndex((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
    if (i >= 0 && i !== this.selected) {
      this.selected = i;
      this.onSelect?.(this.cards[i].id);
    }
  }

  selectDelta(delta: number): void {
    if (this.chosen !== null) return;
    const n = this.cards.length;
    const next = this.selected + delta;
    if (next < 0) {
      this.setPage(this.page - 1);
      this.selected = this.cards.length - 1;
      if (this.cards[this.selected]) this.onSelect?.(this.cards[this.selected].id);
      return;
    }
    if (next >= n) {
      this.setPage(this.page + 1);
      this.selected = 0;
      if (this.cards[0]) this.onSelect?.(this.cards[0].id);
      return;
    }
    this.selected = next;
    this.onSelect?.(this.cards[this.selected].id);
  }

  chooseSelected(): void {
    if (this.chosen !== null) return;
    this.chosen = this.selected;
    this.blink = this.calm ? 1 : BLINK;
    this.events.push("select");
  }

  step(): void {
    this.t++;
    if (this.chosen !== null && this.blink > 0 && --this.blink === 0) {
      const id = this.cards[this.chosen].id;
      this.events.push(`open:${id}`);
      this.onPick?.(id);
    }
  }
}
