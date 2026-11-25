/**
 * Pure stone sprite pixel generator & Stacker constants. Produces packed RGBA
 * buffers + bitmap font glyphs onto stones, portable across Skia & Canvas2D.
 */

import { fontSafe, glyphIndices, textWidth, FONT, CHARSET } from "../pixel/font";
import { INK } from "../pixel/painter";
import { ICONS, KINDS, type EntityKind } from "../pixel/kinds";
import { hash2 } from "../pixel/terrain";

/** Stone height: 3px top face + 8px front. */
export const SH = 11;
/** Base stone width at level 0. */
export const BASE_W = 104;
/** Px of misalignment that still snaps to the stone below. */
export const PERFECT = 2;

export interface StoneSpritePixels {
  w: number;
  h: number;
  pixels: Uint8Array;
}

const CHAR_INDEX = new Map<string, number>();
for (let i = 0; i < CHARSET.length; i++) CHAR_INDEX.set(CHARSET[i], i);

function hexBytes(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fillRectRgba(buf: Uint8Array, bw: number, bh: number, x0: number, y0: number, rw: number, rh: number, color: string): void {
  const [r, g, b] = hexBytes(color);
  const xEnd = Math.min(bw, x0 + rw);
  const yEnd = Math.min(bh, y0 + rh);
  for (let y = Math.max(0, y0); y < yEnd; y++) {
    for (let x = Math.max(0, x0); x < xEnd; x++) {
      const i = (y * bw + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }
}

function drawIconRgba(buf: Uint8Array, bw: number, bh: number, kind: EntityKind, ox: number, oy: number, color: string): void {
  const [r, g, b] = hexBytes(color);
  const pat = ICONS[kind];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      if (pat.charCodeAt(row * 5 + col) !== 49) continue;
      const x = ox + col;
      const y = oy + row;
      if (x < 0 || x >= bw || y < 0 || y >= bh) continue;
      const i = (y * bw + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }
}

function drawTextRgba(buf: Uint8Array, bw: number, bh: number, text: string, ox: number, oy: number, color: string): void {
  const [r, g, b] = hexBytes(color);
  const idx = glyphIndices(text);
  for (let k = 0; k < idx.length; k++) {
    const ch = CHARSET[idx[k]];
    const pat = FONT[ch] ?? FONT["?"];
    for (let p = 0; p < 15; p++) {
      if (pat.charCodeAt(p) !== 49) continue;
      const x = ox + k * 4 + (p % 3);
      const y = oy + ((p / 3) | 0);
      if (x < 0 || x >= bw || y < 0 || y >= bh) continue;
      const i = (y * bw + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }
}

/** Bake an engraved cairn stone into a `w × SH` RGBA byte buffer. */
export function buildStonePixels(width: number, kind: EntityKind, label: string, seed: number): StoneSpritePixels {
  const w = Math.max(1, Math.round(width));
  const buf = new Uint8Array(w * SH * 4);
  const S = KINDS[kind].stone;

  fillRectRgba(buf, w, SH, 0, 0, w, SH, INK);
  if (w <= 2) return { w, h: SH, pixels: buf };

  // Top face (lit), front face (speckled), darker bottom lip.
  fillRectRgba(buf, w, SH, 1, 1, w - 2, 1, S[4]);
  fillRectRgba(buf, w, SH, 1, 2, w - 2, 1, S[3]);
  fillRectRgba(buf, w, SH, 1, 3, w - 2, SH - 4, S[2]);
  fillRectRgba(buf, w, SH, 1, SH - 2, w - 2, 1, S[1]);
  // Light from the left.
  fillRectRgba(buf, w, SH, 1, 3, 1, SH - 5, S[3]);
  fillRectRgba(buf, w, SH, w - 2, 2, 1, SH - 3, S[1]);

  for (let y = 3; y < SH - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const h = hash2(x, y, seed);
      if (h < 0.07) fillRectRgba(buf, w, SH, x, y, 1, 1, S[1]);
      else if (h > 0.95) fillRectRgba(buf, w, SH, x, y, 1, 1, S[3]);
    }
  }

  // Engraved label: light lip underneath dark glyphs.
  const room = Math.floor((w - 12) / 4);
  if (room >= 2) {
    drawIconRgba(buf, w, SH, kind, 3, 4, S[4]);
    drawIconRgba(buf, w, SH, kind, 3, 3, S[0]);
    const safe = fontSafe(label);
    const clipped = safe.length <= room ? safe : safe.slice(0, Math.max(1, room - 1)) + ".";
    if (textWidth(clipped) <= w - 12) {
      drawTextRgba(buf, w, SH, clipped, 10, 4, S[4]);
      drawTextRgba(buf, w, SH, clipped, 10, 3, S[0]);
    }
  }
  return { w, h: SH, pixels: buf };
}

/** Raw RGBA pixels for a carved cairn stone of width `w` (used by StackerRenderer and unit tests). */
export function stoneSprite(w: number, kind: EntityKind, label: string, seed: number): Uint8Array {
  return buildStonePixels(w, kind, label, seed).pixels;
}
