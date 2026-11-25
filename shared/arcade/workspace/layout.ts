/**
 * Where everything in the office goes. Pure and deterministic, so the sim can
 * hit-test exactly what the renderer draws.
 *
 * The office is one room for the whole workspace, seen from above at a slant
 * (voxel models stack upward on screen). The back wall carries the windows,
 * the clock and the "done this week" board; each project gets a desk on the
 * floor, its paper pile as tall as its open tasks and its book pile as tall as
 * its notes. Clicking a desk opens that project: its board, or its notes.
 */

import type { OfficeCard, OfficeProject } from "./data";
import { CONTRACTOR } from "./data";

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a click opens. */
export interface Ref {
  type: "task" | "note";
  id: string;
}

export const inRect = (r: Rect, x: number, y: number, pad = 0) => x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad;

// ── The floor ──────────────────────────────────────────────────────────

/** Back wall height (windows, clock, done board). */
export const WALL_H = 34;
export const CELL_W = 68;
export const CELL_H = 54;
/** Desk footprint on screen (voxel model at k=2). */
export const DESK_PX_W = 40;
export const DESK_PX_D = 18;

export interface Desk {
  project: OfficeProject;
  /** Index into the office's projects. */
  index: number;
  /** Ground centre of the desk. */
  cx: number;
  cy: number;
  /** Click area: the desk, its piles and the name tag under it. */
  hit: Rect;
  /** Where its main worker sits (in front of the desk, facing it). */
  seat: Pt;
  /** Where a second worker stands, beside the desk. */
  side: Pt;
  /** Walkway row below this desk row. */
  aisleY: number;
  /** Walkway column left of this desk. */
  laneX: number;
  /** Who sits here (null: nobody in progress), and who stands beside. */
  holder: string | null;
  visitor: string | null;
  /** Pile heights in voxels, from the counts. */
  paper: number;
  books: number;
}

export interface FloorLayout {
  w: number;
  h: number;
  /** Model scale: 2 normally, 3 when few desks leave room to show them larger. */
  zoom: number;
  desks: Desk[];
  page: number;
  pageCount: number;
  wall: Rect;
  doneBoard: Rect;
  windows: Rect[];
  coffee: Pt;
  cooler: Pt;
  plants: Pt[];
  /** Errand spots, each with the walkway that reaches it. */
  spots: { at: Pt; aisleY: number; laneX: number }[];
}

/** Voxel layers for `n` items: one per item up to 4, then one per two, capped. */
export const pileHeight = (n: number, cap = 10): number => (n <= 0 ? 0 : Math.min(cap, n <= 4 ? n : 4 + Math.ceil((n - 4) / 2)));

/**
 * Who works where. Each person sits at the project where they hold the most
 * cards in progress (ties: the earlier desk); a second person on the same
 * project stands beside it. Unassigned work in progress brings the contractor.
 */
export function staff(projects: readonly OfficeProject[]): { holder: string | null; visitor: string | null }[] {
  const count = new Map<string, number[]>();
  projects.forEach((p, i) => {
    for (const c of p.cards) {
      if (c.zone !== "doing" || !c.assignee) continue;
      const row = count.get(c.assignee) ?? projects.map(() => 0);
      row[i]++;
      count.set(c.assignee, row);
    }
  });
  const out = projects.map(() => ({ holder: null as string | null, visitor: null as string | null }));
  // Busiest people pick first so a desk goes to whoever is most on it.
  const people = [...count.entries()].sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]) || a[0].localeCompare(b[0]));
  for (const [who, row] of people) {
    const order = row
      .map((n, i) => [n, i] as const)
      .filter(([n]) => n > 0)
      .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (const [, i] of order) {
      if (!out[i].holder) {
        out[i].holder = who;
        break;
      }
      if (!out[i].visitor) {
        out[i].visitor = who;
        break;
      }
    }
  }
  projects.forEach((p, i) => {
    if (!out[i].holder && p.cards.some((c) => c.zone === "doing" && !c.assignee)) out[i].holder = CONTRACTOR;
  });
  return out;
}

