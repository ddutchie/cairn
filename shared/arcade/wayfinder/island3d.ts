/**
 * The island expedition stage in real 3D, drawn with the shared software
 * rasterizer (`pixel/raster3d.ts`).
 *
 * The island the captain walks is the island seen from the sea: its ground is
 * the sea map's own elevation (`sim.E`) around the landed isle, so the sea and
 * the stage agree. A trail spirals from the beach where the boat put in up to
 * the summit; each step of the expedition's deck is a station on it, with that
 * step's encounter standing a little further up. The camera rides over the
 * captain's shoulder and walks the trail between stations.
 *
 * Landing is a fly-in: the stage starts straight overhead, framed exactly like
 * the sea view (one sea-map pixel per screen pixel), and dives down to the
 * captain's shoulder over `LANDING_FRAMES`.
 */

import { lerpHex } from "../pixel/kinds";
import { INK } from "../pixel/painter";
import { Framebuffer3D, fbSizeFor, makeCam3D, meshFromModel, worldToCam, type Cam3D, type Mesh3D } from "../pixel/raster3d";
import { BIOMES, fbm, hash2, rgb, type BiomeName } from "../pixel/terrain";
import type { Model } from "../pixel/models";
import { LANDING_FRAMES, WALK_FRAMES, isFight, kindAt, type Expedition, type StepKind } from "./expedition";
import { CAIRN_MODEL, CAPTAIN_GLASS_MODEL, CAPTAIN_MODEL, CHEST_MODEL, BOAT_MODEL, FOE_ROSTER, GHOST_FOE, HERMIT_MODEL, ROWBOAT_MODEL, SHRINE_MODEL, SIGN_MODEL, WRECK_MODEL, tentModel } from "./models";
import { buildScenery } from "./scenery3d";
import { DAY_FRAMES, HD, RELIEF, WD, type WayfinderSim } from "./sim";

/** Sky per biome: zenith, horizon, sun, cloud. */
export const STAGE_SKY: Record<BiomeName, [string, string, string, string]> = {
  tropic: ["#3f8fd2", "#b9e3f2", "#fff2a0", "#e6f6ff"],
  desert: ["#4d6fb8", "#f6c48a", "#fff0a8", "#fde3c0"],
  tundra: ["#24447a", "#c8d6e8", "#e6f2ff", "#dfe9f4"],
  volcano: ["#3b2338", "#ef6a24", "#ffb347", "#6e4a46"],
};
/** Ground and trail band indices into `BIOMES[b].bands`. */
export const STAGE_FLOOR: Record<BiomeName, [number, number]> = { tropic: [1, 0], desert: [0, 2], tundra: [4, 0], volcano: [0, 3] };
/** Fog colour per biome: sea mist, dust haze, freezing fog, volcanic smoke. */
export const STAGE_FOG: Record<BiomeName, string> = { tropic: "#cfe6ee", desert: "#e8cfa8", tundra: "#e6eef8", volcano: "#6e5a5a" };

const FOV = 55;
/** The sea map uses tropic water everywhere; the stage's sea matches it. */
const WATER = BIOMES.tropic.water.map((c) => pack(rgb(c)));
/** Coarse ground around the island (the rest of the archipelago), in sea-map pixels per cell. */
const COARSE = 4;
/** How far past the island the walking stage still draws its neighbours, in sea-map pixels. */
const NEIGHBOURS = 70;
/** Camera: how far behind and above the captain, and how far to the right. */
const CAM_BACK = 112, CAM_UP = 27, CAM_SIDE = -12;
/** The captain keeps to the left of the trail, so what waits up it stays in view over the right shoulder. */
const CAP_SIDE = 8;
/** The step's encounter stands this share of a step up the trail from the captain's station. */
const AHEAD = 0.72;
/** How much the walking camera turns toward the encounter ahead (1) rather than down the trail (0). */
const LOOK_AT = 0.8;
/** Props smaller than this on screen (radius, framebuffer pixels) are skipped; under PROP_FULL_PX they use their LOD mesh. */
const PROP_MIN_PX = 2, PROP_FULL_PX = 12;

function pack(c: readonly number[]): number {
  return (c[0] << 16) | (c[1] << 8) | c[2];
}
function packHex(h: string): number {
  return pack(rgb(h));
}
const smooth = (u: number) => u * u * (3 - 2 * u);

interface Grid {
  /** Sea-map pixels per cell. */
  step: number;
  /** Top-left node, in sea-map pixels. */
  px0: number;
  py0: number;
  nx: number;
  ny: number;
  /** Node heights, in 3D units. */
  z: Float32Array;
  /** Drawable land cells: [cell index, colour A, colour B, on the trail corridor] … (a colour of -1 skips that triangle). */
  cells: Int32Array;
  /** Runs of sea along each row: [row, i0, i1, colour] … */
  sea: number[];
}

interface Prop {
  mesh: Mesh3D;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

interface IslandBake {
  key: string;
  /** 3D units per sea-map pixel on this island. */
  S: number;
  /** Island centre in sea-map pixels: local 3D (0, 0). */
  ox: number;
  oy: number;
  /** Fine ground along the trail, the island's own ground, and the archipelago round it. */
  path: Grid;
  fine: Grid;
  coarse: Grid;
  /** The trail as a dense polyline in local units, with running length. */
  tx: Float32Array;
  ty: Float32Array;
  tlen: Float32Array;
  stepLen: number;
  props: Prop[];
  /** Pennants on the beach, in the project's colour. */
  beach: { x: number; y: number }[];
  sun: -1 | 1;
}

/** The trail as the ground sees it: sea-map polyline, its graded height, and a bucket index for nearest-point lookups. */
interface TrailShape {
  x: number[];
  y: number[];
  z: number[];
  /** Segment indices per BUCKET-pixel cell, row-major over the trail's box (`bx0`, `by0`, `bw` × `bh` cells). */
  buckets: (number[] | undefined)[];
  bx0: number;
  by0: number;
  bw: number;
  bh: number;
}

const BUCKET = 4;
/** Trail half-width and the bank it's graded into, in stage units. */
const PATH_HALF = 11, PATH_BANK = 16;
/** The fine corridor round the trail: its cell size and reach, in sea-map pixels. */
const PATH_CELL = 0.5, PATH_REACH = 4.2;
/** The half-pixel corridor is drawn this near the camera (stage units); further on, the pixel grid's own trail takes over. */
const PATH_NEAR = 330;

/** Where 2D overlays hang: screen points the renderer draws over the 3D frame. */
export interface StageAnchors {
  /** Above the step's encounter (health bar, fork signs). */
  actorTop: { x: number; y: number } | null;
  /** Foot of the encounter (the shrine's beam, the camp's fire). */
  actorFoot: { x: number; y: number } | null;
  /** The sun on screen (or null when it's behind the camera). */
  sun: { x: number; y: number } | null;
  /** 0 → 1 over the landing fly-in; 1 once the camera is on the captain's shoulder. */
  landing: number;
}

export class IslandStage3D {
  fb: Framebuffer3D;
  private W = 0;
  private H = 0;
  private bake: IslandBake | null = null;
  private readonly meshes = new Map<Model, Mesh3D>();
  private readonly tents = new Map<string, Mesh3D>();
  private cam: Cam3D | null = null;

