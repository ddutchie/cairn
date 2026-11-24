/**
 * Task Force terrain: a scrolling island heightmap rendered as raised pixels.
 *
 * Pure (no React Native / Skia), so it runs under vitest. The world is a strip
 * `width + 2·MARGIN` columns wide that scrolls along rows `r` (r grows "up" the
 * screen). Each row is generated once (height, top colour, cliff colour, water
 * class) into a ring buffer; rows are then ray-cast front-to-back with a y-buffer
 * into fixed `CHUNK`-row images. The camera only translates, so a chunk's image
 * never changes: the renderer draws it at an offset instead of re-casting every
 * frame. Shoreline foam flickers by swapping between two baked variants.
 */

export const SEA = 0.5;
/** Pixels of lift per unit of height above sea level. */
const LIFT = 64;
/** Tallest possible column, in pixels (rows this far below a chunk can still poke into it). */
export const KMAX = 34;
export const CHUNK = 128;
/** Extra columns each side so the camera can sway and shake without exposing an edge. */
export const MARGIN = 12;
const RING = 1024;
const LAT = 256;

export type BiomeName = "tropic" | "desert" | "tundra" | "volcano";
export const BIOME_ORDER: BiomeName[] = ["tropic", "desert", "tundra", "volcano"];

interface BiomeDef {
  /** Deep → foam. */
  water: [string, string, string, string, string];
  /** Sand, low, high, rock, peak — each [dark, mid, light]. */
  bands: string[][];
  tree: [string, string];
  lava?: [string, string, string];
  /** HUD accent for levels in this biome. */
  accent: string;
}

export const BIOMES: Record<BiomeName, BiomeDef> = {
  tropic: {
    water: ["#173c8f", "#1f55b5", "#2a74d2", "#47a3e6", "#cfeeff"],
    bands: [["#c9a56a", "#e8cf8e", "#f6e7b4"], ["#3f8f2e", "#5cb83a", "#86d94c"], ["#24602a", "#337d32", "#4a9a3c"], ["#5f5a5a", "#807878", "#a49b96"], ["#9a9a9a", "#c4c4c4", "#ececec"]],
    tree: ["#1d4f24", "#2f7a2f"],
    accent: "#2ec4b6",
  },
  desert: {
    water: ["#11506e", "#18708f", "#2393a8", "#4cbcc0", "#d6f4ec"],
    bands: [["#b9874f", "#d9a866", "#efc98a"], ["#a48a4a", "#c2a85c", "#d8c27a"], ["#8a4f2e", "#a8623a", "#c97d4d"], ["#6e4a36", "#8c5e44", "#a8775a"], ["#c9a27a", "#e0bf98", "#f0d9b8"]],
    tree: ["#5e6b2a", "#7d8c3a"],
    accent: "#f0a04b",
  },
  tundra: {
    water: ["#1a2f55", "#24447a", "#33609c", "#5487bd", "#e6f2ff"],
    bands: [["#7e8a96", "#9aa6b2", "#b8c3cc"], ["#5d7a6a", "#76957f", "#93b29a"], ["#2e4f45", "#3d6658", "#4f7d6c"], ["#5a5f6a", "#727885", "#8d94a0"], ["#c8d6e8", "#e4eef8", "#ffffff"]],
    tree: ["#1f3a33", "#dfe9f4"],
    accent: "#8fb8ff",
  },
  volcano: {
    water: ["#0f2a3a", "#163d52", "#1f566b", "#2f7a85", "#bfe3e0"],
    bands: [["#3a3436", "#4d4548", "#625a5c"], ["#3d5a2e", "#54743a", "#6d8f48"], ["#2a2628", "#3a3436", "#4c4446"], ["#4a3430", "#5e443c", "#76584c"], ["#231e20", "#2f292b", "#3e3638"]],
    tree: ["#243d1e", "#3d5a2e"],
    lava: ["#c2401f", "#ef6a24", "#ffb347"],
    accent: "#ff6a4d",
  },
};

