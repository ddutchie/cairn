/**
 * Cairn Stacker renderer — sky, parallax mountains, clouds, tower, falling debris.
 * Extends PixelPainter so Canvas2D and Skia render identical pixel art.
 */

import { clamp, lerpHex } from "../pixel/kinds";
import { INK, PixelPainter, type PixelBackend } from "../pixel/painter";
import { BAYER, fbm, hash2 } from "../pixel/terrain";
import type { StackerSim, StoneSpec } from "./sim";
import { SH, buildStonePixels } from "./sprites";

const SKY_STOPS: [number, string, string][] = [
  [0.0, "#3f8fd2", "#b9e3f2"],
  [0.3, "#4d6fb8", "#f6c48a"],
  [0.5, "#3b3a78", "#f08a5d"],
  [0.72, "#1c1d44", "#7a4a7a"],
  [1.0, "#070b1a", "#1d2550"],
];

function skyAt(f: number): [string, string] {
  f = clamp(f, 0, 1);
  let i = 0;
  while (i < SKY_STOPS.length - 2 && f > SKY_STOPS[i + 1][0]) i++;
  const [a, ta, ba] = SKY_STOPS[i];
  const [b, tb, bb] = SKY_STOPS[i + 1];
  const k = (f - a) / (b - a);
  return [lerpHex(ta, tb, k), lerpHex(ba, bb, k)];
}

