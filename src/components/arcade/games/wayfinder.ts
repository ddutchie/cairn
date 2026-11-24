/**
 * Wayfinder: sail your knowledge graph. Notes are islands (size = length),
 * links between notes are sea lanes (fast water), each project is a harbour
 * town. Today's tasks are cargo at the Today lighthouse: deliver each to its
 * project's harbour before it's due. Overdue tasks are storms. Notes nothing
 * links to drift out to the edge, hidden in fog: chart them. Leave the boat
 * idle and the crew go fishing or swimming; whales, dolphins, turtles and the
 * odd kraken share the sea.
 */

import type { Priority } from "@cairn/shared/types/domain";
import type { ArcadeData, ArcadeProject } from "../data";
import type { GameFactory } from "../game";
import { KINDS, PRIORITY_PAL } from "../pixel/kinds";
import {
  BAYER, BIOMES, H, INK, W, band, clamp, ctx2d, darken, drawShadow, drawStack, drawText, drawTextC, fbm, hash2, lazy, makeModel, mkCanvas,
  px, rand, scr, textW, u32, type BiomeName, type Model,
} from "../pixel/kit";

const WD = 640, HD = 900;
/** Px of lift at the highest peak. */
const RELIEF = 12;
/** 09:00 → 18:00 in 2.5 minutes. */
const DAY_FRAMES = 60 * 150;
const MAX_CRATES = 12, MAX_STORMS = 5;
const WEIGHT: Record<Priority, number> = { low: 0.04, medium: 0.07, high: 0.1, urgent: 0.14 };
const PCOL: Record<Priority, string> = { low: PRIORITY_PAL.low.h, medium: PRIORITY_PAL.medium.h, high: PRIORITY_PAL.high.h, urgent: PRIORITY_PAL.urgent.h };

// ── Models ───────────────────────────────────────────────────────────────────
/** Boat: bow at y = 0, a deck, mast and a square sail across the beam. */
export const boatModel = lazy(() =>
  makeModel(7, 13, 7, (x, y, z) => {
    const half = y < 3 ? y * 0.9 : y > 10 ? 3 - (y - 10) * 0.5 : 3, dx = Math.abs(x - 3);
    if (z <= 1 && dx <= half) return z === 0 ? "#5a3a22" : dx >= half - 0.6 ? "#7a4a2a" : "#a8693a";
    if (z === 2 && dx <= half - 1 && y > 1 && y < 12) return "#c9a06a";
    if (z >= 2 && x === 3 && y === 6) return "#4a2e1a";
    if (z >= 3 && z <= 5 && y === 7 && dx <= 3) return z === 5 ? "#ffffff" : "#efe6d0";
    if (z === 6 && x === 3 && y === 6) return "#ef5a24";
    return null;
  }),
);
const sea = lazy(() => {
  const crate = Object.fromEntries(
    (Object.keys(PCOL) as Priority[]).map((k) => [
      k,
      makeModel(4, 4, 3, (x, y, z) => (z === 2 ? (x === 0 || y === 0 ? "#e8c890" : "#c9a06a") : x === 1 || y === 1 ? PCOL[k] : "#8a5a32")),
    ]),
  ) as Record<Priority, Model>;
  const lighthouse = makeModel(5, 5, 14, (x, y, z) => {
    const d = Math.abs(x - 2) + Math.abs(y - 2);
    if (z < 11) return d <= 2 - (z > 7 ? 1 : 0) ? ((z >> 1) & 1 ? "#d9483b" : "#f2ede0") : null;
    if (z === 11 || z === 12) return d <= 1 ? "#fff2a0" : null;
    return d === 0 ? "#2a2f3a" : null;
  });
  const whale = makeModel(9, 22, 4, (x, y, z) => {
    const half = y < 3 ? 1 + y : y < 12 ? 4 : y < 18 ? 4 - (y - 12) * 0.55 : 0.6, dx = Math.abs(x - 4);
    if (y >= 19) return z <= 1 && dx <= (y - 18) * 1.6 ? "#2e3f5c" : null; // flukes
    if (dx > half) return null;
    if (z === 0) return "#9fb3cf"; // pale belly
    if (z === 3) return dx <= half - 2 ? (y === 2 && dx === 0 ? "#22304a" : "#2e3f5c") : null;
    if (z === 2 && y === 4 && dx === 3) return "#0d1426"; // eyes
    return hash2(x, y, z) < 0.08 ? "#c7d0e6" : z === 2 ? "#3a4e6e" : "#4a6185"; // barnacles
  });
  const dolphin = makeModel(5, 11, 3, (x, y, z) => {
    const half = y < 2 ? 0.6 : y < 7 ? 2 : y < 9 ? 1 : 0.4, dx = Math.abs(x - 2);
    if (y >= 9) return z === 0 && dx <= (y - 8) * 1.4 ? "#5a6f96" : null;
    if (dx > half) return null;
    if (z === 2) return dx === 0 && y >= 3 && y <= 5 ? "#3d4f73" : null; // dorsal fin
    return z === 0 ? "#c7d0e6" : y === 0 ? "#6b7fa6" : "#7f93b8";
  });
  const turtle = makeModel(7, 9, 3, (x, y, z) => {
    const dx = Math.abs(x - 3);
    if (z === 0) return ((y === 2 || y === 6) && dx === 3) || (y === 0 && dx === 0) ? "#8fb070" : null; // flippers + head
    if (y < 1 || y > 7 || dx > (y < 2 || y > 6 ? 1 : 2)) return null;
    if (z === 2) return dx <= 1 && y > 1 && y < 7 ? ((x + y) % 2 ? "#6b8f3a" : "#4f7a3a") : null;
    return "#3d5a2e";
  });
  const segs = [5, 4, 4, 3, 3, 2].map((w, i) =>
    makeModel(w, w, 2, (x, y, z) => {
      const c = (w - 1) / 2, d = Math.abs(x - c) + Math.abs(y - c);
      if (d > c + 0.5) return null;
      if (z === 1 && x === Math.floor(c) && y === w - 1 && i < 5) return "#e8b8e0"; // suckers
      return z === 1 ? "#a8509a" : "#7a2f72";
    }),
  );
  return { crate, lighthouse, whale, dolphin, turtle, segs };
});
const hutModel = (accent: string) =>
  makeModel(5, 5, 5, (x, y, z) =>
    z < 3 ? (z === 1 && y === 4 && x === 2 ? "#2a1a10" : "#e8dcc0") : Math.abs(x - 2) <= 4 - z + 1 ? (y === 0 ? KINDS.project.l : accent) : null,
  );

/** A tileable 64×64 cloud texture for the fog (three shades). */
const fogTex = lazy(() => {
  const shades = ["#0d1530", "#141d40", "#1d2852"].map(u32), out = new Uint32Array(64 * 64);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      // Noise blended at four wrapped offsets → a seamless tile.
      const n =
        (fbm(x / 16, y / 16, 8) * (64 - x) * (64 - y) + fbm((x - 64) / 16, y / 16, 8) * x * (64 - y) +
          fbm(x / 16, (y - 64) / 16, 8) * (64 - x) * y + fbm((x - 64) / 16, (y - 64) / 16, 8) * x * y) / 4096;
      const q = n + (BAYER[(y & 3) * 4 + (x & 3)] - 0.5) * 0.08;
      out[y * 64 + x] = shades[q < 0.47 ? 0 : q < 0.56 ? 1 : 2];
    }
  return out;
});

// ── World ────────────────────────────────────────────────────────────────────
interface Proj extends ArcadeProject { cx: number; cy: number }
interface Isle {
  i: number; title: string; p: Proj | null; r: number; x: number; y: number; links: number[]; orphan: boolean;
  charted: boolean; biome: BiomeName; harbour?: boolean; today?: boolean; lift: number;
}
interface Crate { title: string; p: Proj; pr: Priority; due: number }
interface Storm { title: string; p: Proj; a: number; rr: number; r: number; x: number; y: number; bolt: number }

