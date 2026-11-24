/**
 * Platform-neutral pixel painter & backend interface shared by all Cairn Arcade
 * renderers on both desktop (HTML5 Canvas2D) and mobile (Skia).
 */

import { ADVANCE, clip, fontAtlasPixels, glyphIndices, textWidth } from "./font";
import type { Model } from "./models";
import { CHUNK, MARGIN, chunkTop, visibleChunks, type Terrain } from "./terrain";

export const INK = "#0a0f1e";
export const FIRE = ["#ffffff", "#fff2a0", "#ffb347", "#ef5a24", "#7a3a2a"];

export interface StackOptions {
  k?: number;
  lift?: number;
  flash?: boolean;
}

export interface AtlasHandle<Img = unknown> {
  readonly model: Model;
  readonly image: Img;
  readonly shadow: Img;
}

export interface PixelSurface<Img = unknown, Frame = unknown> {
  readonly W: number;
  readonly H: number;
  resize(width: number, height: number): void;
  clear(color: string): void;
  snapshot(): Frame;
  toImage(): Img;
  drawRect(x: number, y: number, w: number, h: number, color: string, alpha?: number): void;
  drawStrokeRect(x: number, y: number, w: number, h: number, color: string, alpha?: number): void;
  drawCircle(cx: number, cy: number, r: number, color: string, alpha?: number, stroke?: boolean): void;
  drawLine(x1: number, y1: number, x2: number, y2: number, color: string, alpha?: number): void;
  drawImage(img: Img, x: number, y: number, alpha?: number): void;
  drawImageRect(img: Img, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, alpha?: number): void;
  drawTintedImage(img: Img, x: number, y: number, color: string, alpha?: number): void;
  drawSprite(img: Img, sx: number, sy: number, w: number, h: number, tx: number, ty: number, ang: number, alpha?: number): void;
  drawStack(atlas: AtlasHandle<Img>, tx: number, ty: number, ang: number, opts?: StackOptions): void;
  drawShadow(atlas: AtlasHandle<Img>, tx: number, ty: number, ang: number, alpha: number, k: number): void;
  drawGlyphs(font: Img, indices: number[], x: number, y: number, k: number, color: string, alpha?: number): void;
  clipRect(x: number, y: number, w: number, h: number, fn: () => void): void;
}

export interface PixelBackend<Img = unknown, Frame = unknown> {
  createSurface(width: number, height: number): PixelSurface<Img, Frame>;
  makeImage(w: number, h: number, rgba: Uint8Array): Img;
  makeAtlas(m: Model): AtlasHandle<Img>;
}

export abstract class PixelPainter<Img = unknown, Frame = unknown> {
  protected readonly backend: PixelBackend<Img, Frame>;
  protected readonly surface: PixelSurface<Img, Frame>;
  private readonly fontImg: Img;
  private chunkImages = new Map<number, [Img, Img]>();
  private chunkGen = -1;
  private chunkW = -1;

  W: number;
  H: number;
  protected SX = 0;
  protected SY = 0;

  constructor(backend: PixelBackend<Img, Frame>, width: number, height: number) {
    this.backend = backend;
    this.W = width;
    this.H = height;
    this.surface = backend.createSurface(width, height);
    const f = fontAtlasPixels();
    this.fontImg = backend.makeImage(f.w, f.h, f.pixels);
  }

  resize(width: number, height: number): void {
    if (this.W === width && this.H === height) return;
    this.W = width;
    this.H = height;
    this.surface.resize(width, height);
  }

  protected makeImage(w: number, h: number, rgba: Uint8Array): Img {
    return this.backend.makeImage(w, h, rgba);
  }
  protected makeAtlas(m: Model): AtlasHandle<Img> {
    return this.backend.makeAtlas(m);
  }
  protected clear(color: string): void {
    this.surface.clear(color);
  }
  protected snapshot(): Frame {
    return this.surface.snapshot();
  }

