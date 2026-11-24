/**
 * Sprite stacks for the pixel games. Each model is a tiny voxel grid (a function from
 * (x, y, z) to a colour) sliced into one RGBA image per layer. Drawing the
 * layers bottom-up, 1px apart, all rotated by the same heading, reads as a solid
 * 3D object. Pure: the renderer turns these buffers into Skia images.
 *
 * Every layer canvas is padded 1px per side so it can carry a dark outline.
 * Nose points to y = 0 ("up" at heading 0).
 */

import { rgb } from "./terrain";

export type VoxelFn = (x: number, y: number, z: number) => string | null | undefined;

export interface Model {
  /** Padded layer width / depth in pixels. */
  w: number;
  d: number;
  /** Layer count. */
  h: number;
  /** Per layer, RGBA `w × d`. */
  layers: Uint8Array[];
  /** Same layers blended 65% toward white, for hit flashes. */
  flash: Uint8Array[];
  /** Per layer, a 1px dark ring around that layer's silhouette. */
  outline: Uint8Array[];
  /** Union silhouette of every layer, for the ground shadow. */
  shadow: Uint8Array;
}

const OUTLINE = rgb("#0d1426");
const SHADOW = rgb("#06122a");

export function put(buf: Uint8Array, i: number, r: number, g: number, b: number): void {
  buf[i] = r < 255 ? r : 255;
  buf[i + 1] = g < 255 ? g : 255;
  buf[i + 2] = b < 255 ? b : 255;
  buf[i + 3] = 255;
}

export function makeModel(w: number, d: number, h: number, fn: VoxelFn): Model {
  const V: (string | null)[] = new Array(w * d * h);
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) V[(z * d + y) * w + x] = fn(x, y, z) || null;
  const at = (x: number, y: number, z: number) =>
    x >= 0 && y >= 0 && z >= 0 && x < w && y < d && z < h ? V[(z * d + y) * w + x] : null;
  const PW = w + 2, PD = d + 2;
  const layers: Uint8Array[] = [], flash: Uint8Array[] = [], outline: Uint8Array[] = [];
  const shadow = new Uint8Array(PW * PD * 4);
  for (let z = 0; z < h; z++) {
    const lay = new Uint8Array(PW * PD * 4), fl = new Uint8Array(PW * PD * 4), ol = new Uint8Array(PW * PD * 4);
    for (let y = -1; y <= d; y++) for (let x = -1; x <= w; x++) {
      const i = ((y + 1) * PW + x + 1) * 4;
      const v = at(x, y, z);
      if (!v) {
        if (at(x - 1, y, z) || at(x + 1, y, z) || at(x, y - 1, z) || at(x, y + 1, z)) put(ol, i, ...OUTLINE);
        continue;
      }
      const [r, g, b] = rgb(v);
      let f = 1;
      if (at(x, y, z + 1)) f = 0.7; // covered from above → only seen as the south wall
      else if (!at(x, y - 1, z)) f = 1.14; // north rim catches the light
      else if (!at(x, y + 1, z)) f = 0.86;
      put(lay, i, r * f, g * f, b * f);
      put(fl, i, r * f * 0.35 + 166, g * f * 0.35 + 166, b * f * 0.35 + 166);
      put(shadow, i, ...SHADOW);
    }
    layers.push(lay);
    flash.push(fl);
    outline.push(ol);
  }
  return { w: PW, d: PD, h, layers, flash, outline, shadow };
}

// ── Clouds ───────────────────────────────────────────────────────────────────
export interface CloudSprite {
  w: number;
  h: number;
  pixels: Uint8Array;
  shadow: Uint8Array;
}

/** A chunky blob of overlapping circles, lit from the top-left. */
export function makeCloud(rand: () => number): CloudSprite {
  const h = (10 + rand() * 10) | 0, w = (h * (2 + rand() * 1.6)) | 0;
  const circles: [number, number, number][] = [];
  const n = (4 + rand() * 5) | 0;
  for (let i = 0; i < n; i++) {
    const r = h * (0.22 + rand() * 0.24);
    circles.push([r + rand() * (w - 2 * r), r + rand() * (h - 2 * r), r]);
  }
  const inside = (x: number, y: number) => circles.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
  const pixels = new Uint8Array(w * h * 4), shadow = new Uint8Array(w * h * 4);
  const lit = rgb("#ffffff"), shade = rgb("#a9bcd9"), body = rgb("#e3ecf8");
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inside(x + 0.5, y + 0.5)) continue;
    const i = (y * w + x) * 4;
    put(pixels, i, ...(!inside(x - 1, y - 2) ? lit : !inside(x + 1.5, y + 2.5) ? shade : body));
    put(shadow, i, ...SHADOW);
  }
  return { w, h, pixels, shadow };
}