/** Lay the graph out as a sea chart and bake it (terrain, lanes, masks). */
function buildWorld(data: ArcadeData) {
  const projs: Proj[] = data.projects.slice(0, 6).map((p, i, all) => {
    const a = (i / all.length) * Math.PI * 2 - Math.PI / 2;
    return { ...p, cx: WD / 2 + Math.cos(a) * 165, cy: HD / 2 + Math.sin(a) * 230 };
  });
  const notes = projs.flatMap((p) => p.notes.map((n) => ({ n, p }))).slice(0, 36);
  const index = new Map(notes.map((x, i) => [x.n.id, i]));
  const linked = new Set<number>();
  const links = notes.map(({ n }, i) => {
    const out = n.links.map((id) => index.get(id)).filter((j): j is number => j !== undefined && j !== i);
    if (out.length) linked.add(i);
    out.forEach((j) => linked.add(j));
    return out;
  });
  const islands: Isle[] = notes.map(({ n, p }, i) => {
    const orphan = !linked.has(i), a = hash2(i, 1, 3) * Math.PI * 2, d = orphan ? 0 : 30 + hash2(i, 2, 3) * 30;
    return {
      i, title: n.title, p, links: links[i], orphan, charted: false, biome: p.biome, lift: 0,
      r: Math.round(9 + Math.sqrt(Math.min(n.words, 2400)) * 0.42),
      x: orphan ? WD / 2 + Math.cos(a) * 280 : p.cx + Math.cos(a) * d,
      y: orphan ? HD / 2 + Math.sin(a) * 400 : p.cy + Math.sin(a) * d,
    };
  });
  const harbours: Isle[] = projs.map((p, k) => ({ i: 100 + k, title: p.name, p, r: 15, x: p.cx, y: p.cy, harbour: true, biome: p.biome, links: [], charted: true, orphan: false, lift: 0 }));
  const today: Isle = { i: 200, title: "TODAY", p: null, r: 11, x: WD / 2, y: HD / 2, today: true, biome: "tundra", links: [], charted: true, orphan: false, lift: 0 };
  const all = [...islands, ...harbours, today];

  // A few hundred steps of springs and repulsion; orphans get pushed outward.
  for (let it = 0; it < 260; it++)
    for (const a of islands) {
      let fx = 0, fy = 0;
      for (const b of all) {
        if (a === b) continue;
        const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 1, min = a.r + b.r + 22;
        if (d < min) { fx += (dx / d) * (min - d) * 0.5; fy += (dy / d) * (min - d) * 0.5; }
      }
      for (const j of a.links) {
        const b = islands[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        fx += (dx / d) * (d - 70) * 0.02; fy += (dy / d) * (d - 70) * 0.02;
      }
      if (a.orphan || !a.p) {
        const dx = a.x - WD / 2, dy = a.y - HD / 2, d = Math.hypot(dx, dy) || 1;
        fx += (dx / d) * 0.6; fy += (dy / d) * 0.6;
      } else { fx += (a.p.cx - a.x) * 0.01; fy += (a.p.cy - a.y) * 0.01; }
      a.x = clamp(a.x + fx, a.r + 20, WD - a.r - 20);
      a.y = clamp(a.y + fy, a.r + 30, HD - a.r - 30);
    }
  const lanes: [Isle, Isle, "link" | "trunk"][] = [];
  islands.forEach((a) => a.links.forEach((j) => lanes.push([a, islands[j], "link"])));
  harbours.forEach((h) => lanes.push([h, today, "trunk"]));

  // Elevation, nearness to land, and which island owns each pixel.
  const E = new Float32Array(WD * HD), NEAR = new Float32Array(WD * HD), OWN = new Uint8Array(WD * HD).fill(255);
  all.forEach((is, k) => {
    const R = is.r * 1.9, x0 = Math.max(0, (is.x - R) | 0), x1 = Math.min(WD - 1, (is.x + R) | 0), y0 = Math.max(0, (is.y - R) | 0), y1 = Math.min(HD - 1, (is.y + R) | 0);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const dx = x - is.x, dy = y - is.y, wob = 0.75 + fbm(x * 0.06, y * 0.06, is.i * 13 + 5) * 0.6;
        const d = Math.hypot(dx, dy) / (is.r * wob), o = y * WD + x, e = 1 - d * d;
        if (e > E[o]) { E[o] = e; OWN[o] = k; }
        const n = 1 - (d / 1.7) ** 2;
        if (n > NEAR[o]) { NEAR[o] = n; if (OWN[o] === 255) OWN[o] = k; }
      }
  });
  const LANE = new Uint8Array(WD * HD);
  for (const [a, b, kind] of lanes) {
    const len = Math.hypot(b.x - a.x, b.y - a.y), w = kind === "trunk" ? 4 : 3;
    for (let s = 0; s <= len; s++) {
      const cx = a.x + ((b.x - a.x) * s) / len, cy = a.y + ((b.y - a.y) * s) / len;
      for (let dy = -w; dy <= w; dy++)
        for (let dx = -w; dx <= w; dx++) {
          if (dx * dx + dy * dy > w * w) continue;
          const x = (cx + dx) | 0, y = (cy + dy) | 0;
          if (x >= 0 && y >= 0 && x < WD && y < HD) LANE[y * WD + x] = s % 18 < 2 && dx === 0 && dy === 0 ? 2 : 1;
        }
    }
  }

  const world = mkCanvas(WD, HD), wctx = ctx2d(world), wimg = wctx.createImageData(WD, HD), wbuf = new Uint32Array(wimg.data.buffer);
  const WATER = BIOMES.tropic.water.map(u32), LANE_C = u32("#5fb6e8"), BUOY = u32("#fff2a0");
  const owner = (k: number) => all[k] ?? today;
  const landColour = (e: number, k: number, x: number, y: number) => {
    const bands = BIOMES[owner(k).biome].bands;
    const q = e + (BAYER[(y & 3) * 4 + (x & 3)] - 0.5) * 0.06;
    const b = q < 0.1 ? 0 : q < 0.34 ? 1 : q < 0.6 ? 2 : q < 0.82 ? 3 : 4;
    // Lit from the top-left: compare with the pixel up-left.
    const o = y * WD + x, up = y > 0 && x > 0 ? E[o - WD - 1] : e, sl = e - up;
    const shade = sl > 0.012 ? 2 : sl < -0.012 ? 0 : 1;
    let c = bands[b][shade];
    if (b === 2 && hash2(x, y, 9) < 0.18) c = bands[b][0];
    return u32(c);
  };
  // Water first (flat), then land raycast bottom-up so slopes lift and cliffs show.
  for (let y = 0; y < HD; y++)
    for (let x = 0; x < WD; x++) {
      const o = y * WD + x, n = NEAR[o];
      let c = n > 0.75 ? WATER[3] : n > 0.35 ? WATER[2] : n > 0 ? WATER[1] : fbm(x * 0.02, y * 0.02, 4) > 0.55 ? WATER[1] : WATER[0];
      if (n > 0.55 && n < 0.62 && hash2(x, y, 3) < 0.5) c = WATER[4];
      if (LANE[o] && E[o] <= 0) c = LANE[o] === 2 ? BUOY : BAYER[(y & 3) * 4 + (x & 3)] < 0.6 ? LANE_C : WATER[3];
      wbuf[o] = c;
    }
  for (let x = 0; x < WD; x++) {
    let yb = HD;
    for (let r = HD - 1; r >= 0; r--) {
      const o = r * WD + x, e = E[o];
      if (e <= 0) continue;
      const y = r - Math.round(e * RELIEF);
      if (y >= yb) continue;
      const top = Math.max(0, y);
      wbuf[top * WD + x] = landColour(e, OWN[o], x, r);
      const side = darken(BIOMES[owner(OWN[o]).biome].bands[Math.min(4, (e * 5) | 0)][0], 0.7);
      for (let yy = top + 1; yy < Math.min(yb, r + 1); yy++) wbuf[yy * WD + x] = side;
      yb = top;
    }
  }
  wctx.putImageData(wimg, 0, 0);
  for (const is of all) is.lift = Math.round(Math.max(0, E[(is.y | 0) * WD + (is.x | 0)]) * RELIEF);

  // Cargo: today's open work, most due first; overdue work turns into storms.
  const tasks = projs.flatMap((p) => p.tasks.map((t) => ({ t, p })));
  const crates: Crate[] = tasks.filter((x) => !x.t.overdue).sort((a, b) => a.t.dueMin - b.t.dueMin).slice(0, MAX_CRATES)
    .map(({ t, p }) => ({ title: t.title, p, pr: t.priority, due: t.dueMin }));
  const stormTasks = tasks.filter((x) => x.t.overdue).slice(0, MAX_STORMS);
  return { projs, islands, harbours, today, all, E, NEAR, LANE, world, crates, stormTasks };
}

