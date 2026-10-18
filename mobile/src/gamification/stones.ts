/**
 * Layout for the "your cairn grows" stack: the most recent notes drawn as a
 * balanced pile of stones, newest on top. Pure and deterministic (every stone's
 * wobble comes from a hash of its note id), so the pile looks the same every
 * time you open the app and only changes when a note is added. No framework
 * imports, so it is unit-testable in plain Node.
 */

export interface StoneInput {
  id: string;
  projectId: string;
  title: string;
  /** Content length in characters; bigger notes are wider stones. */
  size: number;
  createdAt: string;
}

export interface Stone {
  id: string;
  projectId: string;
  title: string;
  /** Left edge and top edge, in canvas px (origin top-left of the stack). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, small: a stone is tilted, not tumbling. */
  rotate: number;
  /** 0–1, per-stone shade variation. */
  tone: number;
  /** The newest stone, drawn in the accent colour. */
  top: boolean;
}

export const STACK_WIDTH = 220;
export const MAX_STONES = 9;
export const MIN_STONE_W = 56;
const MAX_STONE_W = 180;
const MIN_BASE_W = 70;
/** A stone may overhang the one below by at most this much, or it would fall. */
const MAX_OVERHANG = 18;
const OVERLAP = 2;
const FULL_SIZE_CHARS = 1500;

/** FNV-1a, 32-bit. Stable across runs and platforms. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function layoutStones(
  inputs: readonly StoneInput[],
  opts: { width?: number; max?: number } = {},
): { stones: Stone[]; height: number } {
  const width = opts.width ?? STACK_WIDTH;
  const max = opts.max ?? MAX_STONES;
  // Oldest at the bottom, newest on top.
  const ordered = [...inputs]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1))
    .slice(0, max)
    .reverse();
  if (ordered.length === 0) return { stones: [], height: 0 };

  const maxW = Math.min(MAX_STONE_W, width * 0.84);
  const built = ordered.map((n, i) => {
    const hsh = hash32(n.id);
    const fill = Math.min(1, Math.max(0, n.size) / FULL_SIZE_CHARS);
    return {
      n,
      hsh,
      baseW: MIN_BASE_W + (maxW - MIN_BASE_W) * fill,
      h: 20 + (hsh % 9),
      // Higher stones taper a little so the pile reads as a cairn, not a wall.
      taper: 1 - 0.04 * i,
    };
  });

  let prevW = Infinity;
  const sized = built.map((b) => {
    const w = clamp(Math.min(b.baseW * b.taper, prevW + MAX_OVERHANG), MIN_STONE_W, maxW);
    prevW = w;
    return { ...b, w };
  });

  const height = sized.reduce((sum, s) => sum + s.h, 0) - OVERLAP * (sized.length - 1);
  let bottom = height;
  const stones: Stone[] = sized.map((s, i) => {
    const y = bottom - s.h;
    bottom = y + OVERLAP;
    const jitter = (((s.hsh >>> 8) % 2001) / 1000 - 1) * s.w * 0.07;
    const x = clamp(width / 2 - s.w / 2 + jitter, 0, width - s.w);
    return {
      id: s.n.id,
      projectId: s.n.projectId,
      title: s.n.title,
      x,
      y,
      w: s.w,
      h: s.h,
      rotate: (((s.hsh >>> 16) % 61) - 30) / 10,
      tone: ((s.hsh >>> 4) % 100) / 100,
      top: i === sized.length - 1,
    };
  });
  return { stones, height };
}