function hexBytes(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class StackerRenderer<Img = unknown, Frame = unknown> extends PixelPainter<Img, Frame> {
  private readonly sim: StackerSim;
  private readonly sprites = new Map<number, Img>();
  private readonly stars: { x: number; y: number; twOff: number; b: string; thr: number }[];

  private skyF = -1;
  private skyImg: Img | null = null;
  private groundImg: Img | null = null;
  private hillImgs: Img[] = [];
  private hillAmps: number[] = [];
  private hillOffsets: number[] = [];
  private bakedW = -1;
  private bakedH = -1;

  constructor(backend: PixelBackend<Img, Frame>, sim: StackerSim) {
    super(backend, sim.W, sim.H);
    this.sim = sim;
    this.stars = Array.from({ length: 70 }, (_, i) => ({
      x: (hash2(i, 1, 9) * sim.W) | 0,
      y: hash2(i, 2, 9) * sim.H * 1.4,
      twOff: i * 13,
      b: hash2(i, 4, 9) > 0.7 ? "#c7e4ff" : "#8b93b8",
      thr: hash2(i, 3, 9),
    }));
    this.bakeTerrain();
  }

  override resize(width: number, height: number): void {
    this.sim.resize(width, height);
    super.resize(width, height);
    if (this.bakedW !== this.sim.W || this.bakedH !== this.sim.H) {
      this.skyF = -1;
      this.skyImg = null;
      this.bakeTerrain();
    }
  }

  private spriteImg(spec: StoneSpec): Img {
    let img = this.sprites.get(spec.id);
    if (!img) {
      const { w, h, pixels } = buildStonePixels(spec.w0, spec.kind, spec.label, spec.seed);
      img = this.makeImage(w, h, pixels);
      this.sprites.set(spec.id, img);
      if (this.sprites.size > 48) {
        const oldest = this.sprites.keys().next().value;
        if (oldest !== undefined) this.sprites.delete(oldest);
      }
    }
    return img;
  }

  private bakeTerrain(): void {
    const W = this.sim.W;
    const H = this.sim.H;
    this.bakedW = W;
    this.bakedH = H;

    // Ground strip under the cairn.
    const gh = Math.max(46, H - this.sim.ground);
    const gpx = new Uint8Array(W * gh * 4);
    for (let d = 0; d < gh; d++) {
      for (let x = 0; x < W; x++) {
        let c =
          d < 2
            ? "#7cc46a"
            : d < 4
              ? BAYER[(d & 3) * 4 + (x & 3)] > 0.5
                ? "#5a9a4c"
                : "#4d8a42"
              : d < 6
                ? "#5a4433"
                : "#4a3729";
        if (d >= 6 && hash2(x, d, 4) < 0.05) c = "#6b5440";
        const [r, g, b] = hexBytes(c);
        const i = (d * W + x) * 4;
        gpx[i] = r;
        gpx[i + 1] = g;
        gpx[i + 2] = b;
        gpx[i + 3] = 255;
      }
    }
    this.groundImg = this.makeImage(W, gh, gpx);

    // Three parallax mountain silhouettes filled down to the ground.
    const specs: [number, number, number, string][] = [
      [70, 0.018, 21, "#3d5a74"],
      [46, 0.03, 22, "#2f5b4f"],
      [26, 0.05, 23, "#3f7a36"],
    ];
    this.hillImgs = [];
    this.hillAmps = [];
    this.hillOffsets = [];
    for (const [amp, freq, seed, col] of specs) {
      const h = amp + H;
      const px = new Uint8Array(W * h * 4);
      const [r, g, b] = hexBytes(col);
      for (let x = 0; x < W; x++) {
        const y0 = amp - Math.round(fbm(x * freq, 3.3, seed) * amp);
        for (let y = y0; y < h; y++) {
          const i = (y * W + x) * 4;
          px[i] = r;
          px[i + 1] = g;
          px[i + 2] = b;
          px[i + 3] = 255;
        }
      }
      this.hillImgs.push(this.makeImage(W, h, px));
      this.hillAmps.push(amp);
    }
    this.hillOffsets = [H - 90, H - 64, H - 46];
  }

  private drawSky(f: number): void {
    const q = Math.round(clamp(f, 0, 1) * 40) / 40;
    const W = this.sim.W;
    const H = this.sim.H;
    if (!this.skyImg || q !== this.skyF) {
      this.skyF = q;
      const [top, bot] = skyAt(q);
      const steps = 7;
      const cols: [number, number, number][] = [];
      for (let i = 0; i <= steps; i++) cols.push(hexBytes(lerpHex(top, bot, i / steps)));
      const px = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) {
        const qy = (y / H) * steps;
        const lo = qy | 0;
        const fr = qy - lo;
        for (let x = 0; x < W; x++) {
          const c = cols[fr > BAYER[(y & 3) * 4 + (x & 3)] ? Math.min(steps, lo + 1) : lo];
          const i = (y * W + x) * 4;
          px[i] = c[0];
          px[i + 1] = c[1];
          px[i + 2] = c[2];
          px[i + 3] = 255;
        }
      }
      this.skyImg = this.makeImage(W, H, px);
    }
    this.image(this.skyImg, 0, 0);

    const sa = clamp((f - 0.55) / 0.3, 0, 1);
    if (sa > 0) {
      for (const st of this.stars) {
        const y = (st.y + this.sim.cam * 0.08) % (H * 1.4);
        if (y >= H || st.thr > sa) continue;
        const tw = (this.sim.t + st.twOff) % 90 < 6;
        this.px(st.x % W, y, tw ? "#ffffff" : st.b);
      }
    }
    const sy = 40 + f * 330 + this.sim.cam * 0.02;
    if (sy < H) {
      this.circle(Math.round(W * 0.73), Math.round(sy), 9, "#ffd36b");
      this.circle(Math.round(W * 0.73), Math.round(sy), 7, "#fff2a0");
    }
    const my = 300 - (f - 0.6) * 520;
    if (f > 0.6 && my > -20) {
      this.circle(Math.round(W * 0.24), Math.round(my), 7, "#b8c2d6");
      this.circle(Math.round(W * 0.24), Math.round(my), 5, "#e8ecf5");
    }
  }

  private drawHills(): void {
    const pars = [0.18, 0.32, 0.55];
    for (let i = 0; i < this.hillImgs.length; i++) {
      const oy = Math.round(this.hillOffsets[i] + this.sim.cam * pars[i]);
      if (oy - this.hillAmps[i] > this.sim.H) continue;
      this.image(this.hillImgs[i], 0, oy - this.hillAmps[i]);
    }
    const gy = Math.round(this.sim.ground + this.sim.cam);
    if (gy < this.sim.H && this.groundImg) {
      this.image(this.groundImg, 0, gy);
      for (let i = 0; i < 26; i++) {
        const x = (hash2(i, 5, 2) * this.sim.W) | 0;
        this.px(x, gy - 1, "#9fe08a");
        if (i % 3 === 0) this.px(x + 1, gy - 2, "#9fe08a");
      }
    }
  }

  private drawStone(sx: number, w: number, spec: StoneSpec, x: number, y: number, cut: "left" | "right" | null): void {
    const img = this.spriteImg(spec);
    this.imageRect(img, sx, 0, w, SH, Math.round(x) + this.SX, Math.round(y) + this.SY, w, SH);
    if (cut) {
      this.rect(Math.round(cut === "left" ? x : x + w - 1) + this.SX, Math.round(y) + this.SY, 1, SH, INK);
    }
  }

  draw(): Frame {
    const s = this.sim;
    const f = s.cam / (SH * 70);
    this.SX = this.SY = 0;
    this.drawSky(f);
    this.drawHills();
    this.SX = s.shake > 0 ? Math.round((s.rand() * 2 - 1) * s.shake) : 0;
    this.SY = s.shake > 0 ? Math.round((s.rand() * 2 - 1) * s.shake * 0.5) : 0;

    if (s.state === "title") {
      s.demo.forEach((d, i) => {
        const sway = i === s.demo.length - 1 ? Math.round(Math.sin(s.t * 0.05) * 3) : 0;
        this.image(this.spriteImg(d.spec), Math.round((s.W - d.spec.w0) / 2) + sway + d.xOff, s.ground - (i + 1) * SH);
      });
      this.band(s.hud.top + 64, 52, 0.45);
      this.textC("CAIRN", s.W / 2, s.hud.top + 70, "#fff2a0", 4);
      this.textC("STACKER", s.W / 2, s.hud.top + 94, "#ffffff", 2);
      if ((s.t >> 5) & 1) {
        const prompt = s.inputMode === "pointer" ? "CLICK OR SPACE TO STACK" : "TAP TO STACK";
        this.textC(prompt, s.W / 2, s.hud.top + 154, "#ffffff");
      }
      this.textC(`BEST ${s.best}`, s.W / 2, s.hud.top + 168, "#c7d0e6");
      return this.snapshot();
    }

    for (let i = 0; i < s.tower.length; i++) {
      const st = s.tower[i];
      const y = s.levelY(st.lvl);
      if (y > s.H || y < -SH) continue;
      const sq = i === s.tower.length - 1 && s.squash > 0 ? 1 : 0;
      this.drawStone(st.sx, st.w, st.sprite, st.x, y + sq, st.cut);
    }

    if (s.mover) {
      const top = s.tower[s.tower.length - 1];
      const y = s.levelY(s.mover.lvl);
      const l = Math.max(s.mover.x, top.x);
      const r = Math.min(s.mover.x + s.mover.w, top.x + top.w);
      if (r > l) this.rect(Math.round(l), Math.round(y) + SH + 1, Math.round(r - l), 2, INK, 0.25);
      const bob = Math.round(Math.sin(s.t * 0.12) * 0.6);
      this.drawStone(s.mover.sx, s.mover.w, s.mover.sprite, s.mover.x, y + bob - 1, null);
    }

    for (const d of s.debris) {
      const img = this.spriteImg(d.sprite);
      this.sprite(img, d.sx, 0, d.w, SH, d.x, d.y, d.a);
    }
    for (const r of s.rings) {
      this.strokeRect(Math.round(r.x - r.t), Math.round(r.y - r.t * 0.5), Math.round(r.w + r.t * 2), SH + r.t, "#fff2a0", 1 - r.t / 16);
    }
    for (const p of s.parts) this.px(p.x, p.y, p.c);
    if (s.pop && (s.pop.t <= 40 || !(s.pop.t & 2))) {
      this.textIn(s.pop.s, s.pop.x, Math.round(s.pop.y - Math.min(s.pop.t, 20) * 0.6), "#fff2a0");
    }

    this.SX = this.SY = 0;
    const scoreY = Math.max(14, s.hud.top + 8);
    this.textC(String(s.score), s.W / 2, scoreY, "#ffffff", 3);
    this.textC(`BEST ${s.best}`, s.W / 2, scoreY + 20, s.newBest ? "#fff2a0" : "#c7d0e6");
    if (s.state === "over") {
      const oy = Math.round(s.H * 0.37);
      this.band(oy - 8, 64, 0.6);
      this.textC("TOPPLED", s.W / 2, oy, "#ef5a24", 3);
      this.textC(s.score === 1 ? "1 STONE" : `${s.score} STONES`, s.W / 2, oy + 24, "#ffffff");
      if (s.newBest) this.textC("NEW BEST!", s.W / 2, oy + 34, "#fff2a0");
      if (s.stateT > 40 && (s.t >> 5) & 1) {
        this.textC(s.inputMode === "pointer" ? "CLICK TO RETRY" : "TAP TO RETRY", s.W / 2, oy + 44, "#c7d0e6");
      }
    }
    return this.snapshot();
  }
}
