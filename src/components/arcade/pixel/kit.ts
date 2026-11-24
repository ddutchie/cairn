/**
 * Pixel kit for the Cairn Arcade (the hidden desktop games). Everything draws
 * into one 180×320 canvas that the host upscales with nearest-neighbour.
 *
 * Colours here are a fixed game palette, not theme tokens: the games render
 * their own night-sky / island art in both themes, the same as on mobile.
 *
 * - Terrain: a per-column heightmap raycast into an ImageData buffer.
 * - Sprite stacks: voxel models sliced into layers, drawn bottom-up 1px apart
 *   and rotated together, each layer with a 1px dark outline.
 * - Text: a 3×5 bitmap font.
 *
 * Only one game runs at a time, so the bound canvas lives in `scr`.
 */

/**
 * Screen size in game pixels. Height is fixed (the layouts are tuned for it);
 * width follows the view's shape, set by `bindScreen` before a game is made.
 * Live bindings: always read these at use, never cache them at module load.
 */
export let W = 180;
export const H = 320;
/** Narrowest (the phone shape) and widest screen a game gets. */
export const MIN_W = 180;
export const MAX_W = 960;
/** Terrain margin each side, so a sideways camera drift has columns to show. */
export const M = 12;

export const INK = "#0a0f1e";
export const FIRE = ["#ffffff", "#fff2a0", "#ffb347", "#ef5a24", "#7a3a2a"];

interface Screen {
  ctx: CanvasRenderingContext2D;
  img: ImageData;
  buf: Uint32Array;
  /** Screen-shake offset applied by `px`, `drawStack` and `drawShadow`. */
  sx: number;
  sy: number;
}

export const scr: Screen = {
  ctx: null as unknown as CanvasRenderingContext2D,
  img: null as unknown as ImageData,
  buf: new Uint32Array(0),
  sx: 0,
  sy: 0,
};

/** Point the kit at a canvas `width` game pixels wide (call before creating a game). */
export function bindScreen(canvas: HTMLCanvasElement, width = MIN_W): void {
  W = Math.round(Math.min(MAX_W, Math.max(MIN_W, width)));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.imageSmoothingEnabled = false;
  scr.ctx = ctx;
  scr.img = ctx.createImageData(W, H);
  scr.buf = new Uint32Array(scr.img.data.buffer);
  scr.sx = scr.sy = 0;
}

// ── Maths ────────────────────────────────────────────────────────────────────
export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
/** Compute once, on first use (models need `document`, which a static prerender lacks). */
export function lazy<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= make());
}

// ── Colour ───────────────────────────────────────────────────────────────────
export type RGB = [number, number, number];
export function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** A hex colour as a little-endian RGBA pixel for the ImageData buffer. */
export function u32(h: string): number {
  const [r, g, b] = hex(h);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}
export function darken(h: string, f: number): number {
  const [r, g, b] = hex(h);
  return ((255 << 24) | (((b * f) | 0) << 16) | (((g * f) | 0) << 8) | ((r * f) | 0)) >>> 0;
}
export function lerpHex(a: string, b: string, f: number): string {
  const A = hex(a), Bc = hex(b);
  return "#" + A.map((v, i) => Math.round(v + (Bc[i] - v) * f).toString(16).padStart(2, "0")).join("");
}
const rgbCache = new Map<string, RGB>();
export function rgb(h: string): RGB {
  let v = rgbCache.get(h);
  if (!v) rgbCache.set(h, (v = hex(h)));
  return v;
}

