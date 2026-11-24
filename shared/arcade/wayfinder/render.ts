/**
 * Wayfinder shared renderer — extends PixelPainter for Canvas2D and Skia parity.
 *
 * Uses baked storm sprites, cached half-resolution bilinear-dithered fog,
 * animated sea life (schools, dolphins, turtles, whales, kraken), crew casting
 * and swimming, compass navigation pointers, mini-chart overlay, and Ship's Log.
 */

import type { Priority } from "../../types/domain";
import { textWidth } from "../pixel/font";
import { clamp } from "../pixel/kinds";
import { INK, PixelPainter, type AtlasHandle, type PixelBackend } from "../pixel/painter";
import { BAYER, BIOMES, fbm, mulberry32, rgb } from "../pixel/terrain";
import {
  BOAT_MODEL,
  CRATE_MODELS,
  DOLPHIN_MODEL,
  KRAKEN_SEGS,
  LIGHTHOUSE_MODEL,
  PCOL,
  TURTLE_MODEL,
  WHALE_MODEL,
  hutModel,
} from "./models";
import { DAY_FRAMES, FH, FOG_TEX, FW, HD, WD, WayfinderSim, type Isle } from "./sim";

const STORM_R = 22;
const STORM_SZ = STORM_R * 2 + 1;

function bakeStormBytes(flash: boolean): Uint8Array {
  const bytes = new Uint8Array(STORM_SZ * STORM_SZ * 4);
  const buf = new Uint32Array(bytes.buffer);
  const pack = (hex: string) => {
    const [r, g, b] = rgb(hex);
    return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  };
  const lit = pack("#c7d0e6");
  const mid = pack("#5a6078");
  const dark = pack("#3a3f55");
  for (let y = -STORM_R; y <= STORM_R; y++) {
    for (let x = -STORM_R; x <= STORM_R; x++) {
      const d = (x * x + y * y) / (STORM_R * STORM_R);
      const n = fbm((x + STORM_R) * 0.08, (y + STORM_R) * 0.08, 7);
      if (d < 1 && n * (1.2 - d) > 0.42 + BAYER[((y + 64) & 3) * 4 + ((x + 64) & 3)] * 0.12) {
        buf[(y + STORM_R) * STORM_SZ + (x + STORM_R)] = flash ? lit : n > 0.62 ? mid : dark;
      }
    }
  }
  return bytes;
}

export class WayfinderRenderer<Img = unknown, Frame = unknown> extends PixelPainter<Img, Frame> {
  private readonly sim: WayfinderSim;
  private readonly world: Img;
  private readonly stormImg: Img;
  private readonly stormFlashImg: Img;
  private readonly boat: AtlasHandle<Img>;
  private readonly lighthouse: AtlasHandle<Img>;
  private readonly whale: AtlasHandle<Img>;
  private readonly dolphin: AtlasHandle<Img>;
  private readonly turtle: AtlasHandle<Img>;
  private readonly segs: AtlasHandle<Img>[];
  private readonly crates: Record<Priority, AtlasHandle<Img>>;
  private readonly huts: AtlasHandle<Img>[];

  private fogW = 0;
  private fogH = 0;
  private fogBytes = new Uint8Array(0);
  private fogBuf = new Uint32Array(0);
  private fogImg: Img | null = null;
  private fogCamX = 0;
  private fogCamY = 0;
  private fogVer = -1;
  private fogTick = -1;
  private mini: Img | null = null;
  private miniBuiltState: string | null = null;
  private readonly fx = mulberry32(404);

