/**
 * Shared drawing layer for the pixel games (Task Force, Stacker, Breakout).
 *
 * Each game draws one frame into a small raster Skia surface at its native
 * resolution and hands back a snapshot; the host view scales that up with
 * nearest-neighbour sampling, so everything keeps the chunky low-res look.
 *
 * Sprite stacks go through one `drawAtlas` call per object: every layer's
 * outline, then every layer's colour, each with an RSXform that rotates by the
 * heading and lifts 1px per layer. Text is a white glyph atlas tinted per
 * colour with a SrcIn colour filter.
 */

import {
  AlphaType,
  BlendMode,
  ColorType,
  FilterMode,
  MipmapMode,
  Skia,
  type SkCanvas,
  type SkImage,
  type SkPaint,
  type SkRect,
  type SkRSXform,
  type SkSurface,
} from "@shopify/react-native-skia";
import { ADVANCE, fontAtlasPixels, glyphIndices, GLYPH_H, GLYPH_W, textWidth } from "./font";
import type { Model } from "./models";
import { CHUNK, MARGIN, chunkTop, visibleChunks, type Terrain } from "./terrain";

export const SAMPLING = { filter: FilterMode.Nearest, mipmap: MipmapMode.None };
/** The games' shared ink: outlines, text shadows, banner bands. */
export const INK = "#0a0f1e";
/** White-hot to ember, for flames, sparks and blasts. */
export const FIRE = ["#ffffff", "#fff2a0", "#ffb347", "#ef5a24", "#7a3a2a"];

/** An unpremultiplied RGBA buffer as a Skia image. */
export function makeImage(w: number, h: number, pixels: Uint8Array): SkImage {
  const img = Skia.Image.MakeImage(
    { width: w, height: h, alphaType: AlphaType.Unpremul, colorType: ColorType.RGBA_8888 },
    Skia.Data.fromBytes(pixels),
    w * 4,
  );
  if (!img) throw new Error("pixel: image allocation failed");
  return img;
}

export interface StackAtlas {
  model: Model;
  image: SkImage;
  shadow: SkImage;
  outline: SkRect[];
  color: SkRect[];
  flash: SkRect[];
  full: SkRect;
}

/** Lay a model's layers out as one atlas: columns outline | colour | flash, a row per layer. */
export function stackAtlas(m: Model): StackAtlas {
  const aw = m.w * 3, ah = m.d * m.h, px = new Uint8Array(aw * ah * 4);
  const blit = (src: Uint8Array, col: number, z: number) => {
    for (let y = 0; y < m.d; y++) px.set(src.subarray(y * m.w * 4, (y + 1) * m.w * 4), ((z * m.d + y) * aw + col * m.w) * 4);
  };
  const outline: SkRect[] = [], color: SkRect[] = [], flash: SkRect[] = [];
  for (let z = 0; z < m.h; z++) {
    blit(m.outline[z], 0, z);
    blit(m.layers[z], 1, z);
    blit(m.flash[z], 2, z);
    outline.push(Skia.XYWHRect(0, z * m.d, m.w, m.d));
    color.push(Skia.XYWHRect(m.w, z * m.d, m.w, m.d));
    flash.push(Skia.XYWHRect(m.w * 2, z * m.d, m.w, m.d));
  }
  return { model: m, image: makeImage(aw, ah, px), shadow: makeImage(m.w, m.d, m.shadow), outline, color, flash, full: Skia.XYWHRect(0, 0, m.w, m.d) };
}

export interface StackOptions {
  /** Scale (whole pixels per voxel). */
  k?: number;
  /** Pixels each layer rises, before `k`. */
  lift?: number;
  flash?: boolean;
}

