/**
 * Inbox Zero: tower defence on your board. Each project is a wave; its open
 * tasks are cards crawling down the flow toward the deadline. Pin tags beside
 * the flow to triage them before they go overdue. Priority sets a card's
 * toughness and pace; triaged cards earn focus to spend on more tags.
 */

import type { Priority } from "@cairn/shared/types/domain";
import type { GameFactory } from "../game";
import { PRIORITY_PAL } from "../pixel/kinds";
import {
  FIRE, H, INK, W, band, clamp, ctx2d, drawShadow, drawStack, drawText, drawTextC, hash2, lazy, makeModel, mkCanvas, px, rand, scr, textW,
  type Model,
} from "../pixel/kit";

const CELL = 12, CORE_GX = 15, GY = 21, TOP = 26, SHOP_Y = TOP + GY * CELL + 2;
const MAX_WAVES = 5;
const MAX_SHOP_W = 72;

// The flow: a serpentine through the centered 15-cell core, in core-relative grid cells.
const PATH_CELLS = [[1, -1], [1, 4], [13, 4], [13, 9], [1, 9], [1, 14], [13, 14], [13, 18], [7, 18], [7, 21]];
const CORE_PATH = PATH_CELLS.map(([c, r]) => ({ x: c * CELL + CELL / 2, y: TOP + r * CELL + CELL / 2 }));
const CORE_SEG = CORE_PATH.slice(1).map((b, i) => {
  const a = CORE_PATH[i];
  return { a, b, len: Math.hypot(b.x - a.x, b.y - a.y) };
});
const PATH_LEN = CORE_SEG.reduce((s, g) => s + g.len, 0);
const onPath = new Uint8Array(CORE_GX * GY);
for (const { a, b } of CORE_SEG) {
  const c0 = (Math.min(a.x, b.x) / CELL) | 0, c1 = (Math.max(a.x, b.x) / CELL) | 0;
  const r0 = ((Math.min(a.y, b.y) - TOP) / CELL) | 0, r1 = ((Math.max(a.y, b.y) - TOP) / CELL) | 0;
  for (let r = Math.max(0, r0); r <= Math.min(GY - 1, r1); r++) for (let c = c0; c <= c1; c++) onPath[r * CORE_GX + c] = 1;
}
function isOnPath(c: number, r: number): boolean {
  return c >= 0 && c < CORE_GX && r >= 0 && r < GY && onPath[r * CORE_GX + c] === 1;
}
function distToSeg(px0: number, py0: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px0 - ax) * dx + (py0 - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px0 - (ax + t * dx), py0 - (ay + t * dy));
}
function along(d: number, coreX: number): { x: number; y: number; dir: number } {
  for (const g of CORE_SEG) {
    if (d <= g.len) {
      const f = d / g.len;
      return { x: coreX + g.a.x + (g.b.x - g.a.x) * f, y: g.a.y + (g.b.y - g.a.y) * f, dir: Math.atan2(g.b.x - g.a.x, -(g.b.y - g.a.y)) };
    }
    d -= g.len;
  }
  const e = CORE_PATH[CORE_PATH.length - 1];
  return { x: coreX + e.x, y: e.y, dir: Math.PI };
}

const PRIO: Record<Priority, { hp: number; v: number; reward: number; h: string; d: string }> = {
  low: { hp: 4, v: 0.32, reward: 3, ...PRIORITY_PAL.low },
  medium: { hp: 8, v: 0.36, reward: 5, ...PRIORITY_PAL.medium },
  high: { hp: 15, v: 0.4, reward: 8, ...PRIORITY_PAL.high },
  urgent: { hp: 26, v: 0.5, reward: 12, ...PRIORITY_PAL.urgent },
};
type TagId = "quick" | "bug" | "focus" | "batch";
interface TagDef { id: TagId; name: string; c: string; l: string; cost: number; range: number; rate: number; dmg: number; slow?: number; splash?: number; blurb: string }
/** Tags are the towers. */
const TAGS: TagDef[] = [
  { id: "quick", name: "#QUICK", c: "#7cc46a", l: "#e9ff9a", cost: 10, range: 30, rate: 16, dmg: 1, blurb: "FAST" },
  { id: "bug", name: "#BUG", c: "#c45aa8", l: "#ffd2f0", cost: 15, range: 28, rate: 36, dmg: 0.6, slow: 80, blurb: "SLOWS" },
  { id: "focus", name: "#FOCUS", c: "#5b8dd6", l: "#c7e4ff", cost: 25, range: 62, rate: 70, dmg: 7, blurb: "LONG" },
  { id: "batch", name: "#BATCH", c: "#e3a23b", l: "#fff0a8", cost: 30, range: 34, rate: 64, dmg: 3, splash: 16, blurb: "SPLASH" },
];