  constructor(private readonly sim: WayfinderSim) {
    this.fb = new Framebuffer3D(1, 1);
  }

  resize(W: number, H: number): void {
    if (W === this.W && H === this.H) return;
    this.W = W;
    this.H = H;
    const s = fbSizeFor(W, H);
    this.fb = new Framebuffer3D(s.w, s.h);
  }

  private mesh(m: Model): Mesh3D {
    let me = this.meshes.get(m);
    if (!me) {
      me = meshFromModel(m, 1, 1);
      this.meshes.set(m, me);
    }
    return me;
  }

  private tent(accent: string): Mesh3D {
    let me = this.tents.get(accent);
    if (!me) {
      me = meshFromModel(tentModel(accent), 1, 1);
      this.tents.set(accent, me);
    }
    return me;
  }

  // ── Elevation ──────────────────────────────────────────────────────────────

  /** Sea-map elevation at a fractional sea-map pixel (bilinear; below 0 is sea). */
  private elev(px: number, py: number): number {
    const E = this.sim.E;
    const x = Math.max(0, Math.min(WD - 1.001, px)), y = Math.max(0, Math.min(HD - 1.001, py));
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, o = y0 * WD + x0;
    const a = E[o] + (E[o + 1] - E[o]) * fx, b = E[o + WD] + (E[o + WD + 1] - E[o + WD]) * fx;
    return a + (b - a) * fy;
  }

  /** The island's own ground (stage units) at a sea-map point, before the trail is cut into it. */
  private natural(px: number, py: number, S: number): number {
    const e = this.elev(px, py);
    if (e <= 0) return Math.max(-14, e * 40);
    const detail = (fbm(px * 0.22, py * 0.22, 7) - 0.5) * Math.min(1, e * 2.2);
    return 1.5 + (e * RELIEF * 1.15 + detail * 3.4) * S;
  }

  /** The trail's height at the point `nearTrail` last found. */
  private nearZ = 0;

  /**
   * Distance (sea-map pixels) from a point to the trail, leaving the trail's
   * height at the nearest point in `nearZ`. Only segments within a bucket of
   * the point are searched, so anything further than BUCKET is Infinity.
   * The bake calls this several times a ground node, so it allocates nothing.
   */
  private nearTrail(tr: TrailShape, px: number, py: number): number {
    const bx = Math.floor(px / BUCKET) - tr.bx0, by = Math.floor(py / BUCKET) - tr.by0;
    this.nearZ = 0;
    if (bx < -1 || by < -1 || bx > tr.bw || by > tr.bh) return Infinity;
    const xs = tr.x, ys = tr.y, zs = tr.z, last = xs.length - 1;
    let best = Infinity;
    for (let j = Math.max(0, by - 1); j <= Math.min(tr.bh - 1, by + 1); j++) {
      for (let i = Math.max(0, bx - 1); i <= Math.min(tr.bw - 1, bx + 1); i++) {
        const list = tr.buckets[j * tr.bw + i];
        if (!list) continue;
        for (let n = 0; n < list.length; n++) {
          const k = list[n];
          if (k >= last) continue;
          // Distance to the segment k → k + 1.
          const ax = xs[k], ay = ys[k], sx = xs[k + 1] - ax, sy = ys[k + 1] - ay, l2 = sx * sx + sy * sy || 1;
          const u = Math.max(0, Math.min(1, ((px - ax) * sx + (py - ay) * sy) / l2));
          const qx = ax + sx * u - px, qy = ay + sy * u - py, d2 = qx * qx + qy * qy;
          if (d2 < best) {
            best = d2;
            this.nearZ = zs[k] + (zs[k + 1] - zs[k]) * u;
          }
        }
      }
    }
    return Math.sqrt(best);
  }

  /** Ground height with the trail graded in: level across its width, banked into the slope beside it. */
  private ground(px: number, py: number, S: number, tr: TrailShape): number {
    const n = this.natural(px, py, S), du = this.nearTrail(tr, px, py) * S;
    if (du >= PATH_HALF + PATH_BANK) return n;
    const w = du < PATH_HALF ? 1 : 1 - smooth((du - PATH_HALF) / PATH_BANK);
    return n + (this.nearZ - n) * w;
  }

  /** Ground height under a local 3D point. */
  groundAt(lx: number, ly: number): number {
    const b = this.bake!;
    return Math.max(0, this.ground(b.ox + lx / b.S, b.oy - ly / b.S, b.S, this.trail!));
  }

  private trail: TrailShape | null = null;

  // ── Bake ───────────────────────────────────────────────────────────────────

  private biomeAt(px: number, py: number): BiomeName {
    let best: BiomeName = "tropic", bd = Infinity;
    for (const is of this.sim.all) {
      const d = (is.x - px) ** 2 + (is.y - py) ** 2;
      if (d < bd) {
        bd = d;
        best = is.biome;
      }
    }
    return best;
  }

  private seaColour(px: number, py: number): number {
    const NEAR = this.sim.NEAR, o = Math.max(0, Math.min(HD - 1, py | 0)) * WD + Math.max(0, Math.min(WD - 1, px | 0));
    const n = NEAR[o];
    return n > 0.75 ? WATER[3] : n > 0.35 ? WATER[2] : n > 0 ? WATER[1] : WATER[0];
  }