export class PixelPainter {
  readonly W: number;
  readonly H: number;
  protected readonly surface: SkSurface;
  protected readonly plain = Skia.Paint();
  /** Screen-shake offset applied by `px`, `stack` and `shadow`. */
  protected SX = 0;
  protected SY = 0;
  private readonly paints = new Map<string, SkPaint>();
  private readonly tints = new Map<string, SkPaint>();
  private readonly font: SkImage;
  private readonly glyphRects: SkRect[];
  private chunkImages = new Map<number, [SkImage, SkImage]>();
  private chunkGen = -1;

  constructor(width: number, height: number) {
    this.W = width;
    this.H = height;
    const surface = Skia.Surface.Make(width, height);
    if (!surface) throw new Error("pixel: surface allocation failed");
    this.surface = surface;
    const f = fontAtlasPixels();
    this.font = makeImage(f.w, f.h, f.pixels);
    this.glyphRects = Array.from({ length: f.w / ADVANCE }, (_, i) => Skia.XYWHRect(i * ADVANCE, 0, GLYPH_W, GLYPH_H));
  }

  protected canvas(): SkCanvas {
    return this.surface.getCanvas();
  }
  protected snapshot(): SkImage {
    return this.surface.makeImageSnapshot();
  }

  // ── Paint caches ───────────────────────────────────────────────────────────
  protected paint(color: string, alpha = 1): SkPaint {
    const key = color + alpha;
    let p = this.paints.get(key);
    if (!p) {
      p = Skia.Paint();
      p.setColor(Skia.Color(color));
      p.setAlphaf(alpha);
      p.setAntiAlias(false);
      this.paints.set(key, p);
    }
    return p;
  }
  /** Paints a white mask image in `color` (text, silhouettes). */
  protected tint(color: string, alpha = 1): SkPaint {
    const key = color + alpha;
    let p = this.tints.get(key);
    if (!p) {
      p = Skia.Paint();
      p.setColorFilter(Skia.ColorFilter.MakeBlend(Skia.Color(color), BlendMode.SrcIn));
      p.setAlphaf(alpha);
      this.tints.set(key, p);
    }
    return p;
  }