// ── Colour packing (little-endian RGBA bytes ⇄ one uint32) ───────────────────
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function pack(r: number, g: number, b: number): number {
  return ((255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
}
const u32 = (hex: string) => pack(...rgb(hex));
function darken(hex: string, f: number): number {
  const [r, g, b] = rgb(hex);
  return pack((r * f) | 0, (g * f) | 0, (b * f) | 0);
}

// ── Noise ────────────────────────────────────────────────────────────────────
/** Integer hash → [0, 1). Used per cell (trees, foam phase), never per octave. */
export function hash2(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Seeded PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

interface Prepared {
  water: number[];
  top: number[][];
  side: number[];
  tree: number[];
  treeSide: number;
  lava: number[] | null;
}
function prepare(def: BiomeDef): Prepared {
  return {
    water: def.water.map(u32),
    top: def.bands.map((b) => b.map(u32)),
    side: def.bands.map((b) => darken(b[0], 0.7)),
    tree: def.tree.map(u32),
    treeSide: darken(def.tree[0], 0.7),
    lava: def.lava ? def.lava.map(u32) : null,
  };
}

export interface Chunk {
  /** RGBA, `width × CHUNK`, two foam phases. */
  pixels: [Uint8Array, Uint8Array];
  /** Water class of each top pixel (0 = land, 1 deep … 5 foam). */
  water: Uint8Array;
}

export class Terrain {
  /** Strip width in columns, including both margins. */
  readonly width: number;
  readonly biome: BiomeName;
  readonly seed: number;
  private readonly lat = new Float32Array(LAT * LAT);
  private readonly b: Prepared;
  private readonly rawH: Float32Array;
  private readonly rawId = new Int32Array(RING).fill(-1e9);
  private readonly rowH: Float32Array;
  private readonly rowC: Uint32Array;
  private readonly rowS: Uint32Array;
  private readonly rowW: Uint8Array;
  private readonly rowId = new Int32Array(RING).fill(-1e9);
  private readonly chunks = new Map<number, Chunk>();
  /** Highest row generated so far (rows are pumped ahead of the camera). */
  private highRow = -1e9;

  constructor(viewWidth: number, biome: BiomeName, seed: number) {
    this.width = viewWidth + MARGIN * 2;
    this.biome = biome;
    this.seed = seed;
    this.b = prepare(BIOMES[biome]);
    const rand = mulberry32(seed * 2654435761);
    for (let i = 0; i < this.lat.length; i++) this.lat[i] = rand();
    const n = RING * this.width;
    this.rawH = new Float32Array(n);
    this.rowH = new Float32Array(n);
    this.rowC = new Uint32Array(n);
    this.rowS = new Uint32Array(n);
    this.rowW = new Uint8Array(n);
  }

  private vnoise(x: number, y: number): number {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const x0 = xi & (LAT - 1), x1 = (xi + 1) & (LAT - 1), y0 = (yi & (LAT - 1)) * LAT, y1 = ((yi + 1) & (LAT - 1)) * LAT;
    const L = this.lat;
    const a = L[y0 + x0], b = L[y0 + x1], c = L[y1 + x0], d = L[y1 + x1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /** Normalised height; SEA is the waterline, ~35% of samples are land. */
  heightAt(x: number, r: number): number {
    let t = 0, amp = 0.5, f = 1 / 56, n = 0;
    for (let i = 0; i < 5; i++) {
      t += this.vnoise(x * f + i * 37.3, r * f + i * 91.7) * amp;
      n += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    let h = t / n;
    h += (this.vnoise(x / 140 + 113.5, r / 180 + 57.2) - 0.5) * 0.36;
    return (h - 0.572) * 1.4 + SEA;
  }

  private raw(r: number): number {
    const slot = r & (RING - 1), o = slot * this.width;
    if (this.rawId[slot] !== r) {
      this.rawId[slot] = r;
      for (let i = 0; i < this.width; i++) this.rawH[o + i] = this.heightAt(i - MARGIN, r);
    }
    return o;
  }

  private genRow(r: number): void {
    const B = this.b, ww = this.width, seed = this.seed;
    const slot = r & (RING - 1), o0 = slot * ww;
    const here = this.raw(r), below = this.raw(r - 1), above = this.raw(r + 1);
    this.rowId[slot] = r;
    if (r > this.highRow) this.highRow = r;
    for (let i = 0; i < ww; i++) {
      const x = i - MARGIN, o = o0 + i, h = this.rawH[here + i];
      const dth = BAYER[((r & 3) << 2) | (x & 3)];
      if (h < SEA) {
        const d = SEA - h + (dth - 0.5) * 0.03;
        const c = d > 0.17 ? 0 : d > 0.1 ? 1 : d > 0.045 ? 2 : d > 0.014 ? 3 : 4;
        this.rowH[o] = 0;
        this.rowC[o] = this.rowS[o] = B.water[c];
        this.rowW[o] = c + 1;
        continue;
      }
      const e = h - SEA, ej = e + (dth - 0.5) * 0.02;
      const band = ej < 0.03 ? 0 : ej < 0.13 ? 1 : ej < 0.24 ? 2 : ej < 0.36 ? 3 : 4;
      // Light from the top-left: lit when the ground rises away from it.
      const xr = Math.min(ww - 1, i + 1), xl = Math.max(0, i - 1);
      const sl = (this.rawH[below + xr] - this.rawH[above + xl]) * 70 + (dth - 0.5) * 0.7;
      const shade = sl > 0.3 ? 2 : sl < -0.3 ? 0 : 1;
      let hh = Math.min(e, 0.5) * LIFT, c = B.top[band][shade], sd = B.side[band];
      if ((band === 1 || band === 2) && hash2(x, r, seed + 5) < (band === 2 ? 0.32 : 0.07)) {
        hh += 2;
        c = B.tree[hash2(x, r, seed + 6) < 0.55 ? 0 : 1];
        sd = B.treeSide;
      }
      if (B.lava && band >= 3) {
        // Thin cracks down dark basalt, a molten crater at the very top.
        const crack = Math.abs(this.vnoise(x / 7 + 11.1, r / 11 + 23.4) - 0.5);
        const crater = e > 0.44;
        if (crater || crack < (band === 4 ? 0.045 : 0.02)) {
          c = B.lava[crater ? 2 : shade === 0 ? 0 : 1];
          sd = B.lava[0];
          hh -= crater ? 3 : 1;
        }
      }
      this.rowH[o] = hh;
      this.rowC[o] = c;
      this.rowS[o] = sd;
      this.rowW[o] = 0;
    }
  }

  private row(r: number): number {
    const slot = r & (RING - 1);
    if (this.rowId[slot] !== r) this.genRow(r);
    return slot * this.width;
  }

  /** Generate up to `budget` rows ahead (≤ `target`) so chunk builds stay cheap. */
  pump(target: number, budget: number): void {
    let r = Math.max(this.highRow + 1, target - RING / 2);
    for (let n = 0; n < budget && r <= target; n++, r++) this.row(r);
  }

  /** The baked chunk covering rows [c·CHUNK, (c+1)·CHUNK). */
  chunk(c: number): Chunk {
    const hit = this.chunks.get(c);
    if (hit) return hit;
    const ww = this.width, C = CHUNK, r0 = c * C, B = this.b;
    const a32 = new Uint32Array(ww * C), b32 = new Uint32Array(ww * C), water = new Uint8Array(ww * C);
    const offs = new Int32Array(C + KMAX);
    for (let k = 0; k < C + KMAX; k++) offs[k] = this.row(r0 - KMAX + k);
    for (let x = 0; x < ww; x++) {
      let yb = C;
      for (let k = 0; k < C + KMAX; k++) {
        const r = r0 - KMAX + k, o = offs[k] + x;
        const y = C - 1 - (r - r0) - (this.rowH[o] | 0);
        if (y >= yb) continue;
        const top = y < 0 ? 0 : y;
        const wc = this.rowW[o];
        let ca = this.rowC[o], cb = ca;
        if (wc === 5) {
          // Foam: half the pixels swap to shallow water each phase.
          if (((hash2(x, r, 7) * 6) | 0) & 1) ca = B.water[3];
          else cb = B.water[3];
        }
        const p = top * ww + x;
        a32[p] = ca;
        b32[p] = cb;
        water[p] = wc;
        const sc = this.rowS[o];
        for (let yy = top + 1; yy < yb; yy++) a32[yy * ww + x] = b32[yy * ww + x] = sc;
        yb = top;
        if (yb <= 0) break;
      }
    }
    const chunk: Chunk = { pixels: [new Uint8Array(a32.buffer), new Uint8Array(b32.buffer)], water };
    this.chunks.set(c, chunk);
    return chunk;
  }

  /** Drop baked chunks outside [lo, hi]. */
  evict(lo: number, hi: number): void {
    for (const c of this.chunks.keys()) if (c < lo || c > hi) this.chunks.delete(c);
  }
}

/**
 * Screen placement for a scroll position. Row r's flat ground sits at screen
 * y = viewH − 1 − (r − floor(camR)); chunk c's image top is at `chunkTop(c)`.
 */
export function chunkTop(c: number, camR: number, viewH: number): number {
  return viewH - (c + 1) * CHUNK + Math.floor(camR);
}
/** Chunk indices whose images overlap the screen, lowest first. */
export function visibleChunks(camR: number, viewH: number): number[] {
  const base = Math.floor(camR);
  const lo = Math.floor(base / CHUNK) - 1;
  const out: number[] = [];
  for (let c = Math.max(lo, -1); ; c++) {
    const top = chunkTop(c, camR, viewH);
    if (top + CHUNK <= 0) break;
    if (top < viewH) out.push(c);
  }
  return out;
}
