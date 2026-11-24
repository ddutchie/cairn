/**
 * Stacker renderer. The backdrop climbs with the tower: a dithered sky that
 * walks from day through sunset to a starry night (re-baked only when the
 * altitude moves a step), a sinking sun and a rising moon, three hazy hill
 * ranges and drifting clouds at their own parallax, and the grassy ground
 * under the cairn. Stones are their carved sprites, sliced where they were cut.
 */

import type { SkCanvas, SkImage } from "@shopify/react-native-skia";
import { lerpHex, type EntityKind } from "@/games/pixel/kinds";
import { makeCloud } from "@/games/pixel/models";
import { INK, PixelPainter, makeImage } from "@/games/pixel/painter";
import { BAYER, hash2, mulberry32, rgb } from "@/games/pixel/terrain";
import { SH, type StackerSim, type StoneSprite } from "./sim";
import { stoneSprite } from "./sprites";

/** Sky stops: altitude, zenith colour, horizon colour. */
const SKY: [number, string, string][] = [
  [0.0, "#3f8fd2", "#b9e3f2"],
  [0.3, "#4d6fb8", "#f6c48a"],
  [0.5, "#3b3a78", "#f08a5d"],
  [0.72, "#1c1d44", "#7a4a7a"],
  [1.0, "#070b1a", "#1d2550"],
];
const SKY_STEPS = 48;

function skyAt(f: number): [string, string] {
  let i = 0;
  while (i < SKY.length - 2 && f > SKY[i + 1][0]) i++;
  const [a, ta, ba] = SKY[i], [b, tb, bb] = SKY[i + 1], k = Math.min(1, Math.max(0, (f - a) / (b - a)));
  return [lerpHex(ta, tb, k), lerpHex(ba, bb, k)];
}

/** Smooth 1D value noise, two octaves. */
function ridge(x: number, s: number): number {
  let v = 0, amp = 0.65, f = 1;
  for (let o = 0; o < 2; o++, amp *= 0.35, f *= 2.3) {
    const xi = Math.floor(x * f), t = x * f - xi, u = t * t * (3 - 2 * t);
    v += amp * (hash2(xi, o, s) + (hash2(xi + 1, o, s) - hash2(xi, o, s)) * u);
  }
  return v;
}

interface Hills {
  mask: SkImage;
  amp: number;
  par: number;
  base: number;
  color: string;
  haze: number;
}

export class StackerRenderer extends PixelPainter {
  private readonly sim: StackerSim;
  private skyImg: SkImage | null = null;
  private skyQ = -1;
  private readonly ground: SkImage;
  private readonly hills: Hills[];
  private readonly sun: SkImage;
  private readonly moon: SkImage;
  private readonly clouds: { img: SkImage; x: number; y: number; v: number }[];
  private readonly stones = new Map<number, SkImage>();
  private readonly demo: { sprite: StoneSprite; img: SkImage }[];
  private readonly fx = mulberry32(5);

  constructor(sim: StackerSim) {
    super(sim.W, sim.H);
    this.sim = sim;
    const W = this.W, H = this.H;
    this.hills = [
      { amp: 70, par: 0.18, base: H - 90, freq: 0.018, s: 21, color: "#3d5a74", haze: 0.55 },
      { amp: 46, par: 0.32, base: H - 64, freq: 0.03, s: 22, color: "#2f5b4f", haze: 0.35 },
      { amp: 26, par: 0.55, base: H - 46, freq: 0.05, s: 23, color: "#3f7a36", haze: 0.12 },
    ].map(({ amp, freq, s, ...rest }) => {
      const px = new Uint8Array(W * amp * 4);
      for (let x = 0; x < W; x++) {
        const top = Math.round(amp - ridge(x * freq, s) * amp);
        for (let y = Math.max(0, top); y < amp; y++) px.fill(255, (y * W + x) * 4, (y * W + x) * 4 + 4);
      }
      return { mask: makeImage(W, amp, px), amp, ...rest };
    });
    this.ground = this.bakeGround();
    this.sun = this.disc(9, "#fff2a0", "#ffd36b");
    this.moon = this.disc(7, "#e8ecf5", "#b8c2d6");
    const rand = mulberry32(31);
    this.clouds = Array.from({ length: 7 }, (_, i) => {
      const c = makeCloud(rand);
      return { img: makeImage(c.w, c.h, c.pixels), x: rand() * (W + 60) - 30, y: -i * 140 + Math.round(H * 0.38), v: 0.08 + rand() * 0.12 };
    });
    const demo: [string, EntityKind, number][] = [
      ["Workspace", "project", sim.baseW],
      ["Release checklist", "note", sim.baseW - 12],
      ["Fix sync conflict", "card", sim.baseW - 20],
      ["urgent", "tag", sim.baseW - 34],
      ["Cairn Mobile", "project", sim.baseW - 46],
    ];
    this.demo = demo.map(([label, kind, w], i) => {
      const sprite = { id: -1 - i, w0: w, kind, label, seed: i * 7 + 3 };
      return { sprite, img: makeImage(w, SH, stoneSprite(w, kind, label, sprite.seed)) };
    });
  }

