/**
 * Scrolling island heightmap terrain rendered as raised pixels into chunked
 * RGBA buffers. Pure (no Skia / DOM), supporting dynamic width resizing.
 */

export const SEA = 0.5;
const LIFT = 64;
export const KMAX = 34;
export const CHUNK = 128;
export const MARGIN = 12;
const RING = 1024;
const LAT = 256;

export type BiomeName = "tropic" | "desert" | "tundra" | "volcano";
export const BIOME_ORDER: BiomeName[] = ["tropic", "desert", "tundra", "volcano"];

interface BiomeDef {
  water: [string, string, string, string, string];
  bands: string[][];
  tree: [string, string];
  lava?: [string, string, string];
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

export function hash2(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
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
export function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, y: number, s: number): number {
  let t = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < 5; i++) {
    t += vnoise(x * f, y * f, s + i * 17) * a;
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return t / n;
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
  pixels: [Uint8Array, Uint8Array];
  water: Uint8Array;
}

export class Terrain {
  width = 0;
  readonly biome: BiomeName;
  readonly seed: number;
  private readonly lat = new Float32Array(LAT * LAT);
  private readonly b: Prepared;
  private rawH = new Float32Array(0);
  private readonly rawId = new Int32Array(RING).fill(-1e9);
  private rowH = new Float32Array(0);
  private rowC = new Uint32Array(0);
  private rowS = new Uint32Array(0);
  private rowW = new Uint8Array(0);
  private readonly rowId = new Int32Array(RING).fill(-1e9);
  private readonly chunks = new Map<number, Chunk>();
  private highRow = -1e9;

  constructor(viewWidth: number, biome: BiomeName, seed: number) {
    this.biome = biome;
    this.seed = seed;
    this.b = prepare(BIOMES[biome]);
    const rand = mulberry32(seed * 2654435761);
    for (let i = 0; i < this.lat.length; i++) this.lat[i] = rand();
    this.resize(viewWidth);
  }

  resize(viewWidth: number): boolean {
    const need = viewWidth + MARGIN * 2;
    if (need === this.width) return false;
    this.width = need;
    const n = RING * need;
    this.rawH = new Float32Array(n);
    this.rowH = new Float32Array(n);
    this.rowC = new Uint32Array(n);
    this.rowS = new Uint32Array(n);
    this.rowW = new Uint8Array(n);
    this.rawId.fill(-1e9);
    this.rowId.fill(-1e9);
    this.chunks.clear();
    this.highRow = -1e9;
    return true;
  }