interface Particle { x: number; y: number; vx: number; vy: number; g: number; life: number; c: string; wake?: boolean }
interface Pop { head: string; title: string; c: string; t: number }
interface Swimmer { x: number; y: number; a: number }

export const createWayfinder: GameFactory = ({ data, best: best0 }) => {
  const ctx = scr.ctx, BOAT = boatModel(), S = sea(), FOG_TEX = fogTex();
  const { islands, harbours, today, all, E, NEAR, LANE, world, crates: allCrates, stormTasks } = buildWorld(data);
  const HUT = harbours.map((h) => hutModel(h.p!.accent));
  const cargoTotal = allCrates.length;

  let state: "title" | "sail" | "map" | "log" = "title", t = 0, stateT = 0, clock = 0;
  const boat = { x: WD / 2, y: HD / 2 + 22, a: 0, v: 0, cargo: [] as Crate[] };
  let crates: Crate[] = [], storms: Storm[] = [], parts: Particle[] = [], pops: Pop[] = [];
  let delivered = 0, late = 0, charted = 0, score = 0, best = best0;
  let camX = 0, camY = 0, steer: { x: number; y: number } | null = null, shake = 0, flash = 0;
  const keys = new Set<string>();
  const FW = Math.ceil(WD / 8), FH = Math.ceil(HD / 8), FOG = new Float32Array(FW * FH).fill(1);

  /** Nearest point with open water (no land within `clear` px), searched in rings. */
  function openWater(x: number, y: number, clear = 7) {
    const free = (qx0: number, qy0: number) => {
      for (let dy = -clear; dy <= clear; dy += 2)
        for (let dx = -clear; dx <= clear; dx += 2) {
          const qx = (qx0 + dx) | 0, qy = (qy0 + dy) | 0;
          if (qx < 4 || qy < 4 || qx >= WD - 4 || qy >= HD - 4 || E[qy * WD + qx] > 0) return false;
        }
      return true;
    };
    for (let r = 0; r < 200; r += 2)
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2, qx = x + Math.cos(a) * r, qy = y + Math.sin(a) * r;
        if (free(qx, qy)) return { x: qx, y: qy };
      }
    return { x, y };
  }
  const homeDock = openWater(today.x, today.y + today.r + 8);

  function reveal(x: number, y: number, R: number) {
    const c0 = Math.max(0, ((x - R) / 8) | 0), c1 = Math.min(FW - 1, ((x + R) / 8) | 0), r0 = Math.max(0, ((y - R) / 8) | 0), r1 = Math.min(FH - 1, ((y + R) / 8) | 0);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(c * 8 + 4 - x, r * 8 + 4 - y) / R, v = clamp((1 - d) * 2.2, 0, 1), o = r * FW + c;
        if (v > FOG[o]) FOG[o] = v;
      }
  }
  const fogAt = (x: number, y: number) => FOG[clamp((y / 8) | 0, 0, FH - 1) * FW + clamp((x / 8) | 0, 0, FW - 1)];
  const timeAt = (f: number) => {
    const m = 540 + Math.floor((f / DAY_FRAMES) * 540);
    return `${String((m / 60) | 0).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const dueFrame = (c: Crate) => (c.due / 540) * DAY_FRAMES;
  const addScore = (n: number) => { score += n; if (score > best) best = score; };
  function pop(head: string, title: string, c: string) {
    pops.push({ head, title, c, t: 0 });
    if (pops.length > 2) pops.shift();
  }

  function reset() {
    Object.assign(boat, { x: homeDock.x, y: homeDock.y, a: 0, v: 0, cargo: [] });
    crates = allCrates.map((c) => ({ ...c }));
    storms = stormTasks.map(({ t: task, p }, k) => {
      const pj = harbours.find((h) => h.p!.id === p.id)!.p!;
      return { title: task.title, p: pj, a: k * 2.1, rr: 26 + k * 6, r: 22 + (task.priority === "high" || task.priority === "urgent" ? 6 : 0), x: pj.cx, y: pj.cy, bolt: 0 };
    });
    FOG.fill(0);
    parts = []; pops = [];
    Object.assign(kraken, { phase: "none", done: false });
    Object.assign(crew, { idle: 0, cast: 0, bite: 0, swim: "deck" });
    delivered = late = charted = score = 0;
    clock = 0;
    for (const is of islands) is.charted = false;
    reveal(WD / 2, HD / 2, 120);
    // You know where your projects are; it's the notes around them you chart.
    for (const h of harbours) reveal(h.x, h.y, 44);
  }

  // ── Sea life ───────────────────────────────────────────────────────────────
  const okWater = (x: number, y: number, maxNear: number, minNear = -1) => {
    if (x < 6 || y < 6 || x >= WD - 6 || y >= HD - 6) return false;
    const o = (y | 0) * WD + (x | 0);
    return E[o] <= 0 && NEAR[o] <= maxNear && NEAR[o] >= minNear;
  };
  function spot(maxNear: number, minNear: number, seed: number) {
    for (let i = 0; i < 400; i++) {
      const x = hash2(seed, i, 1) * WD, y = hash2(seed, i, 2) * HD;
      if (okWater(x, y, maxNear, minNear)) return { x, y };
    }
    return { x: 20, y: 20 };
  }
  const whales = Array.from({ length: 4 }, (_, i) => ({ ...spot(0, -1, 70 + i), a: hash2(i, 3, 3) * 6.28, cyc: (i * 230) % 640 }));
  const turtles = Array.from({ length: 6 }, (_, i) => ({ ...spot(0.7, 0.3, 90 + i), a: hash2(i, 4, 3) * 6.28 }));
  const schools = Array.from({ length: 16 }, (_, i) => ({ ...spot(0.9, 0.15, 110 + i), a: hash2(i, 5, 3) * 6.28, n: 6 + (i % 5), flee: 0 }));
  const pod = { on: 0, met: false };

  /** Drift the heading; turn away from anything outside the allowed water. */
  function wander(c: Swimmer, v: number, maxNear: number, minNear?: number) {
    c.a += Math.sin(t * 0.01 + c.x * 0.03) * 0.01;
    const nx = c.x + Math.sin(c.a) * v, ny = c.y - Math.cos(c.a) * v;
    if (okWater(nx, ny, maxNear, minNear)) { c.x = nx; c.y = ny; }
    else c.a += 0.08;
  }
  function stepCreatures() {
    for (const w of whales) {
      w.cyc = (w.cyc + 1) % 640;
      wander(w, w.cyc < 220 ? 0.22 : 0.32, 0.05);
      if (w.cyc === 30 || w.cyc === 120)
        for (let i = 0; i < 16; i++)
          parts.push({ x: w.x + Math.sin(w.a) * 6, y: w.y - Math.cos(w.a) * 6 - 6, vx: rand(-0.35, 0.35), vy: rand(-1.4, -0.6), g: 0.05, life: 26 + (i % 8), c: i % 3 ? "#e6f6ff" : "#9fd2ff" });
    }
    for (const tt of turtles) wander(tt, 0.12, 0.8, 0.2);
    for (const s of schools) {
      const d = Math.hypot(boat.x - s.x, boat.y - s.y);
      if (d < 26 && boat.v > 0.2) { s.a = Math.atan2(s.x - boat.x, -(s.y - boat.y)); s.flee = 40; }
      wander(s, s.flee-- > 0 ? 1.1 : 0.2, 0.95, 0.1);
    }
    // The pod finds you under way in open water, and leaves when you stop.
    const open = NEAR[(boat.y | 0) * WD + (boat.x | 0)] < 0.4;
    if (state === "sail" && boat.v > 0.75 && open) pod.on = Math.min(1, pod.on + 0.004);
    else pod.on = Math.max(0, pod.on - 0.01);
    if (pod.on >= 1 && !pod.met) { pod.met = true; pop("A POD OF DOLPHINS", "JOINS YOUR BOW", "#c7e4ff"); }
    if (pod.on === 0) pod.met = false;
  }
  /** Dolphin i alongside the bow, porpoising. */
  function dolphinAt(i: number) {
    const lag = 6 + i * 7, side = (i % 2 ? 1 : -1) * (7 + i * 2) + Math.sin(t * 0.03 + i) * 2, away = (1 - pod.on) * 40;
    const x = boat.x + Math.sin(boat.a) * (4 - lag) + Math.cos(boat.a) * (side + Math.sign(side) * away);
    const y = boat.y - Math.cos(boat.a) * (4 - lag) + Math.sin(boat.a) * (side + Math.sign(side) * away);
    const ph = (t * 0.06 + i * 2.1) % (Math.PI * 2), jump = ph < Math.PI ? Math.sin(ph) * 6 : 0;
    return { x, y, jump, ph };
  }
  function drawSeaLifeUnder() {
    for (const s of schools) {
      const x0 = sx(s.x), y0 = sy(s.y);
      if (x0 < -10 || y0 < -10 || x0 > W + 10 || y0 > H + 10) continue;
      for (let k = 0; k < s.n; k++) {
        const r = 3 + (k % 3) * 2, a = t * (s.flee > 0 ? 0.02 : 0.05) + k * 2.4;
        const fx = x0 + Math.cos(a) * r - Math.sin(s.a) * (k % 4), fy = y0 + Math.sin(a) * r * 0.7 + Math.cos(s.a) * (k % 4);
        px(fx, fy, (t + k * 17) % 50 < 2 ? "#c7e4ff" : "#14336a");
      }
    }
    for (const w of whales) if (w.cyc >= 220) drawShadow(S.whale, sx(w.x), sy(w.y), w.a, 0, 0, 0.35);
    if (pod.on > 0)
      for (let i = 0; i < 3; i++) {
        const d = dolphinAt(i);
        if (d.jump <= 0) drawShadow(S.dolphin, sx(d.x), sy(d.y), boat.a, 0, 0, 0.3 * pod.on);
        else drawShadow(S.dolphin, sx(d.x), sy(d.y), boat.a, 1, 2, 0.2 * pod.on);
      }
  }
  function drawSeaLifeOver() {
    for (const tt of turtles) {
      drawShadow(S.turtle, sx(tt.x), sy(tt.y), tt.a, 1, 2, 0.3);
      drawStack(S.turtle, sx(tt.x), sy(tt.y), tt.a + Math.sin(t * 0.15) * 0.1);
    }
    for (const w of whales)
      if (w.cyc < 220) {
        const rise = w.cyc < 20 ? w.cyc / 20 : w.cyc > 200 ? (220 - w.cyc) / 20 : 1;
        drawShadow(S.whale, sx(w.x), sy(w.y), w.a, 2, 3, 0.25);
        drawStack(S.whale, sx(w.x), sy(w.y) + Math.round((1 - rise) * 3), w.a, { lift: 0.5 + rise * 0.5 });
        if ((t >> 3) & 1)
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * 6.283;
            px(sx(w.x) + Math.cos(a) * 9, sy(w.y) + Math.sin(a) * 12, "#9fd2ff");
          }
      }
    if (pod.on > 0)
      for (let i = 0; i < 3; i++) {
        const d = dolphinAt(i);
        if (d.jump > 0) {
          drawStack(S.dolphin, sx(d.x), sy(d.y) - Math.round(d.jump), boat.a);
          if (d.ph < 0.15 || d.ph > Math.PI - 0.15)
            for (let k = 0; k < 3; k++) parts.push({ x: d.x + rand(-2, 2), y: d.y, vx: rand(-0.5, 0.5), vy: rand(-0.9, -0.3), g: 0.06, life: 12, c: "#e6f6ff" });
        }
      }
  }

  // ── The kraken ─────────────────────────────────────────────────────────────
  // At most once a day, after 11:00, in deep water. Touch an arm and it takes
  // your heaviest crate back to the Today dock; slip out for a bonus.
  const kraken = { phase: "none" as "none" | "stir" | "up" | "sink", x: 0, y: 0, t: 0, done: false, arms: [] as { a: number; r: number; h: number }[] };
  function stepKraken() {
    const k = kraken;
    if (k.phase === "none") {
      const deep = NEAR[(boat.y | 0) * WD + (boat.x | 0)] <= 0 && fbm(boat.x * 0.02, boat.y * 0.02, 4) > 0.5;
      if (!k.done && state === "sail" && clock > DAY_FRAMES * 0.22 && deep && boat.v > 0.4 && Math.random() < 0.004) {
        Object.assign(k, { phase: "stir", x: boat.x + Math.sin(boat.a) * 10, y: boat.y - Math.cos(boat.a) * 10, t: 0, done: true });
        k.arms = Array.from({ length: 6 }, (_, i) => ({ a: (i / 6) * Math.PI * 2 + 0.3, r: 32, h: 0 }));
        pop("SOMETHING STIRS", "BELOW THE HULL", "#e8b8e0");
        shake = 1.5;
      }
      return;
    }
    k.t++;
    if (k.phase === "stir" && k.t > 110) { k.phase = "up"; k.t = 0; shake = 3; pop("THE KRAKEN", "SAIL CLEAR OF THE ARMS", "#ff5e8a"); }
    if (k.phase === "up") {
      for (const a of k.arms) { a.h = Math.min(1, a.h + 0.03); a.r = Math.max(16, 32 - k.t * 0.03); }
      for (const a of k.arms) {
        const ax = k.x + Math.cos(a.a) * a.r, ay = k.y + Math.sin(a.a) * a.r;
        if (Math.hypot(ax - boat.x, ay - boat.y) < 6 && a.h > 0.8) {
          const c = [...boat.cargo].sort((p, q) => WEIGHT[q.pr] - WEIGHT[p.pr])[0];
          if (c) { boat.cargo = boat.cargo.filter((x) => x !== c); crates.unshift(c); pop("THE KRAKEN TOOK", c.title, "#ff5e8a"); }
          else pop("THE KRAKEN", "FOUND YOUR HOLD EMPTY", "#e8b8e0");
          boat.v = -0.8; shake = 4; k.phase = "sink"; k.t = 0;
          for (let i = 0; i < 20; i++) parts.push({ x: ax, y: ay, vx: rand(-1, 1), vy: rand(-1.5, -0.3), g: 0.06, life: 24, c: i % 2 ? "#e6f6ff" : "#a8509a" });
          return;
        }
      }
      const far = Math.hypot(boat.x - k.x, boat.y - k.y) > 60;
      if (far || k.t > 480) {
        if (far) { addScore(50); pop("ESCAPED THE KRAKEN", "+50", "#8dff9a"); }
        k.phase = "sink"; k.t = 0;
      }
    }
    if (k.phase === "sink") {
      for (const a of k.arms) a.h = Math.max(0, a.h - 0.03);
      if (k.t > 60) k.phase = "none";
    }
  }
  function drawKrakenUnder() {
    const k = kraken;
    if (k.phase === "none") return;
    const grow = k.phase === "stir" ? Math.min(1, k.t / 60) : k.phase === "sink" ? Math.max(0, 1 - k.t / 60) : 1;
    const rx = 28 * grow, ry = 20 * grow, cx = sx(k.x), cy = sy(k.y);
    for (let y = -ry; y <= ry; y++)
      for (let x = -rx; x <= rx; x++) {
        const d = (x * x) / (rx * rx || 1) + (y * y) / (ry * ry || 1);
        if (d < 1 && BAYER[(((y + 64) | 0) & 3) * 4 + (((x + 64) | 0) & 3)] < 0.75 - d * 0.5) px(cx + x, cy + y, "#0a1a3a");
      }
    if (k.phase === "stir" && t % 6 === 0) parts.push({ x: k.x + rand(-rx, rx), y: k.y + rand(-ry, ry), vx: 0, vy: -0.2, g: 0, life: 18, c: "#9fd2ff", wake: true });
  }
  function drawKrakenOver() {
    const k = kraken;
    if (k.phase !== "up" && k.phase !== "sink") return;
    k.arms.forEach((a, i) => {
      const ax = sx(k.x + Math.cos(a.a) * a.r), ay = sy(k.y + Math.sin(a.a) * a.r), n = Math.round(S.segs.length * 2 * a.h);
      for (let j = 0; j < 4; j++) {
        const q = (j / 4) * 6.283 + t * 0.1;
        px(ax + Math.cos(q) * 4, ay + Math.sin(q) * 3, "#e6f6ff");
      }
      for (let s = 0; s < n; s++) {
        const seg = S.segs[Math.min(S.segs.length - 1, s >> 1)], sway = Math.sin(t * 0.08 + i * 1.7 + s * 0.45) * s * 0.55;
        drawStack(seg, ax + sway, ay - s * 2, 0);
      }
    });
  }

  // ── The crew ───────────────────────────────────────────────────────────────
  // Idle, one casts a line off the stern (a fish, an old boot, or a message in
  // a bottle that charts a lost note); the other dives in for a swim.
  const crew = { idle: 0, cast: 0, bite: 0, nextBite: 0, swim: "deck" as "deck" | "dive" | "swim", st: 0, sa: 0 };
  const CATCHES = ["A MACKEREL", "A SARDINE", "AN OLD BOOT", "A COD", "A TANGLE OF KELP"];
  function deckPoint(lx: number, lf: number) {
    const rx = Math.cos(boat.a), ry = Math.sin(boat.a), fx = Math.sin(boat.a), fy = -Math.cos(boat.a);
    return { x: boat.x + rx * lx + fx * lf, y: boat.y + ry * lx + fy * lf };
  }
  const swimmerPos = () => {
    const a = boat.a + crew.sa;
    return { x: boat.x + Math.cos(a) * 13, y: boat.y + Math.sin(a) * 13 };
  };
  const lineEnd = () => deckPoint(-16 - crew.cast * 4, -5);
  function stepCrew() {
    const idle = state === "sail" && !steer && Math.abs(boat.v) < 0.08 && kraken.phase === "none";
    if (!idle) {
      if (crew.swim === "swim") for (let i = 0; i < 6; i++) parts.push({ ...swimmerPos(), vx: rand(-0.6, 0.6), vy: rand(-1, -0.2), g: 0.06, life: 14, c: "#e6f6ff" });
      Object.assign(crew, { idle: 0, cast: 0, bite: 0, swim: "deck" });
      return;
    }
    crew.idle++;
    if (crew.idle > 80) {
      if (crew.cast < 1) {
        crew.cast = Math.min(1, crew.cast + 0.035);
        if (crew.cast >= 1) crew.nextBite = 200 + Math.random() * 300;
      } else if (crew.bite > 0) {
        if (--crew.bite === 0) catchSomething();
      } else if (--crew.nextBite <= 0) crew.bite = 40;
    }
    if (crew.idle > 200 && crew.swim === "deck") { crew.swim = "dive"; crew.st = 0; crew.sa = 0; }
    if (crew.swim === "dive" && ++crew.st > 24) {
      crew.swim = "swim"; crew.st = 0;
      const p = swimmerPos();
      for (let i = 0; i < 10; i++) parts.push({ x: p.x, y: p.y, vx: rand(-0.8, 0.8), vy: rand(-1.4, -0.4), g: 0.07, life: 18, c: "#e6f6ff" });
    }
    if (crew.swim === "swim") { crew.st++; crew.sa += 0.012; }
  }
  function catchSomething() {
    const lost = islands.filter((i) => i.orphan && !i.charted), end = lineEnd();
    for (let i = 0; i < 8; i++) parts.push({ x: end.x, y: end.y, vx: rand(-0.6, 0.6), vy: rand(-1.4, -0.4), g: 0.07, life: 16, c: "#e6f6ff" });
    if (lost.length && Math.random() < 0.3) {
      const n = lost[(Math.random() * lost.length) | 0];
      reveal(n.x, n.y, 40);
      pop("A MESSAGE IN A BOTTLE", `IT LEADS TO ${n.title}`, "#fff2a0");
    } else {
      const c = CATCHES[(Math.random() * CATCHES.length) | 0];
      if (c !== "AN OLD BOOT") addScore(5);
      pop("THE CREW CAUGHT", c, "#c7e4ff");
    }
    crew.cast = 0;
    crew.idle = 81; // recast
  }
  function sailor(x: number, y: number, shirt: string, lift: number) {
    px(x, y - lift - 3, "#f0c8a0"); px(x, y - lift - 4, "#5a3a22"); px(x, y - lift - 2, shirt); px(x, y - lift - 1, "#2a2f3a");
  }
  function drawCrew(bob: number) {
    const st = deckPoint(-1, -4), bw = deckPoint(1, 3), lift = 3 - bob;
    sailor(sx(st.x), sy(st.y), "#2ec4b6", lift);
    if (crew.swim === "deck") sailor(sx(bw.x), sy(bw.y), "#ef5a24", lift);
    if (crew.cast > 0) {
      const rod = deckPoint(-4, -5), end = lineEnd(), n = 14, dip = crew.bite > 0 && (t >> 2) & 1 ? 1 : 0;
      px(sx(rod.x), sy(rod.y) - lift - 4, "#8a5a32");
      for (let i = 1; i < n * crew.cast; i++) {
        const f = i / n, x = rod.x + (end.x - rod.x) * f, y = rod.y + (end.y - rod.y) * f - (lift + 4) * (1 - f) + Math.sin(f * Math.PI) * 2;
        px(sx(x), sy(y), "#d6dceb");
      }
      if (crew.cast >= 1) {
        const fy = Math.sin(t * 0.1) * 0.5 + dip;
        px(sx(end.x), sy(end.y) + fy, "#ff3d6e"); px(sx(end.x), sy(end.y) + fy - 1, "#ffffff");
        if (crew.bite > 0 && t % 8 === 0) parts.push({ x: end.x + rand(-2, 2), y: end.y, vx: 0, vy: 0, g: 0, life: 10, c: "#e6f6ff", wake: true });
      }
    }
    if (crew.swim === "dive") {
      const f = crew.st / 24, p = swimmerPos(), x = bw.x + (p.x - bw.x) * f, y = bw.y + (p.y - bw.y) * f - Math.sin(f * Math.PI) * 8 - lift * (1 - f);
      px(sx(x), sy(y), "#f0c8a0"); px(sx(x), sy(y) + 1, "#ef5a24");
    }
    if (crew.swim === "swim") {
      const p = swimmerPos(), stroke = (t >> 4) & 1;
      px(sx(p.x), sy(p.y) - 1, "#f0c8a0"); px(sx(p.x), sy(p.y) - 2, "#5a3a22");
      px(sx(p.x) + (stroke ? 1 : -1), sy(p.y) - 1, "#f0c8a0");
      if (crew.st % 24 < 10) {
        const r = 1 + (crew.st % 24) / 4;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * 6.283;
          px(sx(p.x) + Math.cos(a) * r, sy(p.y) + Math.sin(a) * r * 0.6, "#e6f6ff");
        }
      }
    }
  }

  // ── Update ─────────────────────────────────────────────────────────────────
  function update() {
    t++; stateT++;
    if (state !== "map") { stepCreatures(); stepKraken(); stepCrew(); }
    if (state === "title") {
      boat.a += 0.012;
      boat.x = WD / 2 + Math.sin(boat.a) * 40;
      boat.y = HD / 2 + 30 - Math.cos(boat.a) * 40;
      wake(false);
      stepParts();
      return;
    }
    if (state !== "sail") { stepParts(); return; }
    clock++;
    // Arrow keys steer like a held pointer ahead of the bow.
    const kx = (keys.has("ArrowRight") || keys.has("KeyD") ? 1 : 0) - (keys.has("ArrowLeft") || keys.has("KeyA") ? 1 : 0);
    const ky = (keys.has("ArrowDown") || keys.has("KeyS") ? 1 : 0) - (keys.has("ArrowUp") || keys.has("KeyW") ? 1 : 0);
    const aim = kx || ky ? { x: boat.x - camX + kx * 40, y: boat.y - camY + ky * 40 } : steer;
    if (aim) {
      const want = Math.atan2(aim.x + camX - boat.x, -(aim.y + camY - boat.y));
      let da = want - boat.a;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      boat.a += clamp(da, -0.06, 0.06);
    }
    const o = (boat.y | 0) * WD + (boat.x | 0), onLane = LANE[o] > 0;
    const load = boat.cargo.reduce((s, c) => s + WEIGHT[c.pr], 0);
    // Dolphins at the bow are worth a knot.
    let top = (onLane ? 1.55 : 1) * (1 - load) * (1 + pod.on * 0.12);
    const inStorm = storms.find((s) => Math.hypot(s.x - boat.x, s.y - boat.y) < s.r);
    if (inStorm) { top *= 0.45; if (t % 20 === 0) shake = 2; }
    boat.v += ((aim ? top : 0) - boat.v) * 0.04;
    const nx = boat.x + Math.sin(boat.a) * boat.v, ny = boat.y - Math.cos(boat.a) * boat.v;
    const no = (ny | 0) * WD + (nx | 0);
    // Run aground → bounce off and lose way.
    if (nx < 4 || ny < 4 || nx > WD - 4 || ny > HD - 4 || E[no] > 0.04) { boat.v *= -0.3; shake = 1.5; }
    else { boat.x = nx; boat.y = ny; }
    if (boat.v > 0.3) wake(onLane);
    reveal(boat.x, boat.y, 64);

    for (const is of islands)
      if (!is.charted && fogAt(is.x, is.y) > 0.5) {
        is.charted = true;
        charted++;
        pop(is.orphan ? "LOST NOTE CHARTED" : "CHARTED", is.title, is.orphan ? "#fff2a0" : "#c7e4ff");
        addScore(is.orphan ? 30 : 10);
      }
    // Load at the lighthouse (most due first, three crates at most).
    if (Math.hypot(boat.x - today.x, boat.y - today.y) < today.r + 16)
      while (boat.cargo.length < 3 && crates.length) {
        const c = crates.shift()!;
        boat.cargo.push(c);
        pop("LOADED", c.title, PCOL[c.pr]);
      }
    for (const h of harbours)
      if (Math.hypot(boat.x - h.x, boat.y - h.y) < h.r + 18) {
        for (const c of boat.cargo.filter((c) => c.p === h.p)) {
          const isLate = clock > dueFrame(c);
          delivered++;
          if (isLate) late++;
          addScore(isLate ? 50 : 100);
          pop(isLate ? "LATE" : "DELIVERED", c.title, isLate ? "#ff9a6b" : "#8dff9a");
          for (let i = 0; i < 14; i++) parts.push({ x: h.x, y: h.y - h.lift - 6, vx: rand(-1, 1), vy: rand(-1.6, -0.4), g: 0.06, life: 26, c: [h.p!.accent, "#fff2a0", "#ffffff"][i % 3] });
          flash = 6;
        }
        boat.cargo = boat.cargo.filter((c) => c.p !== h.p);
      }
    for (const s of storms) {
      s.a += 0.004;
      s.x = s.p.cx + Math.cos(s.a) * s.rr;
      s.y = s.p.cy + Math.sin(s.a) * s.rr * 0.8;
      if (s.bolt > 0) s.bolt--;
      else if (Math.random() < 0.006) s.bolt = 8;
    }
    if (clock >= DAY_FRAMES || (!crates.length && !boat.cargo.length && charted === islands.length)) {
      state = "log"; stateT = 0; steer = null;
      buildChart();
    }
    if (shake > 0) shake -= 0.25;
    if (flash > 0) flash--;
    stepParts();
  }
  function wake(lane: boolean) {
    const bx = boat.x - Math.sin(boat.a) * 7, by = boat.y + Math.cos(boat.a) * 7;
    if (t % 2 === 0)
      for (const s of [-1, 1])
        parts.push({ x: bx + Math.cos(boat.a) * 2 * s, y: by + Math.sin(boat.a) * 2 * s, vx: Math.cos(boat.a) * 0.15 * s, vy: Math.sin(boat.a) * 0.15 * s, g: 0, life: lane ? 34 : 24, c: "#e6f6ff", wake: true });
  }
  function stepParts() {
    for (const p of parts) { p.vy += p.g; p.x += p.vx; p.y += p.vy; p.life--; }
    parts = parts.filter((p) => p.life > 0);
    for (const p of pops) p.t++;
    pops = pops.filter((p) => p.t < 110);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const sx = (x: number) => x - camX, sy = (y: number) => y - camY;
  let fogCv!: HTMLCanvasElement, fogCtx!: CanvasRenderingContext2D, fogImg!: ImageData, fogBuf!: Uint32Array;
  function allocFog() {
    fogCv = mkCanvas(W, H);
    fogCtx = ctx2d(fogCv);
    fogImg = fogCtx.createImageData(W, H);
    fogBuf = new Uint32Array(fogImg.data.buffer);
  }
  allocFog();
  function drawFog() {
    const g = (c: number, r: number) => FOG[clamp(r, 0, FH - 1) * FW + clamp(c, 0, FW - 1)];
    for (let y = 0; y < H; y++) {
      const wy = y + camY;
      for (let x = 0; x < W; x++) {
        const wx = x + camX;
        // Bilinear reveal across fog cells, then an ordered-dither edge.
        const fx = wx / 8 - 0.5, fy = wy / 8 - 0.5, cx = Math.floor(fx), cy = Math.floor(fy), ax = fx - cx, ay = fy - cy;
        const v = (g(cx, cy) * (1 - ax) + g(cx + 1, cy) * ax) * (1 - ay) + (g(cx, cy + 1) * (1 - ax) + g(cx + 1, cy + 1) * ax) * ay;
        fogBuf[y * W + x] = v > BAYER[(y & 3) * 4 + (x & 3)] ? 0 : FOG_TEX[((wy + (t >> 3)) & 63) * 64 + ((wx + (t >> 4)) & 63)];
      }
    }
    fogCtx.putImageData(fogImg, 0, 0);
    ctx.drawImage(fogCv, 0, 0);
  }
  function render() {
    // The camera leads the boat a little in its heading.
    const lx = boat.x + Math.sin(boat.a) * boat.v * 22, ly = boat.y - Math.cos(boat.a) * boat.v * 30;
    camX = W >= WD ? Math.round((WD - W) / 2) : clamp(Math.round(lx - W / 2), 0, WD - W);
    camY = clamp(Math.round(ly - H * 0.55), 0, HD - H);
    scr.sx = shake > 0 ? Math.round(rand(-shake, shake)) : 0;
    scr.sy = shake > 0 ? Math.round(rand(-shake, shake)) : 0;
    ctx.fillStyle = BIOMES.tropic.water[0];
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(world, -camX + scr.sx, -camY + scr.sy);
    for (let i = 0; i < 6; i++) {
      const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0, wx = x + camX, wy = y + camY;
      if (wx >= 0 && wx < WD && wy >= 0 && wy < HD) {
        const o = wy * WD + wx;
        if (E[o] <= 0 && NEAR[o] > 0 && Math.random() < 0.4) px(x, y, "#e6f6ff");
      }
    }
    harbours.forEach((h, k) => {
      for (const [dx, dy] of [[-6, -2], [5, -4], [0, 5]]) {
        drawShadow(HUT[k], sx(h.x + dx), sy(h.y + dy - h.lift), 0, 2, 3, 0.3);
        drawStack(HUT[k], sx(h.x + dx), sy(h.y + dy - h.lift), 0);
      }
    });
    drawShadow(S.lighthouse, sx(today.x), sy(today.y - today.lift), 0, 5, 8, 0.3);
    drawStack(S.lighthouse, sx(today.x), sy(today.y - today.lift), 0);
    if ((t >> 4) & 1) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = "#fff2a0";
      const bx = sx(today.x) + scr.sx, by = sy(today.y - today.lift) - 13 + scr.sy, a = t * 0.03;
      for (let i = 4; i < 26; i++) ctx.fillRect(Math.round(bx + Math.cos(a) * i), Math.round(by + Math.sin(a) * i * 0.5), 1, 1);
      ctx.globalAlpha = 1;
    }
    crates.slice(0, 6).forEach((c, i) => drawStack(S.crate[c.pr], sx(today.x - 22 + (i % 2) * 6), sy(today.y - today.lift - 4 + ((i / 2) | 0) * 6), 0));

    drawSeaLifeUnder();
    drawKrakenUnder();
    for (const p of parts)
      if (p.wake) {
        ctx.globalAlpha = p.life / 34;
        px(sx(p.x), sy(p.y), p.c);
        ctx.globalAlpha = 1;
      }
    const bx = sx(boat.x), by = sy(boat.y), bob = Math.sin(t * 0.08) * 0.6;
    drawShadow(BOAT, bx, by, boat.a, 2, 3, 0.3);
    drawStack(BOAT, bx, by + bob, boat.a);
    drawSeaLifeOver();
    drawKrakenOver();
    boat.cargo.forEach((c, i) => {
      const o = -3 + i * 3;
      drawStack(S.crate[c.pr], bx - Math.sin(boat.a) * o, by + Math.cos(boat.a) * o - 3 + bob, boat.a, { lift: 0.5 });
    });
    if (state !== "title") drawCrew(bob);
    for (const p of parts) if (!p.wake) px(sx(p.x), sy(p.y), p.c);
    drawFog();
    // Storms show through the fog: you can see weather coming from far off.
    for (const s of storms) {
      const cx = sx(s.x), cy = sy(s.y);
      if (cx < -40 || cy < -40 || cx > W + 40 || cy > H + 40) continue;
      for (let y = -s.r; y <= s.r; y++)
        for (let x = -s.r; x <= s.r; x++) {
          const d = (x * x + y * y) / (s.r * s.r), n = fbm((s.x + x) * 0.08 + t * 0.004, (s.y + y) * 0.08, 7);
          if (d < 1 && n * (1.2 - d) > 0.42 + BAYER[((y + 64) & 3) * 4 + ((x + 64) & 3)] * 0.12) px(cx + x, cy + y - 14, s.bolt > 4 ? "#c7d0e6" : n > 0.62 ? "#5a6078" : "#3a3f55");
        }
      for (let i = 0; i < 10; i++) {
        const rx = cx + rand(-s.r, s.r) * 0.8, ry = cy - 6 + ((t * 3 + i * 23) % (s.r + 10));
        px(rx, ry, "#9fb3d6"); px(rx - 1, ry + 1, "#9fb3d6");
      }
      if (s.bolt > 4) {
        let x = cx + 3, y = cy - 8;
        for (let i = 0; i < 9; i++) { px(x, y, "#ffffff"); y += 2; x += i & 1 ? 1 : -1; }
      }
    }
    for (const is of all) {
      if (!is.charted || is.today) continue;
      const x = sx(is.x), y = sy(is.y - is.lift) - is.r - 6;
      if (x < -40 || x > W + 40 || y < 8 || y > H - 10) continue;
      const s = is.title.length > 16 ? is.title.slice(0, 15) + "." : is.title;
      const c = is.harbour ? is.p!.accent : is.orphan ? "#fff2a0" : "#e6eefc";
      drawTextC(s, clamp(x, textW(s) / 2 + 2, W - textW(s) / 2 - 2), y, c);
    }
    drawTextC("TODAY", sx(today.x), sy(today.y - today.lift) - 26, "#fff2a0");
    scr.sx = scr.sy = 0;
    if (state === "title") return renderTitle();
    if (flash) {
      ctx.globalAlpha = flash / 20;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    renderHud();
    if (state === "log") renderLog();
    if (state === "map") renderMap();
  }
  function compass(target: Isle, label: string, col: string) {
    const dx = target.x - boat.x, dy = target.y - boat.y, d = Math.hypot(dx, dy) || 1;
    const tx = sx(target.x), ty = sy(target.y);
    if (tx > 8 && tx < W - 8 && ty > 30 && ty < H - 30) return;
    const ux = dx / d, uy = dy / d, cx = W / 2;
    const top = 40, bottom = H - 22 - boat.cargo.length * 8, cy2 = (top + bottom) / 2;
    const k = Math.min((W / 2 - 10) / Math.abs(ux || 1e-6), (bottom - top) / 2 / Math.abs(uy || 1e-6));
    const x = cx + ux * k, y = cy2 + uy * k, a = Math.atan2(uy, ux);
    for (let i = 0; i < 5; i++)
      for (let j = -i; j <= i; j++) px(x + Math.cos(a) * (4 - i) - Math.sin(a) * j * 0.6, y + Math.sin(a) * (4 - i) + Math.cos(a) * j * 0.6, col);
    const s = label.length > 12 ? label.slice(0, 11) + "." : label;
    drawTextC(s, clamp(x - ux * 12, textW(s) / 2 + 2, W - textW(s) / 2 - 2), clamp(y - uy * 12 - 2, top, bottom - 6), col);
  }
  function renderHud() {
    band(0, 26, 0.6);
    drawText(timeAt(clock), 4, 4, clock > DAY_FRAMES * 0.85 ? ((t >> 3) & 1 ? "#ff5e8a" : "#ffffff") : "#ffffff");
    drawText(String(score).padStart(5, "0"), W - textW("00000") - 4, 4, "#fff2a0");
    // The chart counter doubles as the map button (a little scroll icon).
    ctx.fillStyle = "#c9a06a"; ctx.fillRect(4, 11, 9, 7);
    ctx.fillStyle = "#e8c890"; ctx.fillRect(5, 12, 7, 5);
    ctx.fillStyle = "#5b8dd6"; ctx.fillRect(6, 13, 2, 2);
    ctx.fillStyle = "#7cc46a"; ctx.fillRect(9, 14, 2, 2);
    drawText(`MAP ${charted}/${islands.length}`, 16, 12, "#c7e4ff");
    const cargo = `CARGO ${delivered}/${cargoTotal}`;
    drawText(cargo, W - textW(cargo) - 4, 12, "#c9d3ea");
    ctx.fillStyle = INK; ctx.fillRect(4, 20, W - 8, 2);
    ctx.fillStyle = "#fff2a0"; ctx.fillRect(4, 20, Math.round(((W - 8) * clock) / DAY_FRAMES), 2);
    boat.cargo.forEach((c, i) => {
      const y = H - 12 - i * 8, overdue = clock > dueFrame(c);
      ctx.globalAlpha = 0.6; ctx.fillStyle = INK; ctx.fillRect(0, y - 2, W, 8); ctx.globalAlpha = 1;
      px(4, y, PCOL[c.pr], 4);
      drawText(c.title.length > 22 ? c.title.slice(0, 21) + "." : c.title, 11, y, "#ffffff");
      drawText(timeAt(dueFrame(c)), W - textW("00:00") - 4, y, overdue ? "#ff9a6b" : "#8dff9a");
    });
    if (state === "sail") {
      if (boat.cargo.length) {
        let h: Isle | null = null;
        for (const x of harbours)
          if (boat.cargo.some((c) => c.p === x.p) && (!h || Math.hypot(x.x - boat.x, x.y - boat.y) < Math.hypot(h.x - boat.x, h.y - boat.y))) h = x;
        if (h) compass(h, h.title, h.p!.accent);
      } else if (crates.length) compass(today, "TODAY", "#fff2a0");
    }
    pops.forEach((p, i) => {
      if (p.t > 90 && p.t & 4) return;
      const y = 34 + i * 16;
      band(y - 2, 15, 0.5);
      drawTextC(p.head, W / 2, y, p.c);
      drawTextC(p.title.length > 40 ? p.title.slice(0, 39) + "." : p.title, W / 2, y + 7, "#ffffff");
    });
    if (state === "sail" && stateT < 240 && (t >> 5) & 1) drawTextC("HOLD THE MOUSE OR ARROWS TO SAIL", W / 2, H * 0.68, "#ffffff");
  }
  function renderTitle() {
    band(54, 70, 0.55);
    drawTextC("SAIL YOUR KNOWLEDGE GRAPH", W / 2, 60, "#c7e4ff");
    drawTextC("WAYFINDER", W / 2, 72, "#fff2a0", 3);
    drawTextC("NOTES ARE ISLANDS - LINKS ARE LANES", W / 2, 98, "#e6eefc");
    drawTextC("DELIVER TODAY'S TASKS BY THEIR DUE TIME", W / 2, 108, "#e6eefc");
    band(H - 74, 46, 0.55);
    drawTextC("OVERDUE TASKS ARE STORMS", W / 2, H - 68, "#ff9a6b");
    drawTextC("UNLINKED NOTES HIDE IN THE FOG", W / 2, H - 58, "#fff2a0");
    if ((t >> 5) & 1) drawTextC("CLICK TO SET SAIL", W / 2, H - 44, "#ffffff");
    drawTextC(`BEST ${best}   M FOR THE MAP`, W / 2, H - 20, "#c7d0e6");
  }
  // The chart: the world with the fog left on, rebuilt only when opened.
  const mini = mkCanvas(WD, HD), mctx = ctx2d(mini);
  function buildChart() {
    mctx.drawImage(world, 0, 0);
    const id = mctx.getImageData(0, 0, WD, HD), d = new Uint32Array(id.data.buffer);
    for (let y = 0; y < HD; y++)
      for (let x = 0; x < WD; x++) if (FOG[((y / 8) | 0) * FW + ((x / 8) | 0)] < 0.5) d[y * WD + x] = FOG_TEX[(y & 63) * 64 + (x & 63)];
    mctx.putImageData(id, 0, 0);
  }
  function drawChart(top: number, bottomPad: number) {
    const k = Math.min((W - 20) / WD, (H - top - bottomPad) / HD), mw = Math.round(WD * k), mh = Math.round(HD * k), mx = Math.round((W - mw) / 2), my = top;
    ctx.fillStyle = "#5a3a22"; ctx.fillRect(mx - 3, my - 3, mw + 6, mh + 6);
    ctx.fillStyle = "#c9a06a"; ctx.fillRect(mx - 2, my - 2, mw + 4, mh + 4);
    ctx.drawImage(mini, 0, 0, WD, HD, mx, my, mw, mh);
    for (const h of harbours) {
      px(mx + h.x * k - 1, my + h.y * k - 1, h.p!.accent, 3);
      if (boat.cargo.some((c) => c.p === h.p) && (t >> 3) & 1) {
        ctx.strokeStyle = "#ffffff";
        ctx.strokeRect(Math.round(mx + h.x * k) - 3.5, Math.round(my + h.y * k) - 3.5, 7, 7);
      }
    }
    px(mx + today.x * k - 1, my + today.y * k - 1, "#fff2a0", 3);
    for (const s of storms) px(mx + s.x * k - 2, my + s.y * k - 2, "#59607a", 4);
    if ((t >> 3) & 1) px(mx + boat.x * k - 1, my + boat.y * k - 1, "#ef5a24", 3);
    return { my, mh };
  }
  function renderMap() {
    ctx.globalAlpha = 0.85; ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    drawTextC("CHARTED WATERS", W / 2, 8, "#fff2a0");
    const { my, mh } = drawChart(20, 52), y = my + mh + 8, lost = islands.filter((i) => i.orphan);
    drawTextC(`${charted} OF ${islands.length} NOTES CHARTED`, W / 2, y, "#c7e4ff");
    drawTextC(`${lost.filter((i) => i.charted).length} OF ${lost.length} LOST NOTES FOUND`, W / 2, y + 10, "#fff2a0");
    if ((t >> 5) & 1) drawTextC("CLICK TO SAIL ON", W / 2, y + 24, "#ffffff");
  }
  function renderLog() {
    ctx.globalAlpha = 0.8; ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    drawTextC("SHIP'S LOG", W / 2, 34, "#fff2a0", 2);
    const { my, mh } = drawChart(54, 96), y = my + mh + 8, lost = islands.filter((i) => i.orphan), found = lost.filter((i) => i.charted).length;
    drawTextC(`${delivered} DELIVERED${late ? `  ${late} LATE` : ""}`, W / 2, y, "#8dff9a");
    drawTextC(`${charted} OF ${islands.length} NOTES CHARTED`, W / 2, y + 10, "#c7e4ff");
    drawTextC(`${found} OF ${lost.length} LOST NOTES FOUND`, W / 2, y + 20, "#fff2a0");
    drawTextC(`SCORE ${score}   BEST ${best}`, W / 2, y + 34, "#ffffff");
    if (stateT > 60 && (t >> 5) & 1) drawTextC("CLICK FOR A NEW DAY", W / 2, y + 48, "#c7d0e6");
  }

  function begin() { state = "sail"; stateT = 0; reset(); }
  function toggleMap() {
    if (state === "sail") { state = "map"; steer = null; buildChart(); }
    else if (state === "map") state = "sail";
  }

  return {
    update,
    render,
    down(x, y) {
      if (state === "title" || (state === "log" && stateT > 60)) return begin();
      if (state === "map") { state = "sail"; return; }
      if (state === "sail" && y < 22 && x < 64) return toggleMap();
      if (state === "sail") steer = { x, y };
    },
    move(x, y) { if (steer) steer = { x, y }; },
    up() { steer = null; },
    key(code, down) {
      if (down) keys.add(code);
      else keys.delete(code);
      if (!down) return /^Arrow/.test(code);
      if (code === "KeyM") { toggleMap(); return true; }
      if ((code === "Space" || code === "Enter") && (state === "title" || (state === "log" && stateT > 60))) { begin(); return true; }
      return /^(Arrow|Key[WASD]$|Space)/.test(code);
    },
    resize() { allocFog(); },
    get best() { return best; },
  };
};