  constructor(backend: PixelBackend<Img, Frame>, sim: WayfinderSim) {
    super(backend, sim.W, sim.H);
    this.sim = sim;
    this.world = this.makeImage(WD, HD, sim.worldPixels);
    this.stormImg = this.makeImage(STORM_SZ, STORM_SZ, bakeStormBytes(false));
    this.stormFlashImg = this.makeImage(STORM_SZ, STORM_SZ, bakeStormBytes(true));
    this.boat = this.makeAtlas(BOAT_MODEL);
    this.lighthouse = this.makeAtlas(LIGHTHOUSE_MODEL);
    this.whale = this.makeAtlas(WHALE_MODEL);
    this.dolphin = this.makeAtlas(DOLPHIN_MODEL);
    this.turtle = this.makeAtlas(TURTLE_MODEL);
    this.segs = KRAKEN_SEGS.map((m) => this.makeAtlas(m));
    this.crates = {
      low: this.makeAtlas(CRATE_MODELS.low),
      medium: this.makeAtlas(CRATE_MODELS.medium),
      high: this.makeAtlas(CRATE_MODELS.high),
      urgent: this.makeAtlas(CRATE_MODELS.urgent),
    };
    this.huts = sim.harbours.map((h) => this.makeAtlas(hutModel(h.p!.accent)));
    this.allocFog(sim.W, sim.H);
  }

  private allocFog(w: number, h: number): void {
    this.fogW = Math.ceil(w / 2) + 8;
    this.fogH = Math.ceil(h / 2) + 8;
    this.fogBytes = new Uint8Array(this.fogW * this.fogH * 4);
    this.fogBuf = new Uint32Array(this.fogBytes.buffer);
    this.fogImg = null;
    this.fogVer = -1;
  }

  override resize(width: number, height: number): void {
    this.sim.resize(width, height);
    super.resize(width, height);
    this.allocFog(width, height);
  }

  private sx = (x: number) => x - this.sim.camX;
  private sy = (y: number) => y - this.sim.camY;
  private rng(a: number, b: number): number {
    return a + this.fx() * (b - a);
  }

  private dolphinAt(i: number) {
    const s = this.sim, b = s.boat, t = s.t;
    const lag = 6 + i * 7, side = (i % 2 ? 1 : -1) * (7 + i * 2) + Math.sin(t * 0.03 + i) * 2, away = (1 - s.pod.on) * 40;
    const x = b.x + Math.sin(b.a) * (4 - lag) + Math.cos(b.a) * (side + Math.sign(side) * away);
    const y = b.y - Math.cos(b.a) * (4 - lag) + Math.sin(b.a) * (side + Math.sign(side) * away);
    const ph = (t * 0.06 + i * 2.1) % (Math.PI * 2), jump = ph < Math.PI ? Math.sin(ph) * 6 : 0;
    return { x, y, jump, ph };
  }

  private drawFog(): void {
    const s = this.sim, W = this.W, H = this.H, FOG = s.fog;
    const outOfBounds =
      s.camX < this.fogCamX ||
      s.camY < this.fogCamY ||
      s.camX + W > this.fogCamX + this.fogW * 2 ||
      s.camY + H > this.fogCamY + this.fogH * 2;
    const driftTick = s.t >> 3;
    const needRebuild =
      !this.fogImg ||
      outOfBounds ||
      driftTick !== this.fogTick ||
      (s.fogVersion !== this.fogVer && (s.t & 3) === 0);

    if (needRebuild) {
      this.fogCamX = Math.floor(s.camX / 2) * 2 - 8;
      this.fogCamY = Math.floor(s.camY / 2) * 2 - 8;
      this.fogVer = s.fogVersion;
      this.fogTick = driftTick;
      const g = (c: number, r: number) => FOG[clamp(r, 0, FH - 1) * FW + clamp(c, 0, FW - 1)];
      for (let y = 0; y < this.fogH; y++) {
        const wy = y * 2 + this.fogCamY;
        const fy = wy / 8 - 0.5, cy = Math.floor(fy), ay = fy - cy;
        const bRow = (y & 3) * 4;
        const tRow = ((wy + driftTick) & 63) * 64;
        for (let x = 0; x < this.fogW; x++) {
          const wx = x * 2 + this.fogCamX;
          const fx = wx / 8 - 0.5, cx = Math.floor(fx), ax = fx - cx;
          const v = (g(cx, cy) * (1 - ax) + g(cx + 1, cy) * ax) * (1 - ay) + (g(cx, cy + 1) * (1 - ax) + g(cx + 1, cy + 1) * ax) * ay;
          this.fogBuf[y * this.fogW + x] = v > BAYER[bRow + (x & 3)] ? 0 : FOG_TEX[tRow + ((wx + (s.t >> 4)) & 63)];
        }
      }
      this.fogImg = this.makeImage(this.fogW, this.fogH, this.fogBytes);
    }

    if (this.fogImg) {
      this.imageRect(this.fogImg, 0, 0, this.fogW, this.fogH, this.fogCamX - s.camX, this.fogCamY - s.camY, this.fogW * 2, this.fogH * 2);
    }
  }