export function layoutFloor(projects: readonly OfficeProject[], w: number, h: number, page: number, extraPlants = 0): FloorLayout {
  w = Math.max(160, Math.floor(w));
  h = Math.max(150, Math.floor(h));
  const floorTop = WALL_H + 10;
  const left = 16;
  const right = w - 16;
  // Bigger desks when the workspace is small enough to fit them.
  const fit = (z: number) => {
    const k = z / 2;
    const maxCols = Math.max(1, Math.floor((right - left) / (CELL_W * k)));
    const maxRows = Math.max(1, Math.floor((h - floorTop) / (CELL_H * k)));
    return { z, k, maxCols, maxRows, per: maxCols * maxRows };
  };
  const big = fit(3);
  const g = projects.length <= big.per ? big : fit(2);
  const { k, maxCols, maxRows } = g;
  const perPage = g.per;
  const pageCount = Math.max(1, Math.ceil(projects.length / perPage));
  const pg = Math.min(Math.max(0, page), pageCount - 1);
  const list = projects.slice(pg * perPage, (pg + 1) * perPage);
  // As few rows as fit, spread over the floor and centred in it.
  const n = Math.max(1, list.length);
  const rows = Math.min(maxRows, Math.max(1, Math.ceil(n / maxCols)));
  const cols = Math.min(maxCols, Math.ceil(n / rows));
  const stepX = Math.floor((right - left) / cols);
  const stepY = Math.min(Math.round((CELL_H + 20) * k), Math.floor((h - floorTop) / rows));
  const y0 = floorTop + Math.floor((h - floorTop - rows * stepY) / 2);
  const crew = staff(projects);
  const desks: Desk[] = list.map((p, j) => {
    const i = pg * perPage + j;
    const cx = left + (j % cols) * stepX + Math.floor(stepX / 2);
    const cy = y0 + Math.floor(j / cols) * stepY + Math.round(24 * k);
    const dw = DESK_PX_W * k;
    return {
      project: p,
      index: i,
      cx,
      cy,
      hit: { x: cx - dw / 2 - 3, y: cy - 30 * k, w: dw + 6, h: 50 * k },
      seat: { x: cx, y: cy + Math.round(14 * k) },
      side: { x: cx + Math.round(dw / 2 + 7 * k), y: cy + Math.round(6 * k) },
      aisleY: cy + Math.round(26 * k),
      laneX: cx - Math.floor(stepX / 2) + 3,
      holder: crew[i].holder,
      visitor: crew[i].visitor,
      paper: pileHeight(p.cards.length),
      books: pileHeight(p.notes.length, 8),
    };
  });
  const coffee = { x: right - 8, y: floorTop - 2 };
  const cooler = { x: left + 6, y: floorTop - 2 };
  const plants = [
    { x: left - 6, y: h - 6 },
    { x: right + 6, y: h - 6 },
  ];
  // Milestone plants line the bottom edge, alternating inward from the corners.
  for (let i = 0; i < Math.max(0, Math.min(6, Math.floor(extraPlants))); i++) {
    plants.push(i % 2 ? { x: right - 18 - Math.floor(i / 2) * 24, y: h - 6 } : { x: left + 18 + Math.floor(i / 2) * 24, y: h - 6 });
  }
  const firstAisle = desks.length ? desks[0].aisleY - stepY : floorTop + 6;
  const top = { aisleY: Math.max(floorTop + 6, firstAisle), laneX: left };
  const spots = [
    { at: { x: coffee.x - 10, y: coffee.y + 10 }, ...top },
    { at: { x: cooler.x + 10, y: cooler.y + 10 }, ...top },
  ];
  // Windows along the back wall, either side of the done board.
  const doneBoard = { x: Math.floor(w / 2) - 24, y: 7, w: 48, h: 20 };
  const windows: Rect[] = [];
  for (let x = 12; x + 30 < w - 12; x += 46) {
    const r = { x, y: 6, w: 30, h: 20 };
    if (r.x + r.w < doneBoard.x - 6 || r.x > doneBoard.x + doneBoard.w + 6) windows.push(r);
  }
  return { w, h, zoom: g.z, desks, page: pg, pageCount, wall: { x: 0, y: 0, w, h: WALL_H }, doneBoard, windows, coffee, cooler, plants, spots };
}

/**
 * A walk from `a` to `b` along the walkways: down to the aisle below `a`'s
 * row, over to a lane, along the lane to `b`'s aisle, across, and up.
 */
export function route(a: Pt, b: Pt, from: { aisleY: number; laneX: number }, to: { aisleY: number; laneX: number }): Pt[] {
  const out: Pt[] = [];
  const push = (x: number, y: number) => {
    const last = out[out.length - 1] ?? a;
    if (last.x !== x || last.y !== y) out.push({ x, y });
  };
  push(a.x, from.aisleY);
  if (from.aisleY !== to.aisleY) {
    push(from.laneX, from.aisleY);
    push(from.laneX, to.aisleY);
  }
  push(b.x, to.aisleY);
  push(b.x, b.y);
  return out;
}

// ── A desk, opened: the project's board or its notes ──────────────────

export type DeskTab = "board" | "notes";

export interface Sticky extends Rect {
  card: OfficeCard;
}

export interface BoardColumnBox extends Rect {
  name: string;
  count: number;
  done: boolean;
  stickies: Sticky[];
  /** Cards that didn't fit, shown as "+N". */
  more: number;
}

export interface NoteRow extends Rect {
  ref: Ref;
  title: string;
  pinned: boolean;
}

export interface DeskView {
  area: Rect;
  columns: BoardColumnBox[];
  /** Columns past the right edge (narrow screens). */
  hiddenColumns: number;
  notes: NoteRow[];
  notesPage: number;
  notesPages: number;
}

export const STICKY_H = 12;
export const COL_HEAD = 13;
const COL_GAP = 5;
export const NOTE_ROW_H = 11;
const NOTE_COL_W = 128;

