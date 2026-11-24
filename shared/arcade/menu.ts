/**
 * The Cairn Arcade: pixel cartridge picker shared across mobile and desktop.
 * Five cartridges in a centred column, clear of iPhone Duo side rails and safe
 * areas, with keyboard (Arrows + Enter) and pointer hover selection on desktop.
 */

import { NO_HUD, type InputMode, type PixelHud } from "./pixel/hud";

export type ArcadeGameId = "task-force" | "wayfinder" | "inbox-zero" | "stacker" | "breakout";
export type ArcadeEvent = "select" | `open:${ArcadeGameId}`;

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
const GAP = 6;
const BLINK = 14;

export const CARTRIDGES: Omit<Cartridge, "best" | "x" | "y" | "w" | "h">[] = [
  { id: "task-force", name: "TASK FORCE", title: "TASK FORCE", blurb: "SHOOT DOWN YOUR BACKLOG", accent: "#2ec4b6", bestKey: "taskforce_best" },
  { id: "wayfinder", name: "WAYFINDER", title: "WAYFINDER", blurb: "SAIL YOUR NOTES", accent: "#47a3e6", bestKey: "wayfinder_best" },
  { id: "inbox-zero", name: "INBOX ZERO", title: "INBOX ZERO", blurb: "DEFEND YOUR BOARD", accent: "#7cc46a", bestKey: "inboxzero_best" },
  { id: "stacker", name: "CAIRN STACKER", title: "STACKER", blurb: "BUILD A CAIRN OF WORK", accent: "#e3a23b", bestKey: "stacker_best" },
  { id: "breakout", name: "BRICK BREAKER", title: "BREAKOUT", blurb: "BREAK THROUGH IT ALL", accent: "#5b8dd6", bestKey: "breakout_best" },
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
    this.best = Math.max(0, ...this.cards.map((c) => c.best));
  }

  private relayout(): void {
    const left = this.hud.left + 8;
    const right = this.W - this.hud.right - 8;
    const w = Math.min(220, Math.max(120, right - left));
    const x = Math.round((left + right - w) / 2);
    const topMargin = this.hud.top + 46;
    const botMargin = this.hud.bottom + 18;
    const avail = Math.max(180, this.H - topMargin - botMargin);
    const cardH = Math.min(CARD_H, Math.floor((avail - (CARTRIDGES.length - 1) * GAP) / CARTRIDGES.length));
    const total = CARTRIDGES.length * cardH + (CARTRIDGES.length - 1) * GAP;
    const y0 = Math.max(topMargin, Math.round((this.H - total) / 2) + 12);
    this.titleY = y0 - 38;
    this.cards = CARTRIDGES.map((c, i) => ({
      ...c,
      best: this.bests[c.id] ?? 0,
      x,
      y: y0 + i * (cardH + GAP),
      w,
      h: cardH,
    }));
  }

  resize(width: number, height: number, hud?: PixelHud): void {
    if (this.W === width && this.H === height && !hud) return;
    this.W = width;
    this.H = height;
    if (hud) this.hud = hud;
    this.relayout();
  }

  /** Finger / pointer down: pick the cartridge under it (ignored while one is opening). */
  down(x: number, y: number): void {
    if (this.chosen !== null) return;
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
    this.selected = (this.selected + delta + n) % n;
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
