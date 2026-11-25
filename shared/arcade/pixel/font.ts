/**
 * 3×5 bitmap font for the Cairn Arcade. Glyphs are 15-character bit strings,
 * rows top to bottom; text advances 4px per character.
 */

export const GLYPH_W = 3;
export const GLYPH_H = 5;
export const ADVANCE = 4;

export const FONT: Record<string, string> = {
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110", E: "111100110100111",
  F: "111100110100100", G: "011100101101011", H: "101101111101101", I: "111010010010111", J: "001001001101010",
  K: "101101110101101", L: "100100100100111", M: "101111111101101", N: "110101101101101", O: "010101101101010",
  P: "110101110100100", Q: "010101101110011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
  U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101", Y: "101101010010010",
  Z: "111001010100111", "0": "111101101101111", "1": "010110010010111", "2": "110001010100111", "3": "110001010001110",
  "4": "101101111001001", "5": "111100110001110", "6": "011100111101111", "7": "111001010010010", "8": "111101111101111",
  "9": "111101111001110", ":": "000010000010000", ".": "000000000000010", "-": "000000111000000", "!": "010010010000010",
  "/": "001001010100100", "'": "010010000000000", "?": "110001010000010", "+": "000010111010000", " ": "000000000000000",
  ",": "000000000010100", "&": "010101010101011", "=": "000111000111000", "#": "101111101111101", "(": "010100100100010",
  ")": "010001001001010", "<": "001010100010001", ">": "100010001010100", x: "000101010101000",
  // Typographic marks used in game copy: a middle dot, dashes, a curly apostrophe, percent.
  "·": "000000010000000", "—": "000000111000000", "–": "000000111000000", "’": "010010000000000", "%": "101001010100101",
};

/** Characters in atlas order; index → glyph cell. */
export const CHARSET = Object.keys(FONT);
const INDEX = new Map(CHARSET.map((c, i) => [c, i]));

/** Atlas cell index for each character of `s` (upper-casing unless lone `x` / `xN`). */
export function glyphIndices(s: string): number[] {
  const unknown = INDEX.get("?") ?? 0;
  const normalized = s === "x" || /^x\d/.test(s) ? s : s.toUpperCase();
  return [...normalized].map((ch) => INDEX.get(ch) ?? unknown);
}

export const textWidth = (s: string, k = 1) => Math.max(0, (s.length * ADVANCE - 1) * k);

/** Clip to `max` characters with a trailing "." when cut. */
export const clip = (s: string, max: number) =>
  s.length <= max ? s : max <= 0 ? "" : max === 1 ? "." : s.slice(0, max - 1) + ".";

/** Strip characters the font lacks while preserving word boundaries across whitespace. */
export function fontSafe(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^A-Z0-9:.\-!/'?+ ,&=#<>()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A white RGBA atlas: one 3×5 cell per glyph, laid out left to right at ADVANCE spacing. */
export function fontAtlasPixels(): { w: number; h: number; pixels: Uint8Array } {
  const w = CHARSET.length * ADVANCE, h = GLYPH_H, pixels = new Uint8Array(w * h * 4);
  CHARSET.forEach((ch, gi) => {
    const g = FONT[ch];
    for (let p = 0; p < 15; p++) {
      if (g.charCodeAt(p) !== 49) continue;
      const i = (((p / 3) | 0) * w + gi * ADVANCE + (p % 3)) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 255;
    }
  });
  return { w, h, pixels };
}
