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
import { FOG_STRIP, bakeShafts, bakeCavern, bakeCliff, bakeFog, bakeRidge, bakeSky, bakeVignette, type Baked } from "./stage-bake";
import { RELIC_INFO, WALK_FRAMES, exploreLayout, isFight, kindAt, landRect, stepCard, type Expedition, type ExploreLayout, type Rect } from "./expedition";
import {
  BOAT_MODEL,
  CAPTAIN_GLASS_MODEL,
  CAPTAIN_MODEL,
  ROWBOAT_MODEL,
  CHEST_MODEL,
  CRATE_MODELS,
  cliffModel,
  CAIRN_MODEL,
  FOE_ROSTER,
  GHOST_FOE,
  HERMIT_MODEL,
  WRECK_MODEL,
  tentModel,
  SHRINE_MODEL,
  SIGN_MODEL,
  FLOOR_PROPS,
  NEAR_TREE_MODELS,
  ROCK_MODELS,
  TREE_MODELS,
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

/** Backdrop per biome: sky top, horizon, sun, cloud. */
const SKY: Record<BiomeName, [string, string, string, string]> = {
  tropic: ["#3f8fd2", "#b9e3f2", "#fff2a0", "#e6f6ff"],
  desert: ["#4d6fb8", "#f6c48a", "#fff0a8", "#fde3c0"],
  tundra: ["#24447a", "#c8d6e8", "#e6f2ff", "#dfe9f4"],
  volcano: ["#3b2338", "#ef6a24", "#ffb347", "#6e4a46"],
};
/** Floor and path band indices into `BIOMES[b].bands`. */
const FLOOR: Record<BiomeName, [number, number]> = { tropic: [1, 0], desert: [0, 2], tundra: [4, 0], volcano: [0, 3] };
/** Fog colour per biome: sea mist, dust haze, freezing fog, volcanic smoke. */
const FOG: Record<BiomeName, string> = { tropic: "#cfe6ee", desert: "#e8cfa8", tundra: "#e6eef8", volcano: "#6e5a5a" };
const WEATHER: Record<BiomeName, { n: number; vx: number; vy: number; c: string[] }> = {
  tropic: { n: 10, vx: 0.2, vy: 0.1, c: ["#fff2a0", "#86d94c"] },
  desert: { n: 22, vx: 1.6, vy: 0.15, c: ["#efc98a", "#d9a866"] },
  tundra: { n: 36, vx: 0.25, vy: 0.55, c: ["#ffffff", "#dfe9f4"] },
  volcano: { n: 24, vx: 0.15, vy: -0.45, c: ["#ffb347", "#ef6a24", "#fff2a0"] },
};
/** What hangs off the cave lip: vines, nothing, icicles, nothing. */
const CAVE_DRIP: Record<BiomeName, string | null> = { tropic: "#2f6b2a", desert: null, tundra: "#cfe6f5", volcano: null };
const RIDGE_PAD = 64;

interface StageBake<Img> {
  key: string;
  sceneKey: string;
  sky: Img;
  vignette: Img;
  fog: Img[];
  fogH: number[];
  /** Per floor row, by stripe band: shaded ground and path colours. */
  floor: string[][];
  path: string[][];
  ridge: Img;
  midL: Img;
  midR: Img;
  midRW: number;
  midW: number;
  cavern: Img | null;
  shafts: Img;
  sunKey: string;
  /** Per floor row: worn dirt by the trail, and the island's other ground for patches. */
  dirt: string[];
  alt: string[];
}

const BIOME_LABEL: Record<BiomeName, string> = { tropic: "PALM", desert: "DUNE", tundra: "FROST", volcano: "EMBER" };
const BIOME_KEYS: BiomeName[] = ["tropic", "desert", "tundra", "volcano"];
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
  private readonly captain: AtlasHandle<Img>;
  private readonly captainGlass: AtlasHandle<Img>;
  private readonly rowboat: AtlasHandle<Img>;
  /** Sim frame the captain last moved, for the idle spyglass. */
  private capBusy = 0;
  /** Depth pass for the near wings: 0 draws pieces behind the captain's row, 1 those in front. */
  private wingPass = { front: false, row: 0 };
  /** World offset for rects and images ashore (camera bob and shake); stacks and px use SX/SY. */
  private OX = 0;
  private OY = 0;
  /** Shadow length: long at the start and end of the sea day. */
  private sunLen = 1;
  /** Horizon row of the stage being drawn, for ground colour lookups. */
  private exHor = 0;
  /** Fog-dissolve frames left after sailing back, and the state drawn last frame. */
  private leaveFog = 0;
  private lastState = "";
  private lastT = 0;
  private fogScreen: { img: Img; w: number; h: number } | null = null;
  private readonly chest: AtlasHandle<Img>;
  private readonly shrine: AtlasHandle<Img>;
  private readonly sign: AtlasHandle<Img>;
  private readonly foes: Record<BiomeName, AtlasHandle<Img>[]>;
  private readonly ghost: AtlasHandle<Img>;
  private readonly hermit: AtlasHandle<Img>;
  private readonly wreck: AtlasHandle<Img>;
  private readonly cairn: AtlasHandle<Img>;
  private readonly tents = new Map<string, AtlasHandle<Img>>();
  private readonly trees: Record<BiomeName, AtlasHandle<Img>>;
  private readonly nearTrees: Record<BiomeName, AtlasHandle<Img>>;
  private readonly rocks: Record<BiomeName, AtlasHandle<Img>[]>;
  private readonly floorProps: Record<BiomeName, AtlasHandle<Img>[]>;

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
    this.captain = this.makeAtlas(CAPTAIN_MODEL);
    this.captainGlass = this.makeAtlas(CAPTAIN_GLASS_MODEL);
    this.rowboat = this.makeAtlas(ROWBOAT_MODEL);
    this.chest = this.makeAtlas(CHEST_MODEL);
    this.shrine = this.makeAtlas(SHRINE_MODEL);
    this.sign = this.makeAtlas(SIGN_MODEL);
    this.foes = Object.fromEntries(BIOME_KEYS.map((b) => [b, FOE_ROSTER[b].map((f) => this.makeAtlas(f.model))])) as Record<BiomeName, AtlasHandle<Img>[]>;
    this.ghost = this.makeAtlas(GHOST_FOE.model);
    this.hermit = this.makeAtlas(HERMIT_MODEL);
    this.wreck = this.makeAtlas(WRECK_MODEL);
    this.cairn = this.makeAtlas(CAIRN_MODEL);
    this.trees = Object.fromEntries(BIOME_KEYS.map((b) => [b, this.makeAtlas(TREE_MODELS[b])])) as Record<BiomeName, AtlasHandle<Img>>;
    const many = (src: Record<BiomeName, import("../pixel/models").Model[]>) =>
      Object.fromEntries(BIOME_KEYS.map((b) => [b, src[b].map((m) => this.makeAtlas(m))])) as Record<BiomeName, AtlasHandle<Img>[]>;
    this.rocks = many(ROCK_MODELS);
    this.floorProps = many(FLOOR_PROPS);
    this.nearTrees = Object.fromEntries(BIOME_KEYS.map((b) => [b, this.makeAtlas(NEAR_TREE_MODELS[b])])) as Record<BiomeName, AtlasHandle<Img>>;
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

  // ── Island expedition: a pseudo-3D stage ──────────────────────────────────
  // Backdrop sky, three parallax ridge flats, a perspective trail floor, voxel
  // wings (trees) sorted by depth, the encounter centre stage and the captain
  // downstage, all in the landed island's biome.

  private renderExplore(): void {
    const s = this.sim, e = s.exp!, W = this.W, H = this.H, t = s.t;
    const L = exploreLayout(W, H, s.hud), sky = SKY[e.biome];
    const hor = L.horizon, cx = L.cx;
    this.exHor = hor;
    // Camera: shake, plus a step's bob while the captain walks. Everything in
    // the world moves together (rects and images through OX/OY).
    const bob = e.walk > 0 ? Math.round(Math.abs(Math.sin(t * 0.45)) * 1.6) : 0;
    this.SX = s.shake > 0 ? Math.round(this.rng(-s.shake, s.shake)) : 0;
    this.SY = (s.shake > 0 ? Math.round(this.rng(-s.shake, s.shake)) : 0) + bob;
    this.OX = this.SX;
    this.OY = this.SY;

    // Backdrop: dithered sky in 8 bands, sun or moon, drifting cloud flats.
    const k = this.stageBake(e, L);
    this.clear(lerpHex(sky[0], INK, 0.6));
    this.image(k.sky, 0, 0);
    // The sea clock sets the hour: the sun sinks through the day and shadows lengthen.
    const day = clamp(s.clock / DAY_FRAMES, 0, 1);
    this.sunLen = 1 + Math.abs(day - 0.45) * 2.2;
    const sun = this.sunSide(e), [sunX, sunY] = this.sunPos(e, L), sunDir = -sun * this.sunLen;
    const lost = e.mood === "lost";
    if (lost) {
      // Lost islands are night stages under a pale moon.
      this.circle(sunX, sunY, 12, "#c7e4ff", 0.12);
      this.circle(sunX, sunY, 6, "#e6f6ff", 0.9);
      this.circle(sunX + 2, sunY - 1, 5, lerpHex(sky[0], INK, 0.5), 0.9);
    } else this.circle(sunX, sunY, 16, sky[2], 0.12);
    if (!lost) this.circle(sunX, sunY, 11, sky[2], 0.22);
    if (!lost) this.circle(sunX, sunY, 7, lerpHex(lerpHex(sky[2], sky[1], 0.3), "#ff9a4d", clamp((day - 0.6) * 2.5, 0, 0.8)), 0.8);
    for (let i = 0; i < 3; i++) {
      const w = 26 + i * 8, x = ((i * 97 + t * (0.05 + i * 0.03)) % (W + w)) - w, y = 26 + L.barH + i * 14;
      if (y > hor - 30) continue;
      this.rect(x, y, w, 3, sky[3], 0.35);
      this.rect(x + 5, y - 2, w - 12, 2, sky[3], 0.35);
    }

    // A low camera: the horizon sits behind the actors' shoulders and the set
    // is built in layers, far to near: a hazy ridge, grey mid rocks and trees,
    // a wash of sky haze, the floor, the actors, then the near wings (a cliff
    // on one side, a big tree on the other) that slide in on every new step.
    // Walking forward: the new step's set pieces start small up the trail and
    // come toward the camera (`ap` 1 → 0), while the last step's near wings
    // swell and sweep out past the edges (`lv` 0 → 1).
    const side = e.step % 2 ? 1 : -1, ap = (e.walk / WALK_FRAMES) ** 1.5, lv = e.walk > 0 ? 1 - e.walk / WALK_FRAMES : 0;
    this.image(k.ridge, -RIDGE_PAD / 2 - Math.round((e.trail * 0.1) % (RIDGE_PAD / 2)), 0);
    if (e.biome === "volcano" && (t >> 4) & 1) this.rect(Math.round(W * 0.3) - 2, hor - 50, 4, 3, "#ffb347");
    // Today's lighthouse, far off on the ridge, on islands that face it.
    if (hash2(e.isleIndex, 9, 61) < 0.5) {
      const lx = cx + sun * W * 0.34, ly = hor - Math.round(hor * 0.12);
      this.stack(this.lighthouse, lx, ly, 0, { k: 0.9 });
      if ((t >> 5) & 1) this.circle(lx, ly - 14, 3, "#fff2a0", 0.6);
    }
    // Far formations on the horizon, nearly lost in haze.
    const nearW = Math.min(W * 0.34, 150), nearK = Math.max(2, Math.min(5.5, nearW / 19));
    for (let i = 0; i < (W > 300 ? 4 : 3); i++) {
      const r = hash2(e.isleIndex, e.step * 7 + i, 41), sgn = i % 2 ? 1 : -1;
      const x = cx + sgn * W * (0.14 + r * 0.32) * (1 - ap * 0.3);
      const a = this.cliff(e.biome, this.rockVariant(e, e.step, 10 + i, false), sgn > 0, 0.72, 0, sun);
      this.stack(a, x, hor - 4, 0, { k: nearK * (0.18 + r * 0.1), outline: false });
    }
    this.fogStrip(k.fog[0], hor - 10, t * 0.15 + e.trail * 0.2);

    const midSlide = Math.round(ap * 0.35 * k.midW);
    this.image(k.midL, midSlide, 0);
    this.image(k.midR, W - k.midRW - midSlide, 0);
    const tree = this.trees[e.biome];
    for (let i = 0; i < (W > 300 ? 4 : 2) * (e.mood === "deep" ? 3 : 1); i++) {
      const r = hash2(e.step, i, 13), sgn = i % 2 ? 1 : -1;
      const x = cx + sgn * W * (0.22 + r * 0.18) * (1 - ap * 0.5);
      this.stack(tree, x, hor + 2, sgn < 0 ? 0 : Math.PI, { k: 0.9 + r * 0.5 });
    }
    this.standCliff(e, L, side as -1 | 1, this.rockVariant(e, e.step, 0, false), nearK * 0.42, hor + 6, -W * 0.16, ap * 0.5, 0, 0.4);
    this.standCliff(e, L, -side as -1 | 1, this.rockVariant(e, e.step, 1, false), nearK * 0.36, hor + 4, -W * 0.06, ap * 0.5, 0, 0.45);
    for (let i = 0; i < (W > 300 ? 6 : 4); i++) {
      const r = hash2(e.step, i, 29), sgn = i % 2 ? 1 : -1, rock = this.rocks[e.biome][i % 4];
      const x = cx + sgn * W * (0.12 + r * 0.3) * (1 - ap * 0.5), y = hor + 3 + Math.round(r * 4);
      this.shadow(rock, x, y, 0, sunDir * 8, 1, 0.22, 0.9);
      this.footing(x, y + 1, Math.round(rock.model.w * (0.7 + r * 0.4) * 0.8), false);
      this.stack(rock, x, y, r * 6, { k: 0.7 + r * 0.4 });
    }
    // A harbour hut from the sea map, on islands that have one by the trail.
    if (this.huts.length && hash2(e.isleIndex, e.step, 33) < 0.35) {
      const hut = this.huts[e.isleIndex % this.huts.length], hx = cx - side * W * (0.2 + hash2(e.isleIndex, e.step, 34) * 0.1) * (1 - ap * 0.5), hy = hor + 5;
      this.shadow(hut, hx, hy, 0, sunDir * 4, 1, 0.25, 1.6);
      this.footing(hx, hy + 1, 10, false);
      this.stack(hut, hx, hy, 0.3, { k: 1.6 });
    }
    this.rect(0, 0, W, hor + 8, FOG[e.biome], 0.18);
    this.fogStrip(k.fog[1], hor - 2, -t * 0.22 + e.trail * 0.5);
    if (!lost) this.image(k.shafts, 0, 0, 0.75 + Math.sin(t * 0.02) * 0.25);

    // Floor: a shallow band at this camera height, stripes rolling toward us.
    const span = H - hor;
    let lastZ = NaN;
    for (let y = hor; y < H; y++) {
      const f = (y - hor) / span, z = 1 / (f + 0.04), band = Math.floor(z * 2.5 + e.trail * 0.25) & 1;
      // Darker toward the camera, sinking into fog toward the horizon.
      const row = y - hor;
      this.rect(0, y, W, 1, k.floor[band][row]);
      const half = this.pathHalf(f, W), bend = this.pathBend(f, e.trail);
      this.rect(cx + bend - half, y, half * 2, 1, k.path[band][row]);
      this.px(cx + bend - half - 1, y, INK, 1, 0.5);
      this.px(cx + bend + half, y, INK, 1, 0.5);
      // Worn dirt along the trail edges, ragged per stripe.
      const zr = Math.floor(z * 8 + e.trail * 0.8), ew = 1 + Math.round(f * 3) + (hash2(zr, 2, 9) < 0.5 ? 1 : 0);
      this.rect(cx + bend - half - 1 - ew, y, ew, 1, k.dirt[row], 0.7);
      this.rect(cx + bend + half + 1, y, ew + (hash2(zr, 3, 9) < 0.4 ? 1 : 0), 1, k.dirt[row], 0.7);
      // Pebbles and ruts on the trail, rolling toward the camera as the captain walks.
      const zi = Math.floor(z * 5 + e.trail * 0.5);
      if (zi !== lastZ) {
        lastZ = zi;
        for (let j = 0; j < 2; j++) {
          const r = hash2(zi, j, 5);
          if (r < 0.55) continue;
          const px = cx + bend + Math.round((hash2(zi, j, 6) - 0.5) * half * 1.7), sz = f > 0.5 ? 2 : 1;
          this.rect(px, y, sz, 1, k.path[band ^ 1][Math.max(0, row - 1)]);
          this.px(px, y + 1, INK, sz, 0.35);
        }
      }
    }

    this.drawGroundPatches(L, e);
    this.drawWaymarks(L, e, ap);
    this.fogStrip(k.fog[2], hor + 8, t * 0.3 + e.trail);
    const scatter = this.floorScatter(L, e);
    const actorY = this.actorY(L, e);
    const drawProp = (p: (typeof scatter)[number]) => {
      this.shadow(p.a, p.x, p.y, 0, sunDir * 3 * p.k, 1, 0.28, p.k);
      this.stack(p.a, p.x, p.y, p.ang, { k: p.k });
    };
    for (const p of scatter) if (p.y <= actorY) drawProp(p);
    if (kindAt(e) === "shrine") this.drawShrineBeam(L, e, actorY);
    this.drawActor(L, e);
    for (const p of scatter) if (p.y > actorY && p.y <= L.captainY) drawProp(p);
    this.drawFootprints(L, e, -side as -1 | 1);
    // Near wings in two passes, so a piece still up the trail stays behind the captain.
    const wings = (front: boolean) => {
      this.wingPass = { front, row: L.captainY };
      this.drawNearWings(e, L, e.step, side as -1 | 1, ap, 0, nearW, nearK, sun);
      if (lv > 0 && e.step > 0) this.drawNearWings(e, L, e.step - 1, -side as -1 | 1, 0, lv, nearW, nearK, sun);
    };
    wings(false);
    this.drawCaptain(L, e, -side as -1 | 1, sunDir);
    for (const p of scatter) if (p.y > L.captainY) drawProp(p);

    // Near wings: the cliff, a cave mouth at the shrine, and a big tree.
    // Two terraced cliffs on the wing side: a tall one behind, a lower one in front.
    wings(true);
    if (k.cavern) {
      // The cave mouth grows out of the trail ahead, anchored on the horizon.
      const c = k.cavern, sc = 1 - ap * 0.7, dw = Math.round(W * sc), dh = Math.round((hor + 28) * sc);
      if (ap <= 0) this.image(c, 0, 0);
      else this.imageRect(c, 0, 0, W, hor + 28, Math.round(cx - dw / 2), Math.round(hor - hor * sc), dw, dh, 1 - ap * 0.6);
    }
    if (e.step === 0 || (e.step === 1 && lv > 0)) this.drawLanding(L, e.step === 0 ? 0 : lv);
    for (const p of s.parts) this.px(p.x, p.y, p.c);
    this.fogStrip(k.fog[3], H - 8, -t * 0.4);
    this.drawWeather(e.biome, hor);
    if (this.stormNear()) this.drawRain(hor);
    // Late in the sea day: warm, then dusk.
    if (day > 0.6) this.rect(0, 0, W, H, "#ff9a4d", Math.min(0.14, (day - 0.6) * 0.5));
    if (day > 0.82) this.rect(0, 0, W, H, "#2a2050", Math.min(0.24, (day - 0.82) * 1.4));
    if (lost) this.rect(0, 0, W, H, "#0a1030", 0.34);
    this.image(k.vignette, 0, 0);
    // Landing: the sea's fog clears off the island.
    if (e.step === 0 && e.t < 36) this.fogCurtain(1 - e.t / 36);
    this.SX = this.SY = this.OX = this.OY = 0;

    if (e.hurt > 0 && !s.calm) this.rect(0, 0, W, H, "#ff3d6e", e.hurt / 40);
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

  private bake: StageBake<Img> | null = null;
  private readonly cliffAtlas = new Map<string, AtlasHandle<Img>>();

  /** A terraced cliff stack, baked on first use. */
  private cliff(biome: BiomeName, variant: number, mirror: boolean, haze = 0, shade = 0, sun: -1 | 0 | 1 = 0, scale: 1 | 2 = 1): AtlasHandle<Img> {
    const key = `${biome}|${variant}|${mirror}|${haze}|${shade}|${sun}|${scale}`;
    let a = this.cliffAtlas.get(key);
    if (!a) {
      if (this.cliffAtlas.size >= 48) {
        const oldest = this.cliffAtlas.keys().next().value;
        if (oldest !== undefined) this.cliffAtlas.delete(oldest);
      }
      a = this.makeAtlas(cliffModel(biome, variant, mirror, FOG[biome], haze, shade, sun, scale));
      this.cliffAtlas.set(key, a);
    }
    return a;
  }

  /** A rock formation for one slot of this island step (one of eight shapes); `tall` skips rubble. */
  private rockVariant(e: Expedition, step: number, slot: number, tall: boolean): number {
    const v = Math.floor(hash2(e.isleIndex, step * 13 + slot, 71) * 8);
    return tall && v % 4 === 3 ? v + 1 : v;
  }

  /**
   * Stand a cliff at one side of the stage, its footprint centred on `y`, and
   * never closer than a few pixels to the trail. `ap` (0..1) pulls it up the
   * trail, smaller, as it approaches; `exit` (0..1) swells it out past the
   * edge and below the frame as the captain walks by.
   */
  private standCliff(e: Expedition, L: ExploreLayout, side: -1 | 1, variant: number, k0: number, y0: number, inset: number, ap: number, exit: number, haze = 0, shade = 0, sun: -1 | 0 | 1 = 0, wingPass = false): void {
    // Fine-grained rock drawn at half the scale: blocks match the captain's.
    const a = this.cliff(e.biome, variant, side > 0, haze, shade, sun, 2);
    const hor = L.horizon, y = Math.round(y0 + (hor + 4 - y0) * ap + exit * exit * this.H * 0.5), k = (k0 / 2) * (1 - ap * 0.75) * (1 + exit * 0.7);
    if (wingPass && !this.inWingPass(y)) return;
    const half = (a.model.w * k) / 2;
    const f = Math.max(0, Math.min(1, (y - hor) / (this.H - hor)));
    const pathEdge = L.cx + this.pathBend(f, e.trail) + side * (this.pathHalf(f, this.W) + 6 + 6 * f);
    const hug = pathEdge + side * half;
    let x = side < 0 ? half - inset : this.W - half + inset;
    x = side < 0 ? Math.min(x, hug) : Math.max(x, hug);
    x = x + (hug - x) * ap + side * exit * exit * this.W * 0.6;
    this.shadow(a, x, y, 0, (sun || -1) * -5 * k * this.sunLen, 2, 0.28, k);
    this.footing(x, y, Math.round(a.model.w * k * 0.9), haze < 0.3);
    this.stack(a, x, y, 0, { k, outline: false });
  }

  /**
   * Where something meets the ground: a dark contact band under it and, with
   * `grass`, blades in the floor's own colour growing up over its base.
   */
  private footing(x: number, y: number, w: number, grass = true): void {
    const b = this.bake;
    if (!b || w < 2) return;
    const row = clamp(Math.round(y) - this.exHor, 0, b.floor[0].length - 1), h = Math.round(w / 2), x0 = Math.round(x) - h;
    this.rect(x0, y - 1, w, 2, INK, 0.28);
    this.rect(x0 + 2, y + 1, Math.max(1, w - 4), 1, INK, 0.14);
    if (!grass) return;
    const g0 = b.floor[0][row], g1 = b.floor[1][row];
    for (let i = 0; i < w; i += 2) {
      const r = hash2(x0 + i, Math.round(y), 19);
      if (r < 0.4) continue;
      const len = 1 + Math.round(r * 4);
      this.rect(x0 + i, y - len, 1, len + 1, r > 0.75 ? g1 : g0);
    }
  }

  /** Patches of the island's other ground (grass on sand, sand on grass…), rolling toward the camera. */
  private drawGroundPatches(L: ExploreLayout, e: Expedition): void {
    const W = this.W, span = this.H - L.horizon, alt = this.bake!.alt, rows = 8, walked = e.trail * 0.05, phase = walked % 1, base = Math.floor(walked);
    for (let i = 0; i < rows; i++) {
      const d = (i + phase) / rows, f = d * d, id = base - i, yc = Math.round(L.horizon + 3 + f * (span - 3));
      const half = this.pathHalf(f, W), bend = this.pathBend(f, e.trail);
      for (let j = 0; j < 2; j++) {
        const r = hash2(id, j, 71);
        if (r < 0.35) continue;
        const sgn = j ? 1 : -1, pw = Math.round((10 + r * 40) * (0.3 + f)), ph = Math.max(1, Math.round((1 + r * 3) * (0.4 + f * 2)));
        const pcx = L.cx + bend + sgn * (half + 6 + pw / 2 + r * W * 0.15 * (0.3 + f));
        for (let k = 0; k < ph; k++) {
          const u = (k + 0.5) / ph - 0.5, w = Math.round(pw * Math.sqrt(1 - 4 * u * u) + hash2(id, k, j) * 3), y = yc - ph + k;
          if (y < L.horizon || y >= this.H) continue;
          this.rect(Math.round(pcx - w / 2), y, w, 1, alt[y - L.horizon]);
        }
      }
    }
  }

  /**
   * Marks of the project on the trail: pennants in its colour on the shore,
   * and on crossroads islands, extra signposts at the trail's edge.
   */
  private drawWaymarks(L: ExploreLayout, e: Expedition, ap: number): void {
    const span = this.H - L.horizon, t = this.sim.t, kind = kindAt(e);
    if ((kind === "shore" || kind === "camp") && e.project) {
      for (const sgn of [-1, 1]) {
        const f = 0.22 + (sgn > 0 ? 0.06 : 0), y = Math.round(L.horizon + f * span * (1 - ap * 0.6)), sc = 1 + f * 2;
        const x = L.cx + this.pathBend(f, e.trail) + sgn * (this.pathHalf(f, this.W) + 6 * sc), ph = Math.round(14 * sc);
        this.rect(x, y - ph, Math.max(1, Math.round(sc * 0.7)), ph, "#3a2416");
        for (let i = 0; i < Math.round(7 * sc); i++) {
          const wave = Math.round(Math.sin(t * 0.12 + i * 0.6) * sc);
          this.rect(x + 1 + i, y - ph + wave, 1, Math.max(1, Math.round((4 - i * 0.4) * sc * 0.8)), i % 3 ? e.project.accent : lerpHex(e.project.accent, "#ffffff", 0.3));
        }
      }
    }
    if (e.mood === "crossroads" && kind !== "fork") {
      for (const sgn of [-1, 1]) {
        const f = 0.35, y = Math.round(L.horizon + f * span), x = L.cx + this.pathBend(f, e.trail) + sgn * (this.pathHalf(f, this.W) + 10);
        this.footing(x, y + 1, 6, false);
        this.stack(this.sign, x, y, sgn > 0 ? 0.6 : -0.6, { k: 1.2 });
      }
    }
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

  /** Which side the sun hangs on for this island: +1 right, -1 left. */
  private sunSide(e: Expedition): -1 | 1 {
    return hash2(e.isleIndex, 3, 77) < 0.5 ? 1 : -1;
  }
  private sunPos(e: Expedition, L: ExploreLayout): [number, number] {
    const span = L.rx - L.lx;
    const day = clamp(this.sim.clock / DAY_FRAMES, 0, 1);
    return [Math.round(this.sunSide(e) > 0 ? L.rx - span * 0.22 : L.lx + span * 0.22), Math.round(L.horizon * (0.3 + day * 0.5))];
  }

  private inWingPass(y: number): boolean {
    return y > this.wingPass.row === this.wingPass.front;
  }

  /** One step's near wings: two cliffs on `side`, and a tree or rock heap opposite. */
  private drawNearWings(e: Expedition, L: ExploreLayout, step: number, side: -1 | 1, ap: number, exit: number, nearW: number, nearK: number, sun: -1 | 1): void {
    const H = this.H, hor = L.horizon;
    this.standCliff(e, L, side, this.rockVariant(e, step, 2, true), nearK * 0.8, hor + Math.round((H - hor) * 0.35), nearW * 0.05, ap, exit, 0.12, 0, sun, true);
    this.standCliff(e, L, side, this.rockVariant(e, step, 3, false), nearK, H + Math.round(nearK * 4), nearW * 0.25, ap, exit, 0, 0.12, sun, true);
    this.drawNearProp(e, L, step, -side as -1 | 1, ap, exit, nearW, nearK, sun);
  }

  /** The near wing opposite the cliff: a big tree, a rock heap, or a smaller tree with a boulder. */
  private drawNearProp(e: Expedition, L: ExploreLayout, step: number, side: -1 | 1, ap: number, exit: number, nearW: number, nearK: number, sun: -1 | 1): void {
    const W = this.W, H = this.H, hor = L.horizon, pick = hash2(e.isleIndex, step, 91);
    if (pick < 0.3) {
      this.standCliff(e, L, side, 3 + (step & 1) * 4, nearK * 0.95, H + Math.round(nearK * 2), nearW * 0.1, ap, exit, 0, 0.1, sun, true);
      return;
    }
    // Approach and exit, as for the cliffs: up the trail and small, or swollen and swept out.
    const grow = (1 - ap * 0.75) * (1 + exit * 0.7), drop = exit * exit * H * 0.5;
    const yAt = (y0: number) => Math.round(y0 + (hor + 4 - y0) * ap + drop);
    const xAt = (x0: number, y: number) => {
      const f = Math.max(0, Math.min(1, (y - hor) / (H - hor)));
      const hug = L.cx + this.pathBend(f, e.trail) + side * (this.pathHalf(f, W) + 10);
      return x0 + (hug - x0) * ap + side * exit * exit * W * 0.6;
    };
    const tk = Math.min(2.3, H / 140) * (pick < 0.65 ? 1 : 0.78) * grow, ty = yAt(H - 6);
    const tx = xAt((side > 0 ? W - nearW * 0.45 : nearW * 0.45) + (pick < 0.65 ? 0 : side * nearW * 0.12), ty);
    const big = this.nearTrees[e.biome];
    if (this.inWingPass(ty)) {
      this.shadow(big, tx, ty, 0, -sun * 16 * tk * this.sunLen, 2, 0.3, tk);
      this.footing(tx, ty, Math.round(10 * tk));
      this.stack(big, tx, ty, side > 0 ? Math.PI : 0, { k: tk, lift: 1.4 });
    }
    if (pick >= 0.65 && this.inWingPass(yAt(H - 2))) {
      const rock = this.rocks[e.biome][2], rk = tk * 1.4, ry = yAt(H - 2), rx = xAt(tx + side * nearW * 0.3, ry);
      this.shadow(rock, rx, ry, 0, -sun * 4 * rk * this.sunLen, 1, 0.3, rk);
      this.footing(rx, ry, Math.round(rock.model.w * rk * 0.8));
      this.stack(rock, rx, ry, pick * 6, { k: rk });
    }
  }

  /**
   * Step 1 is the shoreline, and the sea is behind the camera: surf laps at
   * the bottom of the frame beside the beached rowboat. Walking on (`exit`
   * 0 → 1), both slide down out of view, behind the captain.
   */
  private drawLanding(L: ExploreLayout, exit: number): void {
    const W = this.W, H = this.H, t = this.sim.t, e2 = exit * exit, drop = Math.round(e2 * 60), k = (W >= 300 ? 3.2 : 2.4) * (1 + exit * 0.6);
    const sea = "#2b6c8f", sy = H - 6 + drop;
    if (sy < H) {
      this.rect(0, sy, W, H - sy, sea, 0.85);
      for (let x = (t >> 3) % 6; x < W; x += 6) this.rect(x, sy + ((x >> 3) & 1), 3, 1, "#ffffff", 0.7);
      this.rect(0, sy - 2, W, 2, "#3a2416", 0.25);
    }
    const bx = L.cx - W * (0.2 + e2 * 0.35), by = H - 10 + drop;
    this.shadow(this.rowboat, bx, by, 0.5, 6, 2, 0.3, k);
    this.footing(bx, by + 2, Math.round(10 * k), false);
    this.stack(this.rowboat, bx, by, 0.5, { k });
    // A turtle basking by the boat, and now and then a dolphin breaking the surf.
    const tx = bx + W * 0.16, ty = H - 9 + drop;
    this.footing(tx, ty + 1, Math.round(6 * k * 0.7), false);
    this.stack(this.turtle, tx, ty, 0.9 + Math.sin(t * 0.05) * 0.08, { k: k * 0.7 });
    const p = (t % 260) / 50;
    if (p < 1 && sy < H) {
      const dx = W * (0.62 + p * 0.25), dy = sy + 2 - Math.round(Math.sin(p * Math.PI) * 10);
      this.stack(this.dolphin, dx, dy, Math.PI / 2 - (p - 0.5) * 1.2, { k: 1.6 });
    }
  }

  /** A shaft of light falling on the shrine inside the cave. */
  private drawShrineBeam(L: ExploreLayout, e: Expedition, y: number): void {
    const x = L.cx + this.pathBend((y - L.horizon) / (this.H - L.horizon), e.trail), top = L.card.y + L.card.h, t = this.sim.t;
    const a = 0.06 + Math.sin(t * 0.04) * 0.015;
    // Three nested cones: brightest in the core.
    for (let i = 0; i < 3; i++) {
      const w0 = 8 + i * 6, w1 = 16 + i * 12;
      for (let yy = top; yy < y + 4; yy += 4) {
        const u = (yy - top) / Math.max(1, y - top), w = Math.round(w0 + (w1 - w0) * u);
        this.rect(x - w / 2, yy, w, 4, "#fff2c0", a);
      }
    }
    this.circle(x, y + 1, 14, "#fff2c0", 0.12);
  }

  /** Bootprints on the trail behind the captain, rolling toward the camera as the captain walks. */
  private drawFootprints(L: ExploreLayout, e: Expedition, side: -1 | 1): void {
    const span = this.H - L.horizon, rows = 16, walked = e.trail * 0.08, phase = walked % 1, base = Math.floor(walked);
    const fCap = (L.captainY - L.horizon) / span, off = this.captainOff(L, e, side);
    for (let i = 0; i < rows; i++) {
      const d = (i + phase) / rows, f = d * d, y = Math.round(L.horizon + f * span);
      if (y <= L.captainY + 2 || y >= this.H) continue;
      const id = base - i, foot = id & 1 ? 1 : -1, sc = 1 + f;
      const x = L.cx + this.pathBend(f, e.trail) + off * (f / fCap) + foot * 2 * sc;
      this.rect(x - sc, y, Math.round(2 * sc), 1, INK, 0.3);
    }
  }

  /** How far the captain stands off the trail's centre (over-the-shoulder camera). */
  private captainOff(L: ExploreLayout, e: Expedition, side: -1 | 1): number {
    const f = (L.captainY - L.horizon) / (this.H - L.horizon);
    return side * Math.round(this.pathHalf(f, this.W) * 0.8);
  }

  /** Baked layers for this island step and screen size (rebuilt when either changes). */
  private stageBake(e: Expedition, L: ExploreLayout): StageBake<Img> {
    const W = this.W, H = this.H, hor = L.horizon, key = `${e.isleIndex}|${e.biome}|${e.step}|${W}|${H}|${hor}|${L.card.y + L.card.h}`;
    if (this.bake?.key === key) return this.bake;
    const prev = this.bake, sameScene = prev?.sceneKey === `${e.biome}|${W}|${H}|${hor}`;
    const B = BIOMES[e.biome], sky = SKY[e.biome], fog = FOG[e.biome], rock = B.bands[3], haze = sky[1];
    const img = (b: Baked) => this.makeImage(b.w, b.h, b.bytes);
    const side = e.step % 2 ? 1 : -1;
    const [sunX, sunY] = this.sunPos(e, L), sunKey = `${sunX}|${sunY}`;
    const [gi, pi] = FLOOR[e.biome], ground = B.bands[gi], path = B.bands[pi], span = H - hor;
    const shade = (c: string, f: number) => lerpHex(lerpHex(c, INK, 0.15 + f * 0.4), fog, (1 - f) ** 2 * 0.55);
    const rows = (c: string) => Array.from({ length: span }, (_, r) => shade(c, r / span));
    const midCol = rock.map((c) => lerpHex(haze, c, 0.6)), near = rock.map((c) => lerpHex(c, INK, 0.45));
    const midW = Math.min(W * 0.36, 150);
    const midL = bakeCliff(-1, midW, hor - Math.round(hor * 0.55), hor + 6, midCol, e.step * 7 + 3, false, null);
    const midR = bakeCliff(1, midW * 0.8, hor - Math.round(hor * 0.35), hor + 6, midCol, e.step * 7 + 5, false, null);
    this.bake = {
      key,
      sceneKey: `${e.biome}|${W}|${H}|${hor}`,
      sky: sameScene ? prev!.sky : img(bakeSky(W, hor, lerpHex(sky[0], INK, 0.6), lerpHex(sky[1], fog, 0.5))),
      vignette: sameScene ? prev!.vignette : img(bakeVignette(W, H)),
      fog: sameScene ? prev!.fog : [img(bakeFog(22, fog, 0.85, 1)), img(bakeFog(18, fog, 0.9, 2)), img(bakeFog(14, fog, 0.6, 3)), img(bakeFog(14, fog, 0.3, 4))],
      fogH: [22, 18, 14, 14],
      floor: sameScene ? prev!.floor : [rows(ground[1]), rows(ground[0])],
      path: sameScene ? prev!.path : [rows(path[2]), rows(path[1])],
      ridge: img(bakeRidge(W, RIDGE_PAD, hor, -side as -1 | 1, e.step, e.biome === "volcano", lerpHex(haze, rock[0], 0.4), lerpHex(haze, rock[2], 0.4))),
      midL: img(midL),
      midR: img(midR),
      midRW: midR.w,
      midW,
      dirt: sameScene ? prev!.dirt : rows(lerpHex(path[0], INK, 0.2)),
      alt: sameScene ? prev!.alt : rows(B.bands[gi > 0 ? gi - 1 : gi + 1][1]),
      shafts: sameScene && prev!.sunKey === sunKey ? prev!.shafts : img(bakeShafts(W, hor + 24, sunX, sunY, lerpHex(sky[2], "#fff4d8", 0.5), e.isleIndex)),
      sunKey,
      cavern: kindAt(e) === "shrine" ? img(bakeCavern(W, L.card.y + L.card.h + 6, hor, near, CAVE_DRIP[e.biome], side as -1 | 1)) : null,
    };
    return this.bake;
  }

  /** Draw a tiling fog strip centred on row `y`, scrolled by `drift`. */
  private fogStrip(img: Img, y: number, drift: number): void {
    const h = this.bake!.fogH[this.bake!.fog.indexOf(img)];
    const o = ((Math.round(drift) % FOG_STRIP) + FOG_STRIP) % FOG_STRIP;
    for (let x = -o; x < this.W; x += FOG_STRIP) this.image(img, x, y - h);
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

  private pathHalf(f: number, W: number): number {
    return Math.round(3 + f * Math.min(W * 0.14, 50));
  }
  private pathBend(f: number, trail: number): number {
    return Math.round(Math.sin(trail * 0.05 + (1 - f) * 2.2) * (1 - f) * 14);
  }

  /** Pebbles and tufts beside the trail, rolling toward the camera as the captain walks. */
  private floorScatter(L: ExploreLayout, e: Expedition): { a: AtlasHandle<Img>; x: number; y: number; k: number; ang: number }[] {
    const W = this.W, span = this.H - L.horizon, out: { a: AtlasHandle<Img>; x: number; y: number; k: number; ang: number }[] = [];
    const rows = 7, walked = e.trail * 0.05, phase = walked % 1, base = Math.floor(walked), props = this.floorProps[e.biome];
    for (let i = 0; i < rows; i++) {
      const d = (i + phase) / rows, f = d * d, id = base - i;
      const y = Math.round(L.horizon + 6 + f * (span - 6)), half = this.pathHalf(f, W), bend = this.pathBend(f, e.trail);
      for (let j = 0; j < (W > 300 ? 4 : 3); j++) {
        const r = hash2(id, j, 57);
        if (r < 0.25) continue;
        const sgn = j % 2 ? 1 : -1, gap = 4 + r * (W * 0.32) * (0.3 + f);
        out.push({ a: props[r < 0.55 ? 0 : 1], x: L.cx + bend + sgn * (half + gap), y, k: 0.5 + f * 1.5, ang: r * 6 });
      }
    }
    return out.sort((a, b) => a.y - b.y);
  }

  private actorY(L: ExploreLayout, e: Expedition): number {
    return Math.round(L.foeY - (e.walk / WALK_FRAMES) * (L.foeY - L.horizon) * 0.6);
  }

  private tent(accent: string): AtlasHandle<Img> {
    let a = this.tents.get(accent);
    if (!a) {
      a = this.makeAtlas(tentModel(accent));
      this.tents.set(accent, a);
    }
    return a;
  }

  /** What stands on the trail for this step. */
  private actorAtlas(e: Expedition): AtlasHandle<Img> {
    switch (kindAt(e)) {
      case "ambush":
      case "den":
      case "overdue":
        return e.foe < 0 ? this.ghost : this.foes[e.biome][e.foe % this.foes[e.biome].length];
      case "cache":
        return this.chest;
      case "camp":
        return this.tent(e.project?.accent ?? "#c9a06a");
      case "hermit":
        return this.hermit;
      case "wreck":
        return this.wreck;
      case "trap":
        return this.cairn;
      case "shrine":
        return this.shrine;
      default:
        return this.sign;
    }
  }

  private drawActor(L: ExploreLayout, e: Expedition): void {
    const t = this.sim.t, kind = kindAt(e), near = 1 - (e.walk / WALK_FRAMES) * 0.6, fight = isFight(kind);
    const y = this.actorY(L, e), f = (y - L.horizon) / (this.H - L.horizon), x = L.cx + this.pathBend(f, e.trail);
    // Floor-level set pieces: a gorge with a rope bridge, or a river ford.
    if (kind === "bridge") return this.drawBridge(e, x, y, f);
    if (kind === "ford") return this.drawFord(e, x, y, f);
    const big = kind === "den" ? 1.35 : kind === "overdue" ? 1.15 : 1;
    const base = fight ? 2.2 : kind === "wreck" ? 1.5 : kind === "camp" ? 1.7 : 1.8;
    const k = base * big * near, flash = e.hit > 0 && (t & 2) > 0;
    const bob = Math.round(Math.sin(t * 0.1) * (fight ? 1.5 : 0.5));
    const atlas = this.actorAtlas(e);
    const recoil = e.hit > 0 ? -Math.round(e.hit / 3) : 0;
    const floats = fight && (e.foe < 0 || (e.biome === "tundra" && e.foe === 0));
    const lift = floats ? 4 + Math.round(Math.sin(t * 0.06) * 2) : 0;
    // Camps and wrecks sit beside the trail, on the side away from the captain.
    const away = e.step % 2 ? 1 : -1;
    const ax = kind === "camp" || kind === "wreck" ? x + away * Math.round(this.pathHalf(f, this.W) + atlas.model.w * k * 0.4) : x;
    this.shadow(atlas, ax, y, 0, -5, 2, lift ? 0.2 : 0.35, k);
    if (!lift) this.footing(ax, y + 1, Math.round(atlas.model.w * k * 0.7), false);
    this.stack(atlas, ax, y + bob + recoil - lift, kind === "wreck" ? 0.4 : 0, { k, flash });
    if (kind === "overdue") for (let i = 0; i < 3; i++) this.px(x - 8 + i * 8 + Math.round(Math.sin(t * 0.2 + i) * 2), y - Math.round(atlas.model.h * k) - 10 - ((t + i * 7) % 12), "#c7d0e6", 2, 0.7);
    if (kind === "shrine" && (t >> 3) & 1) this.circle(x, y - Math.round(14 * k), 2, "#4cc9f0", 0.8);
    if (kind === "hermit" && (t >> 4) & 1) this.circle(ax + Math.round(4 * k), y - Math.round(16 * k), 3, "#ffd23c", 0.35);
    if (kind === "camp") {
      // A campfire by the tent, and the crate if one is waiting.
      const fx = ax - away * Math.round(atlas.model.w * k * 0.7), fy = y + 2;
      this.rect(fx - 4, fy - 1, 8, 2, "#3a2416");
      for (let i = 0; i < 4; i++) this.px(fx - 2 + (i % 2) * 3, fy - 3 - ((t >> 2) + i * 3) % 6, i % 2 ? "#ffb347" : "#ff5e3a", 2, 0.9);
      if (e.crate && !e.crateTaken) {
        const bx = x - 5 - away * 2;
        this.rect(bx, y - 9, 10, 9, INK);
        this.rect(bx + 1, y - 8, 8, 7, "#c9a06a");
        this.rect(bx + 1, y - 5, 8, 1, "#8a5a32");
      }
    }
    if (kind === "fork" && e.routes && e.walk === 0) this.drawForkSigns(e, x, y - Math.round(atlas.model.h * k) - 6);
    if (fight && e.walk === 0) {
      const w = 32, top = y - Math.round(atlas.model.h * k) - Math.round(atlas.model.d * k * 0.5) - 8 - lift;
      this.rect(x - w / 2 - 1, top - 1, w + 2, 4, INK);
      this.rect(x - w / 2, top, Math.round((w * e.foeHp) / Math.max(1, e.foeMax)), 2, kind === "overdue" ? "#c7d0e6" : "#ff3d6e");
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

  /** A gorge across the floor, spanned by a sagging plank bridge on the trail. */
  private drawBridge(e: Expedition, x: number, y: number, f: number): void {
    const W = this.W, gh = Math.max(3, Math.round(4 + f * 14)), half = this.pathHalf(f, W) + 2, t = this.sim.t;
    this.rect(0, y - gh, W, gh, INK, 0.92);
    this.rect(0, y - gh, W, 1, lerpHex(FOG[e.biome], INK, 0.5));
    for (let i = 0; i < 6; i++) this.rect(((i * 53 + 11) % W), y - gh + 2 + (i % 3), 2, 1, "#4cc9f0", 0.25);
    const sag = Math.round(Math.sin(t * 0.05) * 1);
    for (let px = x - half; px < x + half; px += Math.max(2, Math.round(2 + f * 3))) {
      const u = (px - x) / half, py = y - gh + Math.round((1 - u * u) * gh * 0.35) + sag;
      this.rect(px, py, Math.max(1, Math.round(1 + f * 2)), Math.max(2, Math.round(gh * 0.5)), (px >> 2) & 1 ? "#8a5a32" : "#6e4426");
    }
    this.rect(x - half - 1, y - gh - Math.round(4 + f * 6), 1, Math.round(4 + f * 6) + gh, "#3a2416");
    this.rect(x + half, y - gh - Math.round(4 + f * 6), 1, Math.round(4 + f * 6) + gh, "#3a2416");
    this.line(x - half, y - gh - Math.round(3 + f * 5), x + half, y - gh - Math.round(3 + f * 5) + 2, "#c9a06a", 0.9);
  }

  /** A river across the trail with stepping stones and fish glinting. */
  private drawFord(e: Expedition, x: number, y: number, f: number): void {
    const W = this.W, h = Math.max(3, Math.round(3 + f * 12)), t = this.sim.t, water = lerpHex("#2b6c8f", FOG[e.biome], 0.25);
    this.rect(0, y - h, W, h, water);
    this.rect(0, y - h, W, 1, lerpHex(water, "#ffffff", 0.3));
    this.rect(0, y - 1, W, 1, lerpHex(water, INK, 0.4));
    for (let i = 0; i < 10; i++) this.rect(((i * 47 + (t >> 1) * (1 + (i % 3))) % (W + 10)) - 5, y - h + 1 + ((i * 5) % Math.max(1, h - 2)), 4, 1, "#e6f6ff", 0.6);
    const sw = Math.max(2, Math.round(2 + f * 4));
    for (let i = -1; i <= 1; i++) {
      const sx = x + i * sw * 2 + (i === 0 ? 0 : (hash2(i, 3, 4) - 0.5) * sw);
      this.rect(Math.round(sx - sw / 2), y - Math.round(h * 0.65), sw, Math.max(1, Math.round(h * 0.4)), "#8a8a92");
      this.rect(Math.round(sx - sw / 2), y - Math.round(h * 0.65), sw, 1, "#b8b8c0");
    }
    if ((t % 90) < 12) this.rect(x + W * 0.18, y - h - 3 + ((t % 90) >> 2), 3, 2, "#c7e4ff");
  }

  private drawCaptain(L: ExploreLayout, e: Expedition, side: -1 | 1, sunDir: number): void {
    const t = this.sim.t, k = this.W >= 220 ? 2.3 : 1.9;
    const walking = e.walk > 0;
    if (walking || e.swing > 0 || e.hurt > 0 || e.phase !== "step" || isFight(kindAt(e))) this.capBusy = t;
    const idle = t - this.capBusy, glass = idle > 70 && idle % 480 < 300;
    const bob = walking ? Math.round(Math.abs(Math.sin(t * 0.45)) * 3) : Math.round(Math.sin(t * 0.08));
    const sw = e.swing > 0 ? Math.sin((e.swing / 14) * Math.PI) : 0;
    // Over the shoulder: off to one side of the trail, turned three-quarters toward it.
    const x = L.cx + this.captainOff(L, e, side), y = L.captainY - Math.round(sw * 8);
    const turn = -side * 0.42, sway = walking ? Math.sin(t * 0.45) * 0.08 : glass ? Math.sin(t * 0.03) * 0.05 : 0;
    const atlas = glass ? this.captainGlass : this.captain;
    this.shadow(atlas, x, L.captainY, turn, sunDir * 7, 2, 0.35, k);
    this.footing(x, L.captainY + 1, Math.round(8 * k), false);
    this.stack(atlas, x, y - bob, turn + sway + sw * 0.25 * side, { k, flash: e.hurt > 0 && (t & 2) > 0 });
    if (e.swing > 3) {
      // Cutlass arc, sweeping up toward the foe.
      const r = 22, a0 = -Math.PI * 0.85, a1 = -Math.PI * (0.85 - (1 - e.swing / 14) * 0.7);
      const ay = y - Math.round(this.captain.model.h * k * 0.75);
      for (let a = a0; a <= a1; a += 0.08) this.px(x - side * 6 + Math.cos(a) * r, ay + Math.sin(a) * r * 0.6, "#ffffff", 2, 0.85);
    }
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
