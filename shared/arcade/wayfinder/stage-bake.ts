/**
 * Pre-baked overlay layers for the Wayfinder expedition stage (the 3D stage
 * itself is drawn by island3d.ts). Baked once per screen size, they become a
 * single image draw. Pure: returns RGBA bytes.
 */

import { rgb } from "../pixel/terrain";

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

function pack(hex: string, alpha = 1): number {
  const [r, g, b] = rgb(hex);
  return ((Math.round(alpha * 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Dithered darkness creeping in from the sides and the floor. */
export function bakeVignette(W: number, H: number): Baked {
  // Smooth alpha rather than dither: a dithered vignette reads as a screen door.
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
