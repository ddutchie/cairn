/**
 * The Workspace renderer. The office floor is stacked voxel models (desks,
 * chairs, people, props) sorted back to front with ground shadows, lit by the
 * windows by day and by monitors after dark. An opened desk is drawn flat from
 * above: the project's board as cork trays of pinned cards, or its notes.
 */

import { clip, textWidth } from "../pixel/font";
import type { PixelHud } from "../pixel/hud";
import { lerpHex, PRIORITY_PAL } from "../pixel/kinds";
import { INK, PixelPainter, type AtlasHandle, type PixelBackend } from "../pixel/painter";
import type { Model } from "../pixel/models";
import { rgb } from "../pixel/terrain";
import { CONTRACTOR, type OfficeCard } from "./data";
import { COL_HEAD, type Desk, type Rect } from "./layout";
import { buildDesk, buildPerson, BIN, CAT, CAT_ASLEEP, CHAIR, COFFEE, COOLER, deskKey, PLANTER_BUSH, PLANTER_TALL, PRINTER, ROBOT } from "./models";
import { cleanerLook, CLOCK_ZOOM, lookKey, PARTY_FRAMES, PRINT_FRAMES, type Janitor, type OfficeSim, type Robot, type Worker } from "./sim";

const BG = "#10131c";
const WALL = "#3a4258";
const WALL_D = "#2c3346";
const WAINSCOT = "#4a5370";
const FLOOR_A = "#8a6a4a";
const FLOOR_B = "#80613f";
const FLOOR_GAP = "#6c5034";
const SUN = "#ffe9b0";
const NIGHT = "#0a0f2a";
const GLOW = "#8fe0ff";
const TEXT = "#e8ecf4";
const TEXT_DIM = "#8a93a8";
const HOVER = "#ffe066";
const BTN = "#2f3548";
const CORK = "#b98e5a";
const CORK_D = "#8f6a40";
const DESKTOP = "#7a5434";
const DESKTOP_L = "#9a6c44";
const PAGE = "#efe8d6";
const RULE = "#d6ccb2";
const BOOKS = ["#5b8dd6", "#d9483b", "#7cc46a", "#c45aa8", "#2ec4b6", "#e3a23b", "#8f6ad6"];

const hashId = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

type Drawable = { y: number; draw: () => void };
/** The flip clock's width on the wall. */
const WALL_FLIP = 30;

export class OfficeRenderer<Img = unknown, Frame = unknown> extends PixelPainter<Img, Frame> {
  private readonly sim: OfficeSim;
  private readonly atlases = new Map<string, AtlasHandle<Img>>();

  constructor(backend: PixelBackend<Img, Frame>, sim: OfficeSim) {
    super(backend, sim.W, sim.H);
    this.sim = sim;
  }

  override resize(width: number, height: number, hud?: PixelHud): void {
    this.sim.resize(width, height, hud);
    super.resize(width, height);
  }

  private atlas(key: string, make: () => Model): AtlasHandle<Img> {
    let a = this.atlases.get(key);
    if (!a) {
      a = this.makeAtlas(make());
      this.atlases.set(key, a);
      // Desk piles change with the workspace; keep the cache from growing without end.
      if (this.atlases.size > 400) this.atlases.delete(this.atlases.keys().next().value as string);
    }
    return a;
  }

  private night: { key: string; img: Img } | null = null;
  private floorImg: { key: string; img: Img } | null = null;

