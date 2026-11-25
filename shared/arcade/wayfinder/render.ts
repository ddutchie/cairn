/**
 * Wayfinder shared renderer — extends PixelPainter for Canvas2D and Skia parity.
 *
 * Uses baked storm sprites, cached half-resolution bilinear-dithered fog,
 * animated sea life (schools, dolphins, turtles, whales, kraken), crew casting
 * and swimming, compass navigation pointers, mini-chart overlay, and Ship's Log.
 */

import type { Priority } from "../../types/domain";
import { textWidth } from "../pixel/font";
import { hudFrame } from "../pixel/hud";
import { clamp, lerpHex } from "../pixel/kinds";
import { INK, PixelPainter, type AtlasHandle, type PixelBackend } from "../pixel/painter";
import { BAYER, BIOMES, fbm, hash2, mulberry32, rgb, type BiomeName } from "../pixel/terrain";
import { bakeVignette } from "./stage-bake";
import { IslandStage3D, STAGE_SKY } from "./island3d";
import { RELIC_INFO, WALK_FRAMES, exploreLayout, isFight, kindAt, landRect, stepCard, type Expedition, type ExploreLayout, type Rect } from "./expedition";
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
/** Fog-buffer margin in world pixels each side (64 in all), so a sailing camera rarely forces a full mask rebuild. */
const FOG_MARGIN = 32;
const BAYER_MIN = Math.min(...BAYER), BAYER_MAX = Math.max(...BAYER);