// ── Noise ────────────────────────────────────────────────────────────────────
export function hash2(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
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

// ── Biomes (water ramp deep→foam; land bands × [dark, mid, light]) ──────────
export type BiomeName = "tropic" | "desert" | "tundra" | "volcano";
interface BiomeDef {
  water: string[];
  bands: string[][];
  tree: string[];
  lava?: string[];
}
export const BIOMES: Record<BiomeName, BiomeDef> = {
  tropic: {
    water: ["#173c8f", "#1f55b5", "#2a74d2", "#47a3e6", "#cfeeff"],
    bands: [["#c9a56a", "#e8cf8e", "#f6e7b4"], ["#3f8f2e", "#5cb83a", "#86d94c"], ["#24602a", "#337d32", "#4a9a3c"], ["#5f5a5a", "#807878", "#a49b96"], ["#9a9a9a", "#c4c4c4", "#ececec"]],
    tree: ["#1d4f24", "#2f7a2f"],
  },
  desert: {
    water: ["#11506e", "#18708f", "#2393a8", "#4cbcc0", "#d6f4ec"],
    bands: [["#b9874f", "#d9a866", "#efc98a"], ["#a48a4a", "#c2a85c", "#d8c27a"], ["#8a4f2e", "#a8623a", "#c97d4d"], ["#6e4a36", "#8c5e44", "#a8775a"], ["#c9a27a", "#e0bf98", "#f0d9b8"]],
    tree: ["#5e6b2a", "#7d8c3a"],
  },
  tundra: {
    water: ["#1a2f55", "#24447a", "#33609c", "#5487bd", "#e6f2ff"],
    bands: [["#7e8a96", "#9aa6b2", "#b8c3cc"], ["#5d7a6a", "#76957f", "#93b29a"], ["#2e4f45", "#3d6658", "#4f7d6c"], ["#5a5f6a", "#727885", "#8d94a0"], ["#c8d6e8", "#e4eef8", "#ffffff"]],
    tree: ["#1f3a33", "#dfe9f4"],
  },
  volcano: {
    water: ["#0f2a3a", "#163d52", "#1f566b", "#2f7a85", "#bfe3e0"],
    bands: [["#3a3436", "#4d4548", "#625a5c"], ["#3d5a2e", "#54743a", "#6d8f48"], ["#2a2628", "#3a3436", "#4c4446"], ["#4a3430", "#5e443c", "#76584c"], ["#231e20", "#2f292b", "#3e3638"]],
    tree: ["#243d1e", "#3d5a2e"],
    lava: ["#c2401f", "#ef6a24", "#ffb347"],
  },
};
export const BIOME_ORDER: BiomeName[] = ["tropic", "desert", "tundra", "volcano"];

// ── Terrain ──────────────────────────────────────────────────────────────────
const SEA = 0.5, RELIEF = 64, KMAX = 34, ROWS = 1024;

/**
 * Endless scrolling islands. `render` raycasts columns front to back into the
 * screen buffer; rows are generated on demand into a ring cache.
 */
export class Terrain {
  private water: number[] = [];
  private top: number[][] = [];
  private side: number[] = [];
  private tree: number[] = [];
  private treeSide = 0;
  private lava: number[] | null = null;
  /** Row width: the screen at creation (or resize) plus the drift margin each side. */
  private ww = 0;
  private rowH = new Float32Array(0);
  private rowC = new Uint32Array(0);
  private rowS = new Uint32Array(0);
  private rowW = new Uint8Array(0);
  private readonly rowId = new Int32Array(ROWS).fill(-1e9);
  seed = 1;

  constructor(biome: BiomeName = "tropic", seed = 1) {
    this.ensureWidth();
    this.set(biome, seed);
  }

  private ensureWidth(): void {
    const need = W + M * 2;
    if (this.ww === need) return;
    this.ww = need;
    this.rowH = new Float32Array(ROWS * need);
    this.rowC = new Uint32Array(ROWS * need);
    this.rowS = new Uint32Array(ROWS * need);
    this.rowW = new Uint8Array(ROWS * need);
    this.rowId.fill(-1e9);
  }

  /** Switch biome and seed; drops the row cache. */
  set(name: BiomeName, seed: number): void {
    const s = BIOMES[name];
    this.water = s.water.map(u32);
    this.top = s.bands.map((b) => b.map(u32));
    this.side = s.bands.map((b) => darken(b[0], 0.7));
    this.tree = s.tree.map(u32);
    this.treeSide = darken(s.tree[0], 0.7);
    this.lava = s.lava ? s.lava.map(u32) : null;
    this.seed = seed;
    this.rowId.fill(-1e9);
  }

  /** The deepest water colour, for clearing. */
  get deep(): number {
    return this.water[0];
  }

  private heightAt(x: number, r: number): number {
    let h = fbm(x / 56, r / 56, this.seed);
    h += (vnoise(x / 140 + 3.1, r / 180, this.seed + 91) - 0.5) * 0.36;
    return (h - 0.572) * 1.4 + SEA; // ~35% land, island chains with open sea between
  }

  private genRow(r: number): void {
    const slot = r & (ROWS - 1), seed = this.seed, WW = this.ww;
    this.rowId[slot] = r;
    const o0 = slot * WW;
    for (let i = 0; i < WW; i++) {
      const x = i - M, o = o0 + i, h = this.heightAt(x, r), dth = BAYER[((r & 3) << 2) | (x & 3)];
      if (h < SEA) {
        const d = SEA - h + (dth - 0.5) * 0.03;
        const c = d > 0.17 ? 0 : d > 0.1 ? 1 : d > 0.045 ? 2 : d > 0.014 ? 3 : 4;
        this.rowH[o] = 0;
        this.rowC[o] = this.rowS[o] = this.water[c];
        this.rowW[o] = c + 1;
        continue;
      }
      const e = h - SEA, ej = e + (dth - 0.5) * 0.02;
      const b = ej < 0.03 ? 0 : ej < 0.13 ? 1 : ej < 0.24 ? 2 : ej < 0.36 ? 3 : 4;
      const sl = (this.heightAt(x + 1, r - 1) - this.heightAt(x - 1, r + 1)) * 70 + (dth - 0.5) * 0.7;
      const s = sl > 0.3 ? 2 : sl < -0.3 ? 0 : 1;
      let hh = Math.min(e, 0.5) * RELIEF, c = this.top[b][s], sd = this.side[b];
      if ((b === 1 || b === 2) && hash2(x, r, seed + 5) < (b === 2 ? 0.32 : 0.07)) {
        hh += 2;
        c = this.tree[hash2(x, r, seed + 6) < 0.55 ? 0 : 1];
        sd = this.treeSide;
      }
      if (this.lava && b >= 3) {
        // Lava: thin cracks down dark basalt, a molten crater at the very top.
        const crack = Math.abs(vnoise(x / 7, r / 11, seed + 40) - 0.5);
        const crater = e > 0.44;
        if (crater || crack < (b === 4 ? 0.045 : 0.02)) {
          c = this.lava[crater ? 2 : s === 0 ? 0 : 1];
          sd = this.lava[0];
          hh -= crater ? 3 : 1;
        }
      }
      this.rowH[o] = hh;
      this.rowC[o] = c;
      this.rowS[o] = sd;
      this.rowW[o] = 0;
    }
  }

  /** Draw into the screen buffer (call `blit()` after). `camR` = world row at the bottom edge. */
  render(camR: number, ox: number, oy: number, t: number): void {
    this.ensureWidth();
    const buf = scr.buf, base = Math.floor(camR), tick = t >> 3, WW = this.ww;
    for (let x = 0; x < W && x < WW - 2 * M; x++) {
      let yb = H;
      const col = x + M + ox;
      for (let k = -KMAX; k < H + KMAX + 8; k++) {
        const r = base + k, slot = r & (ROWS - 1);
        if (this.rowId[slot] !== r) this.genRow(r);
        const o = slot * WW + col;
        const y = H - 1 - k - (this.rowH[o] | 0) + oy;
        if (y < yb) {
          const top = y < 0 ? 0 : y;
          let c = this.rowC[o];
          const wc = this.rowW[o];
          if (wc === 5) {
            if (((hash2(col, r, 7) * 6 + t * 0.04) | 0) & 1) c = this.water[3];
          } else if (wc && wc <= 3 && hash2(col, r, tick) < 0.004) c = this.water[4];
          if (top < yb) buf[top * W + x] = c;
          const sc = this.rowS[o];
          for (let yy = top + 1; yy < yb; yy++) buf[yy * W + x] = sc;
          yb = top;
        }
        if (yb <= 0) break;
      }
    }
  }
}

/** Copy the screen buffer to the canvas. */
export function blit(): void {
  scr.ctx.putImageData(scr.img, 0, 0);
}

// ── Sprite stacks ────────────────────────────────────────────────────────────
export function mkCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext("2d");
  if (!g) throw new Error("2D canvas unavailable");
  return g;
}