// ── Models ───────────────────────────────────────────────────────────────────
/** A task card: a sticky note with a priority stripe and two text lines. */
export const cardModels = lazy(() =>
  Object.fromEntries(
    (Object.keys(PRIO) as Priority[]).map((k) => [
      k,
      makeModel(9, 9, k === "urgent" ? 4 : k === "high" ? 3 : 2, (x, y, z) => {
        if (z === 0) return "#b8ad8e";
        if (y <= 1) return PRIO[k].h;
        if ((y === 4 || y === 6) && x >= 1 && x <= (y === 6 ? 5 : 7)) return "#8a97b8";
        return z % 2 ? "#fffaf0" : "#efe6d0";
      }),
    ]),
  ) as Record<Priority, Model>,
);
/** A tag pinned to a post; the tag points along +y ("up" at angle 0) and turns to aim. */
function tagModel(t: TagDef, lvl: number): Model {
  const h = 3 + lvl * 2;
  return makeModel(9, 11, h, (x, y, z) => {
    const dx = Math.abs(x - 4);
    if (z < h - 2) return dx <= 1 && Math.abs(y - 6) <= 1 ? (z === 0 ? "#2a2f3a" : "#4a5068") : null;
    if (y < 1 || y > 9 || dx > Math.min(3, y)) return null;
    if (x === 4 && y === 2) return null;
    if (z === h - 1) return y === 9 || dx === Math.min(3, y) ? t.c : t.l;
    return t.c;
  });
}
export const towerModels = lazy(() => Object.fromEntries(TAGS.map((t) => [t.id, [0, 1, 2].map((l) => tagModel(t, l))])) as Record<TagId, Model[]>);

export interface BoardLayout {
  coreX: number;
  minC: number;
  maxC: number;
  shopW: number;
  shopX0: number;
}

/**
 * Centered 15-cell core plus symmetrical wing columns and shop geometry for a
 * screen `w` pixels wide.
 */
export function boardLayout(w: number): BoardLayout {
  const coreX = Math.floor((w - CORE_GX * CELL) / 2);
  const minC = -Math.floor(coreX / CELL) || 0;
  const maxC = CORE_GX - 1 + Math.floor((w - coreX - CORE_GX * CELL) / CELL);
  const shopW = Math.min(MAX_SHOP_W, Math.floor(w / TAGS.length));
  const shopX0 = Math.round((w - shopW * TAGS.length) / 2);
  return { coreX, minC, maxC, shopW, shopX0 };
}

/** True when core-relative cell `(c, r)` is off the flow and within reach. */
export function canBuildCore(c: number, r: number): boolean {
  if (r < 0 || r >= GY || isOnPath(c, r)) return false;
  if (c >= 0 && c < CORE_GX) return true;
  const x = c * CELL + CELL / 2, y = TOP + r * CELL + CELL / 2;
  const maxRange = TAGS[2].range; // #FOCUS base range (62 px)
  return CORE_SEG.some(({ a, b }) => distToSeg(x, y, a.x, a.y, b.x, b.y) <= maxRange);
}

