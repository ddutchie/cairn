/**
 * Stacker's carved stones as RGBA buffers (pure; the renderer makes images).
 * A stone is `SH` tall: a lit 2px top face, a speckled front, a darker lip,
 * lit from the left, with the kind icon and label engraved (dark glyphs with a
 * light lip under them) when there's room.
 */

import { FONT } from "@/games/pixel/font";
import { ICONS, KINDS, type EntityKind } from "@/games/pixel/kinds";
import { hash2, rgb } from "@/games/pixel/terrain";
import { SH } from "./sim";

const INK = rgb("#0a0f1e");

export function stoneSprite(w: number, kind: EntityKind, label: string, seed: number): Uint8Array {
  const px = new Uint8Array(w * SH * 4), S = KINDS[kind].stone.map(rgb);
  const set = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= w || y >= SH) return;
    const i = (y * w + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = 255;
  };
  const fill = (x: number, y: number, ww: number, hh: number, c: [number, number, number]) => {
    for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + ww; xx++) set(xx, yy, c);
  };
  fill(0, 0, w, SH, INK);
  if (w <= 2) return px;
  fill(1, 1, w - 2, 1, S[4]);
  fill(1, 2, w - 2, 1, S[3]);
  fill(1, 3, w - 2, SH - 4, S[2]);
  fill(1, SH - 2, w - 2, 1, S[1]);
  fill(1, 3, 1, SH - 5, S[3]);
  fill(w - 2, 2, 1, SH - 3, S[1]);
  for (let y = 3; y < SH - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const h = hash2(x, y, seed);
      if (h < 0.07) set(x, y, S[1]);
      else if (h > 0.95) set(x, y, S[3]);
    }
  const room = Math.floor((w - 12) / 4);
  if (room < 2) return px;
  const icon = ICONS[kind];
  for (const [c, dy] of [[S[4], 1], [S[0], 0]] as const)
    for (let i = 0; i < 25; i++) if (icon.charCodeAt(i) === 49) set(3 + (i % 5), 3 + dy + ((i / 5) | 0), c);
  const s = (label.length <= room ? label : label.slice(0, Math.max(1, room - 1)) + ".").toUpperCase();
  for (const [c, dy] of [[S[4], 1], [S[0], 0]] as const)
    for (let i = 0; i < s.length; i++) {
      const g = FONT[s[i]] ?? FONT["?"];
      for (let p = 0; p < 15; p++) if (g.charCodeAt(p) === 49) set(10 + i * 4 + (p % 3), 3 + dy + ((p / 3) | 0), c);
    }
  return px;
}