  private ensureChart(): Img {
    const s = this.sim;
    if (this.mini && this.miniBuiltState === s.state) return this.mini;
    const bytes = new Uint8Array(s.worldPixels);
    const d = new Uint32Array(bytes.buffer);
    for (let y = 0; y < HD; y++) {
      for (let x = 0; x < WD; x++) {
        if (s.fog[((y / 8) | 0) * FW + ((x / 8) | 0)] < 0.5) d[y * WD + x] = FOG_TEX[(y & 63) * 64 + (x & 63)];
      }
    }
    this.mini = this.makeImage(WD, HD, bytes);
    this.miniBuiltState = s.state;
    return this.mini;
  }

  draw(): Frame {
    const s = this.sim, W = this.W, H = this.H, t = s.t;
    if (s.state !== "map" && s.state !== "log") this.miniBuiltState = null;

    this.SX = s.shake > 0 ? Math.round(this.rng(-s.shake, s.shake)) : 0;
    this.SY = s.shake > 0 ? Math.round(this.rng(-s.shake, s.shake)) : 0;
    this.clear(BIOMES.tropic.water[0]);
    this.image(this.world, -s.camX + this.SX, -s.camY + this.SY);

    for (let i = 0; i < 6; i++) {
      const x = (this.fx() * W) | 0, y = (this.fx() * H) | 0, wx = x + s.camX, wy = y + s.camY;
      if (wx >= 0 && wx < WD && wy >= 0 && wy < HD) {
        const o = wy * WD + wx;
        if (s.E[o] <= 0 && s.NEAR[o] > 0 && this.fx() < 0.4) this.px(x, y, "#e6f6ff");
      }
    }

    s.harbours.forEach((h, k) => {
      for (const [dx, dy] of [[-6, -2], [5, -4], [0, 5]]) {
        this.shadow(this.huts[k], this.sx(h.x + dx), this.sy(h.y + dy - h.lift), 0, 2, 3, 0.3);
        this.stack(this.huts[k], this.sx(h.x + dx), this.sy(h.y + dy - h.lift), 0);
      }
    });
    this.shadow(this.lighthouse, this.sx(s.today.x), this.sy(s.today.y - s.today.lift), 0, 5, 8, 0.3);
    this.stack(this.lighthouse, this.sx(s.today.x), this.sy(s.today.y - s.today.lift), 0);
    if ((t >> 4) & 1) {
      const bx = this.sx(s.today.x) + this.SX, by = this.sy(s.today.y - s.today.lift) - 13 + this.SY, a = t * 0.03;
      for (let i = 4; i < 26; i++) this.rect(Math.round(bx + Math.cos(a) * i), Math.round(by + Math.sin(a) * i * 0.5), 1, 1, "#fff2a0", 0.35);
    }
    s.crates.slice(0, 6).forEach((c, i) => {
      this.stack(this.crates[c.pr], this.sx(s.today.x - 22 + (i % 2) * 6), this.sy(s.today.y - s.today.lift - 4 + ((i / 2) | 0) * 6), 0);
    });

    this.drawSeaLifeUnder();
    this.drawKrakenUnder();
    for (const p of s.parts) if (p.wake) this.px(this.sx(p.x), this.sy(p.y), p.c, 1, Math.max(0, p.life / 34));

    const bx = this.sx(s.boat.x), by = this.sy(s.boat.y), bob = Math.sin(t * 0.08) * 0.6;
    this.shadow(this.boat, bx, by, s.boat.a, 2, 3, 0.3);
    this.stack(this.boat, bx, by + bob, s.boat.a);
    this.drawCrew(bob);
    s.boat.cargo.forEach((c, i) => {
      this.stack(this.crates[c.pr], bx + Math.sin(s.boat.a) * (1 - i * 2), by + bob - 4 - Math.cos(s.boat.a) * (1 - i * 2), s.boat.a, { k: 0.8 });
    });

    this.drawSeaLifeOver();
    this.drawKrakenOver();
    for (const p of s.parts) if (!p.wake) this.px(this.sx(p.x), this.sy(p.y), p.c);
    this.drawFog();

    for (const st of s.storms) {
      const cx = this.sx(st.x), cy = this.sy(st.y);
      if (cx < -40 || cx > W + 40 || cy < -40 || cy > H + 40) continue;
      this.image(st.bolt > 4 ? this.stormFlashImg : this.stormImg, Math.round(cx - STORM_R) + this.SX, Math.round(cy - STORM_R - 14) + this.SY);
      for (let i = 0; i < 10; i++) {
        const rx = cx + this.rng(-st.r, st.r) * 0.8, ry = cy - 6 + ((t * 3 + i * 23) % (st.r + 10));
        this.px(rx, ry, "#9fb3d6");
        this.px(rx - 1, ry + 1, "#9fb3d6");
      }
      if (st.bolt > 4) {
        let x = cx + 3, y = cy - 8;
        for (let i = 0; i < 9; i++) {
          this.px(x, y, "#ffffff");
          y += 2;
          x += i & 1 ? 1 : -1;
        }
      }
    }

    for (const is of s.all) {
      if (!is.charted || is.today) continue;
      const x = this.sx(is.x), y = this.sy(is.y - is.lift) - is.r - 6;
      if (x < -40 || x > W + 40 || y < 8 || y > H - 10) continue;
      const c = is.harbour ? is.p!.accent : is.orphan ? "#fff2a0" : "#e6eefc";
      this.textIn(PixelPainter.clip(is.title, 16), x, y, c);
    }
    this.textC("TODAY", this.sx(s.today.x), this.sy(s.today.y - s.today.lift) - 26, "#fff2a0");

    this.SX = this.SY = 0;
    if (s.state === "title") {
      this.renderTitle();
      return this.snapshot();
    }
    if (s.flash > 0) this.rect(0, 0, W, H, "#ffffff", s.flash / 20);
    this.renderHud();
    if (s.state === "log") this.renderLog();
    if (s.state === "map") this.renderMap();
    return this.snapshot();
  }