const WEATHER: Record<BiomeName, { n: number; vx: number; vy: number; c: string[] }> = {
  tropic: { n: 10, vx: 0.2, vy: 0.1, c: ["#fff2a0", "#86d94c"] },
  desert: { n: 22, vx: 1.6, vy: 0.15, c: ["#efc98a", "#d9a866"] },
  tundra: { n: 36, vx: 0.25, vy: 0.55, c: ["#ffffff", "#dfe9f4"] },
  volcano: { n: 24, vx: 0.15, vy: -0.45, c: ["#ffb347", "#ef6a24", "#fff2a0"] },
};
const BIOME_LABEL: Record<BiomeName, string> = { tropic: "PALM", desert: "DUNE", tundra: "FROST", volcano: "EMBER" };
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
  /** World offset for rects and images ashore (camera bob and shake); stacks and px use SX/SY. */
  private OX = 0;
  private OY = 0;
  /** Horizon row of the stage being drawn, for ground colour lookups. */
  private exHor = 0;
  /** Fog-dissolve frames left after sailing back, and the state drawn last frame. */
  private leaveFog = 0;
  private lastState = "";
  private lastT = 0;
  private fogScreen: { img: Img; w: number; h: number } | null = null;

  private fogW = 0;
  private fogH = 0;
  private fogBytes = new Uint8Array(0);
  private fogBuf = new Uint32Array(0);
  /** 1 where the fog texture shows, per fog-buffer pixel; rebuilt only where the sea's fog changed. */
  private fogMask = new Uint8Array(0);
  /** Per buffer row, the clear [start, end) runs as flat pairs. */
  private fogRuns: number[][] = [];
  private fogColCx = new Int32Array(0);
  private fogColAx = new Float32Array(0);
  private fogMaskOk = false;
  private fogImg: Img | null = null;
  private fogCamX = 0;
  private fogCamY = 0;
  private fogVer = -1;
  private fogTick = -1;
  private mini: Img | null = null;
  private miniBuiltState: string | null = null;
  private readonly fx = mulberry32(404);

  private readonly stage: IslandStage3D;
  constructor(backend: PixelBackend<Img, Frame>, sim: WayfinderSim) {
    super(backend, sim.W, sim.H);
    this.sim = sim;
    this.stage = new IslandStage3D(sim);
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
    this.fogW = Math.ceil(w / 2) + FOG_MARGIN;
    this.fogH = Math.ceil(h / 2) + FOG_MARGIN;
    this.fogBytes = new Uint8Array(this.fogW * this.fogH * 4);
    this.fogBuf = new Uint32Array(this.fogBytes.buffer);
    this.fogMask = new Uint8Array(this.fogW * this.fogH);
    this.fogRuns = Array.from({ length: this.fogH }, () => []);
    this.fogColCx = new Int32Array(this.fogW);
    this.fogColAx = new Float32Array(this.fogW);
    this.fogMaskOk = false;
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

  /**
   * The sea's fog at 2x scale. The mask (which buffer pixels are fog) is kept
   * between frames and recomputed only where the fog changed or when the camera
   * leaves the buffer's margin; the drifting texture has a 32-pixel period in
   * buffer space, so it is laid down as one tile copied across the buffer and the
   * clear runs are zeroed with fills. No per-pixel JS runs on a drift frame, so
   * the cost no longer grows with the screen (it was the unfolded Duo's stutter).
   */
  private drawFog(): void {
    const s = this.sim, W = this.W, H = this.H;
    const outOfBounds =
      s.camX < this.fogCamX ||
      s.camY < this.fogCamY ||
      s.camX + W > this.fogCamX + this.fogW * 2 ||
      s.camY + H > this.fogCamY + this.fogH * 2;
    const driftTick = s.t >> 3;
    const fogMoved = s.fogVersion !== this.fogVer && (s.t & 3) === 0;
    if (!this.fogImg || outOfBounds || !this.fogMaskOk || driftTick !== this.fogTick || fogMoved) {
      if (outOfBounds || !this.fogMaskOk) {
        this.fogCamX = Math.floor((s.camX - FOG_MARGIN) / 2) * 2;
        this.fogCamY = Math.floor((s.camY - FOG_MARGIN) / 2) * 2;
        for (let x = 0; x < this.fogW; x++) {
          const fx = (x * 2 + this.fogCamX) / 8 - 0.5, cx = Math.floor(fx);
          this.fogColCx[x] = cx;
          this.fogColAx[x] = fx - cx;
        }
        s.takeFogDirty();
        this.maskFog(0, 0, this.fogW - 1, this.fogH - 1);
        this.fogMaskOk = true;
        this.fogVer = s.fogVersion;
      } else if (fogMoved) {
        const d = s.takeFogDirty();
        // A changed cell feeds the bilinear lookups half a cell either side of
        // it; an edge cell also feeds everything past the world's edge (clamped).
        if (d) {
          this.maskFog(
            d[0] <= 0 ? 0 : Math.floor(((d[0] - 0.5) * 8 - this.fogCamX) / 2),
            d[1] <= 0 ? 0 : Math.floor(((d[1] - 0.5) * 8 - this.fogCamY) / 2),
            d[2] >= FW - 1 ? this.fogW - 1 : Math.ceil(((d[2] + 1.5) * 8 - this.fogCamX) / 2),
            d[3] >= FH - 1 ? this.fogH - 1 : Math.ceil(((d[3] + 1.5) * 8 - this.fogCamY) / 2),
          );
        }
        this.fogVer = s.fogVersion;
      }
      this.fogTick = driftTick;
      this.paintFog(s.t >> 4, driftTick);
      this.fogImg = this.makeImage(this.fogW, this.fogH, this.fogBytes);
    }

    if (this.fogImg) {
      this.imageRect(this.fogImg, 0, 0, this.fogW, this.fogH, this.fogCamX - s.camX, this.fogCamY - s.camY, this.fogW * 2, this.fogH * 2);
    }
  }

  /** Recompute the fog mask over buffer pixels [x0..x1] x [y0..y1] (clamped) and the clear runs of those rows. */
  private maskFog(x0: number, y0: number, x1: number, y1: number): void {
    const FOG = this.sim.fog, fw = this.fogW, mask = this.fogMask, colCx = this.fogColCx, colAx = this.fogColAx;
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(fw - 1, x1);
    y1 = Math.min(this.fogH - 1, y1);
    if (x0 > x1 || y0 > y1) return;
    const bx = (this.fogCamX >> 1) & 3;
    for (let y = y0; y <= y1; y++) {
      const wy = y * 2 + this.fogCamY, fy = wy / 8 - 0.5, cy = Math.floor(fy), ay = fy - cy;
      const r0 = clamp(cy, 0, FH - 1) * FW, r1 = clamp(cy + 1, 0, FH - 1) * FW;
      const bRow = ((wy >> 1) & 3) * 4, base = y * fw;
      let x = x0;
      while (x <= x1) {
        const cx = colCx[x];
        let xe = x;
        while (xe < x1 && colCx[xe + 1] === cx) xe++;
        const i0 = clamp(cx, 0, FW - 1), i1 = clamp(cx + 1, 0, FW - 1);
        const a = FOG[r0 + i0], b = FOG[r0 + i1], c = FOG[r1 + i0], d = FOG[r1 + i1];
        if (a > BAYER_MAX && b > BAYER_MAX && c > BAYER_MAX && d > BAYER_MAX) mask.fill(0, base + x, base + xe + 1);
        else if (a <= BAYER_MIN && b <= BAYER_MIN && c <= BAYER_MIN && d <= BAYER_MIN) mask.fill(1, base + x, base + xe + 1);
        else {
          const top0 = a * (1 - ay), top1 = b * (1 - ay), bot0 = c * ay, bot1 = d * ay;
          for (let xx = x; xx <= xe; xx++) {
            const ax = colAx[xx], v = (top0 + bot0) * (1 - ax) + (top1 + bot1) * ax;
            mask[base + xx] = v > BAYER[bRow + ((xx + bx) & 3)] ? 0 : 1;
          }
        }
        x = xe + 1;
      }
      const runs = this.fogRuns[y];
      runs.length = 0;
      let start = -1;
      for (let xx = 0; xx < fw; xx++) {
        if (mask[base + xx] === 0) {
          if (start < 0) start = xx;
        } else if (start >= 0) {
          runs.push(start, xx);
          start = -1;
        }
      }
      if (start >= 0) runs.push(start, fw);
    }
  }

  /** Lay the drifting fog texture over the whole buffer, then clear the revealed runs. */
  private paintFog(driftX: number, driftY: number): void {
    const buf = this.fogBuf, fw = this.fogW, fh = this.fogH;
    const c0 = this.fogCamX + driftX, r0 = this.fogCamY + driftY;
    const tw = Math.min(32, fw), th = Math.min(32, fh);
    for (let i = 0; i < th; i++) {
      const row = ((i * 2 + r0) & 63) * 64, base = i * fw;
      for (let j = 0; j < tw; j++) buf[base + j] = FOG_TEX[row + ((j * 2 + c0) & 63)];
      for (let len = tw; len < fw; ) {
        const n = Math.min(len, fw - len);
        buf.copyWithin(base + len, base, base + n);
        len += n;
      }
    }
    for (let rows = th; rows < fh; ) {
      const n = Math.min(rows, fh - rows);
      buf.copyWithin(rows * fw, 0, n * fw);
      rows += n;
    }
    for (let y = 0; y < fh; y++) {
      const runs = this.fogRuns[y], base = y * fw;
      for (let k = 0; k < runs.length; k += 2) buf.fill(0, base + runs[k], base + runs[k + 1]);
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

  protected override rect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    super.rect(x + this.OX, y + this.OY, w, h, color, alpha);
  }
  protected override circle(cx: number, cy: number, r: number, color: string, alpha = 1, stroke = false): void {
    super.circle(cx + this.OX, cy + this.OY, r, color, alpha, stroke);
  }
  protected override image(img: Img, x: number, y: number, alpha = 1): void {
    super.image(img, x + this.OX, y + this.OY, alpha);
  }
  protected override imageRect(img: Img, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, alpha = 1): void {
    super.imageRect(img, sx, sy, sw, sh, dx + this.OX, dy + this.OY, dw, dh, alpha);
  }

  /** The sea's own fog texture over the whole screen (at the sea's 2x scale), for landing and leaving. */
  private fogCurtain(alpha: number): void {
    if (alpha <= 0) return;
    const W = this.W, H = this.H;
    if (!this.fogScreen || this.fogScreen.w !== W || this.fogScreen.h !== H) {
      const w = Math.ceil(W / 2), h = Math.ceil(H / 2), bytes = new Uint8Array(w * h * 4), px = new Uint32Array(bytes.buffer);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = FOG_TEX[(y & 63) * 64 + (x & 63)];
      this.fogScreen = { img: this.makeImage(w, h, bytes), w: W, h: H };
    }
    const f = this.fogScreen.img, w = Math.ceil(W / 2), h = Math.ceil(H / 2), drift = (this.sim.t >> 2) % 2;
    this.imageRect(f, 0, 0, w, h, -drift, 0, w * 2, h * 2, Math.min(1, alpha));
  }

  draw(): Frame {
    const s = this.sim, W = this.W, H = this.H, t = s.t;
    if (s.state !== "map" && s.state !== "log") this.miniBuiltState = null;
    if (this.lastState === "explore" && s.state !== "explore") this.leaveFog = 36;
    if (this.leaveFog > 0) this.leaveFog = Math.max(0, this.leaveFog - Math.max(0, t - this.lastT));
    this.lastState = s.state;
    this.lastT = t;
    if (s.state === "explore" && s.exp) {
      this.renderExplore();
      return this.snapshot();
    }

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

    // Surfaced life is depth-sorted against the boat by its waterline: further up the screen draws behind.
    this.drawSeaLifeOver(false);
    this.drawKrakenOver(false);
    const bx = this.sx(s.boat.x), by = this.sy(s.boat.y), bob = Math.sin(t * 0.08) * 0.6;
    this.shadow(this.boat, bx, by, s.boat.a, 2, 3, 0.3);
    this.stack(this.boat, bx, by + bob, s.boat.a);
    this.drawCrew(bob);
    s.boat.cargo.forEach((c, i) => {
      this.stack(this.crates[c.pr], bx + Math.sin(s.boat.a) * (1 - i * 2), by + bob - 4 - Math.cos(s.boat.a) * (1 - i * 2), s.boat.a, { k: 0.8 });
    });

    this.drawSeaLifeOver(true);
    this.drawKrakenOver(true);
    for (const p of s.parts) if (!p.wake) this.px(this.sx(p.x), this.sy(p.y), p.c);
    this.drawFog();

    for (const st of s.storms) {
      const cx = this.sx(st.x), cy = this.sy(st.y);
      if (cx < -40 || cx > W + 40 || cy < -40 || cy > H + 40) continue;
      const img = st.bolt > 4 ? this.stormFlashImg : this.stormImg;
      const sz = Math.round(st.r * 2 + 1);
      this.imageRect(img, 0, 0, STORM_SZ, STORM_SZ, Math.round(cx - st.r) + this.SX, Math.round(cy - st.r - 14) + this.SY, sz, sz);
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
    // Back from an island: the sea's fog clears off the boat.
    this.fogCurtain(this.leaveFog / 36);
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
      const a = s.boat.a, fx = Math.sin(a), fy = -Math.cos(a);
      for (let i = 0; i < 3; i++) {
        const d = this.dolphinAt(i), x = this.sx(d.x), y = this.sy(d.y);
        if (d.jump > 0) {
          this.shadow(this.dolphin, x, y, a, 1, 2, 0.2 * s.pod.on);
          continue;
        }
        // Swimming just under: a dark body, the dorsal fin cutting the surface, and its wake.
        this.shadow(this.dolphin, x, y, a, 0, 0, 0.5 * s.pod.on);
        const finX = Math.round(x + fx), finY = Math.round(y + fy);
        this.px(finX, finY - 1, "#3d4f73", 1, s.pod.on);
        this.px(finX, finY, "#5a6f96", 1, s.pod.on);
        if ((t + i * 5) % 8 < 5) {
          this.px(Math.round(x - fx * 3 - fy), Math.round(y - fy * 3 + fx), "#e6f6ff", 1, 0.7 * s.pod.on);
          this.px(Math.round(x - fx * 3 + fy), Math.round(y - fy * 3 - fx), "#e6f6ff", 1, 0.7 * s.pod.on);
        }
      }
    }
  }

  /** Is a thing at sea-map row `y` in front of the boat (nearer the bottom of the screen)? */
  private frontOfBoat(y: number): boolean {
    return y >= this.sim.boat.y;
  }

  /** Life at the surface: `front` draws what sits in front of the boat, otherwise what sits behind it. */
  private drawSeaLifeOver(front: boolean): void {
    const s = this.sim, t = s.t;
    for (const tt of s.turtles) {
      if (this.frontOfBoat(tt.y) !== front) continue;
      this.shadow(this.turtle, this.sx(tt.x), this.sy(tt.y), tt.a, 1, 2, 0.3);
      this.stack(this.turtle, this.sx(tt.x), this.sy(tt.y), tt.a + Math.sin(t * 0.15) * 0.1);
    }
    for (const w of s.whales) {
      if (w.cyc < 220 && this.frontOfBoat(w.y) === front) {
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
        if (d.jump <= 0 || this.frontOfBoat(d.y) !== front) continue;
        const x = this.sx(d.x), y = this.sy(d.y);
        // A splash ring where it leaves the water and where it dives back in.
        if (d.ph < 0.4 || d.ph > Math.PI - 0.4) {
          const r = 2 + (d.ph < 0.4 ? d.ph : Math.PI - d.ph) * 5;
          for (let k = 0; k < 8; k++) {
            const q = (k / 8) * 6.283;
            this.px(x + Math.cos(q) * r, y + Math.sin(q) * r * 0.6, "#e6f6ff", 1, 0.8 * s.pod.on);
          }
        }
        // Nearer the camera at the top of the leap, so a little larger.
        this.stack(this.dolphin, x, y - Math.round(d.jump), s.boat.a, { k: 1 + d.jump / 24 });
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

  /** The kraken's arms, depth-sorted against the boat like the sea life. */
  private drawKrakenOver(front: boolean): void {
    const k = this.sim.kraken, t = this.sim.t;
    if (k.phase !== "up" && k.phase !== "sink") return;
    k.arms.forEach((a, i) => {
      if (this.frontOfBoat(k.y + Math.sin(a.a) * a.r) !== front) return;
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
    // The top rows hug the top edge and the cargo rows the bottom, so each clears its rounded corners.
    const F = hudFrame(hud, W, H), lx = F.top.lx, rx = F.top.rx, ty = F.top.y;
    const blx = F.bottom.lx, brx = F.bottom.rx, cx = F.content.cx;
    this.band(0, ty + 22, 0.6);
    this.text(s.timeAt(s.clock), lx, ty, s.clock > DAY_FRAMES * 0.85 ? ((t >> 3) & 1 ? "#ff5e8a" : "#ffffff") : "#ffffff");
    const sc = String(s.score).padStart(5, "0");
    this.text(sc, rx - textWidth(sc), ty, "#fff2a0");
    for (let i = 0; i < s.voyage.maxHp; i++) this.rect(lx + 24 + i * 6, ty + 1, 4, 3, i < s.voyage.hp ? "#ff3d6e" : "#3a3f55");

    this.rect(lx, ty + 8, 9, 7, "#c9a06a");
    this.rect(lx + 1, ty + 9, 7, 5, "#e8c890");
    this.rect(lx + 2, ty + 10, 2, 2, "#5b8dd6");
    this.rect(lx + 5, ty + 11, 2, 2, "#7cc46a");
    this.text(`MAP ${s.charted}/${s.islands.length}`, lx + 12, ty + 9, "#c7e4ff");
    const cargo = `CARGO ${s.delivered}/${s.cargoTotal}`;
    this.text(cargo, rx - textWidth(cargo), ty + 9, "#c9d3ea");

    this.rect(lx, ty + 17, rx - lx, 2, INK);
    this.rect(lx, ty + 17, Math.round(((rx - lx) * s.clock) / DAY_FRAMES), 2, "#fff2a0");

    const botBase = F.bottom.y - 6;
    s.boat.cargo.forEach((c, i) => {
      const y = botBase - i * 8, overdue = s.clock > s.dueFrame(c);
      this.rect(0, y - 2, W, 8, INK, 0.6);
      this.px(blx, y, PCOL[c.pr], 4);
      this.text(PixelPainter.clip(c.title, 22), blx + 7, y, "#ffffff");
      const tm = s.timeAt(s.dueFrame(c));
      this.text(tm, brx - textWidth(tm), y, overdue ? "#ff9a6b" : "#8dff9a");
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
    this.renderLandPrompt();
    if (s.state === "sail" && s.stateT < 240 && (t >> 5) & 1) {
      const hint = s.inputMode === "pointer" ? "WASD / DRAG TO STEER - M FOR CHART" : "HOLD TO STEER - TAP MAP FOR CHART";
      this.textC(hint, cx, H * 0.68, "#ffffff");
    }
  }

  // ── Island expedition: a real 3D stage (island3d.ts) ──────────────────────
  // The 3D frame is drawn by IslandStage3D into a small framebuffer and
  // stretched over the screen in one call; the card, HUD and effects are 2D
  // on top, hung on the anchors the stage projects.

  private renderExplore(): void {
    const s = this.sim, e = s.exp!, W = this.W, H = this.H, t = s.t;
    const L = exploreLayout(W, H, s.hud), sky = STAGE_SKY[e.biome], cx = L.cx;
    this.exHor = L.horizon;
    const bob = e.walk > 0 ? Math.abs(Math.sin(t * 0.45)) * 1.2 : 0;
    const shake = s.shake > 0 && !s.calm ? s.shake : 0;
    this.stage.resize(W, H);
    const a = this.stage.render(e, L.horizon, { x: shake ? this.rng(-shake, shake) * 0.8 : 0, y: (shake ? this.rng(-shake, shake) * 0.5 : 0) + bob });
    const fb = this.stage.fb;
    this.clear(INK);
    this.imageRect(this.makeImage(fb.w, fb.h, fb.rgba), 0, 0, fb.w, fb.h, 0, 0, W, H);

    const day = clamp(s.clock / DAY_FRAMES, 0, 1), lost = e.mood === "lost", kind = kindAt(e);
    if (a.sun && a.landing >= 1) {
      if (lost) {
        // Lost islands are night stages under a pale moon.
        this.circle(a.sun.x, a.sun.y, 12, "#c7e4ff", 0.12);
        this.circle(a.sun.x, a.sun.y, 6, "#e6f6ff", 0.9);
        this.circle(a.sun.x + 2, a.sun.y - 1, 5, lerpHex(sky[0], INK, 0.5), 0.9);
      } else {
        this.circle(a.sun.x, a.sun.y, 16, sky[2], 0.12);
        this.circle(a.sun.x, a.sun.y, 11, sky[2], 0.22);
        this.circle(a.sun.x, a.sun.y, 7, lerpHex(lerpHex(sky[2], sky[1], 0.3), "#ff9a4d", clamp((day - 0.6) * 2.5, 0, 0.8)), 0.8);
      }
    }

    // Effects hung on the encounter.
    const top = a.actorTop, foot = a.actorFoot, fight = isFight(kind);
    if (foot && kind === "shrine") {
      // A shaft of light on the summit shrine.
      const glow = 0.06 + Math.sin(t * 0.04) * 0.015;
      for (let i = 0; i < 3; i++) {
        const w = 10 + i * 10;
        this.rect(foot.x - w / 2, 0, w, foot.y, "#fff2c0", glow);
      }
      if ((t >> 3) & 1 && top) this.circle(top.x, top.y + 4, 2, "#4cc9f0", 0.8);
    }
    if (foot && kind === "camp") for (let i = 0; i < 4; i++) this.px(foot.x - 2 + (i % 2) * 3, foot.y - 3 - (((t >> 2) + i * 3) % 6), i % 2 ? "#ffb347" : "#ff5e3a", 2, 0.9);
    if (top && kind === "hermit" && (t >> 4) & 1) this.circle(top.x + 4, top.y + 6, 3, "#ffd23c", 0.35);
    if (top && kind === "overdue") for (let i = 0; i < 3; i++) this.px(top.x - 8 + i * 8 + Math.round(Math.sin(t * 0.2 + i) * 2), top.y - ((t + i * 7) % 12), "#c7d0e6", 2, 0.7);
    if (top && a.landing >= 1 && e.walk === 0) {
      if (kind === "fork" && e.routes) this.drawForkSigns(e, top.x, top.y - 4);
      if (fight) {
        const w = 32, y = Math.max(L.card.y + L.card.h + 4, top.y);
        this.rect(top.x - w / 2 - 1, y - 1, w + 2, 4, INK);
        this.rect(top.x - w / 2, y, Math.round((w * e.foeHp) / Math.max(1, e.foeMax)), 2, kind === "overdue" ? "#c7d0e6" : "#ff3d6e");
      }
    }
    if (e.swing > 3) {
      // Cutlass arc, sweeping up toward the foe.
      const r = 22, a0 = -Math.PI * 0.85, a1 = -Math.PI * (0.85 - (1 - e.swing / 14) * 0.7), ay = L.captainY - 40;
      for (let ang = a0; ang <= a1; ang += 0.08) this.px(cx + 8 + Math.cos(ang) * r, ay + Math.sin(ang) * r * 0.6, "#ffffff", 2, 0.85);
    }
    for (const p of s.parts) this.px(p.x, p.y, p.c);
    this.drawWeather(e.biome, L.horizon);
    if (this.stormNear()) this.drawRain(L.horizon);
    // Late in the sea day: warm, then dusk.
    if (day > 0.6) this.rect(0, 0, W, H, "#ff9a4d", Math.min(0.14, (day - 0.6) * 0.5));
    if (day > 0.82) this.rect(0, 0, W, H, "#2a2050", Math.min(0.24, (day - 0.82) * 1.4));
    if (lost) this.rect(0, 0, W, H, "#0a1030", 0.34 * a.landing);
    this.image(this.vignette(), 0, 0, a.landing);
    // Landing: the sea's fog parts as the camera dives through it.
    if (a.landing < 1) this.fogCurtain(Math.max(0, 0.5 - a.landing * 1.6));

    if (e.hurt > 0 && !s.calm) this.rect(0, 0, W, H, "#ff3d6e", e.hurt / 40);
    if (a.landing < 0.8) return;
    this.renderExploreHud(L, e);
    if (e.phase === "step") this.renderCard(L, e);
    if (e.phase === "summary") this.renderSummary(L, e);
    if (e.phase === "ko") {
      this.rect(0, 0, W, H, INK, Math.min(0.75, e.t / 40));
      this.textC("KNOCKED OUT", cx, Math.round(H * 0.4), "#ff5e8a", 2);
      this.textC("THE CREW DRAGS YOU ABOARD", cx, Math.round(H * 0.4) + 18, "#ffffff");
      this.textC("ISLAND TREASURE LOST", cx, Math.round(H * 0.4) + 28, "#ff9a6b");
    }
    if (e.toast) {
      const w = textWidth(e.toast.s) + 12;
      this.rect(cx - w / 2, L.toastY - 3, w, 11, INK, 0.85);
      this.textC(e.toast.s, cx, L.toastY, e.toast.c, 1, null);
    }
  }

  private vignetteImg: { img: Img; w: number; h: number } | null = null;
  private vignette(): Img {
    if (!this.vignetteImg || this.vignetteImg.w !== this.W || this.vignetteImg.h !== this.H) {
      const v = bakeVignette(this.W, this.H);
      this.vignetteImg = { img: this.makeImage(v.w, v.h, v.bytes), w: this.W, h: this.H };
    }
    return this.vignetteImg.img;
  }








  /** Is one of the day's storms near where the boat anchored? Then it's raining ashore. */
  private stormNear(): boolean {
    const s = this.sim, b = s.boat;
    return s.storms.some((st) => Math.hypot(st.x - b.x, st.y - b.y) < st.r + 180);
  }

  private drawRain(hor: number): void {
    const t = this.sim.t, W = this.W, H = this.H;
    this.rect(0, 0, W, H, INK, 0.12);
    for (let i = 0; i < 46; i++) {
      const sx = hash2(i, 11, 3) * (W + 30), sy = hash2(i, 12, 3) * H, sp = 3 + hash2(i, 13, 3) * 2;
      const x = Math.round(((sx - t * sp * 0.4) % (W + 30) + W + 30) % (W + 30)), y = Math.round((sy + t * sp) % H);
      if (y < hor - 60 && i % 3) continue;
      for (let k = 0; k < 4; k++) this.px(x - (k >> 1), y + k, "#c7e4ff", 1, 0.45);
    }
  }











  /** Stage effects: drifting snow, rising embers, blowing dust, or pollen. */
  private drawWeather(biome: BiomeName, hor: number): void {
    const t = this.sim.t, W = this.W, H = this.H, w = WEATHER[biome];
    for (let i = 0; i < w.n; i++) {
      const sx = hash2(i, 3, 5) * (W + 40), sy = hash2(i, 7, 5) * H, sp = 0.4 + hash2(i, 9, 5) * 0.8;
      const x = Math.round(((sx + t * w.vx * sp) % (W + 40) + W + 40) % (W + 40)) - 20;
      const y = Math.round((((sy + t * w.vy * sp) % H) + H) % H);
      if (w.vy < 0 && y < hor - 40) continue;
      this.px(x + Math.round(Math.sin(t * 0.03 + i) * 2), y, w.c[i % w.c.length], hash2(i, 1, 1) < 0.2 ? 2 : 1, 0.85);
    }
  }







  /** The fork's signboards, naming the linked notes each trail leads toward. */
  private drawForkSigns(e: Expedition, x: number, y: number): void {
    const [a, b] = e.routes!, la = `< ${PixelPainter.clip(a.title, 10)}`, lb = `${PixelPainter.clip(b.title, 10)} >`;
    const chip = (s: string, right: boolean) => {
      const w = textWidth(s) + 6, cx = right ? x + 4 : x - 4 - w, top = y + (right ? 8 : 0);
      this.rect(cx, top, w, 9, INK);
      this.rect(cx + 1, top + 1, w - 2, 7, "#c9a06a");
      this.text(s, cx + 3, top + 2, "#2a1a10", 1, null);
    };
    chip(la, false);
    chip(lb, true);
  }




  /**
   * The expedition bar, in the sea HUD's style: the paused sea clock and
   * hearts on the first row, gold and supplies on the second, and the trail's
   * progress where the sea shows the day's.
   */
  private renderExploreHud(L: ExploreLayout, e: Expedition): void {
    const s = this.sim, v = s.voyage, t = s.t, lx = L.barLx, ty = L.ty, rx = L.sail.x - 6;
    this.band(0, ty + 22, 0.6);
    const clock = s.timeAt(s.clock);
    this.text(clock, lx, ty, "#c7e4ff");
    const hx = lx + textWidth(clock) + 6;
    for (let i = 0; i < v.maxHp; i++) this.rect(hx + i * 6, ty + 1, 4, 3, i < v.hp ? (v.hp === 1 && (t >> 4) & 1 ? "#ff9a6b" : "#ff3d6e") : "#3a3f55");
    const n = e.deck.length, stepTxt = e.phase === "summary" ? "CLEARED" : `STEP ${Math.min(n, e.step + 1)}/${n}`;
    this.text(stepTxt, rx - textWidth(stepTxt), ty, "#ffffff");
    // A coin, like the sea HUD's chart icon.
    this.rect(lx, ty + 8, 7, 7, "#c9a06a");
    this.rect(lx + 1, ty + 9, 5, 5, "#fff2a0");
    this.rect(lx + 3, ty + 10, 1, 3, "#c9a06a");
    this.text(`GOLD ${e.gold}`, lx + 10, ty + 9, "#fff2a0");
    const sup = `SUP ${v.supplies}`;
    this.text(sup, rx - textWidth(sup), ty + 9, "#c9d3ea");
    // Trail progress, four legs, where the sea draws the day's clock.
    const seg = (L.barRx - lx - 2 * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const x = Math.round(lx + i * (seg + 2));
      this.rect(x, ty + 17, Math.round(seg), 2, INK);
      // Leg i is the walk up to step i: full once arrived, filling while walking.
      const fill = e.phase === "summary" || i < e.step ? 1 : i === e.step ? 1 - e.walk / WALK_FRAMES : 0;
      if (fill > 0) this.rect(x, ty + 17, Math.round(seg * fill), 2, "#fff2a0");
    }
    const sail = L.sail;
    this.rect(sail.x, sail.y, sail.w, sail.h, INK);
    this.rect(sail.x + 1, sail.y + 1, sail.w - 2, sail.h - 2, "#1c2742");
    this.rect(sail.x + 1, sail.y + 1, sail.w - 2, 1, "#4cc9f0");
    this.textC(s.inputMode === "pointer" ? "SAIL ESC" : "SAIL", sail.x + sail.w / 2, sail.y + 5, "#ffffff", 1, null);
  }

  private parchment(r: Rect): void {
    this.rect(r.x + 2, r.y + 3, r.w, r.h, INK, 0.45);
    this.rect(r.x, r.y, r.w, r.h, INK);
    this.rect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, "#c9a06a");
    this.rect(r.x + 2, r.y + 2, r.w - 4, r.h - 4, "#efe6d0");
    for (let i = 0; i < 18; i++) {
      const x = r.x + 3 + ((i * 37) % (r.w - 6)), y = r.y + 15 + ((i * 23) % (r.h - 18));
      this.px(x, y, "#e2d4b4");
    }
  }

  private renderCard(L: ExploreLayout, e: Expedition): void {
    const s = this.sim, card = stepCard(e, s.voyage), r = L.card, t = s.t;
    const slide = e.walk > 0 ? Math.round((e.walk / WALK_FRAMES) * 10) : 0;
    const R = { ...r, y: r.y - slide };
    this.parchment(R);
    this.rect(R.x + 3, R.y + 3, R.w - 6, 11, "#1e2842");
    this.text(card.tag, R.x + 6, R.y + 6, "#fff2a0", 1, null);
    this.text(`${Math.min(e.deck.length, e.step + 1)}/${e.deck.length}`, R.x + R.w - 20, R.y + 6, "#c7e4ff", 1, null);
    const maxCh = Math.floor((R.w - 8) / 4);
    this.textC(PixelPainter.clip(card.title, maxCh), L.cx, R.y + 18, "#2a1a10", 1, null);
    this.textC(PixelPainter.clip(card.lines[0], maxCh), L.cx, R.y + 28, "#4a3729", 1, null);
    this.textC(PixelPainter.clip(card.lines[1], maxCh), L.cx, R.y + 36, "#4a3729", 1, null);
    const pointer = s.inputMode === "pointer";
    ([["a", L.a, card.a, 0], ["b", L.b, card.b, 1]] as const).forEach(([, b, opt, i]) => {
      const hot = pointer && e.sel === i;
      this.rect(b.x, b.y, b.w, b.h, hot && (t >> 4) & 1 ? "#fff2a0" : INK);
      this.rect(b.x + 1, b.y + 1, b.w - 2, b.h - 2, "#1c2742");
      this.rect(b.x + 1, b.y + 1, b.w - 2, 1, hot ? "#fff2a0" : "#4cc9f0");
      const n = Math.floor((b.w - 4) / 4);
      const label = pointer ? `${i + 1} ${opt.label}` : opt.label;
      this.textC(PixelPainter.clip(label, n), b.x + b.w / 2, b.y + 6, "#ffffff");
      this.textC(PixelPainter.clip(opt.desc, n), b.x + b.w / 2, b.y + 14, "#fff2a0", 1, null);
    });
  }

  private renderSummary(L: ExploreLayout, e: Expedition): void {
    const s = this.sim, p = L.panel, cx = L.cx;
    this.rect(p.x + 2, p.y + 3, p.w, p.h, INK, 0.45);
    this.rect(p.x, p.y, p.w, p.h, INK, 0.92);
    this.strokeRect(p.x, p.y, p.w, p.h, "#8dff9a");
    this.textC("ISLAND EXPLORED", cx, p.y + 8, "#8dff9a", 2);
    const n = Math.floor((p.w - 8) / 4);
    this.textC(PixelPainter.clip(e.title, n), cx, p.y + 24, "#c7e4ff");
    this.textC(`TREASURE ${e.gold + e.bonus + (e.orphan ? 60 : 30)}`, cx, p.y + 36, "#fff2a0");
    // What this island gave: up to two relics with what they do, then crate and charts.
    const lines: [string, string][] = [];
    for (const r of e.relics.filter((r, i, all) => all.indexOf(r) === i)) lines.push([`${r}: ${RELIC_INFO[r]}`, "#ffffff"]);
    if (e.crateTaken && e.crate) lines.push([`CRATE: ${e.crate.title}`, "#8dff9a"]);
    if (e.charts.length) lines.push([`CHARTS ${e.charts.length} LINKED NOTE${e.charts.length > 1 ? "S" : ""}`, "#4cc9f0"]);
    if (e.calmed) lines.push(["AN OVERDUE STORM EASES", "#c7d0e6"]);
    if (!lines.length) lines.push(["SAFE PASSAGE", "#ffffff"]);
    lines.slice(0, 3).forEach(([txt, c], i) => this.textC(PixelPainter.clip(txt, n), cx, p.y + 46 + i * 8, c));
    const b = L.panelBtn;
    this.rect(b.x, b.y, b.w, b.h, "#1d4a3a");
    this.strokeRect(b.x, b.y, b.w, b.h, (s.t >> 4) & 1 ? "#fff2a0" : "#8dff9a");
    this.textC(s.inputMode === "pointer" ? "BANK & SET SAIL (ENTER)" : "BANK & SET SAIL", cx, b.y + 7, "#ffffff");
  }

  private renderLandPrompt(): void {
    const s = this.sim, is = s.nearIsland;
    if (!is || s.state !== "sail") return;
    const r = landRect(this.W, this.H, s.hud, s.boat.cargo.length), t = s.t;
    this.rect(r.x, r.y, r.w, r.h, INK, 0.88);
    this.strokeRect(r.x, r.y, r.w, r.h, (t >> 4) & 1 ? "#fff2a0" : "#4cc9f0");
    const n = Math.floor((r.w - 8) / 4) - (s.inputMode === "pointer" ? 4 : 0);
    const label = PixelPainter.clip(`LAND AT ${is.title}`, n);
    this.textC(s.inputMode === "pointer" ? `${label} (E)` : label, r.x + r.w / 2, r.y + 4, "#ffffff");
    this.textC(is.orphan ? "A LOST NOTE - DEEP RELICS" : `${BIOME_LABEL[is.biome]} ISLAND`, r.x + r.w / 2, r.y + 12, is.orphan ? "#fff2a0" : "#c7e4ff", 1, null);
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