export interface Model {
  /** Padded width / depth (1px each side for the outline). */
  w: number;
  d: number;
  h: number;
  slices: HTMLCanvasElement[];
  white: HTMLCanvasElement[];
  outline: HTMLCanvasElement[];
  shadow: HTMLCanvasElement;
}

export type Voxel = (x: number, y: number, z: number) => string | null | undefined | false;

export function makeModel(w: number, d: number, h: number, fn: Voxel): Model {
  const V: (string | null)[] = new Array(w * d * h);
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) V[(z * d + y) * w + x] = fn(x, y, z) || null;
  const at = (x: number, y: number, z: number): string | null =>
    x >= 0 && y >= 0 && z >= 0 && x < w && y < d && z < h ? V[(z * d + y) * w + x] : null;
  const PW = w + 2, PD = d + 2;
  const slices: HTMLCanvasElement[] = [], white: HTMLCanvasElement[] = [], outline: HTMLCanvasElement[] = [];
  const sh = mkCanvas(PW, PD), sx = ctx2d(sh);
  sx.fillStyle = "#06122a";
  for (let z = 0; z < h; z++) {
    const ol = mkCanvas(PW, PD), og = ctx2d(ol);
    og.fillStyle = "#0d1426";
    for (let y = -1; y <= d; y++)
      for (let x = -1; x <= w; x++)
        if (!at(x, y, z) && (at(x - 1, y, z) || at(x + 1, y, z) || at(x, y - 1, z) || at(x, y + 1, z))) og.fillRect(x + 1, y + 1, 1, 1);
    outline.push(ol);
    const c = mkCanvas(PW, PD), c2 = mkCanvas(PW, PD), g = ctx2d(c), g2 = ctx2d(c2);
    const id = g.createImageData(PW, PD), id2 = g2.createImageData(PW, PD);
    for (let y = 0; y < d; y++)
      for (let x = 0; x < w; x++) {
        const v = at(x, y, z);
        if (!v) continue;
        const [r, gg, b] = rgb(v);
        let f = 1;
        if (at(x, y, z + 1)) f = 0.7; // covered from above → only the south wall shows
        else if (!at(x, y - 1, z)) f = 1.14; // north rim catches the light
        else if (!at(x, y + 1, z)) f = 0.86;
        const i = ((y + 1) * PW + x + 1) * 4;
        id.data[i] = Math.min(255, r * f);
        id.data[i + 1] = Math.min(255, gg * f);
        id.data[i + 2] = Math.min(255, b * f);
        id.data[i + 3] = 255;
        // Hit flash: 65% toward white, so the form survives the flash.
        id2.data[i] = r * f * 0.35 + 166;
        id2.data[i + 1] = gg * f * 0.35 + 166;
        id2.data[i + 2] = b * f * 0.35 + 166;
        id2.data[i + 3] = 255;
        sx.fillRect(x + 1, y + 1, 1, 1);
      }
    g.putImageData(id, 0, 0);
    g2.putImageData(id2, 0, 0);
    slices.push(c);
    white.push(c2);
  }
  return { w: PW, d: PD, h, slices, white, outline, shadow: sh };
}