  // ── Primitives ─────────────────────────────────────────────────────────────
  /** A pixel (or `s`×`s` block), shaken. */
  protected px(c: SkCanvas, x: number, y: number, color: string, s = 1, alpha = 1): void {
    c.drawRect(Skia.XYWHRect(Math.round(x) + this.SX, Math.round(y) + this.SY, s, s), this.paint(color, alpha));
  }
  /** A rectangle in screen space (not shaken). */
  protected rect(c: SkCanvas, x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    c.drawRect(Skia.XYWHRect(x, y, w, h), this.paint(color, alpha));
  }
  /** A dimmed full-width band behind banner text. */
  protected band(c: SkCanvas, y: number, h: number, alpha = 0.5): void {
    this.rect(c, 0, y, this.W, h, INK, alpha);
  }
  private xform(a: StackAtlas, x: number, y: number, ang: number, k: number): SkRSXform {
    const c = Math.cos(ang) * k, s = Math.sin(ang) * k, w2 = a.model.w >> 1, d2 = a.model.d >> 1;
    return Skia.RSXform(c, s, x - c * w2 + s * d2, y - s * w2 - c * d2);
  }
  protected stack(cv: SkCanvas, a: StackAtlas, x: number, y: number, ang: number, o: StackOptions = {}): void {
    const k = o.k ?? 1, lift = k * (o.lift ?? 1), steps = Math.max(1, Math.round(lift));
    const tx = Math.round(x) + this.SX, ty = Math.round(y) + this.SY;
    const srcs: SkRect[] = [], xf: SkRSXform[] = [];
    const layerSrc = o.flash ? a.flash : a.color;
    for (const set of [a.outline, layerSrc])
      for (let z = 0; z < a.model.h; z++)
        for (let j = 0; j < steps; j++) {
          srcs.push(set[z]);
          xf.push(this.xform(a, tx, ty - z * lift - j, ang, k));
        }
    cv.drawAtlas(a.image, srcs, xf, this.plain, undefined, undefined, SAMPLING);
  }
  protected shadow(cv: SkCanvas, a: StackAtlas, x: number, y: number, ang: number, dx: number, dy: number, alpha = 0.3, k = 1): void {
    const xf = this.xform(a, Math.round(x + dx) + this.SX, Math.round(y + dy) + this.SY, ang, k);
    cv.drawAtlas(a.shadow, [a.full], [xf], this.paint("#000000", alpha), undefined, undefined, SAMPLING);
  }
  /** Part of an image (`sx`, `sy`, `w`, `h`), rotated by `ang` about its centre at (`cx`, `cy`). */
  protected sprite(cv: SkCanvas, img: SkImage, sx: number, sy: number, w: number, h: number, cx: number, cy: number, ang = 0, paint = this.plain): void {
    const c = Math.cos(ang), s = Math.sin(ang), w2 = w / 2, h2 = h / 2;
    const tx = Math.round(cx) + this.SX - c * w2 + s * h2, ty = Math.round(cy) + this.SY - s * w2 - c * h2;
    cv.drawAtlas(img, [Skia.XYWHRect(sx, sy, w, h)], [Skia.RSXform(c, s, tx, ty)], paint, undefined, undefined, SAMPLING);
  }
  protected text(cv: SkCanvas, s: string, x: number, y: number, color: string, k = 1, shadow: string | null = INK): void {
    const idx = glyphIndices(s);
    if (!idx.length) return;
    const draw = (ox: number, oy: number, col: string) => {
      const srcs = idx.map((i) => this.glyphRects[i]);
      const xf = idx.map((_, i) => Skia.RSXform(k, 0, Math.round(ox) + i * ADVANCE * k, Math.round(oy)));
      cv.drawAtlas(this.font, srcs, xf, this.tint(col), undefined, undefined, SAMPLING);
    };
    if (shadow) draw(x + k, y + k, shadow);
    draw(x, y, color);
  }
  protected textC(cv: SkCanvas, s: string, cx: number, y: number, color: string, k = 1, shadow: string | null = INK): void {
    this.text(cv, s, cx - textWidth(s, k) / 2, y, color, k, shadow);
  }
  /** Text centred on `cx` but kept `pad` px inside the screen edges. */
  protected textIn(cv: SkCanvas, s: string, cx: number, y: number, color: string, k = 1, pad = 2): void {
    const w = textWidth(s, k);
    this.text(cv, s, Math.max(pad, Math.min(this.W - w - pad, cx - w / 2)), y, color, k);
  }

  // ── Terrain ────────────────────────────────────────────────────────────────
  /**
   * Draws the baked terrain chunks covering the screen at `camR`, shifted by
   * `ox` (sideways parallax) and the shake. `gen` changes whenever the
   * terrain is replaced, which drops the cached chunk images. Returns the
   * visible chunk indices.
   */
  protected drawTerrain(cv: SkCanvas, terrain: Terrain, gen: number, camR: number, ox: number, phase: 0 | 1): number[] {
    if (this.chunkGen !== gen) {
      this.chunkImages = new Map();
      this.chunkGen = gen;
    }
    const vis = visibleChunks(camR, this.H);
    for (const c of vis) {
      let imgs = this.chunkImages.get(c);
      if (!imgs) {
        const ch = terrain.chunk(c);
        imgs = [makeImage(terrain.width, CHUNK, ch.pixels[0]), makeImage(terrain.width, CHUNK, ch.pixels[1])];
        this.chunkImages.set(c, imgs);
      }
      cv.drawImage(imgs[phase], -MARGIN - ox, chunkTop(c, camR, this.H) + this.SY);
    }
    const lo = vis[0] ?? 0, hi = vis[vis.length - 1] ?? 0;
    for (const c of this.chunkImages.keys()) if (c < lo || c > hi) this.chunkImages.delete(c);
    terrain.evict(lo - 1, hi + 1);
    return vis;
  }
}
