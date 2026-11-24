/**
 * HTML5 Canvas2D PixelBackend for desktop Cairn Arcade.
 * Adapts @cairn/shared/arcade PixelBackend<HTMLCanvasElement, void> to an
 * offscreen or live 2D canvas with nearest-neighbour rendering.
 */

import { ADVANCE, GLYPH_H, GLYPH_W } from "@cairn/shared/arcade/pixel/font";
import type { Model } from "@cairn/shared/arcade/pixel/models";
import type { AtlasHandle, PixelBackend, PixelSurface, StackOptions } from "@cairn/shared/arcade/pixel/painter";

function mkCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function rgbaToCanvas(w: number, h: number, rgba: Uint8Array): HTMLCanvasElement {
  const c = mkCanvas(w, h);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  const img = ctx.createImageData(w, h);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return c;
}

function makeStackAtlas(m: Model): AtlasHandle<HTMLCanvasElement> {
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
    image: rgbaToCanvas(m.w, totalH, packed),
    shadow: rgbaToCanvas(m.w, m.d, m.shadow),
  };
}

class CanvasPixelSurface implements PixelSurface<HTMLCanvasElement, void> {
  W: number;
  H: number;
  private readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readonly tintedFonts = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();
  private readonly tintScratch = mkCanvas(1, 1);

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.canvas = canvas;
    this.W = width;
    this.H = height;
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    ctx.imageSmoothingEnabled = false;
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    if (this.W === width && this.H === height && this.canvas.width === width && this.canvas.height === height) return;
    this.W = width;
    this.H = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.imageSmoothingEnabled = false;
  }

  clear(color: string): void {
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  snapshot(): void {
    // Draws straight into the bound target canvas.
  }

  toImage(): HTMLCanvasElement {
    return this.canvas;
  }

  drawRect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, w, h);
    this.ctx.globalAlpha = 1;
  }

  drawStrokeRect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.max(0, Math.round(w) - 1), Math.max(0, Math.round(h) - 1));
    this.ctx.globalAlpha = 1;
  }

  drawCircle(cx: number, cy: number, r: number, color: string, alpha = 1, stroke = false): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2);
    if (stroke) {
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 1;
      this.ctx.stroke();
    } else {
      this.ctx.fillStyle = color;
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  }

  drawLine(x1: number, y1: number, x2: number, y2: number, color: string, alpha = 1): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(x1 + 0.5, y1 + 0.5);
    this.ctx.lineTo(x2 + 0.5, y2 + 0.5);
    this.ctx.stroke();
    this.ctx.globalAlpha = 1;
  }

  drawImage(img: HTMLCanvasElement, x: number, y: number, alpha = 1): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(img, Math.round(x), Math.round(y));
    this.ctx.globalAlpha = 1;
  }

  drawImageRect(
    img: HTMLCanvasElement,
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
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    this.ctx.globalAlpha = 1;
  }

  drawTintedImage(img: HTMLCanvasElement, x: number, y: number, color: string, alpha = 1): void {
    const s = this.tintScratch;
    if (s.width !== img.width || s.height !== img.height) {
      s.width = img.width;
      s.height = img.height;
    }
    const g = s.getContext("2d")!;
    g.globalCompositeOperation = "copy";
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, s.width, s.height);
    g.globalCompositeOperation = "source-over";
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(s, Math.round(x), Math.round(y));
    this.ctx.globalAlpha = 1;
  }

  drawSprite(img: HTMLCanvasElement, sx: number, sy: number, w: number, h: number, tx: number, ty: number, ang: number, alpha = 1): void {
    if (w <= 0 || h <= 0) return;
    const c = Math.cos(ang), s = Math.sin(ang);
    this.ctx.globalAlpha = alpha;
    this.ctx.setTransform(c, s, -s, c, Math.round(tx), Math.round(ty));
    this.ctx.drawImage(img, sx, sy, w, h, -Math.round(w / 2), -Math.round(h / 2), w, h);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalAlpha = 1;
  }

  drawStack(atlas: AtlasHandle<HTMLCanvasElement>, tx: number, ty: number, ang: number, opts: StackOptions = {}): void {
    const m = atlas.model;
    const k = opts.k ?? 1;
    const lift = k * (opts.lift ?? 1);
    const steps = Math.max(1, Math.round(lift));
    const c = Math.cos(ang) * k;
    const s = Math.sin(ang) * k;
    const hw = -(m.w >> 1);
    const hd = -(m.d >> 1);

    for (let z = 0; z < m.h; z++) {
      const sy = z * m.d;
      for (let j = 0; j < steps; j++) {
        this.ctx.setTransform(c, s, -s, c, tx, ty - z * lift - j);
        this.ctx.drawImage(atlas.image, 0, sy, m.w, m.d, hw, hd, m.w, m.d);
      }
    }
    const baseRow = opts.flash ? 2 * m.h : m.h;
    for (let z = 0; z < m.h; z++) {
      const sy = (baseRow + z) * m.d;
      for (let j = 0; j < steps; j++) {
        this.ctx.setTransform(c, s, -s, c, tx, ty - z * lift - j);
        this.ctx.drawImage(atlas.image, 0, sy, m.w, m.d, hw, hd, m.w, m.d);
      }
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawShadow(atlas: AtlasHandle<HTMLCanvasElement>, tx: number, ty: number, ang: number, alpha: number, k: number): void {
    const m = atlas.model;
    const c = Math.cos(ang) * k;
    const s = Math.sin(ang) * k;
    this.ctx.globalAlpha = alpha;
    this.ctx.setTransform(c, s, -s, c, tx, ty);
    this.ctx.drawImage(atlas.shadow, -(m.w >> 1), -(m.d >> 1));
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalAlpha = 1;
  }

  private getTintedFont(font: HTMLCanvasElement, color: string): HTMLCanvasElement {
    let byColor = this.tintedFonts.get(font);
    if (!byColor) {
      byColor = new Map();
      this.tintedFonts.set(font, byColor);
    }
    let sheet = byColor.get(color);
    if (!sheet) {
      sheet = mkCanvas(font.width, font.height);
      const g = sheet.getContext("2d")!;
      g.drawImage(font, 0, 0);
      g.globalCompositeOperation = "source-in";
      g.fillStyle = color;
      g.fillRect(0, 0, sheet.width, sheet.height);
      byColor.set(color, sheet);
    }
    return sheet;
  }

  drawGlyphs(font: HTMLCanvasElement, indices: number[], x: number, y: number, k: number, color: string, alpha = 1): void {
    if (!indices.length) return;
    const sheet = this.getTintedFont(font, color);
    this.ctx.globalAlpha = alpha;
    for (let i = 0; i < indices.length; i++) {
      this.ctx.drawImage(sheet, indices[i] * ADVANCE, 0, GLYPH_W, GLYPH_H, x + i * ADVANCE * k, y, GLYPH_W * k, GLYPH_H * k);
    }
    this.ctx.globalAlpha = 1;
  }

  clipRect(x: number, y: number, w: number, h: number, fn: () => void): void {
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(x, y, w, h);
    this.ctx.clip();
    try {
      fn();
    } finally {
      this.ctx.restore();
    }
  }
}

/** Create a Canvas2D PixelBackend bound to an existing screen `<canvas>`. */
export function createCanvasBackend(canvas: HTMLCanvasElement): PixelBackend<HTMLCanvasElement, void> {
  return {
    createSurface: (w, h) => new CanvasPixelSurface(canvas, w, h),
    makeImage: rgbaToCanvas,
    makeAtlas: makeStackAtlas,
  };
}
