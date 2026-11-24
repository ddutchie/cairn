/**
 * Pre-baked layers for the Wayfinder expedition stage. Painting these per
 * frame (noise fog, dithered sky, rock flats, vignette) costs several ms; baked
 * once per island step and screen size they become a handful of image draws,
 * which keeps Skia on a phone at 60 fps. Pure: returns RGBA bytes.
 */

import { BAYER, fbm, hash2, rgb } from "../pixel/terrain";
import { lerpHex } from "../pixel/kinds";

const INK = "#0a0f1e";

export interface Baked {
  w: number;
  h: number;
  bytes: Uint8Array;
}

class Raster {
  readonly bytes: Uint8Array;
  private readonly px: Uint32Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.bytes = new Uint8Array(Math.max(1, w * h) * 4);
    this.px = new Uint32Array(this.bytes.buffer);
  }
  fill(x: number, y: number, w: number, h: number, col: number): void {
    const x0 = Math.max(0, Math.round(x)), x1 = Math.min(this.w, Math.round(x + w));
    const y0 = Math.max(0, Math.round(y)), y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) this.px.fill(col, yy * this.w + x0, yy * this.w + x1);
  }
  out(): Baked {
    return { w: this.w, h: this.h, bytes: this.bytes };
  }
}

export function pack(hex: string, alpha = 1): number {
  const [r, g, b] = rgb(hex);
  return ((Math.round(alpha * 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Sky: a dithered eight-band gradient from `top` down to `low` at the horizon. */
export function bakeSky(W: number, hor: number, top: string, low: string): Baked {
  const r = new Raster(W, hor);
  for (let y = 0; y < hor; y += 2) {
    const q = (y / hor) * 7, i = Math.floor(q);
    const a = pack(lerpHex(top, low, i / 7)), b = pack(lerpHex(top, low, Math.min(1, (i + 1) / 7)));
    for (let x = 0; x < W; x += 2) r.fill(x, y, 2, 2, BAYER[((y >> 1) & 3) * 4 + ((x >> 1) & 3)] < q - i ? b : a);
  }
  return r.out();
}

/** The far ridge, `pad` pixels wider than the stage so it can drift; rises toward `rise`. */
export function bakeRidge(W: number, pad: number, hor: number, rise: -1 | 1, seed: number, volcano: boolean, body: string, rim: string): Baked {
  const r = new Raster(W + pad, hor), B = pack(body), R = pack(rim);
  for (let x = 0; x < W + pad; x += 2) {
    const sx = x - pad / 2, u = Math.max(0, Math.min(1, rise > 0 ? sx / W : 1 - sx / W));
    let h = 10 + 18 * fbm((x + seed * 90) * 0.02, 3.1, 11) + u * u * hor * 0.35;
    if (volcano) h += Math.max(0, 30 - Math.abs(sx - W * 0.3) * 0.6);
    const top = Math.round(hor - h);
    r.fill(x, top, 2, hor - top, B);
    r.fill(x, top, 2, 1, R);
  }
  return r.out();
}

/** How far a rock wing reaches in from its side of the stage at row `y` (fully slid in). */
export function cliffEdge(y: number, u: number, width: number, seed: number): number {
  const ledge = Math.floor(y / 22);
  return Math.round(width * (0.12 + 0.88 * u) + (fbm(y * 0.07, seed, 5) - 0.5) * 16 + (ledge % 2) * 5);
}

/**
 * A rock wing at one side, as an image `cw` wide (anchored to that side of
 * the stage, spanning rows 0..bottom): strata, a lit edge, an ink outline and,
 * with `tuft` colours, grass on its ledges.
 */
export function bakeCliff(side: -1 | 1, width: number, top: number, bottom: number, col: string[], seed: number, outline: boolean, tuft: readonly string[] | null): Baked {
  const cw = Math.ceil(width + 24), r = new Raster(cw, bottom), span = Math.max(1, bottom - top);
  const C0 = pack(col[0]), C1 = pack(col[1]), C2 = pack(col[2]), K = pack(INK);
  const T = tuft ? [pack(tuft[0]), pack(tuft[1])] : null;
  let last = 0;
  for (let y = Math.max(0, top); y < bottom; y++) {
    const d = Math.min(cw - 1, cliffEdge(y, (y - top) / span, width, seed));
    if (d <= 0) continue;
    const x0 = side < 0 ? 0 : cw - d;
    r.fill(x0, y, d, 1, fbm(y * 0.22, seed + 1, 9) > 0.52 ? C0 : C1);
    r.fill(side < 0 ? d - 3 : cw - d, y, 3, 1, C2);
    if (outline) r.fill(side < 0 ? d : cw - d - 1, y, 1, 1, K);
    if (T && last && d - last > 3 && y < bottom - 6) {
      const ex = side < 0 ? d : cw - d;
      for (let b = 0; b < 5; b++) {
        const bx = ex - side * (b - 1) * 2, len = 3 + ((b * 7 + seed) % 4);
        for (let k = 0; k < len; k++) r.fill(bx + (k > len / 2 ? -side : 0), y - k, 1, 1, T[k % 2 ? 0 : 1]);
      }
    }
    last = d;
  }
  return r.out();
}

/**
 * A cave mouth over the whole stage: its lip hangs to `lip` mid-stage and to
 * `hor` at the sides. Chunky stepped rock (4 px blocks) with strata that sink
 * into darkness toward the top, a lit underside, tapered stalactites and, with
 * a `drip` colour, hanging vines or icicles.
 */
export function bakeCavern(W: number, lip: number, hor: number, col: string[], drip: string | null = null, lean: -1 | 1 = 1): Baked {
  const r = new Raster(W, hor + 28), K = pack(INK);
  const C = [col[0], col[1], col[2]];
  // Four depth tints per tone: top of the ceiling is deepest in shadow.
  const tone = C.map((c) => [0.62, 0.42, 0.22, 0].map((d) => pack(lerpHex(c, INK, d))));
  const lit = pack(lerpHex(col[2], "#ffffff", 0.18)), DRIP = drip ? pack(drip) : 0;
  const lipAt = (x: number) => {
    // Off-centre: the arch's crown sits toward `-lean`, so one side hangs lower.
    const bx = x >> 2, d = (bx * 4 + 2 - W * (0.5 - lean * 0.08)) / (W / 2), u = Math.abs(d) * (d * lean > 0 ? 1.15 : 0.9);
    return Math.min(hor + 10, Math.round(lip + u * u * (hor - lip) * 1.2 + (fbm(bx * 0.3, 4, 21) - 0.3) * 14 + (hash2(bx, 1, 9) < 0.25 ? 3 : 0)));
  };
  for (let x = 0; x < W; x += 2) {
    const h = lipAt(x);
    for (let y = 0; y < h; y += 2) {
      const depth = Math.min(3, Math.floor(((y / Math.max(1, h)) ** 0.7) * 4));
      // Strata: bands that wander, broken into blocks.
      const band = Math.floor((y + fbm(x * 0.05, 2, 7) * 10) / 7);
      const t = hash2(x >> 3, band, 13) < 0.35 ? 0 : 1;
      const dith = BAYER[((y >> 1) & 3) * 4 + ((x >> 1) & 3)] < (y / h) * 4 - depth ? Math.min(3, depth + 1) : depth;
      // The soffit: the last rows above the lip catch daylight from outside.
      const soff = h - y < 12 && BAYER[((y >> 1) & 3) * 4 + ((x >> 1) & 3)] < (1 - (h - y) / 12) * 1.2;
      r.fill(x, y, 2, 2, soff ? tone[2][Math.min(3, dith + 1)] : tone[t][dith]);
      // Block ledges: a lit top and a dark seam where strata change.
      const next = Math.floor((y + 2 + fbm(x * 0.05, 2, 7) * 10) / 7);
      if (next !== band && !soff) {
        if (hash2(x >> 3, band, 31) < 0.55) r.fill(x, y + 1, 2, 1, tone[2][Math.max(0, dith - 1)]);
        else r.fill(x, y + 1, 2, 1, tone[0][Math.max(0, dith - 2)]);
      }
    }
    // The lip: a lit underside two rows deep, a thin bright edge, then ink.
    r.fill(x, h - 4, 2, 2, tone[2][3]);
    r.fill(x, h - 2, 2, 1, tone[2][3]);
    r.fill(x, h - 1, 2, 1, lit);
    r.fill(x, h, 2, 1, K);
    // A step in the lip gets an ink side so the blocks read as solid.
    const n = x + 2 < W ? lipAt(x + 2) : h;
    if (n !== h) r.fill(n > h ? x + 2 : x, Math.min(h, n), 1, Math.abs(n - h), K);
  }
  // Stalactites: tapered, lit on the left, ink outline.
  for (let bx = 4; bx < W - 8; bx += 6) {
    const s = hash2(bx, 3, 3);
    if (s > 0.3) continue;
    const base = lipAt(bx), len = 4 + Math.round(hash2(bx, 5, 3) * 14), w0 = len > 10 ? 6 : 4;
    for (let k = 0; k < len; k++) {
      const w = Math.max(1, Math.round(w0 * (1 - k / len)));
      const x0 = bx + Math.floor((w0 - w) / 2), y = base + k;
      r.fill(x0 - 1, y, w + 2, 1, K);
      r.fill(x0, y, w, 1, tone[1][3]);
      r.fill(x0, y, 1, 1, tone[2][3]);
    }
    r.fill(bx + (w0 >> 1) - 1, base + len, 1, 1, K);
  }
  // Vines or icicles hanging off the lip.
  if (DRIP) {
    for (let x = 1; x < W; x += 3) {
      if (hash2(x, 8, 17) > 0.22) continue;
      const base = lipAt(x) + 1, len = 3 + Math.round(hash2(x, 9, 17) * 9);
      for (let k = 0; k < len; k++) r.fill(x + ((k >> 2) & 1), base + k, 1, 1, k === len - 1 ? K : DRIP);
    }
  }
  return r.out();
}

export const FOG_STRIP = 512;

/** A horizontally tileable, dithered fog bank `2h + 1` rows tall, densest in its middle row. */
export function bakeFog(h: number, col: string, alpha: number, seed: number): Baked {
  const r = new Raster(FOG_STRIP, h * 2 + 2);
  for (let row = -h; row <= h; row += 2) {
    const dens = 1 - Math.abs(row) / h, c = pack(col, alpha * dens);
    for (let x = 0; x < FOG_STRIP; x += 4) {
      const f = x / FOG_STRIP;
      const n = fbm(x * 0.025, row * 0.08, seed * 17) * (1 - f) + fbm((x - FOG_STRIP) * 0.025, row * 0.08, seed * 17) * f;
      if (n + BAYER[(((row + 64) >> 1) & 3) * 4 + ((x >> 2) & 3)] * 0.25 > 1.05 - dens * 0.7) r.fill(x, row + h, 4, 2, c);
    }
  }
  return r.out();
}

/** Dithered darkness creeping in from the sides and the floor. */
export function bakeVignette(W: number, H: number): Baked {
  // Smooth alpha rather than dither: a dithered vignette reads as a screen
  // door over the crisp near wings.
  const r = new Raster(W, H), edge = Math.min(40, W * 0.16), base = H * 0.72;
  for (let y = 0; y < H; y += 2) {
    const vy = y > base ? (y - base) / (H - base) : 0;
    for (let x = 0; x < W / 2; x += 2) {
      const v = Math.max(vy * 0.6, 1 - x / edge) * 0.8;
      if (v <= 0) continue;
      const c = pack(INK, 0.24 * v * v);
      r.fill(x, y, 2, 2, c);
      r.fill(W - x - 2, y, 2, 2, c);
    }
  }
  return r.out();
}

/** Sun shafts fanning down from (`sx`, `sy`) to below the horizon: soft, faint, in `col`. */
export function bakeShafts(W: number, bottom: number, sx: number, sy: number, col: string, seed: number): Baked {
  const r = new Raster(W, bottom);
  for (let i = 0; i < 4; i++) {
    const slope = (sx > W / 2 ? -1 : 1) * (0.25 + i * 0.32 + hash2(i, 1, seed) * 0.15), w0 = 3 + hash2(i, 2, seed) * 5;
    const a = 0.05 + hash2(i, 3, seed) * 0.06;
    for (let y = Math.max(0, Math.round(sy)); y < bottom; y++) {
      const d = y - sy, w = w0 + d * 0.12, c = sx + d * slope, fade = Math.min(1, d / 30) * (1 - Math.max(0, (y - bottom + 24) / 24));
      if (fade <= 0) continue;
      for (let x = Math.round(c - w); x < Math.round(c + w); x++) {
        if (x < 0 || x >= W) continue;
        const edge = 1 - Math.abs(x - c) / w;
        r.fill(x, y, 1, 1, pack(col, a * fade * Math.min(1, edge * 2)));
      }
    }
  }
  return r.out();
}
