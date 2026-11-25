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
export const CHAIR = makeModel(7, 6, 7, (x, y, z) => {
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
  return makeModel(7, 4, H, (x, y, z) => {
    if (z < legs) return !sitting && (x === 2 || x === 4) && y >= 1 && y <= 2 ? "#2e3346" : null;
    if (z < body) {
      if (x >= 1 && x <= 5 && y >= 1 && y <= 2) return look.shirt;
      if ((x === 0 || x === 6) && y === 1 && z >= legs + 1) return z === legs + 1 ? look.skin : look.shirt;
      return null;
    }
    const hz = z - body;
    if (x >= 2 && x <= 4 && y >= 0 && y <= 3) {
      if (hz === 3) return look.hair;
      // Back of the head (toward the viewer, +y) is hair; the face is at y=0.
      if (y >= 2) return look.hair;
      if (y === 0 && hz === 1 && (x === 2 || x === 4)) return "#1a1a22";
      return look.skin;
    }
    return null;
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

export const PLANT = makeModel(9, 9, 13, (x, y, z) => {
  const dx = x - 4;
  const dy = y - 4;
  const r = Math.hypot(dx, dy);
  if (z < 4) return r <= 2.5 ? (z === 3 ? "#5a3a22" : "#b8673e") : null;
  const leaf = 4 - Math.abs(z - 8) * 0.6;
  if (r <= leaf && (x * 5 + y * 3 + z * 7) % 4 !== 0) return z > 9 ? "#7cc46a" : (x + z) % 3 ? "#3f8a4a" : "#5fb86a";
  return null;
});
