/**
 * The Cairn Arcade: the pixel game picker the secret menu opens (pure, no
 * Skia). Five cartridges in a column; tap one, it blinks, then the host opens
 * that game.
 */

import type { PixelHud } from "@/games/pixel/hud";
import { NO_HUD } from "@/games/pixel/hud";

export type ArcadeGameId = "task-force" | "wayfinder" | "inbox-zero" | "stacker" | "breakout";
export type ArcadeEvent = "select" | `open:${ArcadeGameId}`;

export interface Cartridge {
  id: ArcadeGameId;
  title: string;
  blurb: string;
  accent: string;
  best: number;
  /** Card rectangle, game pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CARD_H = 48;
const GAP = 6;
const BLINK = 14;

export const CARTRIDGES: Omit<Cartridge, "best" | "x" | "y" | "w" | "h">[] = [
  { id: "task-force", title: "TASK FORCE", blurb: "SHOOT DOWN YOUR BACKLOG", accent: "#2ec4b6" },
  { id: "wayfinder", title: "WAYFINDER", blurb: "SAIL YOUR NOTES", accent: "#47a3e6" },
  { id: "inbox-zero", title: "INBOX ZERO", blurb: "DEFEND YOUR BOARD", accent: "#7cc46a" },
  { id: "stacker", title: "STACKER", blurb: "BUILD A CAIRN OF WORK", accent: "#e3a23b" },
  { id: "breakout", title: "BREAKOUT", blurb: "BREAK THROUGH IT ALL", accent: "#5b8dd6" },
];

export class ArcadeMenu {
  readonly W: number;
  readonly H: number;
  readonly hud: PixelHud;
  readonly cards: Cartridge[];
  readonly titleY: number;
  t = 0;
  /** Card being opened, and frames left in its blink. */
  chosen: number | null = null;
  blink = 0;
  calm = false;
  events: ArcadeEvent[] = [];
  /** Highest of the three bests, so the host's best tracking has something to read. */
  readonly best: number;

  constructor(opts: { width: number; height: number; hud?: PixelHud; bests?: Partial<Record<ArcadeGameId, number>> }) {
    this.W = opts.width;
    this.H = opts.height;
    this.hud = opts.hud ?? NO_HUD;
    const left = this.hud.left + 8, right = this.W - this.hud.right - 8;
    const w = Math.min(220, right - left), x = Math.round((left + right - w) / 2);
    const topMargin = this.hud.top + 46, botMargin = this.hud.bottom + 18;
    const avail = Math.max(180, this.H - topMargin - botMargin);
    const cardH = Math.min(CARD_H, Math.floor((avail - (CARTRIDGES.length - 1) * GAP) / CARTRIDGES.length));
    const total = CARTRIDGES.length * cardH + (CARTRIDGES.length - 1) * GAP;
    const y0 = Math.max(topMargin, Math.round((this.H - total) / 2) + 12);
    this.titleY = y0 - 38;
    this.cards = CARTRIDGES.map((c, i) => ({ ...c, best: opts.bests?.[c.id] ?? 0, x, y: y0 + i * (cardH + GAP), w, h: cardH }));
    this.best = Math.max(0, ...this.cards.map((c) => c.best));
  }

  /** Finger down: pick the card under it (ignored while one is opening). */
  down(x: number, y: number): void {
    if (this.chosen !== null) return;
    const i = this.cards.findIndex((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
    if (i < 0) return;
    this.chosen = i;
    this.blink = this.calm ? 1 : BLINK;
    this.events.push("select");
  }

  step(): void {
    this.t++;
    if (this.chosen !== null && this.blink > 0 && --this.blink === 0) this.events.push(`open:${this.cards[this.chosen].id}`);
  }
}