  private drawSeaLifeUnder(): void {
    const s = this.sim, t = s.t;
    for (const sc of s.schools) {
      const x0 = this.sx(sc.x), y0 = this.sy(sc.y);
      if (x0 < -10 || y0 < -10 || x0 > this.W + 10 || y0 > this.H + 10) continue;
      for (let k = 0; k < sc.n; k++) {
        const r = 3 + (k % 3) * 2, a = t * (sc.flee > 0 ? 0.02 : 0.05) + k * 2.4;
        const fx = x0 + Math.cos(a) * r - Math.sin(sc.a) * (k % 4), fy = y0 + Math.sin(a) * r * 0.7 + Math.cos(sc.a) * (k % 4);
        this.px(fx, fy, (t + k * 17) % 50 < 2 ? "#c7e4ff" : "#14336a");
      }
    }
    for (const w of s.whales) if (w.cyc >= 220) this.shadow(this.whale, this.sx(w.x), this.sy(w.y), w.a, 0, 0, 0.35);
    if (s.pod.on > 0) {
      for (let i = 0; i < 3; i++) {
        const d = this.dolphinAt(i);
        if (d.jump <= 0) this.shadow(this.dolphin, this.sx(d.x), this.sy(d.y), s.boat.a, 0, 0, 0.3 * s.pod.on);
        else this.shadow(this.dolphin, this.sx(d.x), this.sy(d.y), s.boat.a, 1, 2, 0.2 * s.pod.on);
      }
    }
  }