  protected px(x: number, y: number, color: string, s = 1, alpha = 1): void {
    this.surface.drawRect(Math.round(x) + this.SX, Math.round(y) + this.SY, s, s, color, alpha);
  }
  protected rect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    this.surface.drawRect(x, y, w, h, color, alpha);
  }
  protected strokeRect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    this.surface.drawStrokeRect(x, y, w, h, color, alpha);
  }
  protected circle(cx: number, cy: number, r: number, color: string, alpha = 1, stroke = false): void {
    this.surface.drawCircle(cx, cy, r, color, alpha, stroke);
  }
  protected line(x1: number, y1: number, x2: number, y2: number, color: string, alpha = 1): void {
    this.surface.drawLine(x1, y1, x2, y2, color, alpha);
  }
  protected band(y: number, h: number, alpha = 0.5): void {
    this.rect(0, y, this.W, h, INK, alpha);
  }
  protected image(img: Img, x: number, y: number, alpha = 1): void {
    this.surface.drawImage(img, x, y, alpha);
  }
  protected imageRect(img: Img, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, alpha = 1): void {
    this.surface.drawImageRect(img, sx, sy, sw, sh, dx, dy, dw, dh, alpha);
  }
  protected tintedImage(img: Img, x: number, y: number, color: string, alpha = 1): void {
    this.surface.drawTintedImage(img, x, y, color, alpha);
  }
  protected clip(x: number, y: number, w: number, h: number, fn: () => void): void {
    this.surface.clipRect(x, y, w, h, fn);
  }
  protected stack(atlas: AtlasHandle<Img>, x: number, y: number, ang: number, opts: StackOptions = {}): void {
    this.surface.drawStack(atlas, Math.round(x) + this.SX, Math.round(y) + this.SY, ang, opts);
  }
  protected shadow(atlas: AtlasHandle<Img>, x: number, y: number, ang: number, dx: number, dy: number, alpha = 0.3, k = 1): void {
    this.surface.drawShadow(atlas, Math.round(x + dx) + this.SX, Math.round(y + dy) + this.SY, ang, alpha, k);
  }
  protected sprite(img: Img, sx: number, sy: number, w: number, h: number, cx: number, cy: number, ang = 0, alpha = 1): void {
    this.surface.drawSprite(img, sx, sy, w, h, Math.round(cx) + this.SX, Math.round(cy) + this.SY, ang, alpha);
  }

  protected text(s: string, x: number, y: number, color: string, k = 1, shadow: string | null = INK): void {
    const idx = glyphIndices(s);
    if (!idx.length) return;
    if (shadow) this.surface.drawGlyphs(this.fontImg, idx, Math.round(x + k), Math.round(y + k), k, shadow);
    this.surface.drawGlyphs(this.fontImg, idx, Math.round(x), Math.round(y), k, color);
  }
  protected textC(s: string, cx: number, y: number, color: string, k = 1, shadow: string | null = INK): void {
    this.text(s, cx - textWidth(s, k) / 2, y, color, k, shadow);
  }
  protected textIn(s: string, cx: number, y: number, color: string, k = 1, pad = 2): void {
    const w = textWidth(s, k);
    this.text(s, Math.max(pad, Math.min(this.W - w - pad, cx - w / 2)), y, color, k);
  }

  protected drawTerrain(terrain: Terrain, gen: number, camR: number, ox: number, phase: 0 | 1): number[] {
    if (this.chunkGen !== gen || this.chunkW !== terrain.width) {
      this.chunkImages.clear();
      this.chunkGen = gen;
      this.chunkW = terrain.width;
    }
    const vis = visibleChunks(camR, this.H);
    for (const c of vis) {
      let imgs = this.chunkImages.get(c);
      if (!imgs) {
        const ch = terrain.chunk(c);
        imgs = [this.backend.makeImage(terrain.width, CHUNK, ch.pixels[0]), this.backend.makeImage(terrain.width, CHUNK, ch.pixels[1])];
        this.chunkImages.set(c, imgs);
      }
      this.surface.drawImage(imgs[phase], -MARGIN - ox, chunkTop(c, camR, this.H) + this.SY);
    }
    const lo = vis[0] ?? 0, hi = vis[vis.length - 1] ?? 0;
    for (const c of this.chunkImages.keys()) if (c < lo || c > hi) this.chunkImages.delete(c);
    terrain.evict(lo - 1, hi + 1);
    return vis;
  }

  static advance(k = 1): number {
    return ADVANCE * k;
  }
  static clip = clip;
}