  /**
   * The planks under the back wall, with the sunlight on them, as one image:
   * hundreds of rects a frame otherwise. Rebuilt when the room, its windows or
   * the daylight change.
   */
  private floorMap(day: number): Img {
    const sim = this.sim;
    const F = sim.floor;
    const W = sim.area.w;
    const H = Math.max(1, sim.area.h - F.wall.h);
    const level = Math.round(day * 20) / 20;
    const key = `${W}x${H}|${level}|${F.windows.map((w, i) => `${w.x},${w.w},${sim.blinds.has(i) ? 1 : 0}`).join(";")}|${F.plants.map((p) => p.x).join(",")}`;
    if (this.floorImg?.key === key) return this.floorImg.img;
    const px = new Uint8Array(W * H * 4);
    const fill = (x: number, y: number, w: number, h: number, color: string, alpha = 1) => {
      const [r, g, b] = rgb(color);
      for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) {
        for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) {
          const i = (yy * W + xx) * 4;
          px[i] += (r - px[i]) * alpha;
          px[i + 1] += (g - px[i + 1]) * alpha;
          px[i + 2] += (b - px[i + 2]) * alpha;
          px[i + 3] = 255;
        }
      }
    };
    // Floor planks, staggered.
    for (let y = 0; y < H; y += 6) {
      const row = ((y + F.wall.h) / 6) | 0;
      fill(0, y, W, 6, row % 2 ? FLOOR_A : FLOOR_B);
      fill(0, y + 5, W, 1, FLOOR_GAP, 0.6);
      for (let x = (row * 23) % 40; x < W; x += 40) fill(x, y, 1, 5, FLOOR_GAP, 0.5);
    }
    // Sunlight from each window, falling forward and to the right.
    if (level > 0) {
      for (const [wi, w] of F.windows.entries()) {
        if (sim.blinds.has(wi)) continue;
        for (let i = 0; i < 26; i++) fill(w.x + 2 + i, i * 3, w.w - 4, 3, SUN, 0.16 * level * (1 - i / 26));
      }
      // A planter standing in a window's light throws its shadow into the beam, slanting the same way.
      const base = F.plants.length ? F.plants[0].y - F.wall.h : 0;
      F.plants.forEach((p, pi) => {
        if (!F.windows.some((w, wi) => !sim.blinds.has(wi) && p.x >= w.x && p.x < w.x + w.w)) return;
        const half = pi % 2 ? 4 : 3;
        for (let yy = 0; yy < 36; yy += 2) {
          fill(Math.round(p.x - half + (base + yy) / 3 - base / 3), base + yy, half * 2, 2, "#3a2a1a", 0.2 * level * (1 - yy / 36));
        }
      });
    }
    const img = this.makeImage(W, H, px);
    this.floorImg = { key, img };
    return img;
  }

  /**
   * The darkness over the floor as one image, with a pool of light cut out around every lit monitor.
   * Rebuilt only when the room, its lit desks or the hour change. Light falls off in pixel bands
   * (2px cells, dithered at each band edge) and is wider than it is deep, spilling forward onto the chair.
   */
  private nightMap(dark: number): Img {
    const sim = this.sim;
    const a = sim.area;
    const z = sim.floor.zoom / 2;
    const lights = sim.floor.desks.filter((d) => d.holder).map((d) => ({ x: d.cx, y: d.cy - 6 * z }));
    const level = Math.round(dark * 20) / 20;
    // Daylight through the open windows cuts through the gloom too (lights off by day, dusk).
    const sun = Math.round(sim.daylight * 20) / 20;
    const wins = sun > 0 ? sim.floor.windows.filter((_, i) => !sim.blinds.has(i)) : [];
    const key = `${a.w}x${a.h}|${z}|${level}|${sun}|${lights.map((l) => `${l.x},${l.y}`).join(";")}|${wins.map((w) => w.x).join(",")}`;
    if (this.night?.key === key) return this.night.img;
    const W = a.w;
    const H = a.h;
    const px = new Uint8Array(W * H * 4);
    const night = [10, 15, 42];
    const glow = [30, 125, 255];
    const warm = rgb(SUN);
    const R = 46 * z;
    const BANDS = 5;
    const bayer = [0, 2, 3, 1];
    const wallH = sim.floor.wall.h;
    const BEAM = 78;
    for (let cy = 0; cy < H; cy += 2) {
      for (let cx = 0; cx < W; cx += 2) {
        let lit = 0;
        for (const l of lights) {
          const dx = (cx - l.x) / 1.35;
          const dy = cy < l.y ? (cy - l.y) * 1.6 : cy - l.y;
          const d = Math.hypot(dx, dy) / R;
          if (d < 1) lit = Math.max(lit, 1 - d);
        }
        // The window itself, and its beam falling forward and to the right (as on the floor).
        let sunLit = 0;
        for (const w of wins) {
          if (cy >= w.y - 2 && cy < w.y + w.h + 2 && cx >= w.x - 2 && cx < w.x + w.w + 2) sunLit = Math.max(sunLit, sun);
          const dy = cy - wallH;
          if (dy < 0 || dy >= BEAM) continue;
          const shift = dy / 3;
          if (cx >= w.x + 2 + shift && cx < w.x + w.w - 2 + shift) sunLit = Math.max(sunLit, sun * 0.85 * (1 - dy / BEAM));
        }
        // Quantize into bands, dithering the edge between two bands for a pixel-art falloff.
        const band = (v: number) => {
          const f = v * BANDS;
          let b = Math.floor(f);
          if (f - b > (bayer[((cy >> 1) & 1) * 2 + ((cx >> 1) & 1)] + 0.5) / 4) b++;
          return Math.min(1, b / BANDS);
        };
        const glowL = band(lit);
        const sunL = band(sunLit);
        const light = Math.max(glowL, sunL);
        // Sunlight clears the dark more than a monitor does, and tints it warm, not blue.
        const tint = sunL > glowL ? warm : glow;
        const alpha = dark * (0.62 * (1 - light) + (sunL > glowL ? 0.08 : 0.3) * light);
        const r = night[0] + (tint[0] - night[0]) * light;
        const g = night[1] + (tint[1] - night[1]) * light;
        const b = night[2] + (tint[2] - night[2]) * light;
        for (let yy = cy; yy < Math.min(H, cy + 2); yy++) {
          for (let xx = cx; xx < Math.min(W, cx + 2); xx++) {
            const i = (yy * W + xx) * 4;
            px[i] = r;
            px[i + 1] = g;
            px[i + 2] = b;
            px[i + 3] = Math.round(alpha * 255);
          }
        }
      }
    }
    const img = this.makeImage(W, H, px);
    this.night = { key, img };
    return img;
  }

  draw(): Frame {
    const sim = this.sim;
    this.clear(BG);
    if (sim.focus === null && sim.week) this.drawWeek();
    else if (sim.focus === null) this.drawFloor();
    else this.drawOpenDesk();
    this.drawBubble();
    this.drawBoardPanel();
    this.drawHeader();
    this.drawFooter();
    if (sim.clockShown) this.drawClockOverlay();
    return this.snapshot();
  }

  /** The minute the flip clock last showed, and when its cards started turning. */
  private flip: { from: string; to: string; t0: number } | null = null;

  /**
   * The big pixel clock: analogue or digital, the date under it, tap anywhere to close.
   * No panel behind it: it floats over the dimmed room, lit from the top left like the room: a bevelled wooden bezel, a face sunk into it,
   * hands and markers that cast shadows, a ticking second hand and glass over it all;
   * or flip cards. It zooms out of the wall clock when it opens.
   */
  private drawClockOverlay(): void {
    const sim = this.sim;
    const a = sim.area;
    const tap = sim.inputMode === "pointer" ? "CLICK" : "TAP";
    const p = sim.clockFrame();
    // Out of the wall clock as it opens, back onto the wall as it closes.
    const e = sim.clockOpen
      ? sim.calm ? 1 : Math.min(1, Math.max(0, sim.t - sim.clockOpenedAt) / CLOCK_ZOOM)
      : 1 - Math.min(1, (sim.t - sim.clockClosedAt) / CLOCK_ZOOM);
    if (e <= 0) return;
    const ease = 1 - (1 - e) ** 3;
    // No panel: the clock floats over the dimmed room on its own shadow.
    this.rect(a.x, a.y, a.w, a.h, INK, 0.8 * ease);
    // Everything above the toggle is the face, with the date under it.
    const R = Math.max(12, Math.min(Math.floor((p.w - 24) / 2), Math.floor((p.h - 38) / 2)));
    const fx = p.x + Math.floor(p.w / 2), fy = p.y + 6 + R;
    // Zoom out of the wall clock: from its spot and size to the middle of the panel.
    const wall = sim.wallClockAt();
    const wx = sim.sx(wall.x), wy = sim.sy(wall.y);
    const cx = Math.round(wx + (fx - wx) * ease), cy = Math.round(wy + (fy - wy) * ease);
    const r = Math.max(6, Math.round(7 + (R - 7) * ease));
    if (sim.clockDigital) {
      const W = Math.min(p.w - 24, 200);
      this.drawFlipClock(cx, cy, Math.round(WALL_FLIP + (W - WALL_FLIP) * ease), Math.round(9 + (R * 2 - 15) * ease));
    }
    else this.drawAnalogue(cx, cy, r);
    // The room's light falls on it too: a little monitor-blue at night.
    if (!sim.clockDigital && sim.gloom > 0) this.circle(cx, cy, r + 2, "#1e3a8a", 0.14 * sim.gloom);
    if (e < 1) return;
    const date = sim.dateLine;
    this.text(date, Math.round(fx - textWidth(date) / 2), fy + R + 6, TEXT, 1, INK);
    const t = sim.clockToggleRect();
    if (t) this.button(t, sim.clockDigital ? "ANALOGUE" : "DIGITAL", false);
    const hint = `${tap} OUTSIDE TO CLOSE`;
    this.text(clip(hint, 36), Math.round(p.x + (p.w - textWidth(clip(hint, 36))) / 2), p.y + p.h + 6, TEXT, 1, null);
  }

  private drawAnalogue(cx: number, cy: number, r: number): void {
    const sim = this.sim;
    const now = sim.now;
    const hh = now.getHours(), mm = now.getMinutes(), ss = now.getSeconds();
    // Hung off the panel: a soft shadow down and to the right.
    this.circle(cx + 3, cy + 4, r + 2, INK, 0.22);
    this.circle(cx + 2, cy + 2, r + 2, INK, 0.18);
    // A wooden bezel, bevelled: lit edge top-left, dark edge bottom-right.
    this.circle(cx, cy, r + 2, "#20273a");
    this.circle(cx + 1, cy + 1, r + 1, "#4e3420");
    this.circle(cx - 1, cy - 1, r + 1, "#d4a874");
    this.circle(cx, cy, r, "#9a6c44");
    // The face sits below the bezel, which shades its top-left inside edge.
    const f = Math.max(4, r - Math.max(3, Math.round(r / 9)));
    this.circle(cx, cy, f, "#2c2418");
    this.circle(cx, cy, f, "#f4f1e8");
    this.circle(cx, cy, f, INK, 0.2);
    this.circle(cx + 2, cy + 2, f - 1, "#f4f1e8");
    // Markers: raised blocks at 12, 3, 6 and 9, dots between, each with a shadow.
    const big = Math.max(2, Math.round(f / 10));
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * Math.PI * 2;
      const size = i % 3 === 0 ? big + 1 : Math.max(1, big - 1);
      const mx = Math.round(cx + Math.cos(t) * (f - 4 - big) - size / 2), my = Math.round(cy + Math.sin(t) * (f - 4 - big) - size / 2);
      this.rect(mx + 1, my + 1, size, size, INK, 0.25);
      this.rect(mx, my, size, size, i % 3 === 0 ? "#20273a" : "#5a6079");
    }
    // The hands, each lifted above the face: shadow first, then the hand.
    const hand = (ang: number, len: number, width: number, color: string, tail = 0) => {
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const draw = (ox: number, oy: number, c: string, alpha: number) => {
        for (let o = 0; o < width; o++) {
          // Thicken across the hand, not along it.
          const px = Math.round(-dy * (o - (width - 1) / 2)), py = Math.round(dx * (o - (width - 1) / 2));
          this.line(Math.round(cx - dx * tail) + px + ox, Math.round(cy - dy * tail) + py + oy, Math.round(cx + dx * len) + px + ox, Math.round(cy + dy * len) + py + oy, c, alpha);
        }
      };
      draw(2, 2, INK, 0.22);
      draw(0, 0, color, 1);
    };
    const ha = (((hh % 12) + mm / 60) / 12) * Math.PI * 2 - Math.PI / 2;
    const ma = ((mm + ss / 60) / 60) * Math.PI * 2 - Math.PI / 2;
    // The second hand ticks, overshooting a touch and settling back.
    const frac = now.getMilliseconds() / 1000;
    const kick = sim.calm || frac > 0.18 ? 0 : 0.35 * Math.sin((frac / 0.18) * Math.PI);
    const sa = ((ss + kick) / 60) * Math.PI * 2 - Math.PI / 2;
    const thick = Math.max(2, Math.round(f / 14));
    hand(ha, Math.round(f * 0.5), thick + 1, "#20273a");
    hand(ma, Math.round(f * 0.78), thick, "#20273a");
    hand(sa, Math.round(f * 0.86), 1, "#d9483b", Math.round(f * 0.18));
    // A domed cap over the hands' pivot.
    this.circle(cx, cy, thick + 1, "#20273a");
    this.circle(cx, cy, Math.max(1, thick), "#d9483b");
    this.rect(cx - 1, cy - 1, 1, 1, "#ffb3a8");
    // Glass: a soft sheen and a bright glint across the top left.
    this.circle(Math.round(cx - f * 0.35), Math.round(cy - f * 0.38), Math.round(f * 0.42), "#ffffff", 0.1);
    for (let i = 0; i < 9; i++) {
      const t = Math.PI * (1.08 + i * 0.045);
      this.rect(Math.round(cx + Math.cos(t) * (f - 3)), Math.round(cy + Math.sin(t) * (f - 3)), 2, 1, "#ffffff", 0.55 - i * 0.04);
    }
  }

  /** Flip cards for HH:MM: lighter top halves, a split line and hinges, each card on its own shadow. */
  private drawFlipClock(cx: number, cy: number, W: number, maxH: number): void {
    const sim = this.sim;
    const time = sim.clockText;
    // A changed minute turns the cards that changed.
    if (!this.flip || this.flip.to !== time) this.flip = { from: this.flip?.to ?? time, to: time, t0: sim.t };
    const turn = sim.calm ? 1 : Math.min(1, (sim.t - this.flip.t0) / 14);
    const digits = time.replace(":", "").split("");
    const old = this.flip.from.replace(":", "").split("");
    // Everything scales with the width, from the wall's 22px up to the overlay's 200.
    const s = Math.min(1, W / 200);
    const colon = Math.max(2, Math.round(8 * s));
    const gap = Math.max(1, Math.round(3 * s));
    const inner = Math.max(1, Math.round(3 * s));
    const cw = Math.max(4, Math.floor((W - colon - gap * 2 - inner * 2) / 4));
    const ch = Math.max(6, Math.min(Math.round(cw * 1.45), maxH));
    // The digit fills about two thirds of its card.
    const k = Math.max(1, Math.min(Math.floor((cw * 0.66) / textWidth("8")), Math.floor((ch * 0.66) / 5)));
    const sh = W < 60 ? 1 : 2;
    const total = cw * 4 + inner * 2 + gap * 2 + colon;
    let x = Math.round(cx - total / 2);
    const y = Math.round(cy - ch / 2);
    const card = (cx0: number, d: string, prev: string) => {
      const mid = y + Math.floor(ch / 2);
      this.rect(cx0 + sh, y + sh + 1, cw, ch, INK, 0.35);
      const face = (dd: string, top: boolean, y0: number, h: number) =>
        this.clip(cx0, y0, cw, h, () => {
          this.rect(cx0, y, cw, ch, top ? "#323b52" : "#262d40");
          this.text(dd, Math.round(cx0 + (cw - textWidth(dd, k)) / 2), Math.round(y + (ch - 5 * k) / 2), "#f4f6fa", k, null);
        });
      const flipping = turn < 1 && d !== prev;
      // Settled halves: the new top, and the bottom still old until the flap lands.
      face(d, true, y, mid - y);
      face(flipping && turn < 0.5 ? prev : d, false, mid, y + ch - mid);
      if (flipping) {
        if (turn < 0.5) {
          // The old top folds down toward the hinge.
          const h = Math.max(1, Math.round((mid - y) * (1 - turn * 2)));
          face(prev, true, mid - h, h);
          this.rect(cx0, mid - h, cw, 1, "#ffffff", 0.25);
        } else {
          // The new bottom falls open below it.
          const h = Math.max(1, Math.round((y + ch - mid) * (turn - 0.5) * 2));
          face(d, false, mid, h);
          this.rect(cx0, mid + h - 1, cw, 1, INK, 0.4);
        }
      }
      this.rect(cx0, y, cw, 1, "#4a5370");
      // At 1× the hinge line would land on the digit's middle row and turn an 8 into a 0.
      if (k > 1) this.rect(cx0, mid, cw, 1, "#10131c");
      if (cw >= 10) {
        this.rect(cx0 - 1, mid - 1, 2, 3, "#8a93a8");
        this.rect(cx0 + cw - 1, mid - 1, 2, 3, "#8a93a8");
      }
    };
    for (let i = 0; i < 4; i++) {
      card(x, digits[i] ?? "0", old[i] ?? digits[i] ?? "0");
      x += cw + (i === 1 ? gap + colon + gap : inner);
      if (i === 1) {
        // The colon blinks with the seconds.
        const on = sim.calm || sim.now.getSeconds() % 2 === 0;
        const dot = Math.max(1, Math.round(k * 0.8));
        const colonX = x - gap - colon + Math.floor((colon - dot) / 2);
        for (const dy of [-1, 1]) {
          const dyy = Math.round(y + ch / 2 + dy * ch * 0.18 - dot / 2);
          this.rect(colonX + 1, dyy + 1, dot, dot, INK, 0.3);
          this.rect(colonX, dyy, dot, dot, on ? "#e8ecf4" : "#5a6079");
        }
      }
    }
  }

  // ── The week wall (calendar mode) ──────────────────────────────────

  private drawWeek(): void {
    const sim = this.sim;
    const v = sim.weekView;
    if (!v) return;
    // A big cork wall: pinstripe backing, then the day boards and the red tray.
    this.rect(v.area.x, v.area.y, v.area.w, v.area.h, "#6c543a");
    for (let y = 0; y < v.area.h; y += 4) this.rect(v.area.x, v.area.y + y, v.area.w, 1, "#5e4832", 0.5);
    for (const c of v.cols) {
      if (c.isWeekend) this.rect(c.rect.x, c.rect.y, c.rect.w, c.rect.h, NIGHT, 0.35);
      this.rect(c.rect.x, c.rect.y, c.rect.w, c.rect.h, CORK, c.isWeekend ? 0.75 : 1);
      this.rect(c.head.x, c.head.y, c.head.w, c.head.h, c.isToday ? "#ffe066" : "#8f6a40");
      const label = clip(c.label, Math.floor(c.head.w / 4) - 1);
      this.text(label, c.head.x + 3, c.head.y + 2, c.isToday ? "#1d2232" : TEXT, 1, null);
      for (const p of c.pins) this.drawPin(p.x, p.y, p.w, p.title, p.accent, p.priority);
      if (c.more > 0) this.text(`+${c.more}`, c.rect.x + 3, c.rect.y + c.rect.h - 9, TEXT_DIM, 1, null);
    }
    const t = v.tray;
    this.rect(t.rect.x, t.rect.y, t.rect.w, t.rect.h, "#7a2e2e");
    this.rect(t.rect.x, t.rect.y, t.rect.w, 11, "#d9483b");
    const over = `OVERDUE ${t.pins.length + t.more}`;
    this.text(clip(over, Math.floor(t.rect.w / 4) - 1), t.rect.x + 3, t.rect.y + 2, "#ffffff", 1, null);
    for (const p of t.pins) this.drawPin(p.x, p.y, p.w, p.title, p.accent, p.priority);
    if (t.more > 0) this.text(`+${t.more}`, t.rect.x + t.rect.w - 20, t.rect.y + t.rect.h - 9, TEXT, 1, null);
  }

  private drawPin(x: number, y: number, w: number, title: string, accent: string, priority: "low" | "medium" | "high" | "urgent"): void {
    const pal = PRIORITY_PAL[priority];
    this.rect(x, y, w, 10, "#efe8d6");
    this.rect(x, y, 3, 10, pal.h);
    this.rect(x, y, w, 1, "#ffffff", 0.5);
    this.text(clip(title, Math.floor((w - 6) / 4)), x + 5, y + 2, INK, 1, null);
    this.rect(x + w - 4, y + 1, 3, 3, accent);
  }

  // ── The office floor ──────────────────────────────────────────────────

  private drawFloor(): void {
    const sim = this.sim;
    const a = sim.area;
    const F = sim.floor;
    const ox = a.x;
    const oy = a.y;
    const day = sim.daylight;
    this.clip(a.x, a.y, a.w, a.h, () => {
      this.image(this.floorMap(day), ox, oy + F.wall.h);
      // Back wall: windows, the done board, a clock.
      this.rect(ox, oy, a.w, F.wall.h, WALL);
      this.rect(ox, oy + F.wall.h - 6, a.w, 6, WAINSCOT);
      this.rect(ox, oy + F.wall.h - 1, a.w, 1, WALL_D);
      this.rect(ox, oy + F.wall.h, a.w, 3, INK, 0.25);
      F.windows.forEach((w, i) => this.drawWindow(ox + w.x, oy + w.y, w.w, w.h, day, sim.blinds.has(i)));
      this.drawDoneBoard(ox + F.doneBoard.x, oy + F.doneBoard.y, F.doneBoard.w, F.doneBoard.h);
      // Off the wall while the big clock is out (it is the same clock).
      if (!sim.clockShown) this.drawClock(ox + F.clock.x, oy + F.clock.y);
      this.drawLightSwitch(ox + F.lightSwitch.x, oy + F.lightSwitch.y, F.lightSwitch.w, F.lightSwitch.h);

      // Everything that stands on the floor, back to front.
      const items: Drawable[] = [];
      for (const d of F.desks) this.queueDesk(items, d, ox, oy);
      // After dark only whoever is working late is still here.
      for (const w of sim.workers.values()) {
        if (!sim.deskFor(w)) continue;
        items.push({ y: w.y + (w.mode === "sit" ? 0 : 0.5), draw: () => this.drawWorker(w, ox, oy) });
      }
      const j = sim.janitor;
      if (j) items.push({ y: j.y + 0.5, draw: () => this.drawJanitor(j, ox, oy) });
      if (sim.cat) {
        const c = sim.catAt();
        // On a desk it draws after the desk; on the floor it sorts like anyone else.
        items.push({ y: c.lift ? c.y + 3.5 * F.zoom + 0.1 : c.y + 0.4, draw: () => this.drawCat(ox, oy) });
      }
      if (sim.robot) items.push({ y: sim.robot.y + 0.5, draw: () => this.drawRobot(sim.robot, ox, oy) });
      const prop = (m: AtlasHandle<Img>, x: number, y: number) =>
        items.push({
          y,
          draw: () => {
            this.shadow(m, ox + x, oy + y, 0, 3, 2, 0.3, 2);
            this.stack(m, ox + x, oy + y, 0, { k: 2 });
          },
        });
      prop(this.atlas("coffee", () => COFFEE), F.coffee.x, F.coffee.y);
      prop(this.atlas("cooler", () => COOLER), F.cooler.x, F.cooler.y);
      prop(this.atlas("bin", () => BIN), F.bin.x, F.bin.y);
      prop(this.atlas("printer", () => PRINTER), F.printer.x, F.printer.y);
      // Planters alternate tall snake-plants and bushy pothos down the row; a touch makes one sway.
      F.plants.forEach((p, i) => {
        const age = sim.t - (sim.plantTouched.get(i) ?? -999);
        const sway = age < 40 ? Math.round(Math.sin(age / 2.5) * 2 * (1 - age / 40)) : 0;
        prop(this.atlas(i % 2 ? "planter-bush" : "planter-tall", () => (i % 2 ? PLANTER_BUSH : PLANTER_TALL)), p.x + sway, p.y);
      });
      // The robot's charging pad, bottom-left: lit while it is docked.
      if (sim.robot) {
        const r = sim.robot;
        const home = sim.dockHome();
        const docked = r.mode === "idle" && r.desk === null && Math.abs(r.x - home.x) < 1 && Math.abs(r.y - home.y) < 1;
        items.push({
          y: home.y - 0.5,
          draw: () => {
            this.rect(ox + home.x - 7, oy + home.y - 4, 14, 9, "#20273a");
            this.rect(ox + home.x - 6, oy + home.y - 3, 12, 7, "#2e3a52");
            this.rect(ox + home.x - 6, oy + home.y - 3, 12, 1, docked ? "#8fe0ff" : "#4a5068");
            this.rect(ox + home.x - 6, oy + home.y + 3, 12, 1, docked ? "#8fe0ff" : "#4a5068", docked ? 0.9 : 0.5);
            if (docked) this.circle(ox + home.x, oy + home.y + 1, 7, "#8fe0ff", 0.12 + 0.05 * Math.sin(sim.t / 9));
          },
        });
      }
      // Crumpled paper: high arcs in flight (tumbling as they go), flat ones the robot hasn't fetched.
      for (const p of sim.papers) {
        const f = p.state === "fly" ? Math.min(1, p.t / p.dur) : 1;
        const arc = p.state === "fly" ? Math.sin(f * Math.PI) * p.arcH : 0;
        const tumble = p.state === "fly" && (p.t >> 2) % 2 === 1;
        items.push({
          y: p.y + 0.6,
          draw: () => {
            // Tumbling: wide one frame, tall the next.
            const w = tumble ? 2 : 3, h = tumble ? 3 : 2;
            const sh = tumble ? "#c9c2b2" : "#efe8d6";
            this.rect(ox + p.x - 1, oy + p.y - h - arc, w, h, sh);
            if (!tumble) this.rect(ox + p.x - 1, oy + p.y - 1 - arc, 3, 1, "#c9c2b2");
          },
        });
      }
      items.sort((p, q) => p.y - q.y);
      for (const it of items) it.draw();
      this.drawPropFx(ox, oy);


      // After dark the room dims, and each lit monitor is a light: a pool of screen-blue light on its
      // desk, its piles and whoever sits there, the rest of the room left dark.
      const dark = sim.gloom;
      // The lights on after dark: a warm wash instead of the night.
      if (sim.lights === "on" && day < 1) this.rect(a.x, a.y, a.w, a.h, "#ffe9b0", 0.05 * (1 - day));
      if (dark > 0.02) {
        this.image(this.nightMap(dark), a.x, a.y);
        for (const d of F.desks) {
          if (!d.holder) continue;
          const s = sim.floor.zoom / 2;
          const flicker = 0.5 + 0.5 * Math.sin((sim.t + d.cx * 7) / 9);
          this.circle(ox + d.cx, oy + d.cy - 13 * s, 4 * s, GLOW, 0.08 * dark * flicker);
        }
      }
      // Name tags float above the scene (and the dark) so people never hide them.
      for (const d of F.desks) this.drawNameTag(d, ox, oy);
      this.drawFloorFx(ox, oy);
      this.drawSays(ox, oy);
      // A soft vignette for depth.
      for (let i = 0; i < 6; i++) {
        this.rect(a.x, a.y + a.h - 1 - i, a.w, 1, INK, 0.05 * (6 - i));
        this.rect(a.x + i, a.y, 1, a.h, INK, 0.04 * (6 - i));
        this.rect(a.x + a.w - 1 - i, a.y, 1, a.h, INK, 0.04 * (6 - i));
      }
    });
  }

  private drawWindow(x: number, y: number, w: number, h: number, day: number, closed = false): void {
    const sky = lerpHex("#141a3a", "#8fd0ff", day);
    const low = lerpHex("#1d2450", "#c8ecff", day);
    this.rect(x - 1, y - 1, w + 2, h + 2, "#20273a");
    this.rect(x, y, w, h, sky);
    this.rect(x, y + Math.floor(h * 0.6), w, h - Math.floor(h * 0.6), low);
    if (day < 0.5) {
      // Stars, and a lit window across the street.
      for (let i = 0; i < 4; i++) this.rect(x + ((i * 11 + x) % (w - 2)) + 1, y + ((i * 7) % (h - 8)) + 2, 1, 1, "#ffffff", 0.8 - day);
    } else {
      this.rect(x + 4, y + 4, 8, 2, "#ffffff", 0.5 * day);
      this.rect(x + 7, y + 3, 5, 1, "#ffffff", 0.4 * day);
    }
    this.drawWeather(x, y, w, h);
    this.rect(x + Math.floor(w / 2), y, 1, h, "#20273a");
    this.rect(x, y + Math.floor(h / 2), w, 1, "#20273a");
    if (closed) {
      // Blinds down: slats, with a cord.
      for (let yy = 0; yy < h; yy += 3) {
        this.rect(x, y + yy, w, 2, lerpHex("#6e6450", "#d8c9a4", Math.max(0.35, day)));
        this.rect(x, y + yy + 2, w, 1, INK, 0.25);
      }
      this.rect(x + w - 3, y + 2, 1, h - 2, "#8a7a5a");
    }
    this.rect(x - 2, y + h + 1, w + 4, 2, "#5a6079");
    // A little snow settles on the sill in winter.
    if (this.sim.season === "snow") this.rect(x - 2, y + h, w + 4, 1, "#f4f6fa");
  }

  /** What's outside: snowflakes drifting down, or leaves blowing past. */
  private drawWeather(x: number, y: number, w: number, h: number): void {
    const season = this.sim.season;
    if (!season) return;
    const t = this.sim.t;
    const n = season === "snow" ? 7 : 3;
    for (let i = 0; i < n; i++) {
      const speed = season === "snow" ? 0.18 + (i % 3) * 0.07 : 0.35 + (i % 2) * 0.15;
      const fy = Math.floor((i * 37 + x + t * speed) % h);
      const drift = season === "snow" ? Math.round(Math.sin((t + i * 40) / 30) * 2) : Math.floor((t * speed * 0.8 + i * 23) % w);
      const fx = season === "snow" ? (i * 11 + x * 3) % (w - 2) + drift : drift;
      const px = x + Math.max(0, Math.min(w - 2, fx));
      if (season === "snow") this.rect(px, y + fy, 1, 1, "#ffffff", 0.9);
      else this.rect(px, y + fy, 2, 1, i % 2 ? "#e07a2f" : "#c2452a");
    }
  }

  private drawLightSwitch(x: number, y: number, w: number, h: number): void {
    const on = this.sim.lightsOn;
    this.rect(x, y, w, h, "#d8dce6");
    this.rect(x, y + h - 1, w, 1, "#8a93a8");
    this.rect(x + 1, y + (on ? 1 : h - 4), w - 2, 3, "#5a6079");
  }

  private drawDoneBoard(x: number, y: number, w: number, h: number): void {
    const sim = this.sim;
    const { done, overdue } = sim.boardStats;
    const pop = this.sim.t - this.sim.boardPulse;
    const popping = pop >= 0 && pop < 40;
    this.rect(x - 1, y - 1, w + 2, h + 2, "#7d8496");
    this.rect(x, y, w, h, "#f4f6fa");
    this.text("DONE", x + 3, y + 3, "#3f7a36", 1, null);
    this.text("THIS WEEK", x + 3, y + 11, TEXT_DIM, 1, null);
    const n = `${done}`;
    this.text(n, x + w - textWidth(n, 2) - 3, y + 3 - (popping ? Math.round(3 * Math.sin((pop / 40) * Math.PI)) : 0), popping && pop % 8 < 4 ? "#ffb347" : "#3f7a36", 2, null);
    this.text(clip(`OVERDUE ${overdue}`, Math.floor((w - 6) / 4)), x + 3, y + h - 8, overdue > 0 ? "#d9483b" : TEXT_DIM, 1, null);
  }

  /** The wall clock: a small round one, or a small flip clock once you've picked the digital face. */
  private drawClock(cx: number, cy: number): void {
    if (this.sim.clockDigital) {
      const x = cx - 6;
      this.rect(x - 16, cy - 7, 34, 16, INK, 0.35);
      this.rect(x - 17, cy - 8, 34, 15, "#20273a");
      this.rect(x - 17, cy - 8, 34, 1, "#4a5370");
      this.drawFlipClock(x, cy, WALL_FLIP, 9);
      return;
    }
    const [hh, mm] = this.sim.clockText.split(":").map(Number);
    this.circle(cx, cy, 7, "#20273a");
    this.circle(cx, cy, 6, "#f4f6fa");
    const ma = (mm / 60) * Math.PI * 2 - Math.PI / 2;
    const ha = (((hh % 12) + mm / 60) / 12) * Math.PI * 2 - Math.PI / 2;
    this.line(cx, cy, Math.round(cx + Math.cos(ma) * 5), Math.round(cy + Math.sin(ma) * 5), INK);
    this.line(cx, cy, Math.round(cx + Math.cos(ha) * 3), Math.round(cy + Math.sin(ha) * 3), "#d9483b");
  }

  private queueDesk(items: Drawable[], d: Desk, ox: number, oy: number): void {
    const sim = this.sim;
    const look = { paper: d.paper, books: d.books, lit: !!d.holder, overdue: d.project.cards.some((c) => c.overdue), accent: d.project.accent };
    const desk = this.atlas(`desk:${deskKey(look)}`, () => buildDesk(look));
    const chair = this.atlas("chair", () => CHAIR);
    const hovered = sim.hover?.desk === d.index;
    const z = sim.floor.zoom;
    const s = z / 2;
    items.push({
      y: d.cy,
      draw: () => {
        if (hovered) {
          const hw = 25 * s;
          this.rect(ox + d.cx - hw, oy + d.cy - 12 * s, hw * 2, 26 * s, d.project.accent, 0.22);
          this.strokeRect(ox + d.cx - hw, oy + d.cy - 12 * s, hw * 2, 26 * s, HOVER, 0.8);
        }
        this.shadow(desk, ox + d.cx, oy + d.cy, 0, 4 * s, 3 * s, 0.35, z);
        this.stack(desk, ox + d.cx, oy + d.cy, 0, { k: z });
      },
    });
    // The chair is drawn just in front of whoever sits in it, so its back hides theirs.
    items.push({
      y: d.seat.y + 0.25,
      draw: () => {
        this.shadow(chair, ox + d.seat.x, oy + d.seat.y + 1, 0, 2 * s, 2 * s, 0.3, z);
        this.stack(chair, ox + d.seat.x, oy + d.seat.y + 1, 0, { k: z });
      },
    });
  }

  private drawWorker(w: Worker, ox: number, oy: number): void {
    const sitting = w.mode === "sit";
    const m = this.atlas(`p:${lookKey(w.look)}:${sitting ? 1 : 0}`, () => buildPerson(w.look, sitting));
    const sim = this.sim;
    const walking = w.mode === "walk";
    const bob = walking ? (Math.floor(sim.t / 7) % 2) : 0;
    // A celebration: a few hops.
    const hopAge = sim.t - w.hop;
    const hop = !sim.calm && hopAge >= 0 && hopAge < PARTY_FRAMES ? Math.round(Math.abs(Math.sin(hopAge / 5)) * 3) : 0;
    const ang = walking ? Math.atan2(w.dx, -w.dy) : w.mode === "stay" ? Math.PI : 0;
    const x = ox + w.x;
    const y = oy + w.y - bob - hop;
    const z = sim.floor.zoom;
    this.shadow(m, x, oy + w.y, ang, z, z, 0.35, z);
    this.stack(m, x, sitting ? y - Math.round(1.5 * z) : y, ang, { k: z });
    if (w.holder === CONTRACTOR && !sitting) this.rect(x - 2, y - 13 * z, 4, 2, "#f2d43a");
    // What they carry: a watering can, a printout, or a coffee on the way back.
    const e = w.errand;
    if (e && !sitting) {
      const hx = Math.round(x + 3 * z), hy = Math.round(y - 6 * z);
      if (e.k === "water") {
        this.rect(hx, hy, 4, 3, "#5fb86a");
        this.rect(hx + 4, hy, 2, 1, "#5fb86a");
        this.rect(hx + 1, hy - 1, 2, 1, "#3f8a4a");
      } else if (e.k === "deliver") {
        this.rect(hx - 1, hy - 2, 4, 5, "#f3eedf");
        this.rect(hx - 1, hy - 2, 4, 1, "#c9c2b2");
      } else if (e.k === "coffee" && w.homeward) {
        this.rect(hx, hy, 2, 3, "#f2f2f2");
        if ((sim.t >> 3) % 2) this.rect(hx + 1, hy - 2, 1, 1, "#e8ecf4", 0.6);
      }
    }
    // Working late: a mug steaming beside the keyboard.
    if (w.late && sitting) {
      const d = sim.deskFor(w);
      if (d) {
        const mx = Math.round(ox + d.cx + 3.5 * z), my = Math.round(oy + d.cy - 5.5 * z);
        for (let i = 0; i < 2; i++) this.rect(mx + ((sim.t >> 4) + i) % 2, my - 2 - ((sim.t / 6 + i * 4) % 6), 1, 1, "#e8ecf4", 0.6);
      }
    }
  }

  private drawJanitor(j: Janitor, ox: number, oy: number): void {
    const sim = this.sim;
    const m = this.atlas("cleaner", () => buildPerson(cleanerLook(), false));
    const walking = j.mode !== "sweep";
    const bob = walking ? Math.floor(sim.t / 7) % 2 : 0;
    const ang = walking ? Math.atan2(j.dx, -j.dy) : Math.PI;
    const z = sim.floor.zoom;
    const x = ox + j.x;
    const y = oy + j.y - bob;
    this.shadow(m, x, oy + j.y, ang, z, z, 0.35, z);
    this.stack(m, x, y, ang, { k: z });
    // A broom: the handle in hand, bristles swishing on the floor while sweeping.
    const sweep = j.mode === "sweep" && !sim.calm ? Math.round(Math.sin(sim.t / 6) * z) : 0;
    this.line(Math.round(x + 3 * z), Math.round(y - 7 * z), Math.round(x + 5 * z + sweep), oy + j.y, "#a87a4c");
    this.rect(Math.round(x + 4 * z + sweep) - 1, oy + j.y - 1, 5, 2, "#e3c04a");
  }

  private drawCat(ox: number, oy: number): void {
    const sim = this.sim;
    const c = sim.cat;
    const at = sim.catAt();
    const asleep = c.mode === "sleep";
    const m = this.atlas(asleep ? "cat-asleep" : "cat", () => (asleep ? CAT_ASLEEP : CAT));
    const walking = c.mode === "walk" || c.mode === "prowl";
    const ang = walking ? Math.atan2(c.dx, -c.dy) : asleep ? 0 : Math.PI;
    const z = sim.floor.zoom;
    const x = ox + at.x;
    const ground = oy + at.y - at.lift;
    const bob = walking ? Math.floor(sim.t / 6) % 2 : 0;
    this.shadow(m, x, ground, ang, z * 0.7, z * 0.6, 0.3, z);
    this.stack(m, x, ground - bob, ang, { k: z });
    if (asleep && !sim.calm) {
      const age = sim.t % 60;
      this.text("Z", Math.round(x + 3 * z), Math.round(ground - 5 * z - age / 6), "#e8ecf4", 1, null);
    }
    // Petted: hearts float up.
    const pet = sim.t - c.petAt;
    if (pet >= 0 && pet < 60) {
      for (let i = 0; i < 2; i++) {
        const hx = Math.round(x - 3 + i * 6), hy = Math.round(ground - 8 * z - pet / 4 - i * 4);
        this.rect(hx, hy, 1, 1, "#ff6b8a");
        this.rect(hx + 2, hy, 1, 1, "#ff6b8a");
        this.rect(hx, hy + 1, 3, 1, "#ff6b8a");
        this.rect(hx + 1, hy + 2, 1, 1, "#ff6b8a");
      }
    }
  }

  /** The props at work: coffee steam, cooler bubbles, a printout coming out, water on a planter, confetti. */
  private drawPropFx(ox: number, oy: number): void {
    const sim = this.sim;
    const F = sim.floor;
    const t = sim.t;
    const steam = t - sim.steamAt;
    if (steam >= 0 && steam < 90) {
      for (let i = 0; i < 3; i++) {
        const rise = (steam + i * 12) % 30;
        this.circle(Math.round(ox + F.coffee.x - 2 + i * 2 + Math.sin((t + i * 9) / 6)), Math.round(oy + F.coffee.y - 25 - rise * 0.6), 1.5, "#e8ecf4", 0.5 * (1 - steam / 90));
      }
    }
    const gulp = t - sim.coolerAt;
    if (gulp >= 0 && gulp < 40) {
      for (let i = 0; i < 3; i++) this.rect(Math.round(ox + F.cooler.x - 1 + i), Math.round(oy + F.cooler.y - 14 - ((gulp * 0.6 + i * 5) % 14)), 1, 1, "#ffffff", 0.8);
    }
    if (sim.printing) {
      const p = Math.min(1, (t - sim.printing.t0) / PRINT_FRAMES);
      const out = Math.round(p * 5);
      this.rect(ox + F.printer.x - 3, oy + F.printer.y - 13 - out, 6, out + 1, "#f3eedf");
      for (let k = 0; k < out - 1; k += 2) this.rect(ox + F.printer.x - 2, oy + F.printer.y - 12 - out + k, 4, 1, "#9aa3b8");
      if ((t >> 3) % 2) this.rect(ox + F.printer.x + 5, oy + F.printer.y - 9, 1, 1, "#7cc46a");
    }
    F.plants.forEach((pl, i) => {
      const age = t - (sim.plantWatered.get(i) ?? -999);
      if (age < 0 || age >= 50) return;
      for (let k = 0; k < 3; k++) this.rect(Math.round(ox + pl.x - 3 + k * 3), Math.round(oy + pl.y - 22 + ((age + k * 7) % 14)), 1, 2, "#8fd0ff", 0.85);
    });
    const party = sim.party;
    const d = party && F.desks.find((x) => x.project.id === party.project);
    if (party && d) {
      const age = t - party.t0;
      const s = F.zoom / 2;
      const colors = ["#ffe066", "#d9483b", "#5b8dd6", "#7cc46a", "#c45aa8"];
      for (let i = 0; i < 18; i++) {
        const fx = ((i * 37) % 60 - 30) * s + Math.sin((age + i * 11) / 7) * 2;
        const fy = -50 * s + ((age * 1.2 + i * 13) % (60 * s));
        this.rect(Math.round(ox + d.cx + fx), Math.round(oy + d.cy + fy), 2, 1 + (i % 2), colors[i % colors.length], Math.min(1, (PARTY_FRAMES - age) / 20));
      }
    }
  }

  /** Speech bubbles over whoever is talking (workers at the cooler, the cleaner), nudged apart. */
  private drawSays(ox: number, oy: number): void {
    const sim = this.sim;
    const z = sim.floor.zoom;
    const talk: { text: string; x: number; y: number }[] = [];
    for (const w of sim.workers.values()) if (w.say && sim.deskFor(w)) talk.push({ text: w.say.text, x: w.x, y: w.y - (w.mode === "sit" ? 11 : 13) * z });
    const j = sim.janitor;
    if (j?.say) talk.push({ text: j.say.text, x: j.x, y: j.y - 13 * z });
    const placed: Rect[] = [];
    for (const s of talk) {
      const text = clip(s.text, 24);
      const w = textWidth(text) + 6;
      const r = { x: Math.round(ox + s.x - w / 2), y: Math.round(oy + s.y - 12), w, h: 9 };
      r.x = Math.max(sim.area.x + 1, Math.min(sim.area.x + sim.area.w - w - 1, r.x));
      while (placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h + 1 && r.y + r.h + 1 > p.y)) r.y -= 10;
      placed.push(r);
      this.rect(r.x + 1, r.y + 1, r.w, r.h, INK, 0.4);
      this.rect(r.x, r.y, r.w, r.h, "#f4f1e8");
      this.strokeRect(r.x, r.y, r.w, r.h, INK);
      this.rect(Math.round(ox + s.x) - 1, r.y + r.h, 2, 2, "#f4f1e8");
      this.text(text, r.x + 3, r.y + 2, INK, 1, null);
    }
  }

  private drawRobot(r: Robot, ox: number, oy: number): void {
    const m = this.atlas("robot", () => ROBOT);
    const walking = r.mode === "walk";
    const bob = walking ? Math.floor(this.sim.t / 7) % 2 : 0;
    // Walking, it faces where it goes; working, its desk; waiting, the room (so its eyes show).
    const ang = walking ? Math.atan2(r.dx, -r.dy) : r.mode === "idle" ? Math.PI : 0;
    const x = ox + r.x;
    const y = oy + r.y - bob;
    const z = this.sim.floor.zoom;
    this.shadow(m, x, oy + r.y, ang, z, z, 0.35, z);
    this.stack(m, x, y, ang, { k: z });
    // Facing the room, its face is drawn flat on the head: sprite stacks lose a front face this small.
    if (ang === Math.PI) {
      const fx = Math.round(x - 3 * z), fy = Math.round(y - 11 * z);
      this.rect(fx, fy, 6 * z, 3 * z, "#10131c");
      const blink = this.sim.t % 220 < 6;
      for (const ex of [1, 4]) this.rect(fx + ex * z, fy + (blink ? 2 : 1) * z, z, blink ? 1 : z, "#8fe0ff");
    }
    // A working robot glows blue; a small tag says whose side it is on.
    if (r.active) this.circle(x, y - 12 * z, 3 * z, "#8fe0ff", 0.5 + 0.2 * Math.sin(this.sim.t / 9));
    const label = r.active ? "AGENT" : "IDLE";
    const w = textWidth(label) + 6;
    const lx = Math.round(x - w / 2), ly = Math.round(y - 13 * z - 8);
    this.rect(lx, ly, w, 9, "#1d2232", 0.92);
    this.text(label, lx + 3, ly + 2, r.active ? "#8fe0ff" : TEXT, 1, null);
  }

  private drawNameTag(d: Desk, ox: number, oy: number): void {
    const name = clip(d.project.name, 12);
    const w = textWidth(name) + 10;
    const x = Math.round(ox + d.cx - w / 2);
    const y = oy + d.cy + Math.round(22 * (this.sim.floor.zoom / 2));
    this.rect(x + 1, y + 1, w, 8, INK, 0.35);
    this.rect(x, y, w, 8, "#1d2232", 0.92);
    this.rect(x + 2, y + 2, 4, 4, d.project.accent);
    this.text(name, x + 8, y + 2, TEXT, 1, null);
  }

  // ── An opened desk: the board or the notes ───────────────────────────

  private drawOpenDesk(): void {
    const sim = this.sim;
    const a = sim.area;
    const p = sim.focused!;
    // The desk top, with a bevelled edge and lamp light from the top left.
    this.rect(a.x, a.y, a.w, a.h, DESKTOP);
    for (let y = 0; y < a.h; y += 5) this.rect(a.x, a.y + y, a.w, 1, DESKTOP_L, 0.25);
    this.rect(a.x, a.y, a.w, 2, DESKTOP_L);
    this.rect(a.x, a.y + a.h - 2, a.w, 2, "#4e3420");
    for (let i = 0; i < 8; i++) this.circle(a.x + 20, a.y + 10, 30 + i * 18, SUN, 0.025);
    this.rect(a.x, a.y, 3, a.h, p.accent);
    if (sim.tab === "board") this.drawBoard();
    else this.drawNotes();
    if (sim.gloom > 0) this.rect(a.x, a.y, a.w, a.h, NIGHT, 0.25 * sim.gloom);
    // What just changed here floats up the right edge.
    let row = 0;
    for (const f of sim.fx) {
      if (f.k !== "label" || f.project !== p.id) continue;
      const age = sim.t - f.t0;
      if (age < 0 || age > f.life) continue;
      const fade = Math.min(1, (f.life - age) / 30);
      const w = textWidth(f.text) + 8;
      const x = a.x + a.w - w - 6;
      const y = a.y + a.h - 18 - row * 12;
      this.rect(x, y, w, 9, INK, 0.7 * fade);
      this.text(f.text, x + 4, y + 2, lerpHex(BG, f.color, fade), 1, null);
      row++;
    }
  }

  /** Effects over the office floor: labels rising from desks, sheets flying, writing bubbles. */
  private drawFloorFx(ox: number, oy: number): void {
    const sim = this.sim;
    const F = sim.floor;
    const desk = (id: string) => F.desks.find((d) => d.project.id === id);
    const s = F.zoom / 2;
    const rows = new Map<string, number>();
    for (const f of sim.fx) {
      const d = desk(f.project);
      const age = sim.t - f.t0 - f.delay;
      if (!d || age < 0 || age > f.life) continue;
      const p = age / f.life;
      if (f.k === "paper") {
        let x: number, y: number;
        if (f.to === "desk") {
          // Drops from above onto the pile, bouncing once.
          x = ox + d.cx - 12 * s;
          y = oy + d.cy - 14 * s - (1 - p * p) * 38 * s;
        } else {
          // Lifts off the desk and arcs to the done board.
          const bx = ox + F.doneBoard.x + F.doneBoard.w / 2;
          const by = oy + F.doneBoard.y + F.doneBoard.h / 2;
          x = ox + d.cx + (bx - (ox + d.cx)) * p;
          y = oy + d.cy - 14 * s + (by - (oy + d.cy - 14 * s)) * p - Math.sin(p * Math.PI) * 26;
        }
        this.rect(Math.round(x) + 1, Math.round(y) + 2, 4, 5, INK, 0.3);
        this.rect(Math.round(x), Math.round(y), 4, 5, "#f3eedf");
        this.rect(Math.round(x), Math.round(y), 4, 1, f.color);
        if (f.to === "board" && p > 0.9) this.circle(Math.round(x) + 2, Math.round(y) + 2, 5 * (p - 0.9) * 10, f.color, 0.5 * (1 - p) * 10, true);
        continue;
      }
      const fade = Math.min(1, (f.life - age) / 30);
      const rise = 8 + 18 * Math.min(1, age / 40);
      // Several labels over one desk stack upward instead of overlapping.
      const row = rows.get(f.project) ?? 0;
      rows.set(f.project, row + 1);
      const y = oy + d.cy - 36 * s - rise - row * 11;
      const w = textWidth(f.text) + 8;
      const x = Math.round(ox + d.cx - w / 2);
      this.rect(x, y - 1, w, 9, INK, 0.75 * fade);
      this.text(f.text, x + 4, y + 1, lerpHex(BG, f.color, fade), 1, null);
    }
    // Swishes: a ring and a label bursting out of the bin's mouth.
    for (const pop of sim.pops) {
      const age = sim.t - pop.t0;
      if (age < 0 || age > 40) continue;
      const f = age / 40;
      const mouth = (BIN.h - 1) * 2;
      const cy = oy + pop.y - mouth - f * 6;
      this.circle(ox + pop.x, cy, 2 + f * 7, "#ffe066", 0.7 * (1 - f));
      const w = textWidth("SWISH!") + 6;
      this.rect(ox + pop.x - w / 2 + 1, cy - 16 + 1, w, 9, INK, 0.5 * (1 - f));
      this.rect(ox + pop.x - w / 2, cy - 16, w, 9, "#f4f1e8");
      this.text("SWISH!", ox + pop.x - w / 2 + 3, cy - 14, INK, 1, null);
    }
    // Notes being written: a bubble with moving dots, and a pulse on the desk.
    for (const id of sim.writing) {
      const p = sim.projectOfNote(id);
      const d = p && desk(p.id);
      if (!d || !p) continue;
      const dots = ".".repeat(1 + (Math.floor(sim.t / 14) % 3));
      const label = `WRITING${dots}`;
      const w = textWidth("WRITING...") + 8;
      const x = Math.round(ox + d.cx - w / 2);
      const y = oy + d.cy - 36 * s - 4;
      const pulse = 0.12 + 0.1 * Math.sin(sim.t / 8);
      this.rect(ox + d.cx - 25 * s, oy + d.cy - 12 * s, 50 * s, 26 * s, p.accent, pulse);
      this.rect(x + 1, y + 1, w, 9, INK, 0.4);
      this.rect(x, y, w, 9, "#f4f1e8");
      this.strokeRect(x, y, w, 9, p.accent);
      this.text(label, x + 4, y + 2, INK, 1, null);
    }
  }

  private drawBoard(): void {
    const sim = this.sim;
    const v = sim.view!;
    for (const c of v.columns) {
      // A cork tray, sunk into the desk.
      this.rect(c.x + 1, c.y + 2, c.w, c.h, INK, 0.3);
      this.rect(c.x, c.y, c.w, c.h, c.done ? "#7d8496" : CORK);
      this.rect(c.x, c.y, c.w, 1, INK, 0.25);
      this.rect(c.x, c.y, 1, c.h, INK, 0.15);
      this.rect(c.x, c.y + COL_HEAD - 1, c.w, 1, c.done ? "#5e6478" : CORK_D);
      const count = `${c.count}`;
      this.text(clip(c.name, Math.max(1, Math.floor((c.w - textWidth(count) - 8) / 4))), c.x + 3, c.y + 4, INK, 1, null);
      this.text(count, c.x + c.w - textWidth(count) - 3, c.y + 4, c.done ? "#e8ecf4" : "#4e3420", 1, null);
      if (c.done) {
        const n = `${c.count}`;
        this.text(n, Math.round(c.x + c.w / 2 - textWidth(n, 3) / 2), c.y + 30, "#f4f6fa", 3, null);
        this.textC("THIS WEEK", c.x + c.w / 2, c.y + 50, "#e8ecf4", 1, null);
        continue;
      }
      for (const s of c.stickies) this.drawSticky(s.x, s.y, s.w, s.h, s.card);
      if (c.more > 0) this.text(`+${c.more} MORE`, c.x + 4, c.y + c.h - 8, "#4e3420", 1, null);
    }
    if (v.hiddenColumns > 0) this.text(`+${v.hiddenColumns} COLUMNS`, v.area.x + v.area.w - textWidth(`+${v.hiddenColumns} COLUMNS`), v.area.y + v.area.h + 2, TEXT_DIM, 1, null);
  }

  private drawSticky(x: number, y: number, w: number, h: number, c: OfficeCard): void {
    const pal = PRIORITY_PAL[c.priority];
    const opened = this.sim.opened?.ref.id === c.id;
    const hovered = this.sim.hover?.rect && this.sim.hover.rect.x === x && this.sim.hover.rect.y === y;
    const lift = hovered ? 1 : 0;
    this.rect(x + 1, y + 2, w, h, INK, hovered ? 0.4 : 0.28);
    this.rect(x, y - lift, w, h, lerpHex("#fffdf4", pal.a, 0.35));
    this.rect(x, y - lift, 2, h, pal.h);
    this.rect(x, y + h - 1 - lift, w, 1, INK, 0.12);
    const pin = c.overdue ? "#ff3b30" : c.dueToday ? "#ffb347" : pal.h;
    this.rect(x + Math.floor(w / 2), y - 1 - lift, 2, 2, pin);
    const initials = c.assignee ? c.assignee.split(" ").map((s) => s[0]).join("").slice(0, 2) : "";
    const room = Math.floor((w - 6 - (initials ? textWidth(initials) + 5 : 0)) / 4);
    this.text(clip(c.title, Math.max(1, room)), x + 4, y + 4 - lift, INK, 1, null);
    if (initials) {
      const ix = x + w - textWidth(initials) - 3;
      this.rect(ix - 2, y + 2 - lift, textWidth(initials) + 4, 8, this.sim.lookOf(c.assignee!).shirt);
      this.text(initials, ix, y + 4 - lift, INK, 1, null);
    }
    const born = this.sim.fresh.get(c.id);
    if (born !== undefined && (this.sim.t - born) % 30 < 20) this.strokeRect(x - 2, y - 2 - lift, w + 4, h + 4, "#7cc46a");
    if (opened || hovered) this.strokeRect(x - 1, y - 1 - lift, w + 2, h + 2, opened ? "#ffffff" : HOVER);
  }

  private drawNotes(): void {
    const sim = this.sim;
    const v = sim.view!;
    const ar = v.area;
    // An open notebook: a page with ruled lines.
    this.rect(ar.x + 2, ar.y + 3, ar.w, ar.h, INK, 0.3);
    this.rect(ar.x, ar.y, ar.w, ar.h, PAGE);
    for (let y = ar.y + 3; y < ar.y + ar.h - 2; y += 11) this.rect(ar.x + 2, y + 10, ar.w - 4, 1, RULE);
    if (!v.notes.length) {
      this.textC("NO NOTES IN THIS PROJECT YET", ar.x + ar.w / 2, ar.y + ar.h / 2 - 3, "#8a7a5a", 1, null);
      return;
    }
    for (const n of v.notes) {
      const hovered = sim.hover?.rect === n || (sim.hover?.rect && sim.hover.rect.x === n.x && sim.hover.rect.y === n.y);
      const opened = sim.opened?.ref.id === n.ref.id;
      if (hovered || opened) this.rect(n.x, n.y, n.w, n.h, opened ? "#ffffff" : HOVER, 0.45);
      const born = sim.fresh.get(n.ref.id);
      if (born !== undefined && (sim.t - born) % 30 < 20) this.rect(n.x, n.y, n.w, n.h, "#7cc46a", 0.35);
      if (sim.writing.has(n.ref.id)) this.text(`WRITING${".".repeat(1 + (Math.floor(sim.t / 14) % 3))}`, n.x + n.w - textWidth("WRITING...") - 2, n.y + 2, "#c45a2a", 1, null);
      const c = n.pinned ? "#e3c04a" : BOOKS[hashId(n.ref.id) % BOOKS.length];
      this.rect(n.x + 2, n.y + 1, 4, 8, c);
      this.rect(n.x + 2, n.y + 1, 1, 8, "#ffffff", 0.35);
      this.rect(n.x + 5, n.y + 1, 1, 8, INK, 0.3);
      this.text(clip(n.title, Math.floor((n.w - 12) / 4)), n.x + 9, n.y + 2, "#2a2418", 1, null);
    }
    if (v.notesPages > 1) {
      const p = sim.notesPrevBtn;
      const q = sim.notesNextBtn;
      this.rect(p.x, p.y, p.w, p.h, BTN);
      this.rect(q.x, q.y, q.w, q.h, BTN);
      this.text("<", p.x + 3, p.y + 2, TEXT, 1, null);
      this.text(">", q.x + 3, q.y + 2, TEXT, 1, null);
      const label = `${v.notesPage + 1}/${v.notesPages}`;
      this.text(label, Math.round((p.x + p.w + q.x) / 2 - textWidth(label) / 2), p.y + 2, "#5a4a30", 1, null);
    }
  }

  // ── Overlays ──────────────────────────────────────────────────────────

  private drawBubble(): void {
    const b = this.sim.bubble;
    if (!b) return;
    const r = b.rect;
    this.rect(r.x + 2, r.y + 2, r.w, r.h, INK, 0.45);
    this.rect(r.x, r.y, r.w, r.h, "#f4f1e8");
    this.strokeRect(r.x, r.y, r.w, r.h, INK);
    const shirt = b.worker.look.shirt;
    this.rect(r.x + 3, r.y + 3, 4, 4, shirt);
    this.text(b.worker.holder, r.x + 9, r.y + 3, INK, 1, null);
    for (const l of b.lines) {
      this.rect(l.rect.x + 2, l.rect.y + 3, 2, 2, "#5b8dd6");
      this.text(l.title, l.rect.x + 7, l.rect.y + 1, INK, 1, null);
    }
    const tap = this.sim.inputMode === "pointer" ? "CLICK" : "TAP";
    this.text(b.lines.length ? `${tap} ONE TO OPEN` : "NOTHING IN PROGRESS", r.x + 4, r.y + r.h - 7, "#7a7a86", 1, null);
  }

  /** The done board's list: each project's done count this week, tap a row for its desk. */
  private drawBoardPanel(): void {
    const sim = this.sim;
    const b = sim.boardPanel;
    if (!b) return;
    const r = b.rect;
    this.rect(r.x + 2, r.y + 2, r.w, r.h, INK, 0.45);
    this.rect(r.x, r.y, r.w, r.h, "#f4f6fa");
    this.strokeRect(r.x, r.y, r.w, r.h, "#7d8496");
    this.text(b.title, r.x + 4, r.y + 3, "#3f7a36", 1, null);
    if (!b.rows.length) this.text("NOTHING YET", r.x + 4, r.y + 13, TEXT_DIM, 1, null);
    for (const row of b.rows) {
      const hovered = sim.hover?.rect === row.rect;
      if (hovered) this.rect(row.rect.x, row.rect.y, row.rect.w, row.rect.h, HOVER, 0.45);
      this.rect(row.rect.x + 2, row.rect.y + 2, 4, 4, row.accent);
      this.text(row.name, row.rect.x + 8, row.rect.y + 2, INK, 1, null);
      const n = `${row.n}`;
      this.text(n, row.rect.x + row.rect.w - textWidth(n) - 2, row.rect.y + 2, "#3f7a36", 1, null);
    }
  }

  private button(r: Rect, label: string, on = false): void {
    this.rect(r.x, r.y, r.w, r.h, on ? HOVER : BTN);
    this.text(label, r.x + Math.round((r.w - textWidth(label)) / 2), r.y + 2, on ? INK : TEXT, 1, null);
  }

  private drawHeader(): void {
    const sim = this.sim;
    const f = sim.frame;
    const y = f.top.y + 4;
    const focused = sim.focus !== null;
    let x = f.top.lx + 3;
    if (focused) {
      this.button(sim.backBtn, "< OFFICE");
      x = sim.backBtn.x + sim.backBtn.w + 5;
      for (const t of sim.tabBtns) this.button(t.rect, sim.tabLabel(t.tab), sim.tab === t.tab);
    }
    const arrows = focused ? sim.projects.length > 1 : sim.week || sim.floor.pageCount > 1;
    let right = arrows ? sim.prevBtn.x - 4 : f.top.rx - 3;
    if (focused && sim.tabBtns.length) right = sim.tabBtns[0].rect.x - 4;
    if (!focused) {
      // With page arrows showing, the toggle button reaches the clock's corner: sit left of it.
      if (arrows) right = sim.calBtn.x - 4;
      const clock = sim.clockText;
      right -= textWidth(clock);
      this.text(clock, right, y, TEXT_DIM, 1, null);
      right -= 6;
    }
    const title = focused ? sim.focused!.name : "THE WORKSPACE";
    const sub = focused ? "" : ` · ${sim.data.workspace}`;
    const room = Math.floor((right - x) / 4);
    if (focused) this.rect(x, y, 4, 5, sim.focused!.accent);
    const tx = focused ? x + 6 : x;
    this.text(clip(title, room - (focused ? 2 : 0)), tx, y, HOVER, 1, null);
    if (sub && room > title.length + 3) this.text(clip(sub, room - title.length), tx + textWidth(title) + 1, y, TEXT_DIM, 1, null);
    if (arrows) {
      this.button(sim.prevBtn, "<");
      this.button(sim.nextBtn, ">");
      const label = focused ? `${sim.focus! + 1}/${sim.projects.length}` : sim.week ? sim.weekLabel : `${sim.page + 1}/${sim.floor.pageCount}`;
      const mid = (sim.prevBtn.x + sim.prevBtn.w + sim.nextBtn.x) / 2;
      this.text(label, Math.round(mid - textWidth(label) / 2), sim.prevBtn.y + 2, TEXT_DIM, 1, null);
    }
    if (!focused) this.button(sim.calBtn, sim.week ? "OFFICE" : "WEEK", sim.week);
  }

  private drawFooter(): void {
    const sim = this.sim;
    const f = sim.frame;
    const y = f.bottom.y - 8;
    const max = Math.floor((f.bottom.rx - f.bottom.lx - 6) / 4);
    const text = sim.hover?.text ?? sim.hint;
    this.text(clip(text, max), f.bottom.lx + 3, y, sim.hover ? TEXT : TEXT_DIM, 1, null);
  }
}