  /**
   * A grid of ground cells over a sea-map rectangle. `keep` picks the cells
   * this grid draws (the others belong to a finer one); `mark` paints the
   * trail (2) and its worn edge (1). Only kept cells' nodes are evaluated.
   */
  private buildGrid(
    px0: number, py0: number, px1: number, py1: number, step: number, S: number, sun: -1 | 1,
    o: { biome: (px: number, py: number) => BiomeName; height: (px: number, py: number) => number; keep?: (px: number, py: number) => boolean; mark?: (px: number, py: number) => number; corridor?: (px: number, py: number) => boolean; sea: boolean },
  ): Grid {
    const nx = Math.max(2, Math.ceil((px1 - px0) / step) + 1), ny = Math.max(2, Math.ceil((py1 - py0) / step) + 1);
    const z = new Float32Array(nx * ny).fill(NaN), e = new Float32Array(nx * ny).fill(NaN);
    const node = (k: number) => {
      if (Number.isNaN(z[k])) {
        const px = px0 + (k % nx) * step, py = py0 + Math.floor(k / nx) * step;
        e[k] = this.elev(px, py);
        z[k] = o.height(px, py);
      }
    };
    // Light from the sun's side, high: slopes facing it are bright.
    const lx = sun * 0.55, ly = 0.35, lz = 0.76, cs = step * S;
    const cells: number[] = [], sea: number[] = [];
    for (let j = 0; j < ny - 1; j++) {
      let run = -1, runC = -1;
      for (let i = 0; i < nx - 1; i++) {
        const k = j * nx + i, pxc = px0 + (i + 0.5) * step, pyc = py0 + (j + 0.5) * step;
        const keep = o.keep ? o.keep(pxc, pyc) : true;
        let seaC = -1;
        if (keep) {
          node(k);
          node(k + 1);
          node(k + nx);
          node(k + nx + 1);
          const emin = Math.min(e[k], e[k + 1], e[k + nx], e[k + nx + 1]);
          // Sea under the cell (coastal land cells keep it, so the shore meets the water).
          if (o.sea && emin <= 0.02) seaC = this.seaColour(pxc, pyc);
        }
        if (seaC !== runC || run < 0) {
          if (run >= 0 && runC >= 0) sea.push(j, run, i, runC);
          run = i;
          runC = seaC;
        }
        if (!keep) continue;
        const zs = [z[k], z[k + 1], z[k + nx + 1], z[k + nx]];
        if (Math.max(...zs) <= 0.5) continue;
        const biome = o.biome(pxc, pyc), bands = BIOMES[biome].bands, em = (e[k] + e[k + 1] + e[k + nx] + e[k + nx + 1]) / 4;
        const path = o.mark ? o.mark(pxc, pyc) : 0;
        const col = [-1, -1];
        for (let t = 0; t < 2; t++) {
          // Triangle 00-10-11 or 00-11-01; local +y is north (sea-map y runs south).
          const zA = zs[0], zB = t ? zs[2] : zs[1], zC = t ? zs[3] : zs[2];
          if (Math.max(zA, zB, zC) <= 0.5) continue;
          const ux = cs, uy = t ? -cs : 0, uz = zB - zA, vx = t ? 0 : cs, vy = -cs, vz = zC - zA;
          let nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
          if (nzv < 0) {
            nxv = -nxv;
            nyv = -nyv;
            nzv = -nzv;
          }
          const d = (nxv * lx + nyv * ly + nzv * lz) / (Math.hypot(nxv, nyv, nzv) || 1);
          const shade = d > 0.9 ? 2 : d > 0.68 ? 1 : 0, h = hash2(Math.round(pxc * 4) + t, Math.round(pyc * 4), 9);
          // Steep faces are bare rock whatever the height.
          const steep = nzv / (Math.hypot(nxv, nyv, nzv) || 1) < 0.55;
          const q = em + (h - 0.5) * 0.06;
          const band = steep && em > 0.08 ? 3 : q < 0.1 ? 0 : q < 0.34 ? 1 : q < 0.6 ? 2 : q < 0.82 ? 3 : 4;
          let c = bands[band][shade];
          if (band === 2 && h < 0.18) c = bands[band][0];
          if (path) {
            const p = bands[STAGE_FLOOR[biome][1]];
            c = path === 2 ? p[Math.min(2, shade + (h < 0.3 ? 0 : 1))] : lerpHex(p[0], INK, 0.2);
          }
          col[t] = packHex(c);
        }
        if (col[0] >= 0 || col[1] >= 0) cells.push(k, col[0], col[1], o.corridor?.(pxc, pyc) ? 1 : 0);
      }
      if (run >= 0 && runC >= 0) sea.push(j, run, nx - 1, runC);
    }
    for (let k = 0; k < z.length; k++) if (Number.isNaN(z[k])) z[k] = 0;
    return { step, px0, py0, nx, ny, z, cells: Int32Array.from(cells), sea };
  }