  private vnoise(x: number, y: number): number {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const x0 = xi & (LAT - 1), x1 = (xi + 1) & (LAT - 1), y0 = (yi & (LAT - 1)) * LAT, y1 = ((yi + 1) & (LAT - 1)) * LAT;
    const L = this.lat;
    const a = L[y0 + x0], b = L[y0 + x1], c = L[y1 + x0], d = L[y1 + x1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  heightAt(x: number, r: number): number {
    let h = 0, amp = 0.5, f = 1 / 56, norm = 0;
    for (let o = 0; o < 5; o++, amp *= 0.5, f *= 2.03) {
      h += this.vnoise(x * f, r * f) * amp;
      norm += amp;
    }
    h = h / norm + (this.vnoise(x / 140 + 3.1, r / 180) - 0.5) * 0.36;
    return (h - 0.572) * 1.4 + SEA;
  }

  private rawRow(r: number): number {
    const slot = r & (RING - 1);
    if (this.rawId[slot] !== r) {
      this.rawId[slot] = r;
      const o0 = slot * this.width;
      for (let i = 0; i < this.width; i++) this.rawH[o0 + i] = this.heightAt(i - MARGIN, r);
    }
    return slot * this.width;
  }

  private shadeRow(r: number): number {
    const slot = r & (RING - 1);
    if (this.rowId[slot] === r) return slot * this.width;
    this.rowId[slot] = r;
    const o0 = slot * this.width, h0 = this.rawRow(r), hUp = this.rawRow(r - 1), hDn = this.rawRow(r + 1);
    const b = this.b, seed = this.seed;

    for (let i = 0; i < this.width; i++) {
      const x = i - MARGIN, o = o0 + i, h = this.rawH[h0 + i], dth = BAYER[((r & 3) << 2) | (x & 3)];
      if (h < SEA) {
        const d = SEA - h + (dth - 0.5) * 0.03;
        const c = d > 0.17 ? 0 : d > 0.1 ? 1 : d > 0.045 ? 2 : d > 0.014 ? 3 : 4;
        this.rowH[o] = 0;
        this.rowC[o] = this.rowS[o] = b.water[c];
        this.rowW[o] = c + 1;
        continue;
      }
      const e = h - SEA, ej = e + (dth - 0.5) * 0.02;
      const band = ej < 0.03 ? 0 : ej < 0.13 ? 1 : ej < 0.24 ? 2 : ej < 0.36 ? 3 : 4;
      const hr = i + 1 < this.width ? this.rawH[hUp + i + 1] : this.heightAt(x + 1, r - 1);
      const hl = i > 0 ? this.rawH[hDn + i - 1] : this.heightAt(x - 1, r + 1);
      const sl = (hr - hl) * 70 + (dth - 0.5) * 0.7;
      const shade = sl > 0.3 ? 2 : sl < -0.3 ? 0 : 1;
      let hh = Math.min(e, 0.5) * LIFT, c = b.top[band][shade], sd = b.side[band];
      if ((band === 1 || band === 2) && hash2(x, r, seed + 5) < (band === 2 ? 0.32 : 0.07)) {
        hh += 2;
        c = b.tree[hash2(x, r, seed + 6) < 0.55 ? 0 : 1];
        sd = b.treeSide;
      }
      if (b.lava && band >= 3) {
        const crack = Math.abs(this.vnoise(x / 7 + 1.3, r / 11 + 5.7) - 0.5), crater = e > 0.44;
        if (crater || crack < (band === 4 ? 0.045 : 0.02)) {
          c = b.lava[crater ? 2 : shade === 0 ? 0 : 1];
          sd = b.lava[0];
          hh -= crater ? 3 : 1;
        }
      }
      this.rowH[o] = hh;
      this.rowC[o] = c;
      this.rowS[o] = sd;
      this.rowW[o] = 0;
    }
    return o0;
  }

  pump(upToRow: number, maxRows = 32): void {
    if (this.highRow < upToRow - RING) this.highRow = upToRow - RING;
    const target = Math.min(upToRow, this.highRow + maxRows);
    while (this.highRow < target) this.shadeRow(++this.highRow);
  }

  private bake(c: number): Chunk {
    const W = this.width, rBase = c * CHUNK;
    const p0 = new Uint8Array(W * CHUNK * 4), p1 = new Uint8Array(W * CHUNK * 4), water = new Uint8Array(W * CHUNK);
    const b0 = new Uint32Array(p0.buffer), b1 = new Uint32Array(p1.buffer), w = this.b.water;
    const deep = w[0];
    b0.fill(deep);
    b1.fill(deep);

    for (let x = 0; x < W; x++) {
      let yb = CHUNK;
      for (let k = -KMAX; k < CHUNK + KMAX; k++) {
        const r = rBase + k, o = this.shadeRow(r) + x;
        const y = CHUNK - 1 - k - (this.rowH[o] | 0);
        if (y >= yb) continue;
        const top = y < 0 ? 0 : y;
        const wc = this.rowW[o], c0 = this.rowC[o];
        const c1 = wc === 5 ? w[3] : c0;
        const phase = ((hash2(x - MARGIN, r, 7) * 6) | 0) & 1;
        if (top < yb) {
          const idx = top * W + x;
          b0[idx] = phase ? c1 : c0;
          b1[idx] = phase ? c0 : c1;
          water[idx] = wc;
        }
        const sc = this.rowS[o];
        for (let yy = top + 1; yy < yb; yy++) {
          const idx = yy * W + x;
          b0[idx] = b1[idx] = sc;
        }
        yb = top;
        if (yb <= 0) break;
      }
    }
    return { pixels: [p0, p1], water };
  }

  chunk(c: number): Chunk {
    let ch = this.chunks.get(c);
    if (!ch) this.chunks.set(c, (ch = this.bake(c)));
    return ch;
  }

  evict(lo: number, hi: number): void {
    for (const c of this.chunks.keys()) if (c < lo || c > hi) this.chunks.delete(c);
  }
}

export function visibleChunks(camR: number, viewH: number): number[] {
  const lo = Math.floor((camR - KMAX) / CHUNK), hi = Math.floor((camR + viewH - 1 + KMAX) / CHUNK);
  const out: number[] = [];
  for (let c = lo; c <= hi; c++) out.push(c);
  return out;
}

export function chunkTop(c: number, camR: number, viewH: number): number {
  return Math.round(viewH - (c + 1) * CHUNK + camR);
}
