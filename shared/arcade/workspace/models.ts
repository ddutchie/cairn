/**
 * Office voxel models, stacked like Task Force's and Wayfinder's: +x right,
 * +y toward the viewer, +z up. `makeModel` shades each layer (lit tops, darker
 * faces toward the viewer), and the renderer drops a shadow under each one.
 */

import { makeModel, type Model } from "../pixel/models";
import type { Look } from "./sim";

const WOOD = "#a87a4c";
const WOOD_D = "#7a5434";
const WOOD_L = "#c99a66";
const LEG = "#3a3f52";
const DARK = "#252a38";
const PAPER = "#f3eedf";
const PAPER_D = "#ddd5bf";
const BOOKS = ["#5b8dd6", "#d9483b", "#7cc46a", "#c45aa8", "#2ec4b6", "#e3a23b", "#8f6ad6"];

export interface DeskLook {
  paper: number;
  books: number;
  /** Someone works here: the monitor is on. */
  lit: boolean;
  /** An overdue card: a red tab on the pile. */
  overdue: boolean;
  accent: string;
}

export const deskKey = (d: DeskLook) => `${d.paper}|${d.books}|${d.lit ? 1 : 0}|${d.overdue ? 1 : 0}|${d.accent}`;

/** A desk 20×9 voxels: legs, a top with an accent front edge, monitor, keyboard, a paper pile and a book pile. */
export function buildDesk(d: DeskLook): Model {
  const H = 5 + Math.max(6, d.paper, d.books) + 1;
  return makeModel(20, 9, H, (x, y, z) => {
    // Legs at the corners.
    if (z < 4) return (x === 0 || x === 19) && (y === 0 || y === 8) ? LEG : null;
    if (z === 4) {
      if (y === 8) return d.accent; // front edge in the project's colour
      return x === 0 || x === 19 || y === 0 ? WOOD_D : (x + y * 3) % 7 === 0 ? WOOD_L : WOOD;
    }
    const zz = z - 5;
    // Monitor: stand, then a screen facing the viewer.
    if (x >= 7 && x <= 12 && y === 1 && zz >= 1 && zz <= 5) return zz === 5 || x === 7 || x === 12 ? DARK : d.lit ? (zz % 2 ? "#8fe0ff" : "#6cc8f0") : "#3a4258";
    if (x >= 9 && x <= 10 && y === 2 && zz === 0) return DARK;
    // Keyboard and a mug.
    if (zz === 0 && x >= 8 && x <= 11 && y >= 5 && y <= 6) return "#9aa3b8";
    if (x === 13 && y === 6 && zz <= 1) return zz === 1 ? "#f2f2f2" : "#d9483b";
    // Paper pile (left), one layer per few cards.
    if (x >= 1 && x <= 5 && y >= 2 && y <= 6 && zz < d.paper) {
      if (d.overdue && zz === d.paper - 1 && x === 5 && y === 2) return "#ff3b30";
      return zz % 3 === 2 ? PAPER_D : PAPER;
    }
    // Book pile (right), alternating spines.
    if (x >= 14 && x <= 18 && y >= 3 && y <= 6 && zz < d.books) {
      const inset = zz % 2 ? x === 18 : x === 14;
      return inset ? null : BOOKS[zz % BOOKS.length];
    }
    return null;
  });
}

/** An office chair seen from behind (its back toward the viewer). */
export const CHAIR = makeModel(7, 6, 5, (x, y, z) => {
  if (z < 2) return x === 3 && y >= 2 && y <= 3 ? LEG : null;
  if (z === 2) return x >= 1 && x <= 5 && y >= 1 && y <= 4 ? "#4a5068" : null;
  if (z >= 3 && y === 5 && x >= 1 && x <= 5) return "#3a3f55";
  return null;
});

/**
 * A person, facing away from the viewer (toward their desk). Standing: legs,
 * body, arms, head; sitting: shorter, legs hidden under the desk. Rotate by π
 * to show the face.
 */