export function layoutDesk(p: OfficeProject, area: Rect, notesPage: number): DeskView {
  // Board: one column per board column (done columns show the week's count, not cards).
  const cols = p.columns.length ? p.columns : [{ id: "", name: "OPEN", zone: "backlog" as const }];
  const minW = 44;
  const fits = Math.max(1, Math.min(cols.length, Math.floor((area.w + COL_GAP) / (minW + COL_GAP))));
  const cw = Math.floor((area.w - COL_GAP * (fits - 1)) / fits);
  const columns: BoardColumnBox[] = cols.slice(0, fits).map((c, i) => {
    const x = area.x + i * (cw + COL_GAP);
    const done = c.zone === "done";
    const cards = done ? [] : p.cards.filter((k) => !c.id || k.columnId === c.id);
    const room = Math.max(0, Math.floor((area.h - COL_HEAD - 6) / (STICKY_H + 2)));
    const shown = cards.length > room ? Math.max(0, room - 1) : cards.length;
    return {
      x,
      y: area.y,
      w: cw,
      h: area.h,
      name: c.name,
      count: done ? p.doneThisWeek : cards.length,
      done,
      stickies: cards.slice(0, shown).map((card, k) => ({ card, x: x + 3, y: area.y + COL_HEAD + 3 + k * (STICKY_H + 2), w: cw - 6, h: STICKY_H })),
      more: cards.length - shown,
    };
  });
  // Notes: rows in as many columns as fit, paged.
  const ncols = Math.max(1, Math.floor((area.w + 8) / (NOTE_COL_W + 8)));
  const nrows = Math.max(1, Math.floor((area.h - 16) / NOTE_ROW_H));
  const per = ncols * nrows;
  const notesPages = Math.max(1, Math.ceil(p.notes.length / per));
  const np = Math.min(Math.max(0, notesPage), notesPages - 1);
  const colW = Math.floor((area.w - 8 * (ncols - 1)) / ncols);
  const notes: NoteRow[] = p.notes.slice(np * per, (np + 1) * per).map((n, i) => ({
    x: area.x + Math.floor(i / nrows) * (colW + 8),
    y: area.y + 4 + (i % nrows) * NOTE_ROW_H,
    w: colW,
    h: NOTE_ROW_H - 1,
    ref: { type: "note", id: n.id },
    title: n.title,
    pinned: n.pinned,
  }));
  return { area, columns, hiddenColumns: cols.length - fits, notes, notesPage: np, notesPages };
}

// ── The week wall (calendar mode) ────────────────────────────────────

export interface WeekPin extends Rect {
  ref: Ref;
  title: string;
  accent: string;
  priority: "low" | "medium" | "high" | "urgent";
}

export interface WeekCol {
  key: string;
  label: string;
  isToday: boolean;
  isWeekend: boolean;
  rect: Rect;
  head: Rect;
  pins: WeekPin[];
  more: number;
}

export interface WeekTray {
  rect: Rect;
  pins: WeekPin[];
  more: number;
}

export interface WeekView {
  area: Rect;
  cols: WeekCol[];
  tray: WeekTray;
}

export const WEEK_PIN_H = 10;

/** Seven day cork boards across the top two thirds, the red overdue tray along the bottom. */
export function layoutWeek(
  days: { key: string; label: string; isToday: boolean; isWeekend: boolean; cards: { ref: Ref; title: string; accent: string; priority: WeekPin["priority"] }[] }[],
  overdue: { ref: Ref; title: string; accent: string; priority: WeekPin["priority"] }[],
  area: Rect,
): WeekView {
  const gap = 4;
  const trayH = Math.max(30, Math.round(area.h * 0.24));
  const topH = area.h - trayH - gap;
  const cw = Math.floor((area.w - gap * 6) / 7);
  const cols: WeekCol[] = days.map((d, i) => {
    const x = area.x + i * (cw + gap);
    const rect = { x, y: area.y, w: cw, h: topH };
    const head = { x, y: area.y, w: cw, h: 11 };
    const room = Math.max(0, Math.floor((topH - 11 - 4) / (WEEK_PIN_H + 2)));
    const shown = d.cards.slice(0, Math.max(0, room - (d.cards.length > room ? 1 : 0)));
    return {
      ...d,
      rect,
      head,
      pins: shown.map((c, k) => ({ ...c, x: x + 2, y: area.y + 11 + 2 + k * (WEEK_PIN_H + 2), w: cw - 4, h: WEEK_PIN_H })),
      more: d.cards.length - shown.length,
    };
  });
  const tray = { x: area.x, y: area.y + topH + gap, w: area.w, h: trayH };
  const perRow = Math.max(1, Math.floor((tray.w - 8) / 76));
  const rows = Math.max(1, Math.floor((tray.h - 14) / (WEEK_PIN_H + 2)));
  const cap = Math.max(0, perRow * rows - (overdue.length > perRow * rows ? 1 : 0));
  const shown = overdue.slice(0, cap);
  return {
    area,
    cols,
    tray: {
      rect: tray,
      pins: shown.map((c, k) => {
        const r = Math.floor(k / perRow), q = k % perRow;
        return { ...c, x: tray.x + 4 + q * 76, y: tray.y + 12 + r * (WEEK_PIN_H + 2), w: 72, h: WEEK_PIN_H };
      }),
      more: overdue.length - shown.length,
    },
  };
}
