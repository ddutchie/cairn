/**
 * Skia PixelBackend for React Native / Expo mobile Arcade.
 * Adapts @cairn/shared/arcade PixelBackend<SkImage, SkImage> to Skia surfaces
 * with packed voxel-stack drawAtlas rendering and nearest-neighbour sampling.
 */

import {
  AlphaType,
  BlendMode,
  ClipOp,
  ColorType,
  FilterMode,
  MipmapMode,
  Skia,
  type SkImage,
  type SkPaint,
  type SkSurface,
} from "@shopify/react-native-skia";
import { ADVANCE, GLYPH_H, GLYPH_W } from "@cairn/shared/arcade/pixel/font";
import type { Model } from "@cairn/shared/arcade/pixel/models";
import type { AtlasHandle, PixelBackend, PixelSurface, StackOptions } from "@cairn/shared/arcade/pixel/painter";

export const SAMPLING = { filter: FilterMode.Nearest, mipmap: MipmapMode.None } as const;

function rgbaToImage(w: number, h: number, rgba: Uint8Array): SkImage {
  const data = Skia.Data.fromBytes(rgba);
  const img = Skia.Image.MakeImage(
    { width: w, height: h, alphaType: AlphaType.Unpremul, colorType: ColorType.RGBA_8888 },
    data,
    w * 4,
  );
  if (!img) throw new Error(`Skia.Image.MakeImage(${w}x${h}) failed`);
  return img;
}

function makeStackAtlas(m: Model): AtlasHandle<SkImage> {
  const rowH = m.d;
  const totalH = rowH * m.h * 3;
  const packed = new Uint8Array(m.w * totalH * 4);
  const sliceBytes = m.w * rowH * 4;
  for (let z = 0; z < m.h; z++) {
    packed.set(m.outline[z], z * sliceBytes);
    packed.set(m.layers[z], (m.h + z) * sliceBytes);
    packed.set(m.flash[z], (2 * m.h + z) * sliceBytes);
  }
  return {
    model: m,
    image: rgbaToImage(m.w, totalH, packed),
    shadow: rgbaToImage(m.w, m.d, m.shadow),
  };
}

class SkiaPixelSurface implements PixelSurface<SkImage, SkImage> {
  W: number;
  H: number;
  private surface: SkSurface;
  private readonly paint: SkPaint = Skia.Paint();
  private readonly imgPaint: SkPaint = Skia.Paint();
  private readonly tintCache = new Map<string, SkPaint>();

  constructor(width: number, height: number) {
    this.W = width;
    this.H = height;
    const s = Skia.Surface.Make(width, height);
    if (!s) throw new Error(`Skia.Surface.Make(${width}x${height}) failed`);
    this.surface = s;
  }

  private get canvas() {
    return this.surface.getCanvas();
  }

  private tintPaint(color: string, alpha = 1): SkPaint {
    let p = this.tintCache.get(color);
    if (!p) {
      p = Skia.Paint();
      p.setColorFilter(Skia.ColorFilter.MakeBlend(Skia.Color(color), BlendMode.SrcIn));
      this.tintCache.set(color, p);
    }
    p.setAlphaf(alpha);
    return p;
  }

  resize(width: number, height: number): void {
    if (this.W === width && this.H === height) return;
    this.W = width;
    this.H = height;
    const s = Skia.Surface.Make(width, height);
    if (!s) throw new Error(`Skia.Surface.Make(${width}x${height}) failed`);
    this.surface = s;
  }

  clear(color: string): void {
    this.canvas.clear(Skia.Color(color));
  }

  snapshot(): SkImage {
    this.surface.flush();
    return this.surface.makeImageSnapshot();
  }

  toImage(): SkImage {
    return this.snapshot();
  }