export function buildPerson(look: Look, sitting: boolean): Model {
  const legs = sitting ? 1 : 4;
  const body = legs + 4;
  const H = body + 4;
  return makeModel(9, 4, H, (x, y, z) => {
    if (z < legs) return !sitting && (x === 3 || x === 5) && y >= 1 && y <= 2 ? "#2e3346" : null;
    if (z < body) {
      // Torso, widening into shoulders at the top, with arms down the sides.
      const shoulders = z === body - 1;
      if (x >= 2 && x <= 6 && y >= 1 && y <= 2) return look.shirt;
      if ((x === 1 || x === 7) && y >= 1 && y <= 2 && (shoulders || z >= legs + 1)) return !shoulders && z === legs + 1 ? look.skin : look.shirt;
      return null;
    }
    const hz = z - body;
    // A neck, then a head wider than it with a rounded crown.
    if (hz === 0) return x === 4 && y >= 1 && y <= 2 ? look.skin : null;
    if (x < 2 || x > 6 || y > 2) return null;
    if (hz === 3) return x >= 3 && x <= 5 && y === 1 ? look.hair : null;
    // Back of the head (toward the viewer, +y) is hair with the ears showing; the face is at y=0.
    if ((x === 2 || x === 6) && y === 1 && hz === 1) return look.skin;
    if (y >= 1) return look.hair;
    if (hz === 3) return look.hair;
    if (hz === 2 && (x === 3 || x === 5)) return "#1a1a22";
    return look.skin;
  });
}

export const COFFEE = makeModel(8, 6, 12, (x, y, z) => {
  if (x < 1 || x > 6 || y < 1 || y > 4) return null;
  if (z < 7) return y === 4 && z >= 2 && z <= 4 && x >= 2 && x <= 5 ? (z === 2 && x === 3 ? "#f3eedf" : "#1d2030") : "#3a3e4c";
  if (z < 11) return y === 4 && z === 9 && x === 5 ? "#ff5a4a" : "#4a4f62";
  return x >= 2 && x <= 5 ? "#5a2e1a" : null;
});

export const COOLER = makeModel(6, 6, 14, (x, y, z) => {
  const dx = Math.abs(x - 2.5);
  const dy = Math.abs(y - 2.5);
  if (z < 7) return dx <= 2.5 && dy <= 2.5 ? (z === 4 && y === 5 && x === 2 ? "#5b8dd6" : "#e8ecf4") : null;
  return dx <= 2 && dy <= 2 ? (z === 13 ? "#9fd0ff" : "#7fb8ec") : null;
});

/** A paper bin: an open box, dark inside, with a rolled rim. */
export const BIN = makeModel(6, 6, 7, (x, y, z) => {
  if (x < 0 || x > 5 || y < 0 || y > 5) return null;
  if (z === 6) {
    if (x === 0 || x === 5 || y === 0 || y === 5) return "#8a93a8";
    return null;
  }
  if (z === 0) return "#3a3f55";
  if (x === 0 || x === 5 || y === 0 || y === 5) return z % 2 ? "#565d75" : "#6b7488";
  return z === 1 ? "#10131c" : null;
});

/** The agent's robot: a wide screen head on a small body on wheels, facing away from the viewer (+y is its back). */
export const ROBOT = makeModel(9, 5, 13, (x, y, z) => {
  // Wheels.
  if (z < 2) return (x === 2 || x === 6) && y >= 1 && y <= 3 ? "#252a38" : null;
  // Body with a glowing chest light on the face (-y), and an arm either side.
  if (z < 6) {
    if ((x === 0 || x === 8) && y === 2) return z === 2 ? "#39c6ff" : z < 5 ? "#9fb2cc" : null;
    if ((x === 1 || x === 7) && y === 2 && z === 4) return "#7d8496";
    if (x < 2 || x > 6 || y < 1 || y > 3) return null;
    if (y === 1 && x === 4 && z >= 3 && z <= 4) return "#8fe0ff";
    return "#dfe6f2";
  }
  // Neck.
  if (z === 6) return x === 4 && y === 2 ? "#565d75" : null;
  // Head: wider than the body, a dark visor with two bright eyes on the face.
  if (z < 11) {
    if (x < 1 || x > 7) return null;
    if (y === 0 && x >= 2 && x <= 6 && z >= 8 && z <= 9) return "#10131c";
    if (y === 4 && x >= 3 && x <= 5 && z === 8) return "#9fb2cc";
    return x === 1 || x === 7 ? "#9fb2cc" : "#e8eef7";
  }
  // A little antenna, red-tipped.
  if (x === 4 && y === 2) return z === 11 ? "#8a93a8" : "#ff5a4a";
  return null;
});