  private drawSeaLifeOver(): void {
    const s = this.sim, t = s.t;
    for (const tt of s.turtles) {
      this.shadow(this.turtle, this.sx(tt.x), this.sy(tt.y), tt.a, 1, 2, 0.3);
      this.stack(this.turtle, this.sx(tt.x), this.sy(tt.y), tt.a + Math.sin(t * 0.15) * 0.1);
    }
    for (const w of s.whales) {
      if (w.cyc < 220) {
        const rise = w.cyc < 20 ? w.cyc / 20 : w.cyc > 200 ? (220 - w.cyc) / 20 : 1;
        this.shadow(this.whale, this.sx(w.x), this.sy(w.y), w.a, 2, 3, 0.25);
        this.stack(this.whale, this.sx(w.x), this.sy(w.y) + Math.round((1 - rise) * 3), w.a, { lift: 0.5 + rise * 0.5 });
        if ((t >> 3) & 1) {
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * 6.283;
            this.px(this.sx(w.x) + Math.cos(a) * 9, this.sy(w.y) + Math.sin(a) * 12, "#9fd2ff");
          }
        }
      }
    }
    if (s.pod.on > 0) {
      for (let i = 0; i < 3; i++) {
        const d = this.dolphinAt(i);
        if (d.jump > 0) this.stack(this.dolphin, this.sx(d.x), this.sy(d.y) - Math.round(d.jump), s.boat.a);
      }
    }
  }

  private drawKrakenUnder(): void {
    const k = this.sim.kraken, t = this.sim.t;
    if (k.phase === "none") return;
    const grow = k.phase === "stir" ? Math.min(1, k.t / 60) : k.phase === "sink" ? Math.max(0, 1 - k.t / 60) : 1;
    const rx = 28 * grow, ry = 20 * grow, cx = this.sx(k.x), cy = this.sy(k.y);
    for (let y = -ry; y <= ry; y++) {
      for (let x = -rx; x <= rx; x++) {
        const d = (x * x) / (rx * rx || 1) + (y * y) / (ry * ry || 1);
        if (d < 1 && BAYER[(((y + 64) | 0) & 3) * 4 + (((x + 64) | 0) & 3)] < 0.75 - d * 0.5) this.px(cx + x, cy + y, "#0a1a3a");
      }
    }
    if (k.phase === "stir" && t % 6 === 0) this.px(cx, cy, "#9fd2ff", 1, 0.6);
  }

  private drawKrakenOver(): void {
    const k = this.sim.kraken, t = this.sim.t;
    if (k.phase !== "up" && k.phase !== "sink") return;
    k.arms.forEach((a, i) => {
      const ax = this.sx(k.x + Math.cos(a.a) * a.r), ay = this.sy(k.y + Math.sin(a.a) * a.r), n = Math.round(this.segs.length * 2 * a.h);
      for (let j = 0; j < 4; j++) {
        const q = (j / 4) * 6.283 + t * 0.1;
        this.px(ax + Math.cos(q) * 4, ay + Math.sin(q) * 3, "#e6f6ff");
      }
      for (let s = 0; s < n; s++) {
        const seg = this.segs[Math.min(this.segs.length - 1, s >> 1)], sway = Math.sin(t * 0.08 + i * 1.7 + s * 0.45) * s * 0.55;
        this.stack(seg, ax + sway, ay - s * 2, 0);
      }
    });
  }

  private sailor(x: number, y: number, shirt: string, lift: number): void {
    this.px(x, y - lift - 3, "#f0c8a0");
    this.px(x, y - lift - 4, "#5a3a22");
    this.px(x, y - lift - 2, shirt);
    this.px(x, y - lift - 1, "#2a2f3a");
  }

  private drawCrew(bob: number): void {
    const s = this.sim, crew = s.crew, t = s.t, lift = Math.round(3 - bob);
    const st = s.deckPoint(-1, 3);
    this.sailor(this.sx(st.x), this.sy(st.y), "#fff2a0", lift);
    const fw = s.deckPoint(1, -2);
    if (crew.swim === "deck") this.sailor(this.sx(fw.x), this.sy(fw.y), "#ffffff", lift + (crew.idle > 60 && crew.cast === 0 ? 1 : 0));
    const bw = s.deckPoint(-2, 0);
    if (crew.swim === "deck") this.sailor(this.sx(bw.x), this.sy(bw.y), "#ef5a24", lift);
    if (crew.cast > 0) {
      const dip = crew.bite > 0 && t & 2 ? 2 : 0, rod = s.deckPoint(-6, -1), end = s.lineEnd(), n = 10;
      this.line(this.sx(fw.x), this.sy(fw.y) - lift - 2, this.sx(rod.x), this.sy(rod.y) - lift - 4 + dip, "#8a5a32");
      for (let i = 1; i < n * crew.cast; i++) {
        const f = i / n, x = rod.x + (end.x - rod.x) * f, y = rod.y + (end.y - rod.y) * f - (lift + 4) * (1 - f) + Math.sin(f * Math.PI) * 2;
        this.px(this.sx(x), this.sy(y), "#d6dceb");
      }
      if (crew.cast >= 1) {
        const fy = Math.sin(t * 0.1) * 0.5 + dip;
        this.px(this.sx(end.x), this.sy(end.y) + fy, "#ff3d6e");
        this.px(this.sx(end.x), this.sy(end.y) + fy - 1, "#ffffff");
      }
    }
    if (crew.swim === "dive") {
      const f = crew.st / 24, p = s.swimmerPos(), x = bw.x + (p.x - bw.x) * f, y = bw.y + (p.y - bw.y) * f - Math.sin(f * Math.PI) * 8 - lift * (1 - f);
      this.px(this.sx(x), this.sy(y), "#f0c8a0");
      this.px(this.sx(x), this.sy(y) + 1, "#ef5a24");
    }
    if (crew.swim === "swim") {
      const p = s.swimmerPos(), stroke = (t >> 4) & 1;
      this.px(this.sx(p.x), this.sy(p.y) - 1, "#f0c8a0");
      this.px(this.sx(p.x), this.sy(p.y) - 2, "#5a3a22");
      this.px(this.sx(p.x) + (stroke ? 1 : -1), this.sy(p.y) - 1, "#f0c8a0");
      if (crew.st % 24 < 10) {
        const r = 1 + (crew.st % 24) / 4;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * 6.283;
          this.px(this.sx(p.x) + Math.cos(a) * r, this.sy(p.y) + Math.sin(a) * r * 0.6, "#e6f6ff");
        }
      }
    }
  }

  private compass(target: Isle, label: string, col: string): void {
    const s = this.sim, hud = s.hud;
    const dx = target.x - s.boat.x, dy = target.y - s.boat.y, d = Math.hypot(dx, dy) || 1;
    const tx = this.sx(target.x), ty = this.sy(target.y);
    const lx = Math.max(8, hud.left + 8), rx = this.W - Math.max(8, hud.right + 8);
    const top = Math.max(30, hud.top + 30), bottom = this.H - Math.max(22, hud.bottom + 14) - s.boat.cargo.length * 8;
    if (tx > lx && tx < rx && ty > top && ty < bottom) return;
    const ux = dx / d, uy = dy / d, cx = (lx + rx) / 2, cy2 = (top + bottom) / 2;
    const k = Math.min(((rx - lx) / 2 - 4) / Math.abs(ux || 1e-6), ((bottom - top) / 2 - 2) / Math.abs(uy || 1e-6));
    const x = cx + ux * k, y = cy2 + uy * k, a = Math.atan2(uy, ux);
    for (let i = 0; i < 5; i++) {
      for (let j = -i; j <= i; j++) {
        this.px(x + Math.cos(a) * (4 - i) - Math.sin(a) * j * 0.6, y + Math.sin(a) * (4 - i) + Math.cos(a) * j * 0.6, col);
      }
    }
    this.textIn(PixelPainter.clip(label, 12), x - ux * 12, clamp(y - uy * 12 - 2, top, bottom - 6), col);
  }

  private renderHud(): void {
    const s = this.sim, W = this.W, H = this.H, t = s.t, hud = s.hud;
    const lx = Math.max(4, hud.left + 4), rx = W - Math.max(4, hud.right + 4), ty = Math.max(4, hud.top);
    const cx = (lx + rx) / 2;
    this.band(0, ty + 22, 0.6);
    this.text(s.timeAt(s.clock), lx, ty, s.clock > DAY_FRAMES * 0.85 ? ((t >> 3) & 1 ? "#ff5e8a" : "#ffffff") : "#ffffff");
    const sc = String(s.score).padStart(5, "0");
    this.text(sc, rx - textWidth(sc), ty, "#fff2a0");

    this.rect(lx, ty + 8, 9, 7, "#c9a06a");
    this.rect(lx + 1, ty + 9, 7, 5, "#e8c890");
    this.rect(lx + 2, ty + 10, 2, 2, "#5b8dd6");
    this.rect(lx + 5, ty + 11, 2, 2, "#7cc46a");
    this.text(`MAP ${s.charted}/${s.islands.length}`, lx + 12, ty + 9, "#c7e4ff");
    const cargo = `CARGO ${s.delivered}/${s.cargoTotal}`;
    this.text(cargo, rx - textWidth(cargo), ty + 9, "#c9d3ea");

    this.rect(lx, ty + 17, rx - lx, 2, INK);
    this.rect(lx, ty + 17, Math.round(((rx - lx) * s.clock) / DAY_FRAMES), 2, "#fff2a0");

    const botBase = H - Math.max(10, hud.bottom + 10);
    s.boat.cargo.forEach((c, i) => {
      const y = botBase - i * 8, overdue = s.clock > s.dueFrame(c);
      this.rect(0, y - 2, W, 8, INK, 0.6);
      this.px(lx, y, PCOL[c.pr], 4);
      this.text(PixelPainter.clip(c.title, 22), lx + 7, y, "#ffffff");
      const tm = s.timeAt(s.dueFrame(c));
      this.text(tm, rx - textWidth(tm), y, overdue ? "#ff9a6b" : "#8dff9a");
    });

    if (s.state === "sail") {
      if (s.boat.cargo.length) {
        let h: Isle | null = null;
        for (const x of s.harbours) {
          if (s.boat.cargo.some((c) => c.p === x.p) && (!h || Math.hypot(x.x - s.boat.x, x.y - s.boat.y) < Math.hypot(h.x - s.boat.x, h.y - s.boat.y))) h = x;
        }
        if (h) this.compass(h, h.title, h.p!.accent);
      } else if (s.crates.length) {
        this.compass(s.today, "TODAY", "#fff2a0");
      }
    }

    s.pops.forEach((p, i) => {
      if (p.t > 90 && (p.t & 4)) return;
      const y = ty + 28 + i * 16;
      this.band(y - 2, 15, 0.5);
      this.textC(p.head, cx, y, p.c);
      this.textC(PixelPainter.clip(p.title, 40), cx, y + 7, "#ffffff");
    });
    if (s.state === "sail" && s.stateT < 240 && (t >> 5) & 1) {
      const hint = s.inputMode === "pointer" ? "WASD / DRAG TO STEER - M FOR CHART" : "HOLD TO STEER - TAP MAP FOR CHART";
      this.textC(hint, cx, H * 0.68, "#ffffff");
    }
  }

  private renderTitle(): void {
    const s = this.sim, t = s.t, H = this.H;
    const cx = (s.hud.left + this.W - s.hud.right) / 2;
    const top = Math.max(54, s.hud.top + 32);
    this.band(top, 70, 0.55);
    this.textC("SAIL YOUR KNOWLEDGE GRAPH", cx, top + 6, "#c7e4ff");
    this.textC("WAYFINDER", cx, top + 18, "#fff2a0", 3);
    this.textC("NOTES ARE ISLANDS - LINKS ARE LANES", cx, top + 44, "#e6eefc");
    this.textC("DELIVER TODAY'S TASKS BY DUE TIME", cx, top + 54, "#e6eefc");

    const bot = H - s.hud.bottom - 70;
    this.band(bot, 46, 0.55);
    this.textC("OVERDUE TASKS ARE STORMS", cx, bot + 6, "#ff9a6b");
    this.textC("UNLINKED NOTES HIDE IN THE FOG", cx, bot + 16, "#fff2a0");
    if ((t >> 5) & 1) this.textC(s.inputMode === "pointer" ? "CLICK OR SPACE TO SET SAIL" : "TAP TO SET SAIL", cx, bot + 30, "#ffffff");
    this.textC(`BEST ${s.best}`, cx, H - s.hud.bottom - 16, "#c7d0e6");
  }

  private drawChart(top: number, bottomPad: number): { my: number; mh: number } {
    const s = this.sim, mini = this.ensureChart();
    const usableW = this.W - s.hud.left - s.hud.right - 20;
    const k = Math.min(usableW / WD, (this.H - top - bottomPad) / HD);
    const mw = Math.round(WD * k), mh = Math.round(HD * k), mx = Math.round(s.hud.left + (this.W - s.hud.left - s.hud.right - mw) / 2), my = top;
    this.rect(mx - 3, my - 3, mw + 6, mh + 6, "#5a3a22");
    this.rect(mx - 2, my - 2, mw + 4, mh + 4, "#c9a06a");
    this.imageRect(mini, 0, 0, WD, HD, mx, my, mw, mh);
    for (const h of s.harbours) {
      this.px(mx + h.x * k - 1, my + h.y * k - 1, h.p!.accent, 3);
      if (s.boat.cargo.some((c) => c.p === h.p) && (s.t >> 3) & 1) {
        this.strokeRect(Math.round(mx + h.x * k) - 4, Math.round(my + h.y * k) - 4, 8, 8, "#ffffff");
      }
    }
    this.px(mx + s.today.x * k - 1, my + s.today.y * k - 1, "#fff2a0", 3);
    for (const st of s.storms) this.px(mx + st.x * k - 2, my + st.y * k - 2, "#59607a", 4);
    if ((s.t >> 3) & 1) this.px(mx + s.boat.x * k - 1, my + s.boat.y * k - 1, "#ef5a24", 3);
    return { my, mh };
  }

  private renderMap(): void {
    const s = this.sim, cx = (s.hud.left + this.W - s.hud.right) / 2, top = Math.max(8, s.hud.top + 4);
    this.rect(0, 0, this.W, this.H, INK, 0.85);
    this.textC("CHARTED WATERS", cx, top, "#fff2a0");
    const { my, mh } = this.drawChart(top + 12, 52 + s.hud.bottom), y = my + mh + 8, lost = s.islands.filter((i) => i.orphan);
    this.textC(`${s.charted} OF ${s.islands.length} NOTES CHARTED`, cx, y, "#c7e4ff");
    this.textC(`${lost.filter((i) => i.charted).length} OF ${lost.length} LOST NOTES FOUND`, cx, y + 10, "#fff2a0");
    if ((s.t >> 5) & 1) this.textC(s.inputMode === "pointer" ? "CLICK OR M TO SAIL ON" : "TAP TO SAIL ON", cx, y + 24, "#ffffff");
  }

  private renderLog(): void {
    const s = this.sim, cx = (s.hud.left + this.W - s.hud.right) / 2, top = Math.max(24, s.hud.top + 12);
    this.rect(0, 0, this.W, this.H, INK, 0.8);
    this.textC("SHIP'S LOG", cx, top, "#fff2a0", 2);
    const { my, mh } = this.drawChart(top + 20, 80 + s.hud.bottom), y = my + mh + 8;
    const lost = s.islands.filter((i) => i.orphan), found = lost.filter((i) => i.charted).length;
    this.textC(`${s.delivered} DELIVERED${s.late ? `  ${s.late} LATE` : ""}`, cx, y, "#8dff9a");
    this.textC(`${s.charted} OF ${s.islands.length} NOTES CHARTED`, cx, y + 10, "#c7e4ff");
    this.textC(`${found} OF ${lost.length} LOST NOTES FOUND`, cx, y + 20, "#fff2a0");
    this.textC(`SCORE ${s.score}   BEST ${s.best}`, cx, y + 34, "#ffffff");
    if (s.stateT > 60 && (s.t >> 5) & 1) {
      this.textC(s.inputMode === "pointer" ? "CLICK OR SPACE FOR A NEW DAY" : "TAP FOR A NEW DAY", cx, y + 48, "#c7d0e6");
    }
  }
}