  drawRect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    this.paint.setColor(Skia.Color(color));
    this.paint.setAlphaf(alpha);
    this.paint.setStyle(0); // Fill
    this.canvas.drawRect(Skia.XYWHRect(x, y, w, h), this.paint);
  }

  drawStrokeRect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    this.paint.setColor(Skia.Color(color));
    this.paint.setAlphaf(alpha);
    this.paint.setStyle(1); // Stroke
    this.paint.setStrokeWidth(1);
    this.canvas.drawRect(Skia.XYWHRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1)), this.paint);
    this.paint.setStyle(0);
  }

  drawCircle(cx: number, cy: number, r: number, color: string, alpha = 1, stroke = false): void {
    this.paint.setColor(Skia.Color(color));
    this.paint.setAlphaf(alpha);
    this.paint.setStyle(stroke ? 1 : 0);
    if (stroke) this.paint.setStrokeWidth(1);
    this.canvas.drawCircle(cx, cy, r, this.paint);
    this.paint.setStyle(0);
  }

  drawLine(x1: number, y1: number, x2: number, y2: number, color: string, alpha = 1): void {
    this.paint.setColor(Skia.Color(color));
    this.paint.setAlphaf(alpha);
    this.paint.setStrokeWidth(1);
    this.canvas.drawLine(x1 + 0.5, y1 + 0.5, x2 + 0.5, y2 + 0.5, this.paint);
  }

  drawImage(img: SkImage, x: number, y: number, alpha = 1): void {
    this.imgPaint.setAlphaf(alpha);
    this.canvas.drawImage(img, x, y, this.imgPaint);
  }

  drawImageRect(
    img: SkImage,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    alpha = 1,
  ): void {
    this.imgPaint.setAlphaf(alpha);
    this.canvas.drawImageRectOptions(img, Skia.XYWHRect(sx, sy, sw, sh), Skia.XYWHRect(dx, dy, dw, dh), FilterMode.Nearest, MipmapMode.None, this.imgPaint);
  }

  drawTintedImage(img: SkImage, x: number, y: number, color: string, alpha = 1): void {
    this.canvas.drawImage(img, x, y, this.tintPaint(color, alpha));
  }

  drawSprite(img: SkImage, sx: number, sy: number, w: number, h: number, tx: number, ty: number, ang: number, alpha = 1): void {
    const c = Math.cos(ang), s = Math.sin(ang);
    const hw = w / 2, hh = h / 2;
    this.imgPaint.setAlphaf(alpha);
    this.canvas.drawAtlas(
      img,
      [Skia.XYWHRect(sx, sy, w, h)],
      [Skia.RSXform(c, s, tx - (c * hw - s * hh), ty - (s * hw + c * hh))],
      this.imgPaint,
      BlendMode.SrcOver,
      undefined,
      SAMPLING,
    );
  }

  drawStack(atlas: AtlasHandle<SkImage>, tx: number, ty: number, ang: number, opts: StackOptions = {}): void {
    const m = atlas.model;
    const k = opts.k ?? 1;
    const lift = k * (opts.lift ?? 1);
    const steps = Math.max(1, Math.round(lift));
    const c = Math.cos(ang) * k;
    const s = Math.sin(ang) * k;
    const hw = m.w >> 1;
    const hd = m.d >> 1;
    const ox = c * hw - s * hd;
    const oy = s * hw + c * hd;

    const srcs: ReturnType<typeof Skia.XYWHRect>[] = [];
    const xforms: ReturnType<typeof Skia.RSXform>[] = [];
    for (let z = 0; opts.outline !== false && z < m.h; z++) {
      const sy = z * m.d;
      for (let j = 0; j < steps; j++) {
        srcs.push(Skia.XYWHRect(0, sy, m.w, m.d));
        xforms.push(Skia.RSXform(c, s, tx - ox, ty - z * lift - j - oy));
      }
    }
    const baseRow = opts.flash ? 2 * m.h : m.h;
    for (let z = 0; z < m.h; z++) {
      const sy = (baseRow + z) * m.d;
      for (let j = 0; j < steps; j++) {
        srcs.push(Skia.XYWHRect(0, sy, m.w, m.d));
        xforms.push(Skia.RSXform(c, s, tx - ox, ty - z * lift - j - oy));
      }
    }
    this.imgPaint.setAlphaf(1);
    this.canvas.drawAtlas(atlas.image, srcs, xforms, this.imgPaint, BlendMode.SrcOver, undefined, SAMPLING);
  }

  drawShadow(atlas: AtlasHandle<SkImage>, tx: number, ty: number, ang: number, alpha: number, k: number): void {
    const m = atlas.model;
    const c = Math.cos(ang) * k;
    const s = Math.sin(ang) * k;
    const hw = m.w >> 1;
    const hd = m.d >> 1;
    this.imgPaint.setAlphaf(alpha);
    this.canvas.drawAtlas(
      atlas.shadow,
      [Skia.XYWHRect(0, 0, m.w, m.d)],
      [Skia.RSXform(c, s, tx - (c * hw - s * hd), ty - (s * hw + c * hd))],
      this.imgPaint,
      BlendMode.SrcOver,
      undefined,
      SAMPLING,
    );
  }

  drawGlyphs(font: SkImage, indices: number[], x: number, y: number, k: number, color: string, alpha = 1): void {
    if (!indices.length) return;
    const srcs: ReturnType<typeof Skia.XYWHRect>[] = [];
    const xforms: ReturnType<typeof Skia.RSXform>[] = [];
    for (let i = 0; i < indices.length; i++) {
      srcs.push(Skia.XYWHRect(indices[i] * ADVANCE, 0, GLYPH_W, GLYPH_H));
      xforms.push(Skia.RSXform(k, 0, x + i * ADVANCE * k, y));
    }
    this.canvas.drawAtlas(font, srcs, xforms, this.tintPaint(color, alpha), BlendMode.SrcOver, undefined, SAMPLING);
  }

  clipRect(x: number, y: number, w: number, h: number, fn: () => void): void {
    this.canvas.save();
    this.canvas.clipRect(Skia.XYWHRect(x, y, w, h), ClipOp.Intersect, false);
    try {
      fn();
    } finally {
      this.canvas.restore();
    }
  }
}

export const skiaBackend: PixelBackend<SkImage, SkImage> = {
  createSurface: (w, h) => new SkiaPixelSurface(w, h),
  makeImage: rgbaToImage,
  makeAtlas: makeStackAtlas,
};