/** Bake the Kanban backdrop and centered serpentine flow for the current `W`. */
function buildBoard(lay: BoardLayout): HTMLCanvasElement {
  const board = mkCanvas(W, H), g = ctx2d(board);
  g.fillStyle = "#151b2e";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#1a2138";
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (hash2(x, y, 5) < 0.05) g.fillRect(x, y, 1, 1);
  for (let i = 0; i < 3; i++) {
    const x0 = Math.round((i * W) / 3), x1 = Math.round(((i + 1) * W) / 3);
    g.fillStyle = i % 2 ? "#171e33" : "#141a2c";
    g.fillRect(x0, TOP, x1 - x0, GY * CELL);
  }
  g.fillStyle = "#26304d";
  for (let r = 0; r < GY; r++)
    for (let c = lay.minC; c <= lay.maxC; c++)
      if (canBuildCore(c, r)) g.fillRect(lay.coreX + c * CELL + 6, TOP + r * CELL + 6, 1, 1);
  for (const { a, b } of CORE_SEG) {
    const ax = a.x + lay.coreX, bx = b.x + lay.coreX;
    const x0 = Math.min(ax, bx) - 5, y0 = Math.min(a.y, b.y) - 5, w = Math.abs(bx - ax) + 10, h = Math.abs(b.y - a.y) + 10;
    g.fillStyle = "#0b1020"; g.fillRect(x0 - 1, y0 - 1, w + 2, h + 3);
    g.fillStyle = "#2a3350"; g.fillRect(x0, y0, w, h);
    g.fillStyle = "#35406a"; g.fillRect(x0, y0, w, 1);
  }
  g.fillStyle = "#3d4a78";
  for (let d = 6; d < PATH_LEN; d += 12) {
    const p = along(d, lay.coreX), c = Math.cos(p.dir), s = Math.sin(p.dir);
    for (const [lx, ly] of [[0, -1], [-1, 0], [1, 0], [-2, 1], [2, 1]]) g.fillRect(Math.round(p.x + lx * c - ly * s), Math.round(p.y + lx * s + ly * c), 1, 1);
  }
  // The deadline at the bottom of the flow.
  g.fillStyle = "#3a1424";
  g.fillRect(0, TOP + GY * CELL - 2, W, 2);
  g.fillStyle = "#ff3d6e";
  for (let x = 0; x < W; x += 4) g.fillRect(x, TOP + GY * CELL - 2, 2, 1);
  return board;
}

interface Card { title: string; pr: Priority; d: number; hp: number; max: number; slow: number; flash: number; x: number; y: number; dir: number; gone?: boolean }
interface Tower { id: TagId; c: number; r: number; x: number; y: number; lvl: number; a: number; cd: number; kick: number }
interface Shot { beam?: boolean; x: number; y: number; tx?: number; ty?: number; target?: Card; dmg?: number; T?: TagDef; v?: number; life: number; c: string }