export interface StackOpts {
  /** Scale. */
  k?: number;
  /** Pixels between layers (before scale). */
  lift?: number;
  flash?: boolean;
}

export function drawStack(m: Model, x: number, y: number, ang: number, o: StackOpts = {}): void {
  const ctx = scr.ctx, k = o.k || 1, lift = k * (o.lift || 1), steps = Math.max(1, Math.round(lift));
  const c = Math.cos(ang) * k, s = Math.sin(ang) * k;
  const tx = Math.round(x) + scr.sx, ty = Math.round(y) + scr.sy, sl = o.flash ? m.white : m.slices;
  for (let z = 0; z < m.h; z++)
    for (let j = 0; j < steps; j++) {
      ctx.setTransform(c, s, -s, c, tx, ty - z * lift - j);
      ctx.drawImage(m.outline[z], -(m.w >> 1), -(m.d >> 1));
    }
  for (let z = 0; z < m.h; z++)
    for (let j = 0; j < steps; j++) {
      ctx.setTransform(c, s, -s, c, tx, ty - z * lift - j);
      ctx.drawImage(sl[z], -(m.w >> 1), -(m.d >> 1));
    }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function drawShadow(m: Model, x: number, y: number, ang: number, dx: number, dy: number, a = 0.3, k = 1): void {
  const ctx = scr.ctx;
  ctx.globalAlpha = a;
  const c = Math.cos(ang) * k, s = Math.sin(ang) * k;
  ctx.setTransform(c, s, -s, c, Math.round(x + dx) + scr.sx, Math.round(y + dy) + scr.sy);
  ctx.drawImage(m.shadow, -(m.w >> 1), -(m.d >> 1));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

// ── Clouds: chunky pixel blobs with a lit top-left edge ─────────────────────
export interface Cloud {
  c: HTMLCanvasElement;
  /** Shadow silhouette. */
  s: HTMLCanvasElement;
  w: number;
  h: number;
}
export function makeCloud(): Cloud {
  const h = (10 + Math.random() * 10) | 0, w = (h * (2 + Math.random() * 1.6)) | 0, circles: [number, number, number][] = [];
  const n = (4 + Math.random() * 5) | 0;
  for (let i = 0; i < n; i++) {
    const r = h * (0.22 + Math.random() * 0.24);
    circles.push([r + Math.random() * (w - 2 * r), r + Math.random() * (h - 2 * r), r]);
  }
  const inside = (x: number, y: number) => circles.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
  const c = mkCanvas(w, h), g = ctx2d(c), s = mkCanvas(w, h), gs = ctx2d(s);
  gs.fillStyle = "#06122a";
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      g.fillStyle = !inside(x - 1, y - 2) ? "#ffffff" : !inside(x + 1.5, y + 2.5) ? "#a9bcd9" : "#e3ecf8";
      g.fillRect(x, y, 1, 1);
      gs.fillRect(x, y, 1, 1);
    }
  return { c, s, w, h };
}
export const clouds = lazy(() => Array.from({ length: 10 }, makeCloud));

// ── Drawing ──────────────────────────────────────────────────────────────────
/** One pixel (or an s×s block), shaken. */
export function px(x: number, y: number, c: string, s = 1): void {
  scr.ctx.fillStyle = c;
  scr.ctx.fillRect(Math.round(x) + scr.sx, Math.round(y) + scr.sy, s, s);
}
/** A full-width dark band, for HUD rows and banners. */
export function band(y: number, h: number, a = 0.5): void {
  const ctx = scr.ctx;
  ctx.globalAlpha = a;
  ctx.fillStyle = INK;
  ctx.fillRect(0, y, W, h);
  ctx.globalAlpha = 1;
}
export function rect(x: number, y: number, w: number, h: number, c: string, a = 1): void {
  const ctx = scr.ctx;
  ctx.globalAlpha = a;
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
}

// ── Bitmap font (3×5) ────────────────────────────────────────────────────────
const FONT: Record<string, string> = {
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110", E: "111100110100111", F: "111100110100100",
  G: "011100101101011", H: "101101111101101", I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
  M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100", Q: "010101101110011", R: "110101110101101",
  S: "011100010001110", T: "111010010010010", U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
  Y: "101101010010010", Z: "111001010100111", "0": "111101101101111", "1": "010110010010111", "2": "110001010100111", "3": "110001010001110",
  "4": "101101111001001", "5": "111100110001110", "6": "011100111101111", "7": "111001010010010", "8": "111101111101111", "9": "111101111001110",
  ":": "000010000010000", ".": "000000000000010", "-": "000000111000000", "!": "010010010000010", "/": "001001010100100", "'": "010010000000000",
  "?": "110001010000010", "+": "000010111010000", " ": "000000000000000", ",": "000000000010100", "&": "010101010101011", "=": "000111000111000",
  x: "000101010101000", "#": "101111101111101", "<": "001010100010001", ">": "100010001010100",
};
export const textW = (s: string, k = 1): number => (s.length * 4 - 1) * k;
/** Draw glyphs in `g`'s current fill (no case change, no shadow). */
export function glyphs(s: string, x: number, y: number, k = 1, g: CanvasRenderingContext2D = scr.ctx): void {
  const ctx = g;
  for (let i = 0; i < s.length; i++) {
    const g = FONT[s[i]] || FONT["?"];
    for (let p = 0; p < 15; p++) if (g.charCodeAt(p) === 49) ctx.fillRect(x + i * 4 * k + (p % 3) * k, y + ((p / 3) | 0) * k, k, k);
  }
}
/** Text in the 3×5 font, upper-cased (a lone "x" stays the multiplier glyph). */
export function drawText(s: string, x: number, y: number, col: string, k = 1, sh: string | null = INK): void {
  const ctx = scr.ctx;
  s = s === "x" || /^x\d/.test(s) ? s : s.toUpperCase();
  if (sh) {
    ctx.fillStyle = sh;
    glyphs(s, x + k, y + k, k);
  }
  ctx.fillStyle = col;
  glyphs(s, x, y, k);
}
export function drawTextC(s: string, cx: number, y: number, col: string, k = 1, sh: string | null = INK): void {
  drawText(s, Math.round(cx - textW(s, k) / 2), y, col, k, sh);
}
export const clipText = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + ".");
/** Strip characters the font lacks, so real titles don't render as "?". */
export function fontSafe(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^A-Z0-9:.\-!/'?+ ,&=#<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
