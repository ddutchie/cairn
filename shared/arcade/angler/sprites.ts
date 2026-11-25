/**
 * Angler fish sprites: each fish is drawn once into RGBA pixels from its
 * species, size and project accent (fins and markings), facing right.
 */

import { hash2 } from "../pixel/terrain";
import { lerpHex } from "../pixel/kinds";
import { SPECIES, type FishSpec, type Species } from "./sim";

export interface Look {
  back: string;
  body: string;
  belly: string;
  /** Fin colour; null takes the project accent. */
  fin: string | null;
  pattern: "line" | "bars" | "spots" | "patch" | "none";
  /** Marking colour; null takes the project accent. */
  mark: string | null;
  /** Tall dorsal and belly fins (angelfish). */
  tall?: boolean;
}

export const LOOKS: Record<Species, Look> = {
  minnow: { back: "#5d7f93", body: "#a9bec9", belly: "#e6eef2", fin: null, pattern: "line", mark: "#2f4a5a" },
  perch: { back: "#6f7a2a", body: "#c8b84a", belly: "#efe6a8", fin: "#e0703a", pattern: "bars", mark: "#3f4a1e" },
  bass: { back: "#3e6a2a", body: "#6f9a44", belly: "#dfe6b4", fin: null, pattern: "line", mark: "#2a4418" },
  pike: { back: "#4c5a26", body: "#7c8c3c", belly: "#e2e2b0", fin: null, pattern: "spots", mark: "#e2e6a0" },
  angel: { back: "#b8b8c8", body: "#eeeef6", belly: "#ffffff", fin: null, pattern: "bars", mark: null, tall: true },
  puffer: { back: "#b89a2a", body: "#e8c84a", belly: "#fff2c0", fin: "#d8a83a", pattern: "spots", mark: "#6a4a18" },
  koi: { back: "#ece6d8", body: "#f8f4ea", belly: "#ffffff", fin: "#f4ece0", pattern: "patch", mark: null },
};

export interface FishPixels {
  w: number;
  h: number;
  pixels: Uint8Array;
}

function bytes(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The fish facing right; `mirror` flips it to face left. */
export function fishPixels(f: FishSpec, mirror = false): FishPixels {
  const look = LOOKS[f.species];
  const def = SPECIES[f.species];
  const L = Math.max(6, f.size);
  const bodyH = Math.max(3, Math.round(L * def.ratio));
  const tailW = Math.max(3, Math.round(L * (f.species === "pike" ? 0.22 : 0.3)));
  const finH = look.tall ? Math.max(3, Math.round(bodyH * 0.55)) : Math.max(1, Math.round(bodyH * 0.3));
  const w = tailW + L + 2;
  const h = bodyH + finH * 2 + 2;
  const cy = (h - 1) / 2;
  const x0 = 1 + tailW;
  const cx = x0 + (L - 1) / 2;
  const fin = look.fin ?? f.accent;
  const mark = look.mark ?? lerpHex(f.accent, "#1a1a2a", 0.25);
  const dark = f.overdue ? 0.28 : 0;
  const shade = (c: string) => (dark ? lerpHex(c, "#4a2230", dark) : c);

  const col: (string | null)[] = new Array(w * h).fill(null);
  const set = (x: number, y: number, c: string) => {
    if (x >= 0 && y >= 0 && x < w && y < h) col[y * w + x] = c;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / (L / 2), dy = (y - cy) / (bodyH / 2);
      if (dx * dx + dy * dy <= 1) {
        const yr = (y - (cy - bodyH / 2)) / bodyH;
        let c = yr < 0.34 ? look.back : yr < 0.7 ? look.body : look.belly;
        const bx = x - x0;
        switch (look.pattern) {
          case "line":
            if (Math.round(cy) === y && bx > L * 0.12 && bx < L * 0.8) c = mark;
            break;
          case "bars":
            if (bx % 4 === 1 && bx > 1 && bx < L - 3 && yr < 0.8) c = mark;
            break;
          case "spots":
            if (hash2(x, y, f.seed % 9973) > 0.8 && yr < 0.72 && bx < L - 3) c = mark;
            break;
          case "patch":
            if (hash2(x >> 1, y >> 1, f.seed % 9973) > 0.55 && yr < 0.8) c = hash2(x >> 2, y >> 2, 7) > 0.5 ? "#ef6a2a" : f.accent;
            break;
        }
        set(x, y, shade(c));
        continue;
      }
      // Tail: fans out behind the body, forked at the end.
      if (x >= 1 && x <= x0) {
        const rel = (x0 - x) / tailW;
        const ay = Math.abs(y - cy);
        if (ay <= 0.8 + rel * bodyH * 0.6 && !(rel > 0.65 && ay < (rel - 0.65) * bodyH * 0.9)) set(x, y, fin);
      }
    }
  }
  // Rim light along the back: the top edge of the body catches the light from above.
  for (let x = 0; x < w; x++) {
    for (let y = 1; y < h; y++) {
      const c = col[y * w + x];
      if (c && !col[(y - 1) * w + x] && x > x0 - 1) {
        col[y * w + x] = lerpHex(c, "#ffffff", 0.35);
        break;
      }
    }
  }
  // Dorsal (and for tall fish, belly) fins.
  const fc = cx - L * 0.05, fw = L * (look.tall ? 0.22 : 0.24);
  for (let x = Math.floor(fc - fw); x <= Math.ceil(fc + fw); x++) {
    const hgt = Math.round(finH * (1 - Math.abs(x - fc) / fw)) + (look.tall ? 1 : 0);
    const top = Math.round(cy - bodyH / 2);
    for (let k = 1; k <= hgt; k++) if (!col[(top - k + 1) * w + x]) set(x, top - k + 1, fin);
    const bot = Math.round(cy + bodyH / 2);
    const bh = look.tall ? hgt : Math.round(hgt * 0.5);
    for (let k = 1; k <= bh; k++) if (!col[(bot + k - 1) * w + x]) set(x, bot + k - 1, fin);
  }
  // Eye near the nose, with a light ring on the bigger fish.
  const ex = Math.round(x0 + L * 0.78), ey = Math.round(cy - bodyH * 0.14);
  if (bodyH >= 6) set(ex - 1, ey, "#f4f4f4");
  set(ex, ey, f.overdue ? "#c02a2a" : "#10141e");

  const px = new Uint8Array(w * h * 4);
  const ink = bytes("#0a0f1e");
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = mirror ? w - 1 - x : x;
      const c = col[y * w + sx];
      const o = (y * w + x) * 4;
      if (c) {
        const [r, g, b] = bytes(c);
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 255;
      } else {
        const near = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < w && yy < h && col[yy * w + xx] !== null;
        if (near(sx - 1, y) || near(sx + 1, y) || near(sx, y - 1) || near(sx, y + 1)) {
          px[o] = ink[0];
          px[o + 1] = ink[1];
          px[o + 2] = ink[2];
          px[o + 3] = 190;
        }
      }
    }
  }
  return { w, h, pixels: px };
}