export const createInboxZero: GameFactory = ({ data, best: best0 }) => {
  const ctx = scr.ctx, CARD = cardModels(), TOWER = towerModels();
  let lay = boardLayout(W), board = buildBoard(lay);
  // Waves: projects with open tasks, smallest first so the day warms up.
  const WAVES = data.projects
    .filter((p) => p.tasks.length)
    .slice(0, MAX_WAVES)
    .sort((a, b) => a.tasks.length - b.tasks.length)
    .map((p) => ({ name: p.name, accent: p.accent, tasks: p.tasks.map((t) => ({ title: t.title, pr: t.priority })) }));

  let state: "title" | "intro" | "wave" | "over" | "win" = "title", t = 0, stateT = 0;
  let wave = 0, queue: { title: string; pr: Priority }[] = [], spawnT = 0, cards: Card[] = [], towers: Tower[] = [], shots: Shot[] = [];
  let parts: { x: number; y: number; vx: number; vy: number; g: number; life: number; c: string }[] = [];
  let pops: { s: string; title: string; c: string; x: number; y: number; t: number }[] = [];
  let rings: { x: number; y: number; r: number; c: string }[] = [];
  let hearts = 5, focus = 40, triaged = 0, leaked = 0, score = 0, best = best0, shake = 0;
  let picked = 0, cursor: { x: number; y: number } | null = null, toast: { s: string; t: number } | null = null;

  function reset() {
    wave = 0; cards = []; towers = []; shots = []; parts = []; pops = []; rings = [];
    hearts = 5; focus = 40; triaged = 0; leaked = 0; score = 0; picked = 0;
    startWave();
  }
  function startWave() {
    queue = WAVES[wave].tasks.map((x) => ({ ...x }));
    // Urgent work tends to arrive late in the day.
    queue.sort((a, b) => PRIO[a.pr].hp - PRIO[b.pr].hp + (Math.random() - 0.5) * 6);
    state = "intro"; stateT = 0; spawnT = 0;
  }
  const tagAt = (c: number, r: number) => towers.find((tw) => tw.c === c && tw.r === r);
  const say = (s: string) => { toast = { s, t: 0 }; };
  const ring = (x: number, y: number, c: string) => rings.push({ x, y, r: 2, c });
  const addScore = (n: number) => { score += n; if (score > best) best = score; };

  function tapBoard(x: number, y: number) {
    if (y >= SHOP_Y) {
      const i = Math.floor((x - lay.shopX0) / lay.shopW);
      if (x >= lay.shopX0 && i >= 0 && i < TAGS.length) picked = i;
      return;
    }
    const c = Math.floor((x - lay.coreX) / CELL), r = Math.floor((y - TOP) / CELL);
    if (c < lay.minC || c > lay.maxC || r < 0 || r >= GY) return;
    const tw = tagAt(c, r);
    if (tw) {
      const cost = Math.round(TAGS.find((x) => x.id === tw.id)!.cost * (tw.lvl + 1) * 0.8);
      if (tw.lvl >= 2) return say("MAXED");
      if (focus < cost) return say(`NEED ${cost} FOCUS`);
      focus -= cost; tw.lvl++;
      ring(tw.x, tw.y, "#fff2a0");
      return say("UPGRADED");
    }
    if (isOnPath(c, r)) return say("THAT'S THE FLOW");
    if (!canBuildCore(c, r)) return say("TOO FAR FROM FLOW");
    const tag = TAGS[picked];
    if (focus < tag.cost) return say(`NEED ${tag.cost} FOCUS`);
    focus -= tag.cost;
    const tx = lay.coreX + c * CELL + CELL / 2, ty = TOP + r * CELL + CELL / 2;
    towers.push({ id: tag.id, c, r, x: tx, y: ty + 2, lvl: 0, a: Math.PI, cd: 0, kick: 0 });
    ring(tx, ty, tag.c);
  }

  function update() {
    t++; stateT++;
    for (const p of parts) { p.vy += p.g; p.x += p.vx; p.y += p.vy; p.life--; }
    parts = parts.filter((p) => p.life > 0);
    for (const r of rings) r.r += 0.8;
    rings = rings.filter((r) => r.r < 14);
    for (const p of pops) p.t++;
    pops = pops.filter((p) => p.t < 60);
    if (toast && ++toast.t > 70) toast = null;
    if (shake > 0) shake -= 0.4;
    if (state === "title") return titleTick();
    if (state === "intro" && stateT > 120) { state = "wave"; stateT = 0; }
    if (state !== "wave" && state !== "intro") return;

    if (state === "wave" && queue.length && --spawnT <= 0) {
      const q = queue.shift()!, P = PRIO[q.pr], hp = P.hp * (1 + wave * 0.15);
      const p0 = along(0, lay.coreX);
      cards.push({ ...q, d: 0, hp, max: hp, slow: 0, flash: 0, x: p0.x, y: p0.y, dir: Math.PI });
      spawnT = 70 - wave * 6;
    }
    for (const c of cards) {
      c.d += PRIO[c.pr].v * (c.slow > 0 ? 0.45 : 1);
      if (c.slow > 0) c.slow--;
      if (c.flash > 0) c.flash--;
      const p = along(c.d, lay.coreX);
      c.x = p.x; c.y = p.y; c.dir = p.dir;
      if (c.d >= PATH_LEN) {
        c.gone = true; hearts--; leaked++; shake = 4;
        pops.push({ s: "OVERDUE", title: c.title, c: "#ff5e8a", x: c.x, y: c.y - 10, t: 0 });
        if (hearts <= 0) { state = "over"; stateT = 0; }
      }
    }
    // Tags pick the card furthest down the flow in range, turn to it, fire.
    for (const tw of towers) {
      const T = TAGS.find((x) => x.id === tw.id)!, range = T.range * (1 + tw.lvl * 0.15);
      if (tw.kick > 0) tw.kick--;
      let target: Card | null = null;
      for (const c of cards) if (!c.gone && Math.hypot(c.x - tw.x, c.y - tw.y) <= range && (!target || c.d > target.d)) target = c;
      if (!target) continue;
      let da = Math.atan2(target.x - tw.x, -(target.y - tw.y)) - tw.a;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      tw.a += clamp(da, -0.25, 0.25);
      if (--tw.cd > 0 || Math.abs(da) > 0.4) continue;
      tw.cd = T.rate * (1 - tw.lvl * 0.15);
      tw.kick = 4;
      const dmg = T.dmg * (1 + tw.lvl * 0.6);
      if (T.id === "focus") {
        hit(target, dmg);
        shots.push({ beam: true, x: tw.x, y: tw.y - 6, tx: target.x, ty: target.y, life: 6, c: T.l });
      } else shots.push({ x: tw.x + Math.sin(tw.a) * 5, y: tw.y - 5 - Math.cos(tw.a) * 5, target, dmg, T, v: T.id === "batch" ? 1.8 : 3, life: 90, c: T.l });
    }
    for (const s of shots) {
      s.life--;
      if (s.beam || !s.target || !s.T) continue;
      const tg = s.target, T = s.T;
      if (tg.gone && !T.splash) { s.life = 0; continue; }
      const dx = tg.x - s.x, dy = tg.y - s.y, d = Math.hypot(dx, dy), v = s.v ?? 3;
      if (d < v + 1) {
        s.life = 0;
        if (T.splash) {
          ring(tg.x, tg.y, "#ffb347");
          for (let i = 0; i < 10; i++) parts.push({ x: tg.x, y: tg.y, vx: rand(-1.2, 1.2), vy: rand(-1.2, 1.2), g: 0, life: 14, c: FIRE[1 + (i % 3)] });
          for (const c of cards) if (!c.gone && Math.hypot(c.x - tg.x, c.y - tg.y) <= T.splash) hit(c, s.dmg ?? 0);
        } else {
          hit(tg, s.dmg ?? 0);
          if (T.slow) {
            tg.slow = T.slow;
            for (let i = 0; i < 4; i++) parts.push({ x: tg.x, y: tg.y, vx: rand(-0.6, 0.6), vy: rand(-0.6, 0.3), g: 0.02, life: 16, c: "#ffd2f0" });
          }
        }
      } else { s.x += (dx / d) * v; s.y += (dy / d) * v; }
    }
    shots = shots.filter((s) => s.life > 0);
    cards = cards.filter((c) => !c.gone);
    if (state === "wave" && !queue.length && !cards.length) {
      focus += 15;
      if (++wave >= WAVES.length) { state = "win"; stateT = 0; }
      else startWave();
    }
  }
  function hit(c: Card, dmg: number) {
    if (c.gone) return;
    c.hp -= dmg;
    c.flash = 4;
    if (c.hp > 0) return;
    c.gone = true;
    triaged++;
    const P = PRIO[c.pr];
    focus += P.reward;
    addScore(P.reward * 10);
    pops.push({ s: "DONE", title: c.title, c: "#8dff9a", x: c.x, y: c.y - 10, t: 0 });
    for (let i = 0; i < 12; i++) parts.push({ x: c.x, y: c.y - 3, vx: rand(-1, 1), vy: rand(-1.6, -0.2), g: 0.08, life: 20 + (i % 8), c: ["#fffaf0", "#efe6d0", P.h][i % 3] });
    ring(c.x, c.y - 2, "#8dff9a");
  }
  /** A gentle parade of cards down the flow behind the title. */
  function titleTick() {
    if (t % 60 === 0) {
      const pr = (["low", "medium", "high", "urgent"] as const)[((t / 60) | 0) % 4];
      const p0 = along(0, lay.coreX);
      cards.push({ title: "", pr, d: 0, hp: 1, max: 1, slow: 0, flash: 0, x: p0.x, y: p0.y, dir: 0 });
    }
    for (const c of cards) {
      c.d += 0.6;
      const p = along(c.d, lay.coreX);
      c.x = p.x; c.y = p.y; c.dir = p.dir;
    }
    cards = cards.filter((c) => c.d < PATH_LEN);
  }

  function render() {
    scr.sx = shake > 0 ? Math.round(rand(-shake, shake)) : 0;
    scr.sy = 0;
    const SX = scr.sx;
    ctx.drawImage(board, SX, 0);
    ["TO DO", "DOING", "REVIEW"].forEach((s, i) => drawTextC(s, Math.round(((i + 0.5) * W) / 3), TOP + 2, "#3a4670", 1, null));

    if (cursor && state !== "title" && cursor.y < SHOP_Y) {
      const c = Math.floor((cursor.x - lay.coreX) / CELL), r = Math.floor((cursor.y - TOP) / CELL);
      if (c >= lay.minC && c <= lay.maxC && r >= 0 && r < GY && !tagAt(c, r) && canBuildCore(c, r)) {
        const ok = focus >= TAGS[picked].cost;
        const cx = lay.coreX + c * CELL, cy = TOP + r * CELL;
        ctx.strokeStyle = ok ? "#8dff9a" : "#ff5e8a";
        ctx.strokeRect(cx + 0.5, cy + 0.5, CELL - 1, CELL - 1);
        if (ok) {
          ctx.globalAlpha = 0.12;
          ctx.fillStyle = TAGS[picked].c;
          ctx.beginPath();
          ctx.arc(cx + 6, cy + 6, TAGS[picked].range, 0, 7);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    }
    for (const c of cards) drawShadow(CARD[c.pr], c.x, c.y, c.dir + Math.sin(t * 0.2 + c.d) * 0.08, 2, 3, 0.35);
    for (const tw of towers) drawShadow(TOWER[tw.id][tw.lvl], tw.x, tw.y, tw.a, 3, 4, 0.35);
    // Back to front, so nearer things overlap farther ones.
    const things: ({ y: number; c: Card } | { y: number; tw: Tower })[] = [...cards.map((c) => ({ y: c.y, c })), ...towers.map((tw) => ({ y: tw.y, tw }))].sort((a, b) => a.y - b.y);
    for (const th of things) {
      if ("c" in th) {
        const c = th.c, bob = Math.abs(Math.sin(t * 0.2 + c.d)) * 1.2;
        drawStack(CARD[c.pr], c.x, c.y - bob, c.dir + Math.sin(t * 0.2 + c.d) * 0.08, { flash: c.flash > 0 });
        if (c.slow > 0 && (t >> 2) & 1) px(c.x - 5, c.y - 8 - bob, "#ffd2f0");
        if (c.hp < c.max) {
          ctx.fillStyle = INK; ctx.fillRect(Math.round(c.x) - 5 + SX, Math.round(c.y) + 6, 10, 2);
          ctx.fillStyle = PRIO[c.pr].h; ctx.fillRect(Math.round(c.x) - 5 + SX, Math.round(c.y) + 6, Math.max(1, Math.round((10 * c.hp) / c.max)), 1);
        }
      } else {
        const tw = th.tw, k = tw.kick;
        drawStack(TOWER[tw.id][tw.lvl], tw.x - Math.sin(tw.a) * k * 0.4, tw.y + Math.cos(tw.a) * k * 0.4, tw.a);
        for (let i = 0; i < tw.lvl; i++) px(tw.x - 4 + i * 3, tw.y + 5, "#fff2a0");
      }
    }
    for (const s of shots) {
      if (s.beam) {
        ctx.globalAlpha = s.life / 6;
        ctx.strokeStyle = s.c;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s.x + 0.5, s.y + 0.5);
        ctx.lineTo((s.tx ?? s.x) + 0.5, (s.ty ?? s.y) + 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (s.T?.splash) {
        px(s.x, s.y + 3, INK);
        px(s.x - 1, s.y - 1, s.c, 3);
      } else px(s.x, s.y, s.c, s.T?.slow ? 2 : 1);
    }
    for (const p of parts) px(p.x, p.y, p.c);
    for (const r of rings) {
      const n = Math.max(8, r.r * 5);
      ctx.globalAlpha = 1 - r.r / 14;
      for (let i = 0; i < n; i++) px(r.x + Math.cos((i / n) * 6.283) * r.r, r.y + Math.sin((i / n) * 6.283) * r.r * 0.8, r.c);
      ctx.globalAlpha = 1;
    }
    for (const c of cards)
      if (c.title && (c.pr === "urgent" || c.pr === "high")) {
        const s = c.title.length > 14 ? c.title.slice(0, 13) + "." : c.title;
        drawTextC(s, clamp(c.x, textW(s) / 2 + 2, W - textW(s) / 2 - 2), c.y - 16, c.pr === "urgent" ? "#ffb4a8" : "#ffe7a8");
      }
    for (const p of pops) {
      if (p.t > 46 && p.t & 2) continue;
      const s = `${p.s}: ${p.title}`, sc = s.length > 30 ? s.slice(0, 29) + "." : s;
      drawTextC(sc, clamp(p.x, textW(sc) / 2 + 2, W - textW(sc) / 2 - 2), Math.round(p.y - p.t * 0.3), p.c);
    }
    scr.sx = 0;
    if (state === "title") return renderTitle();
    renderHud();
  }
  function heart(x: number, y: number, c: string) {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, 2, 1); ctx.fillRect(x + 3, y, 2, 1); ctx.fillRect(x, y + 1, 5, 1); ctx.fillRect(x + 1, y + 2, 3, 1); ctx.fillRect(x + 2, y + 3, 1, 1);
  }
  function renderHud() {
    band(0, TOP, 0.7);
    for (let i = 0; i < 5; i++) heart(4 + i * 7, 4, i < hearts ? "#ff5e8a" : "#3a3f55");
    drawText(`FOCUS ${focus}`, W - textW(`FOCUS ${focus}`) - 4, 4, "#fff2a0");
    const wv = WAVES[Math.min(wave, WAVES.length - 1)];
    drawText(`${Math.min(wave + 1, WAVES.length)}/${WAVES.length}`, 4, 14, "#c9d3ea");
    const left = queue.length + cards.length, leftS = `${left} LEFT`;
    const room = Math.floor((W - textW(leftS) - 30) / 4);
    drawText(wv.name.length > room ? wv.name.slice(0, room - 1) + "." : wv.name, 22, 14, wv.accent);
    drawText(leftS, W - textW(leftS) - 4, 14, "#7f8aa6");
    const sw = lay.shopW, sx0 = lay.shopX0, pad = Math.max(0, Math.floor((sw - 41) / 2));
    ctx.fillStyle = "#0b1020";
    ctx.fillRect(0, SHOP_Y - 2, W, H - SHOP_Y + 2);
    TAGS.forEach((tg, i) => {
      const x = sx0 + i * sw, sel = i === picked, can = focus >= tg.cost;
      ctx.fillStyle = sel ? tg.c : "#1b2236"; ctx.fillRect(x + 1, SHOP_Y, sw - 2, H - SHOP_Y - 2);
      ctx.fillStyle = sel ? "#0b1020" : "#141a2c"; ctx.fillRect(x + 2, SHOP_Y + 1, sw - 4, H - SHOP_Y - 4);
      drawStack(TOWER[tg.id][0], x + pad + 9, SHOP_Y + 18, -0.5 + Math.sin(t * 0.05 + i) * 0.3);
      drawText(tg.name.slice(1), x + pad + 17, SHOP_Y + 4, can ? tg.l : "#59607a", 1, null);
      drawText(tg.blurb, x + pad + 17, SHOP_Y + 12, "#7f8aa6", 1, null);
      drawText(String(tg.cost), x + pad + 17, SHOP_Y + 20, can ? "#fff2a0" : "#59607a", 1, null);
    });
    const cy = TOP + 90;
    if (state === "intro") {
      band(cy - 6, 50, 0.65);
      drawTextC(`PROJECT ${wave + 1} OF ${WAVES.length}`, W / 2, cy, "#c9d3ea");
      const wv2 = WAVES[wave], big = textW(wv2.name, 2) < W - 8;
      drawTextC(wv2.name, W / 2, cy + 11, wv2.accent, big ? 2 : 1);
      drawTextC(`${wv2.tasks.length} TASKS INCOMING`, W / 2, cy + 30, "#ffffff");
    }
    if (toast) drawTextC(toast.s, W / 2, SHOP_Y - 10, "#ffffff");
    if (state === "over" || state === "win") {
      band(cy - 10, 74, 0.75);
      if (state === "win") {
        drawTextC("INBOX ZERO!", W / 2, cy - 2, "#8dff9a", 2);
        drawTextC("EVERY PROJECT TRIAGED", W / 2, cy + 18, "#ffffff");
      } else {
        drawTextC("SNOWED UNDER", W / 2, cy - 2, "#ff5e8a", 2);
        drawTextC(`${leaked} TASKS WENT OVERDUE`, W / 2, cy + 18, "#ffffff");
      }
      drawTextC(`${triaged} TRIAGED  SCORE ${score}`, W / 2, cy + 30, "#fff2a0");
      drawTextC(`BEST ${best}`, W / 2, cy + 40, "#c7d0e6");
      if (stateT > 60 && (t >> 5) & 1) drawTextC("CLICK TO PLAY AGAIN", W / 2, cy + 54, "#c7d0e6");
    }
  }
  function renderTitle() {
    band(60, 64, 0.75);
    drawTextC("TOWER DEFENCE FOR YOUR BOARD", W / 2, 66, "#c9d3ea");
    drawTextC("INBOX", W / 2, 78, "#ffffff", 3);
    drawTextC("ZERO", W / 2, 98, "#8dff9a", 3);
    band(150, 92, 0.75);
    TAGS.forEach((tg, i) => {
      const x = Math.round(W / 2 + (i - 1.5) * 43);
      drawStack(TOWER[tg.id][1], x, 176, Math.sin(t * 0.03 + i) * 0.8);
      drawTextC(tg.name, x, 188, tg.l);
    });
    drawTextC("PIN TAGS BESIDE THE FLOW", W / 2, 202, "#ffffff");
    drawTextC("TRIAGE TASKS BEFORE THE DEADLINE", W / 2, 212, "#ffffff");
    drawTextC("CLICK A TAG TO UPGRADE IT", W / 2, 222, "#7f8aa6");
    if ((t >> 5) & 1) drawTextC("CLICK TO START", W / 2, 268, "#ffffff", 2);
    drawTextC(`BEST ${best}   KEYS 1-4 PICK A TAG`, W / 2, 290, "#c7d0e6");
  }

  return {
    update,
    render,
    down(x, y) {
      if (state === "title" || ((state === "over" || state === "win") && stateT > 60)) {
        cards = [];
        return reset();
      }
      if (state === "over" || state === "win") return;
      tapBoard(x, y);
    },
    move(x, y) { cursor = { x, y }; },
    up() {},
    key(code, down) {
      if (!down) return false;
      const n = /^Digit([1-4])$/.exec(code);
      if (n) { picked = Number(n[1]) - 1; return true; }
      if ((code === "Space" || code === "Enter") && (state === "title" || ((state === "over" || state === "win") && stateT > 60))) {
        cards = [];
        reset();
        return true;
      }
      return false;
    },
    resize(prevW) {
      const oldCoreX = boardLayout(prevW).coreX;
      lay = boardLayout(W);
      board = buildBoard(lay);
      const dx = lay.coreX - oldCoreX;
      if (!dx) return;
      for (const c of cards) c.x += dx;
      for (const tw of towers) tw.x = lay.coreX + tw.c * CELL + CELL / 2;
      for (const s of shots) {
        s.x += dx;
        if (s.tx !== undefined) s.tx += dx;
      }
      for (const p of parts) p.x += dx;
      for (const p of pops) p.x += dx;
      for (const r of rings) r.x += dx;
      if (cursor) cursor.x += dx;
    },
    get best() { return best; },
  };
};