/** An office printer: a grey box with a dark slot on top and a paper tray at the front. */
export const PRINTER = makeModel(9, 7, 7, (x, y, z) => {
  if (x < 1 || x > 7 || y < 1 || y > 5) return null;
  if (z < 5) {
    if (y === 5 && z === 2 && x >= 2 && x <= 6) return PAPER;
    if (y === 5 && z === 4 && x === 6) return "#7cc46a";
    return z === 0 ? "#565d75" : (x + z) % 4 === 0 ? "#b8bfcc" : "#cfd4dc";
  }
  if (z === 5) return y === 3 && x >= 2 && x <= 6 ? DARK : "#9aa3b8";
  return y <= 2 && x >= 2 && x <= 6 ? PAPER_D : null;
});

/** The office cat, a ginger tabby facing away from the viewer (+y is its tail). */
export const CAT = makeModel(5, 5, 4, (x, y, z) => {
  const fur = "#e08a3c", stripe = "#b0612a";
  // Kept shallow: a stack turns depth into screen height, and a deep cat reads as a post.
  if (z === 0) return (x === 1 || x === 3) && (y === 2 || y === 4) ? stripe : null;
  if (y === 4 && x === 2 && z >= 1) return z === 3 ? stripe : fur;
  if (y >= 2 && y <= 3 && x >= 1 && x <= 3 && z <= 1) return (x + z) % 2 ? fur : stripe;
  if (y <= 1 && x >= 1 && x <= 3 && z >= 1 && z <= 2) {
    if (y === 0 && z === 2 && (x === 1 || x === 3)) return "#2b2118";
    return fur;
  }
  if (z === 3 && y === 1 && (x === 1 || x === 3)) return fur;
  return null;
});

/** The cat asleep: a small curled ginger loaf. */
export const CAT_ASLEEP = makeModel(5, 4, 2, (x, y, z) => {
  const r = Math.hypot((x - 2) / 2.4, (y - 1.5) / 1.9);
  if (r > 1) return null;
  if (z === 1) return r < 0.75 ? ((x + y) % 2 ? "#e08a3c" : "#b0612a") : null;
  return (x + y) % 3 === 0 ? "#b0612a" : "#e08a3c";
});

/** A ceramic planter trough with soil and tall snake-plant blades. */
export const PLANTER_TALL = makeModel(9, 9, 15, (x, y, z) => {
  // Trough: light ceramic walls with a pale rim.
  if (z < 4) {
    if (x === 0 || x === 8 || y === 0 || y === 8) return z === 3 ? "#eef1f6" : (x + y) % 2 ? "#cfd4dc" : "#c2c8d2";
    return null;
  }
  // Soil just under the rim.
  if (z === 4) return x >= 1 && x <= 7 && y >= 1 && y <= 7 ? "#4a3524" : null;
  // Snake-plant blades: columns of banded green at scattered spots, uneven heights.
  const blade = (bx: number, by: number, h: number) => (x === bx && y === by && z >= 5 && z < 5 + h);
  const blades: [number, number, number][] = [[2, 3, 7], [3, 5, 9], [4, 2, 6], [5, 5, 8], [6, 3, 9], [3, 6, 5], [6, 6, 6]];
  for (const [bx, by, h] of blades) {
    if (blade(bx, by, h)) {
      if (z === 5 + h - 1) return "#8fd694"; // pale new tip
      return (z + bx) % 3 === 0 ? "#5fb86a" : "#2f7a3e"; // banded leaf
    }
  }
  // A low bushy filler around the blades' feet.
  if (z === 5 && ((x === 2 && y === 5) || (x === 5 && y === 3))) return "#3f8a4a";
  return null;
});

/** A low planter with a bushy pothos mound spilling over the rim. */
export const PLANTER_BUSH = makeModel(9, 9, 10, (x, y, z) => {
  if (z < 4) {
    if (x === 0 || x === 8 || y === 0 || y === 8) return z === 3 ? "#eef1f6" : (x + y) % 2 ? "#cfd4dc" : "#c2c8d2";
    return null;
  }
  if (z === 4) return x >= 1 && x <= 7 && y >= 1 && y <= 7 ? "#4a3524" : null;
  // Mound shrinking with height, heart-leaf greens with pale new growth on top.
  const dx = x - 4, dy = y - 4.5;
  const r = Math.hypot(dx, dy);
  if (z >= 5 && r <= 4.2 - (z - 5) * 0.9) {
    if (z >= 7 && (x * 3 + y * 5) % 3 === 0) return "#a8e05f";
    return (x * 5 + y * 3 + z * 7) % 4 === 0 ? "#2f7a3e" : "#48a957";
  }
  // A vine spilling over the front rim.
  if (x >= 3 && x <= 5 && y === 8 && (z === 4 || z === 5)) return z === 5 ? "#48a957" : "#2f7a3e";
  return null;
});