  /** The trail: from the beach where the boat put in, spiralling up to the summit. */
  private traceTrail(ox: number, oy: number, r: number, seed: number): { x: number[]; y: number[] } {
    const sim = this.sim;
    // The summit: the highest point near the centre.
    let kx = ox, ky = oy, ke = -1;
    for (let y = Math.round(oy - r); y <= oy + r; y++) {
      for (let x = Math.round(ox - r); x <= ox + r; x++) {
        const ev = this.elev(x, y);
        if (ev > ke) {
          ke = ev;
          kx = x;
          ky = y;
        }
      }
    }
    // The beach: start no further out than the island's own shallows (so a neighbour in between
    // can't claim it), then walk toward the summit until the ground rises out of the sea.
    const dl0 = Math.hypot(kx - sim.boat.x, ky - sim.boat.y) || 1, start = Math.min(dl0, r * 1.7);
    let bx = kx + ((sim.boat.x - kx) / dl0) * start, by = ky + ((sim.boat.y - ky) / dl0) * start;
    const ux = (kx - bx) / start, uy = (ky - by) / start;
    for (let i = 0; i < start * 4 && this.elev(bx, by) < 0.07; i++) {
      bx += ux * 0.25;
      by += uy * 0.25;
    }
    // Spiral in: radius shrinks from the beach to the summit while the angle sweeps round.
    const a0 = Math.atan2(by - ky, bx - kx), r0 = Math.hypot(bx - kx, by - ky);
    const turn = (hash2(seed, 5, 3) < 0.5 ? -1 : 1) * Math.PI * (1.05 + hash2(seed, 6, 3) * 0.35);
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i <= 160; i++) {
      const u = i / 160, a = a0 + turn * smooth(Math.min(1, u * 1.05)), rr = r0 * (1 - u) ** 1.15;
      let x = kx + Math.cos(a) * rr, y = ky + Math.sin(a) * rr;
      // Keep the trail on land: pull points that land in the sea toward the summit.
      for (let k = 0; k < 12 && this.elev(x, y) < 0.06; k++) {
        x += (kx - x) * 0.12;
        y += (ky - y) * 0.12;
      }
      xs.push(x);
      ys.push(y);
    }
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < xs.length - 1; i++) {
        xs[i] = (xs[i - 1] + xs[i] * 2 + xs[i + 1]) / 4;
        ys[i] = (ys[i - 1] + ys[i] * 2 + ys[i + 1]) / 4;
      }
    }
    return { x: xs, y: ys };
  }

  /** The trail's graded height: the ground along it, smoothed and never dipping, so the walk only climbs. */
  private shapeTrail(xs: number[], ys: number[], S: number): TrailShape {
    const n = xs.length;
    let z = xs.map((x, i) => this.natural(x, ys[i], S));
    for (let pass = 0; pass < 3; pass++) z = z.map((_, i) => {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - 6); k <= Math.min(n - 1, i + 6); k++) {
        s += z[k];
        c++;
      }
      return s / c;
    });
    z[0] = Math.max(2.5, z[0]);
    for (let i = 1; i < n; i++) z[i] = Math.max(z[i], z[i - 1]);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < n; i++) {
      bx0 = Math.min(bx0, Math.floor(xs[i] / BUCKET));
      by0 = Math.min(by0, Math.floor(ys[i] / BUCKET));
      bx1 = Math.max(bx1, Math.floor(xs[i] / BUCKET));
      by1 = Math.max(by1, Math.floor(ys[i] / BUCKET));
    }
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    const buckets: (number[] | undefined)[] = new Array(bw * bh);
    for (let i = 0; i < n; i++) {
      // A segment can sit in two buckets; file it under both ends.
      for (const k of [i, Math.min(n - 1, i + 1)]) {
        const key = (Math.floor(ys[k] / BUCKET) - by0) * bw + Math.floor(xs[k] / BUCKET) - bx0, list = buckets[key];
        if (!list) buckets[key] = [i];
        else if (list[list.length - 1] !== i) list.push(i);
      }
    }
    return { x: xs, y: ys, z, buckets, bx0, by0, bw, bh };
  }

  private bakeIsland(e: Expedition): IslandBake {
    const sim = this.sim, is = sim.all.find((i) => i.i === e.isleIndex) ?? sim.islands[0];
    const key = `${e.isleIndex}|${this.W}|${this.H}|${sim.camX}|${sim.camY}`;
    if (this.bake?.key === key) return this.bake;
    const ox = is.x, oy = is.y, r = is.r;
    // A pending fork adds a station when a route is chosen: reserve it now so the trail never rebakes mid-walk.
    const N = Math.max(1, e.deck.length + (e.routes && e.deck.indexOf("fork") >= e.step ? 1 : 0));
    const raw = this.traceTrail(ox, oy, r, is.i);
    let lenPx = 0;
    for (let i = 1; i < raw.x.length; i++) lenPx += Math.hypot(raw.x[i] - raw.x[i - 1], raw.y[i] - raw.y[i - 1]);
    // Scale the island so each step is a comfortable walk, whatever the island's size.
    const S = Math.max(9, Math.min(17, (N * 96) / Math.max(1, lenPx)));
    const tr = this.shapeTrail(raw.x, raw.y, S);
    this.trail = tr;
    const sun: -1 | 1 = hash2(e.isleIndex, 3, 77) < 0.5 ? 1 : -1;
    const n = tr.x.length, tx = new Float32Array(n), ty = new Float32Array(n), tlen = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      tx[i] = (tr.x[i] - ox) * S;
      ty[i] = -(tr.y[i] - oy) * S;
      if (i) tlen[i] = tlen[i - 1] + Math.hypot(tx[i] - tx[i - 1], ty[i] - ty[i - 1]);
    }
    const stepLen = tlen[n - 1] / (N - 1 + AHEAD + 0.12);

    const height = (px: number, py: number) => this.ground(px, py, S, tr);
    // A grid cell asks keep, mark and corridor about the same centre: answer repeats from the last lookup.
    let lastX = NaN, lastY = NaN, lastD = 0;
    const dist = (px: number, py: number) => {
      if (px !== lastX || py !== lastY) {
        lastX = px;
        lastY = py;
        lastD = this.nearTrail(tr, px, py);
      }
      return lastD;
    };
    const isleBiome = () => is.biome;

    // The trail's corridor at half a sea-map pixel, with the path painted in.
    let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity;
    for (let i = 0; i < n; i++) {
      tx0 = Math.min(tx0, tr.x[i]);
      ty0 = Math.min(ty0, tr.y[i]);
      tx1 = Math.max(tx1, tr.x[i]);
      ty1 = Math.max(ty1, tr.y[i]);
    }
    const pathHalfPx = PATH_HALF / S, edgePx = (PATH_HALF + 3.5) / S;
    const path = this.buildGrid(Math.floor(tx0 - PATH_REACH), Math.floor(ty0 - PATH_REACH), tx1 + PATH_REACH, ty1 + PATH_REACH, PATH_CELL, S, sun, {
      biome: isleBiome,
      height,
      keep: (px, py) => dist(px, py) < PATH_REACH,
      mark: (px, py) => {
        const d = dist(px, py);
        return d < pathHalfPx ? 2 : d < edgePx ? 1 : 0;
      },
      corridor: () => true,
      sea: false,
    });
    // The whole island at a pixel a cell; its trail corridor is drawn only beyond PATH_NEAR.
    const reach = Math.ceil(r * 1.45) + 3;
    const fx0 = ox - reach, fy0 = oy - reach, fx1 = ox + reach, fy1 = oy + reach;
    const fine = this.buildGrid(fx0, fy0, fx1, fy1, 1, S, sun, {
      biome: isleBiome,
      height,
      mark: (px, py) => {
        const d = dist(px, py);
        return d < pathHalfPx + 0.25 ? 2 : 0;
      },
      corridor: (px, py) => dist(px, py) < PATH_REACH - 0.8,
      sea: true,
    });
    // The archipelago round it, coarse: the neighbours, and the whole sea view the fly-in starts from.
    const cx0 = Math.max(0, Math.min(sim.camX, ox - NEIGHBOURS)), cy0 = Math.max(0, Math.min(sim.camY, oy - NEIGHBOURS));
    const cx1 = Math.min(WD - 1, Math.max(sim.camX + this.W, ox + NEIGHBOURS)), cy1 = Math.min(HD - 1, Math.max(sim.camY + this.H, oy + NEIGHBOURS));
    const coarse = this.buildGrid(Math.floor(cx0 / COARSE) * COARSE, Math.floor(cy0 / COARSE) * COARSE, cx1, cy1, COARSE, S, sun, {
      biome: (px, py) => this.biomeAt(px, py),
      height: (px, py) => this.natural(px, py, S),
      keep: (px, py) => !(px > fx0 + 1 && px < fx1 - 1 && py > fy0 + 1 && py < fy1 - 1),
      sea: true,
    });

    // Scenery: trees by the shore and on the slopes, boulders and crags up high, tufts along the trail.
    const set = buildScenery(is.biome, is.i), props: Prop[] = [];
    const density = { tropic: 0.1, desert: 0.045, tundra: 0.085, volcano: 0.06 }[is.biome];
    let crags = 0;
    const pick = (list: Mesh3D[], h: number) => list[Math.floor(h * 997) % list.length];
    for (let py = Math.ceil(oy - reach); py < oy + reach; py++) {
      for (let px = Math.ceil(ox - reach); px < ox + reach; px++) {
        const ev = this.elev(px, py);
        if (ev < 0.05) continue;
        const h = hash2(px, py, is.i * 7 + 1), jx = px + hash2(px, py, 3) - 0.5, jy = py + hash2(px, py, 4) - 0.5;
        const du = dist(jx, jy) * S, yaw = hash2(px, py, 5) * 6.283, sc = 0.85 + hash2(px, py, 11) * 0.4;
        const at = (mesh: Mesh3D, scale: number) => props.push({ mesh, x: (jx - ox) * S, y: -(jy - oy) * S, z: 0, yaw, scale });
        if (du < PATH_HALF + 2) continue;
        if (du < PATH_HALF + PATH_BANK) {
          if (h < 0.35) at(pick(set.tuft, h), sc);
          else if (h < 0.42) at(pick(set.rock, h), sc * 0.5);
          continue;
        }
        if (ev > 0.55 && crags < 7 && h < 0.03 && du > 70) {
          crags++;
          at(pick(set.crag, h * 30), 0.8 + hash2(px, py, 9) * 0.7);
          continue;
        }
        if (h < 0.025) at(pick(set.rock, h * 40), sc);
        else if (ev > 0.62) {
          if (h < 0.1) at(pick(set.rock, h * 10), sc * 1.2);
        } else if (ev < 0.17) {
          if (h < 0.025 + density * 0.9) at(pick(set.low, h * 13), sc);
        } else if (h < 0.025 + density) at(pick(set.mid, h * 17), sc);
        else if (h < 0.025 + density * 1.7) at(pick(set.bush, h * 19), sc);
      }
    }
    const bake: IslandBake = { key, S, ox, oy, path, fine, coarse, tx, ty, tlen, stepLen, props, beach: [], sun };
    this.bake = bake;
    // Seat everything on the ground now the trail is shaped.
    for (const p of props) p.z = this.groundAt(p.x, p.y) - 1.5;
    const beach = this.along(0.35 * stepLen);
    bake.beach = [-1, 1].map((sgn) => ({ x: beach.x - beach.dy * sgn * 24, y: beach.y + beach.dx * sgn * 24 }));
    return bake;
  }

  /** A point on the trail at running length `s`, with its heading. */
  private along(s: number): { x: number; y: number; dx: number; dy: number } {
    const b = this.bake!, n = b.tlen.length;
    s = Math.max(0, Math.min(b.tlen[n - 1], s));
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (b.tlen[m] <= s) lo = m;
      else hi = m;
    }
    const seg = b.tlen[hi] - b.tlen[lo] || 1, f = (s - b.tlen[lo]) / seg;
    const x = b.tx[lo] + (b.tx[hi] - b.tx[lo]) * f, y = b.ty[lo] + (b.ty[hi] - b.ty[lo]) * f;
    // Heading from a stretch of trail ahead, so the camera turns smoothly round the bends.
    const a = Math.max(0, lo - 3), z = Math.min(n - 1, hi + 6);
    const hx = b.tx[z] - b.tx[a], hy = b.ty[z] - b.ty[a], hl = Math.hypot(hx, hy) || 1;
    return { x, y, dx: hx / hl, dy: hy / hl };
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  /**
   * Draw the stage into `fb` and return where the 2D overlays go. `horizon`
   * is the screen row the horizon should sit on (below the step card).
   */
  render(e: Expedition, horizon: number, shake: { x: number; y: number }): StageAnchors {
    const sim = this.sim, fb = this.fb, W = this.W, H = this.H, t = sim.t;
    const b = this.bakeIsland(e), S = b.S;
    const sky = STAGE_SKY[e.biome], fogHex = lerpHex(sky[1], STAGE_FOG[e.biome], 0.5);
    const [hr, hg, hb] = rgb(fogHex), [zr, zg, zb] = rgb(lerpHex(sky[0], INK, 0.45));

    // Where the captain is: between the last station and this one while walking.
    const sCap = (e.step - e.walk / WALK_FRAMES) * b.stepLen + 0.06 * b.stepLen;
    const mid = this.along(sCap), px = -mid.dy, py = mid.dx;
    const cap = { ...mid, x: mid.x + px * CAP_SIDE, y: mid.y + py * CAP_SIDE }, capZ = this.groundAt(cap.x, cap.y);

    // The walking camera: behind the captain's right shoulder, pitched so the horizon sits on `horizon`.
    // It looks toward the encounter ahead (mostly) rather than straight down the trail, so a foe around
    // a bend of the spiral stays in frame. The aim point slides with the walk, so the view turns smoothly.
    const look = this.along((e.step - e.walk / WALK_FRAMES + AHEAD) * b.stepLen);
    let vx = look.x - mid.x, vy = look.y - mid.y;
    const vl = Math.hypot(vx, vy);
    if (vl > 1) {
      vx = (vx / vl) * LOOK_AT + mid.dx * (1 - LOOK_AT);
      vy = (vy / vl) * LOOK_AT + mid.dy * (1 - LOOK_AT);
      const l = Math.hypot(vx, vy) || 1;
      vx /= l;
      vy /= l;
    } else {
      vx = mid.dx;
      vy = mid.dy;
    }
    const focalScreen = H / 2 / Math.tan((FOV * Math.PI) / 360);
    const pitch = Math.atan((horizon - H / 2) / focalScreen);
    const ex = mid.x - vx * CAM_BACK - vy * CAM_SIDE + shake.x, ey = mid.y - vy * CAM_BACK + vx * CAM_SIDE;
    const ez = Math.max(capZ + CAM_UP, this.groundAt(ex, ey) + 14) + shake.y;
    const walkEye = { x: ex, y: ey, z: ez };
    const walkTarget = { x: ex + vx * 100, y: ey + vy * 100, z: ez + Math.tan(pitch) * 100 };

    // Landing: dive from straight overhead, framed like the sea view, to the shoulder.
    const land = e.step === 0 ? Math.min(1, e.t / LANDING_FRAMES) : 1;
    let eye = walkEye, target = walkTarget, far = 1300;
    if (land < 1) {
      const h0 = (H * S) / 2 / Math.tan((FOV * Math.PI) / 360);
      const tx0 = (sim.camX + W / 2 - b.ox) * S, ty0 = -(sim.camY + H / 2 - b.oy) * S;
      const u = smooth(smooth(land)), v = smooth(Math.min(1, land * 1.35));
      const eye0 = { x: tx0, y: ty0 - h0 * 0.002, z: h0 };
      eye = { x: eye0.x + (walkEye.x - eye0.x) * v, y: eye0.y + (walkEye.y - eye0.y) * v, z: eye0.z + (walkEye.z - eye0.z) * u };
      target = { x: tx0 + (walkTarget.x - tx0) * v, y: ty0 + (walkTarget.y - ty0) * v, z: walkTarget.z * v };
      far = Math.max(1300, h0 * 1.6 * (1 - u) + 1300);
    }
    const cam = makeCam3D(eye, target, fb.w, fb.h, FOV, 6, far);
    this.cam = cam;

    // Sky gradient down to the horizon row, then fog that thickens into it.
    const horRow = this.horizonRow(cam);
    fb.clearSky(zr, zg, zb, hr, hg, hb, Math.max(0.05, Math.min(1, horRow / fb.h)));
    fb.fogR = hr;
    fb.fogG = hg;
    fb.fogB = hb;
    fb.fogStart = land < 1 ? 1e9 : 340;
    fb.fogEnd = land < 1 ? 2e9 : 1150;
    if (land < 1 && land > 0.7) {
      const k = (land - 0.7) / 0.3;
      fb.fogStart = 340 + (1 - k) * 6000;
      fb.fogEnd = 1150 + (1 - k) * 8000;
    }

    // Sea all round, then the ground: neighbours coarse, this island fine.
    this.drawOuterSea(cam, b);
    this.drawGrid(cam, b.coarse, b, land < 1 ? 1e9 : NEIGHBOURS * S * 1.4);
    this.drawGrid(cam, b.fine, b, 1e9);
    this.drawGrid(cam, b.path, b, 1e9);

    // Scenery, nearest first is not needed: the Z-buffer sorts it.
    // Pick each prop's detail by its size on screen: skip specks, the coarse mesh until it's close.
    for (const p of b.props) {
      const rad = p.mesh.rad * p.scale, depth = (p.x - cam.ex) * cam.fx + (p.y - cam.ey) * cam.fy + (p.z + p.mesh.cz * p.scale - cam.ez) * cam.fz;
      if (depth < -rad || depth - rad > far) continue;
      const px = (rad * cam.focal) / Math.max(1, depth);
      if (px < PROP_MIN_PX) continue;
      const mesh = p.mesh.lod && px < PROP_FULL_PX ? p.mesh.lod : p.mesh;
      fb.drawMesh(cam, mesh, p.x, p.y, p.z, p.yaw, p.scale);
    }

    // The ship at anchor, and the rowboat pulled up on the beach.
    const shipX = (sim.boat.x - b.ox) * S, shipY = -(sim.boat.y - b.oy) * S;
    fb.drawMesh(cam, this.mesh(BOAT_MODEL), shipX, shipY, -2 + Math.sin(t * 0.04) * 1.2, -sim.boat.a + Math.PI, S * 0.55);
    if (e.step <= 1) {
      const sb = this.along(0);
      fb.drawMesh(cam, this.mesh(ROWBOAT_MODEL), sb.x - sb.dx * 34 - px * 22, sb.y - sb.dy * 34 - py * 22, this.groundAt(sb.x - sb.dx * 34, sb.y - sb.dy * 34) - 1, Math.atan2(sb.dy, sb.dx) + 0.5, 1.5);
    }
    // The project's pennants on the beach.
    if (e.project && e.step <= 1) {
      const [ar, ag, ab] = rgb(e.project.accent);
      for (const p of b.beach) {
        const gz = this.groundAt(p.x, p.y), wave = Math.sin(t * 0.12 + p.x) * 1.5;
        fb.drawBox(cam, p.x - 0.8, p.y - 0.8, gz, p.x + 0.8, p.y + 0.8, gz + 26, 58, 36, 22);
        fb.drawBox(cam, p.x + 0.8, p.y - 0.5, gz + 17 + wave * 0.3, p.x + 11, p.y + 0.5, gz + 25 + wave * 0.3, ar, ag, ab);
      }
    }

    // The encounter for this step, standing up the trail.
    const anchors: StageAnchors = { actorTop: null, actorFoot: null, sun: null, landing: land };
    const sAct = e.step * b.stepLen + AHEAD * b.stepLen;
    const act = this.along(sAct);
    anchors.actorFoot = this.project(act.x, act.y, this.groundAt(act.x, act.y));
    const top = this.drawActor(cam, e, act, Math.atan2(act.dy, act.dx) + Math.PI / 2);
    anchors.actorTop = top;

    // The captain, facing up the trail.
    this.drawCaptain(cam, e, cap, capZ);

    // The sun, low over the sea on its side of the island.
    const day = Math.max(0, Math.min(1, sim.clock / DAY_FRAMES));
    const sd = { x: b.sun * 0.8 - cap.dx * 0.2, y: 0.6 };
    anchors.sun = this.project(cap.x + sd.x * 4000, cap.y + sd.y * 4000, capZ + 4000 * (0.32 - day * 0.18));
    return anchors;
  }

  /** The screen row (in fb pixels) the far horizon falls on. */
  private horizonRow(cam: Cam3D): number {
    // A point far off along the view, at the eye's height.
    const fx = cam.fx, fy = cam.fy, fl = Math.hypot(fx, fy) || 1;
    const c = worldToCam(cam, cam.ex + (fx / fl) * 1e5, cam.ey + (fy / fl) * 1e5, 0);
    if (c.z <= 0) return 0;
    return cam.hh - (c.y * cam.focal) / c.z;
  }

  private drawOuterSea(cam: Cam3D, b: IslandBake): void {
    const fb = this.fb, g = b.coarse, S = b.S, R = 9000;
    const x0 = (g.px0 - b.ox) * S, x1 = (g.px0 + (g.nx - 1) * g.step - b.ox) * S;
    const y0 = -(g.py0 + (g.ny - 1) * g.step - b.oy) * S, y1 = -(g.py0 - b.oy) * S;
    const [r, gg, bb] = [(WATER[0] >> 16) & 255, (WATER[0] >> 8) & 255, WATER[0] & 255];
    // A little under the grid's own sea and tucked a cell beneath its edge, so no seam opens between them.
    const z = -0.6, m = g.step * S;
    const quad = (ax: number, ay: number, bx: number, by: number) => {
      fb.drawTri(cam, ax, ay, z, bx, ay, z, bx, by, z, r, gg, bb, true);
      fb.drawTri(cam, ax, ay, z, bx, by, z, ax, by, z, r, gg, bb, true);
    };
    quad(-R, y1 - m, R, R);
    quad(-R, -R, R, y0 + m);
    quad(-R, y0, x0 + m, y1);
    quad(x1 - m, y0, R, y1);
  }

  private drawGrid(cam: Cam3D, g: Grid, b: IslandBake, reach: number): void {
    const fb = this.fb, S = b.S, cs = g.step * S, t = this.sim.t, nx = g.nx;
    const X = (i: number) => (g.px0 + i * g.step - b.ox) * S, Y = (j: number) => -(g.py0 + j * g.step - b.oy) * S;
    // Cull cells outside the view: behind, past `reach`, off either side or below the bottom edge.
    const ax = cam.hw / cam.focal, ay = cam.hh / cam.focal, m = cs * 0.75 + 4, r2 = reach * reach;
    const visible = (x: number, y: number, z = 0) => {
      const dx = x - cam.ex, dy = y - cam.ey, dz = z - cam.ez;
      const cz = dx * cam.fx + dy * cam.fy + dz * cam.fz;
      if (cz < -m || dx * dx + dy * dy > r2) return false;
      const cx = dx * cam.rx + dy * cam.ry + dz * cam.rz, lim = Math.max(0, cz) * ax + m * 1.5;
      if (cx > lim || -cx > lim) return false;
      const cy = dx * cam.ux + dy * cam.uy + dz * cam.uz;
      return cy > -(Math.max(0, cz) * ay + m * 1.5);
    };
    // Sea runs, a slow shimmer on the shallows.
    for (let k = 0; k < g.sea.length; k += 4) {
      const j = g.sea[k], i0 = g.sea[k + 1], i1 = g.sea[k + 2], c = g.sea[k + 3];
      const xa = X(i0), xb = X(i1), ya = Y(j), yb = Y(j + 1);
      if (!visible((xa + xb) / 2, ya) && !visible(xa, ya) && !visible(xb, ya)) continue;
      const sh = c === WATER[0] ? 0 : Math.sin(t * 0.05 + j * 0.7) * 6;
      const r = Math.min(255, ((c >> 16) & 255) + sh), gg = Math.min(255, ((c >> 8) & 255) + sh), bb = Math.min(255, (c & 255) + sh);
      fb.drawTri(cam, xa, ya, 0, xb, ya, 0, xb, yb, 0, r, gg, bb, true);
      fb.drawTri(cam, xa, ya, 0, xb, yb, 0, xa, yb, 0, r, gg, bb, true);
    }
    // Corridor cells: the fine path grid draws them near the camera, the pixel grid beyond (overlapping a little).
    const near2 = (PATH_NEAR + (g.step < 1 ? 14 : -14)) ** 2, wantNear = g.step < 1;
    const cells = g.cells, z = g.z;
    for (let c = 0; c < cells.length; c += 4) {
      const k = cells[c], i = k % nx, j = (k - i) / nx, x = X(i), y = Y(j);
      if (cells[c + 3]) {
        const d2 = (x - cam.ex) ** 2 + (y - cam.ey) ** 2;
        if (d2 < near2 !== wantNear) continue;
      }
      const z00 = z[k], z10 = z[k + 1], z01 = z[k + nx], z11 = z[k + nx + 1];
      if (!visible(x + cs / 2, y - cs / 2, (z00 + z11) / 2)) continue;
      const xn = x + cs, yn = y - cs, ta = cells[c + 1], tb = cells[c + 2];
      if (ta >= 0) fb.drawTri(cam, x, y, z00, xn, y, z10, xn, yn, z11, (ta >> 16) & 255, (ta >> 8) & 255, ta & 255, true);
      if (tb >= 0) fb.drawTri(cam, x, y, z00, xn, yn, z11, x, yn, z01, (tb >> 16) & 255, (tb >> 8) & 255, tb & 255, true);
    }
  }

  private actorModel(e: Expedition, kind: StepKind): Model | null {
    switch (kind) {
      case "ambush":
      case "den":
      case "overdue": {
        const roster = FOE_ROSTER[e.biome];
        return e.foe < 0 ? GHOST_FOE.model : roster[e.foe % roster.length].model;
      }
      case "cache":
        return CHEST_MODEL;
      case "hermit":
        return HERMIT_MODEL;
      case "wreck":
        return WRECK_MODEL;
      case "trap":
        return CAIRN_MODEL;
      case "shrine":
        return SHRINE_MODEL;
      case "bridge":
      case "ford":
      case "camp":
        return null;
      default:
        return SIGN_MODEL;
    }
  }

  /** Draw the step's encounter; returns the screen point above it. */
  private drawActor(cam: Cam3D, e: Expedition, at: { x: number; y: number; dx: number; dy: number }, yaw: number): { x: number; y: number } | null {
    const fb = this.fb, t = this.sim.t, kind = kindAt(e), fight = isFight(kind);
    const gz = this.groundAt(at.x, at.y), side = -1, px = -at.dy, py = at.dx;
    if (kind === "ford") {
      // A stream across the trail, with stepping stones.
      const w = 90, d = 9;
      const ax = at.x - px * w, ay = at.y - py * w, bx = at.x + px * w, by = at.y + py * w;
      const [r, g, b] = rgb("#2b6c8f");
      const z = gz + 0.6, sh = Math.sin(t * 0.08) * 8;
      fb.drawTri(cam, ax - at.dx * d, ay - at.dy * d, z, bx - at.dx * d, by - at.dy * d, z, bx + at.dx * d, by + at.dy * d, z, r + sh, g + sh, b + sh, true);
      fb.drawTri(cam, ax - at.dx * d, ay - at.dy * d, z, bx + at.dx * d, by + at.dy * d, z, ax + at.dx * d, ay + at.dy * d, z, r + sh, g + sh, b + sh, true);
      for (let i = -1; i <= 1; i++) {
        const sx = at.x + px * i * 7, sy = at.y + py * i * 7;
        fb.drawBox(cam, sx - 2.5, sy - 2.5, gz, sx + 2.5, sy + 2.5, gz + 2.2, 138, 138, 146);
      }
      return this.project(at.x, at.y, gz + 20);
    }
    if (kind === "bridge") {
      // A dark gorge across the trail, spanned by planks between two posts.
      const w = 110, d = 12, z = gz + 0.4;
      const ax = at.x - px * w, ay = at.y - py * w, bx = at.x + px * w, by = at.y + py * w;
      fb.drawTri(cam, ax - at.dx * d, ay - at.dy * d, z, bx - at.dx * d, by - at.dy * d, z, bx + at.dx * d, by + at.dy * d, z, 14, 16, 26, true);
      fb.drawTri(cam, ax - at.dx * d, ay - at.dy * d, z, bx + at.dx * d, by + at.dy * d, z, ax + at.dx * d, ay + at.dy * d, z, 14, 16, 26, true);
      for (let k = -d + 1; k < d; k += 3) {
        const sx = at.x + at.dx * k, sy = at.y + at.dy * k, sag = (1 - (k / d) ** 2) * -1.2;
        fb.drawBox(cam, sx - px * 6 - 1, sy - py * 6 - 1, z + 0.6 + sag, sx + px * 6 + 1, sy + py * 6 + 1, z + 1.6 + sag, (k & 2) ? 138 : 110, (k & 2) ? 90 : 68, (k & 2) ? 50 : 38);
      }
      for (const sgn of [-1, 1]) {
        for (const end of [-1, 1]) {
          const sx = at.x + px * sgn * 7 + at.dx * end * (d + 1), sy = at.y + py * sgn * 7 + at.dy * end * (d + 1);
          fb.drawBox(cam, sx - 0.8, sy - 0.8, gz, sx + 0.8, sy + 0.8, gz + 9, 58, 36, 22);
        }
      }
      return this.project(at.x, at.y, gz + 20);
    }
    if (kind === "camp") {
      // The project's tent beside the trail, a fire before it, and the crate if one waits.
      const tx = at.x + px * side * 26, ty = at.y + py * side * 26, tz = this.groundAt(tx, ty) - 1;
      fb.drawMesh(cam, this.tent(e.project?.accent ?? "#c9a06a"), tx, ty, tz, yaw + Math.PI / 2, 1.7);
      const fx = at.x + px * side * 8, fy = at.y + py * side * 8, fz = this.groundAt(fx, fy);
      fb.drawBox(cam, fx - 3, fy - 1, fz, fx + 3, fy + 1, fz + 1.2, 58, 36, 22);
      fb.drawBox(cam, fx - 1, fy - 3, fz, fx + 1, fy + 3, fz + 1.2, 58, 36, 22);
      if (e.crate && !e.crateTaken) {
        const cx = at.x - px * side * 10, cy = at.y - py * side * 10, cz = this.groundAt(cx, cy);
        fb.drawBox(cam, cx - 4, cy - 4, cz, cx + 4, cy + 4, cz + 7, 201, 160, 106);
      }
      return this.project(fx, fy, fz);
    }
    const m = this.actorModel(e, kind);
    if (!m) return null;
    const mesh = this.mesh(m);
    const scale = fight ? (kind === "den" ? 1.9 : kind === "overdue" ? 1.65 : 1.5) : kind === "wreck" ? 1.6 : 1.25;
    const floats = fight && (e.foe < 0 || (e.biome === "tundra" && e.foe === 0));
    const lift = floats ? 6 + Math.sin(t * 0.06) * 2 : 0, bob = fight ? Math.abs(Math.sin(t * 0.1)) * 1.5 : 0;
    // Struck foes reel back up the trail.
    const recoil = e.hit > 0 ? e.hit * 0.5 : 0;
    const ax = at.x + at.dx * recoil, ay = at.y + at.dy * recoil;
    const flash = e.hit > 0 && (t & 2) > 0;
    fb.drawMesh(cam, mesh, ax, ay, gz - 0.5 + lift + bob, kind === "wreck" ? yaw + 0.6 : yaw, scale, flash ? 2.2 : 1);
    return this.project(ax, ay, gz + lift + bob + mesh.cz * 2 * scale + 6);
  }

  private capBusy = 0;

  private drawCaptain(cam: Cam3D, e: Expedition, cap: { x: number; y: number; dx: number; dy: number }, gz: number): void {
    const fb = this.fb, t = this.sim.t, walking = e.walk > 0;
    if (walking || e.swing > 0 || e.hurt > 0 || e.phase !== "step" || isFight(kindAt(e))) this.capBusy = t;
    // Idle long enough and the captain lifts the spyglass.
    const idle = t - this.capBusy, glass = idle > 70 && idle % 480 < 300;
    const bob = walking ? Math.abs(Math.sin(t * 0.45)) * 1.6 : 0;
    const sw = e.swing > 0 ? Math.sin((e.swing / 14) * Math.PI) : 0;
    // A lunge up the trail on each strike.
    const x = cap.x + cap.dx * sw * 10, y = cap.y + cap.dy * sw * 10;
    const sway = walking ? Math.sin(t * 0.45) * 0.1 : glass ? Math.sin(t * 0.03) * 0.06 : 0;
    const yaw = Math.atan2(cap.dy, cap.dx) - Math.PI / 2 + sway + sw * 0.3;
    const flash = e.hurt > 0 && (t & 2) > 0;
    fb.drawMesh(cam, this.mesh(glass ? CAPTAIN_GLASS_MODEL : CAPTAIN_MODEL), x, y, gz - 0.5 + bob, yaw, 1.05, flash ? 2.2 : 1);
  }

  /** Project a local 3D point to the full-size screen (W × H), or null when off camera. */
  project(x: number, y: number, z: number): { x: number; y: number } | null {
    const cam = this.cam;
    if (!cam) return null;
    const c = worldToCam(cam, x, y, z);
    if (c.z < cam.near) return null;
    const sx = cam.hw + (c.x * cam.focal) / c.z, sy = cam.hh - (c.y * cam.focal) / c.z;
    return { x: (sx / this.fb.w) * this.W, y: (sy / this.fb.h) * this.H };
  }
}