  // ── Bakes ──────────────────────────────────────────────────────────────────
  private disc(r: number, c: string, edge: string): SkImage {
    const n = r * 2 + 1, px = new Uint8Array(n * n * 4), C = rgb(c), E = rgb(edge);
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        const d = x * x + y * y;
        if (d > r * r) continue;
        const col = d > (r - 1.5) * (r - 1.5) ? E : C, i = ((y + r) * n + x + r) * 4;
        px.set([col[0], col[1], col[2], 255], i);
      }
    return makeImage(n, n, px);
  }
  /** Grass lip, dithered turf, soil with pebbles; tall enough to fill below the ground at camera 0. */
  private bakeGround(): SkImage {
    const W = this.W, h = this.H - this.sim.ground + 2, px = new Uint8Array(W * h * 4);
    const g1 = rgb("#7cc46a"), g2 = rgb("#5a9a4c"), g3 = rgb("#4d8a42"), s1 = rgb("#5a4433"), s2 = rgb("#4a3729"), peb = rgb("#6b5440");
    for (let y = 0; y < h; y++)
      for (let x = 0; x < W; x++) {
        const c = y < 2 ? g1 : y < 4 ? (BAYER[(y & 3) * 4 + (x & 3)] > 0.5 ? g2 : g3) : y < 6 ? s1 : hash2(x, y, 4) < 0.05 ? peb : s2;
        px.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
      }
    return makeImage(W, h, px);
  }
  private bakeSky(f: number): SkImage {
    const W = this.W, H = this.H, [top, bot] = skyAt(f), steps = 7;
    const cols = Array.from({ length: steps + 1 }, (_, i) => rgb(lerpHex(top, bot, i / steps)));
    const px = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      const q = (y / H) * steps, lo = q | 0, fr = q - lo, row = (y & 3) * 4;
      for (let x = 0; x < W; x++) {
        const c = cols[fr > BAYER[row + (x & 3)] ? Math.min(steps, lo + 1) : lo], i = (y * W + x) * 4;
        px[i] = c[0];
        px[i + 1] = c[1];
        px[i + 2] = c[2];
        px[i + 3] = 255;
      }
    }
    return makeImage(W, H, px);
  }

  // ── Backdrop ───────────────────────────────────────────────────────────────
  private backdrop(cv: SkCanvas): void {
    const sim = this.sim, W = this.W, H = this.H, f = sim.altitude, cam = sim.cam, t = sim.t;
    const q = Math.round(f * SKY_STEPS);
    if (q !== this.skyQ || !this.skyImg) {
      this.skyImg = this.bakeSky(q / SKY_STEPS);
      this.skyQ = q;
    }
    cv.drawImage(this.skyImg, 0, 0);

    // Stars fade in after dusk and drift slowly with the climb.
    const sa = Math.min(1, Math.max(0, (f - 0.55) / 0.3));
    if (sa > 0)
      for (let i = 0; i < 70; i++) {
        if (hash2(i, 3, 9) > sa) continue;
        const x = (hash2(i, 1, 9) * W) | 0, y = ((hash2(i, 2, 9) * H * 1.4 + cam * 0.08) % (H * 1.4)) | 0;
        if (y >= H) continue;
        const twinkle = (t + i * 13) % 90 < 6;
        this.rect(cv, x, y, 1, 1, twinkle ? "#ffffff" : hash2(i, 4, 9) > 0.7 ? "#c7e4ff" : "#8b93b8");
      }
    // The sun sinks as you climb; the moon rises after.
    const sy = Math.round(this.sim.hud.top + 30 + f * (H + 10) + cam * 0.02);
    if (sy < H) cv.drawImage(this.sun, Math.round(W * 0.73) - 9, sy - 9);
    const my = Math.round(H - 20 - (f - 0.6) * (H * 1.6));
    if (f > 0.6 && my > -20) cv.drawImage(this.moon, Math.round(W * 0.24) - 7, my - 7);

    // Clouds thin out at night.
    const ca = 0.85 - Math.min(0.5, Math.max(0, f - 0.6));
    const cloudPaint = this.paint("#000000", ca);
    for (const c of this.clouds) {
      const x = ((c.x + t * c.v) % (W + 80)) - 40, y = c.y + cam * 0.45;
      if (y < -60 || y > H) continue;
      cv.drawImage(c.img, Math.round(x), Math.round(y), cloudPaint);
    }

    const bot = skyAt(q / SKY_STEPS)[1];
    for (const h of this.hills) {
      const y = Math.round(h.base + cam * h.par);
      if (y >= H) continue;
      const col = lerpHex(h.color, bot, h.haze);
      cv.drawImage(h.mask, 0, y, this.tint(col));
      if (y + h.amp < H) this.rect(cv, 0, y + h.amp, W, H - y - h.amp, col);
    }
    const gy = Math.round(sim.ground + cam);
    if (gy < H) {
      cv.drawImage(this.ground, 0, gy);
      for (let i = 0; i < 26; i++) {
        const x = (hash2(i, 5, 2) * W) | 0;
        this.rect(cv, x, gy - 1, 1, 1, "#9fe08a");
        if (i % 3 === 0) this.rect(cv, x + 1, gy - 2, 1, 1, "#9fe08a");
      }
    }
  }

  // ── Stones ─────────────────────────────────────────────────────────────────
  private stoneImage(s: StoneSprite, used: Set<number>): SkImage {
    used.add(s.id);
    let img = this.stones.get(s.id);
    if (!img) {
      img = makeImage(s.w0, SH, stoneSprite(s.w0, s.kind, s.label, s.seed));
      this.stones.set(s.id, img);
    }
    return img;
  }
  /** A slice of a stone with its left edge at `x`, top at `y`; a cut edge gets a fresh outline. */
  private stone(cv: SkCanvas, img: SkImage, sx: number, w: number, cut: "left" | "right" | null, x: number, y: number): void {
    if (w <= 0) return;
    this.sprite(cv, img, sx, 0, w, SH, x + w / 2, y + SH / 2);
    if (cut) this.rect(cv, Math.round(x) + this.SX + (cut === "left" ? 0 : w - 1), Math.round(y) + this.SY, 1, SH, INK);
  }

  // ── Frame ──────────────────────────────────────────────────────────────────
  draw(): SkImage {
    const sim = this.sim, cv = this.canvas();
    this.SX = this.SY = 0;
    this.backdrop(cv);
    const sh = sim.shake;
    this.SX = sh > 0 ? Math.round((this.fx() * 2 - 1) * sh) : 0;
    this.SY = sh > 0 ? Math.round((this.fx() * 2 - 1) * sh * 0.5) : 0;

    if (sim.state === "title") {
      this.drawTitle(cv);
      return this.snapshot();
    }
    const used = new Set<number>();
    sim.tower.forEach((s, i) => {
      const y = sim.levelY(s.lvl);
      if (y > this.H || y < -SH) return;
      const sq = i === sim.tower.length - 1 && sim.squash > 0 ? 1 : 0;
      this.stone(cv, this.stoneImage(s.sprite, used), s.sx, s.w, s.cut, s.x, y + sq);
    });
    const m = sim.mover;
    if (m) {
      const top = sim.top, y = sim.levelY(m.lvl);
      const l = Math.max(m.x, top.x), r = Math.min(m.x + m.w, top.x + top.w);
      if (r > l) this.rect(cv, Math.round(l), Math.round(y) + SH + 1, Math.round(r - l), 2, INK, 0.25);
      const bob = Math.round(Math.sin(sim.t * 0.12) * 0.6);
      this.stone(cv, this.stoneImage(m.sprite, used), m.sx, m.w, null, m.x, y + bob - 1);
    }
    for (const d of sim.debris)
      this.sprite(cv, this.stoneImage(d.sprite, used), d.sx, 0, d.w, SH, d.x, d.y, d.a);
    for (const id of this.stones.keys()) if (!used.has(id)) this.stones.delete(id);

    for (const r of sim.rings) {
      const g = r.t, a = 1 - g / 16, x = Math.round(r.x - g), y = Math.round(r.y - g * 0.5), w = Math.round(r.w + g * 2), h = SH + g;
      this.rect(cv, x, y, w, 1, "#fff2a0", a);
      this.rect(cv, x, y + h - 1, w, 1, "#fff2a0", a);
      this.rect(cv, x, y, 1, h, "#fff2a0", a);
      this.rect(cv, x + w - 1, y, 1, h, "#fff2a0", a);
    }
    for (const p of sim.parts) this.px(cv, p.x, p.y, p.c);
    if (sim.pop && !(sim.pop.t > 40 && sim.pop.t & 2))
      this.textIn(cv, sim.pop.s, sim.pop.x, Math.round(sim.pop.y - Math.min(sim.pop.t, 20) * 0.6), "#fff2a0");

    this.SX = this.SY = 0;
    const cx = this.centreX(), top = sim.hud.top + 4;
    this.textC(cv, String(sim.score), cx, top, "#ffffff", 3);
    this.textC(cv, `BEST ${sim.best}`, cx, top + 20, sim.newBest ? "#fff2a0" : "#c7d0e6");
    if (sim.state === "over") this.drawOver(cv);
    return this.snapshot();
  }

  /** Centre of the playfield between the side insets (the Duo's rail). */
  private centreX(): number {
    return (this.sim.hud.left + this.W - this.sim.hud.right) / 2;
  }

  private drawTitle(cv: SkCanvas): void {
    const sim = this.sim, t = sim.t, cx = this.centreX();
    this.demo.forEach(({ sprite, img }, i) => {
      const sway = i === this.demo.length - 1 ? Math.round(Math.sin(t * 0.05) * 3) : 0;
      this.stone(cv, img, 0, sprite.w0, null, Math.round(cx - sprite.w0 / 2) + sway + (i % 2 ? 2 : -1), sim.ground - (i + 1) * SH);
    });
    const ty = Math.max(sim.hud.top + 24, Math.round(this.H * 0.22));
    this.band(cv, ty - 6, 52, 0.45);
    this.textC(cv, "CAIRN", cx, ty, "#fff2a0", 4);
    this.textC(cv, "STACKER", cx, ty + 24, "#ffffff", 2);
    if ((t >> 5) & 1) this.textC(cv, "TAP TO STACK", cx, ty + 84, "#ffffff");
    this.textC(cv, `BEST ${sim.best}`, cx, ty + 98, "#c7d0e6");
    this.textC(cv, "LINE UP PERFECT DROPS", cx, ty + 120, "#c7d0e6");
  }

  private drawOver(cv: SkCanvas): void {
    const sim = this.sim, cx = this.centreX(), y = Math.round(this.H * 0.37);
    this.band(cv, y, 64, 0.6);
    this.textC(cv, "TOPPLED", cx, y + 8, "#ef5a24", 3);
    this.textC(cv, `${sim.score} ${sim.score === 1 ? "STONE" : "STONES"}`, cx, y + 32, "#ffffff");
    if (sim.newBest) this.textC(cv, "NEW BEST!", cx, y + 42, "#fff2a0");
    if (sim.stateT > 40 && (sim.t >> 5) & 1) this.textC(cv, "TAP TO RETRY", cx, y + 52, "#c7d0e6");
  }
}
