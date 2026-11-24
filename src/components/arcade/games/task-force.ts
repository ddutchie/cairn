/**
 * Task Force: a sprite-stacking shooter over endless islands. Each project is
 * a level; its open tasks are the enemies (priority sets toughness and
 * pattern), its notes drop as spread-shot pickups, and a project review boss
 * waits at the end. Tasks that slip past are carried over to the back of the
 * queue.
 */

import type { Priority } from "@cairn/shared/types/domain";
import type { ArcadeProject } from "../data";
import type { GameFactory } from "../game";
import { PRIORITY_PAL } from "../pixel/kinds";
import {
  FIRE, H, INK, M, Terrain, W, angDiff, blit, clamp, clouds, drawShadow, drawStack, drawText, drawTextC, lazy, makeModel, px, rand,
  scr, textW, type Cloud, type Model,
} from "../pixel/kit";

// ── Models ───────────────────────────────────────────────────────────────────
const JP = { h: "#b8c2d6", d: "#6b7488", k: "#343b4c", a: "#2ec4b6", c: "#a8f4ff", n: "#22262f" };
/** The player jet, nose at y = 0. */
export const playerModel = lazy(() =>
  makeModel(15, 19, 6, (x, y, z) => {
    const dx = Math.abs(x - 7);
    if (z === 4 && dx === 0 && y >= 4 && y <= 7) return JP.c;
    if (z === 3 && dx === 0 && y >= 4 && y <= 8) return JP.c;
    if (y <= 2) return dx === 0 && z >= 1 && z <= 2 ? JP.a : null;
    if (y >= 17 && dx <= 1 && z >= 1 && z <= 2) return JP.n;
    if (y >= 3 && y <= 16 && dx <= 1 && z >= 1 && z <= 3) return z === 3 && dx === 0 ? JP.d : JP.h;
    if (y >= 6 && y <= 9 && dx === 2 && z >= 1 && z <= 2) return JP.k;
    if (z === 2 && y >= 7 && y <= 13 && dx <= 2 + (y - 7) * 0.9) return dx >= 6 ? JP.a : y === 13 ? JP.d : JP.h;
    if (z === 2 && y >= 14 && y <= 17 && dx <= 3 + (y - 14) * 0.6) return dx >= 4 ? JP.a : JP.h;
    if (dx === 2 && y >= 13 && y <= 17 && z >= 3 && z <= Math.min(5, 3 + (y - 13))) return z === 5 ? JP.a : JP.d;
    return null;
  }),
);

const EYE = "#ff3d6e", GUN = "#2a2f3a";
const enemyModels = lazy((): Record<Priority, Model> => ({
  low: makeModel(9, 9, 3, (x, y, z) => {
    const p = PRIORITY_PAL.low, dx = Math.abs(x - 4), dy = Math.abs(y - 4), m = dx + dy;
    if (z === 0 && m <= 3) return p.d;
    if (z === 1 && m <= 4) return (dx === 0 || dy === 0) && m >= 3 ? p.a : p.h;
    if (z === 2 && m <= 1) return y === 3 && x === 4 ? EYE : p.d;
    return null;
  }),
  medium: makeModel(13, 12, 4, (x, y, z) => {
    const p = PRIORITY_PAL.medium, dx = Math.abs(x - 6), half = y * 0.55;
    if (z === 0 && y >= 2 && dx <= half - 1) return p.d;
    if (z === 1 && dx <= half) return y >= 10 ? p.d : dx >= half - 0.8 && y > 5 ? p.a : p.h;
    if (z === 2 && dx <= 1 && y >= 2 && y <= 10) return p.h;
    if (z === 3 && dx === 0 && y >= 4 && y <= 6) return y === 4 ? EYE : p.d;
    return null;
  }),
  high: makeModel(17, 15, 5, (x, y, z) => {
    const p = PRIORITY_PAL.high, dx = Math.abs(x - 8);
    if (z === 4 && dx === 0 && y >= 4 && y <= 7) return y === 4 ? EYE : GUN;
    if (z === 3 && dx <= 1 && y >= 6 && y <= 8) return p.d;
    if (z <= 1 && dx >= 5 && dx <= 7 && y >= 3 && y <= 13) return y === 3 ? p.a : z === 0 ? p.d : p.h;
    if (z === 2 && dx === 6 && y >= 4 && y <= 12) return p.h;
    if (z === 1 && y >= 7 && y <= 10 && dx <= 7) return y === 10 ? p.d : p.h;
    if (dx <= 2 && y >= 1 && y <= 13 && z <= 2) {
      if (y <= 2) return dx <= 1 ? p.a : null;
      return z === 0 ? p.d : p.h;
    }
    return null;
  }),
  urgent: makeModel(23, 20, 7, (x, y, z) => {
    const p = PRIORITY_PAL.urgent, ex = (x - 11) / 11, ey = (y - 10) / 9.5, rr = ex * ex + ey * ey;
    const sc = [1, 0.95, 0.85, 0.55, 0.38, 0.26, 0.15][z];
    if (rr <= sc * sc) {
      if (z <= 2) {
        if (z === 2 && Math.abs(x - 11) % 4 === 0 && y > 4) return p.a;
        return z === 0 ? p.d : p.h;
      }
      if (z === 3) return (x + y) % 3 === 0 ? p.d : p.h;
      if (z === 4) return p.d;
      return z === 6 ? EYE : p.a;
    }
    const ax = Math.abs(x - 11);
    if (z <= 1 && y <= 6 && ax >= 6 && ax <= 8) return z === 0 ? p.d : p.a;
    return null;
  }),
}));
const bossModel = lazy(() =>
  makeModel(41, 33, 9, (x, y, z) => {
    const ex = (x - 20) / 20, ey = (y - 16) / 16, rr = ex * ex + ey * ey;
    const sc = [1, 0.97, 0.9, 0.75, 0.6, 0.45, 0.32, 0.2, 0.1][z];
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3 + Math.PI / 6, tx = 20 + Math.cos(a) * 15, ty = 16 + Math.sin(a) * 12;
      if ((z === 3 || z === 4) && (x - tx) ** 2 + (y - ty) ** 2 <= 2.3) return z === 4 ? GUN : "#4a5068";
    }
    if (rr > sc * sc) return null;
    if (z === 0) return "#3a2340";
    if (z <= 2) {
      const a = Math.atan2(y - 16, x - 20);
      return ((((a / Math.PI) * 8) | 0) + 16) % 2 ? "#8f3a7a" : "#c45aa8";
    }
    if (z <= 5) return rr < 0.2 ? "#9aa3bd" : "#e0e4f0";
    return z === 8 ? "#ffd2e0" : EYE;
  }),
);
export const noteModel = lazy(() =>
  makeModel(9, 11, 3, (x, y, z) => {
    if (x >= 7 && y <= 1) return z === 0 ? "#cbbd96" : null;
    if (z === 0) return "#bfae86";
    if (z === 1) return "#e9dfc3";
    return (y === 3 || y === 5 || y === 7) && x >= 1 && x <= 6 ? "#8a97b8" : "#fffaf0";
  }),
);

// ── Rules ────────────────────────────────────────────────────────────────────
const SCROLL = 0.55;
const ECFG: Record<Priority, { hp: number; r: number; score: number; gap: number; sz: number }> = {
  low: { hp: 1, r: 5, score: 10, gap: 34, sz: 1 },
  medium: { hp: 2, r: 6, score: 25, gap: 50, sz: 1.4 },
  high: { hp: 5, r: 8, score: 60, gap: 80, sz: 2 },
  urgent: { hp: 12, r: 11, score: 150, gap: 130, sz: 3 },
};
const PRI_W: Record<Priority, number> = { low: 0, medium: 1, high: 2, urgent: 3 };

interface QTask { title: string; pr: Priority; k: number }
interface Enemy {
  task: QTask; pr: Priority; m: Model; x: number; y: number; x0: number; hp: number; r: number; t: number; ang: number;
  flash: number; ft: number; ph: number; mode: number; mt: number; ty: number;
}
interface Boss { x: number; y: number; hp: number; max: number; t: number; ang: number; flash: number; r: number; dying: number }
interface Bullet { x: number; y: number; vx: number; vy: number; dead?: boolean }
/** k: 0 fire, 1 smoke, 2 debris, 3 note sparkle. */
interface Part { x: number; y: number; vx: number; vy: number; l: number; m: number; s: number; k: number }
interface Pickup { x: number; y: number; ang: number; title: string; got?: boolean }
interface FloatText { s: string; x: number; y: number; c: string; l: number; m: number }

/** Levels: projects with something to shoot, busiest first (at most six). */
function levels(projects: ArcadeProject[]): ArcadeProject[] {
  const withTasks = projects.filter((p) => p.tasks.length >= 2);
  return (withTasks.length ? withTasks : projects).slice(0, 6);
}

export const createTaskForce: GameFactory = ({ data, best: best0 }) => {
  const ctx = scr.ctx, PLAYER = playerModel(), MODELS = enemyModels(), BOSS = bossModel(), NOTE = noteModel();
  const PROJECTS = levels(data.projects);
  const terrain = new Terrain("tropic", 3);
  let hitstop = 0, hurt = 0, muzzle = 0, best = best0;
  let state: "title" | "intro" | "play" | "boss" | "clear" | "over" | "win" = "title";
  let stateT = 0, t = 0, camR = 0, score = 0, lives = 3, levelIdx = 0, loop = 0, shake = 0;
  let proj = PROJECTS[0];
  const player = { x: W / 2, y: 260, tx: W / 2, ty: 260, px: W / 2, ang: 0, inv: 0, fire: 0, spread: 0, dead: false };
  let enemies: Enemy[] = [], pbul: Bullet[] = [], ebul: Bullet[] = [], parts: Part[] = [];
  let rings: { x: number; y: number; r: number; max: number }[] = [], texts: FloatText[] = [], pickups: Pickup[] = [];
  let trail: { x: number; y: number; l: number }[] = [];
  let queue: QTask[] = [], noteQ: string[] = [], spawnT = 0, noteT = 0, boss: Boss | null = null, done = 0, total = 0;
  const keys = new Set<string>();
  let drag = false;
  const cloudSet: { spr: Cloud; x: number; y: number; hi: boolean }[] = [];
  for (let i = 0; i < 7; i++) cloudSet.push({ spr: clouds()[i % 10], x: rand(-20, W), y: rand(-40, H), hi: i >= 5 });

  const aimAt = (x: number, y: number) => Math.atan2(player.x - x, -(player.y - y));
  const bump = (s: number) => { score += s; if (score > best) best = score; };

  function startGame() { score = 0; lives = 3; levelIdx = 0; loop = 0; startLevel(); }
  function startLevel() {
    proj = PROJECTS[levelIdx];
    terrain.set(proj.biome, levelIdx * 1013 + loop * 77 + 3);
    camR = 0;
    queue = proj.tasks.map((x) => ({ title: x.title, pr: x.priority, k: PRI_W[x.priority] + Math.random() * 2.2 })).sort((a, b) => a.k - b.k);
    total = queue.length; done = 0; noteQ = proj.notes.map((n) => n.title);
    enemies = []; pbul = []; ebul = []; pickups = []; boss = null; texts = [];
    Object.assign(player, { x: W / 2, y: 260, tx: W / 2, ty: 260, inv: 90, dead: false, spread: 0 });
    spawnT = 30; noteT = 360; state = "intro"; stateT = 150;
  }
  const addText = (s: string, x: number, y: number, c: string, life = 70) => texts.push({ s, x, y, c, l: life, m: life });

  function explode(x: number, y: number, sz: number) {
    for (let i = 0; i < 8 + sz * 8; i++) {
      const a = Math.random() * 6.283, sp = Math.random() * (0.6 + sz * 0.55), l = (14 + Math.random() * 16 * (0.6 + sz * 0.3)) | 0;
      parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, l, m: l, s: Math.random() < 0.3 ? 2 : 1, k: 0 });
    }
    for (let i = 0; i < sz * 4; i++) {
      const l = 40 + ((Math.random() * 30) | 0);
      parts.push({ x: x + rand(-4, 4), y: y + rand(-4, 4), vx: rand(-0.3, 0.3), vy: rand(-0.3, 0.3), l, m: l, s: 2 + ((Math.random() * 2) | 0), k: 1 });
    }
    for (let i = 0; i < sz * 3; i++) {
      const a = Math.random() * 6.283, sp = 1 + Math.random() * 2;
      parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, l: 30, m: 30, s: 1, k: 2 });
    }
    rings.push({ x, y, r: 2, max: 6 + sz * 6 });
    shake = Math.max(shake, sz * 2.2);
  }
  const sparks = (x: number, y: number) => { for (let i = 0; i < 3; i++) parts.push({ x, y, vx: rand(-1, 1), vy: rand(-1.5, 0), l: 8, m: 8, s: 1, k: 0 }); };
  const shoot = (x: number, y: number, a: number, sp: number) => ebul.push({ x, y, vx: Math.sin(a) * sp, vy: -Math.cos(a) * sp });
  const aimShot = (e: { x: number; y: number }, sp: number) => shoot(e.x, e.y, aimAt(e.x, e.y), sp * (1 + loop * 0.15));
  function fan(e: { x: number; y: number }, n: number, arc: number, sp: number) {
    const b = aimAt(e.x, e.y);
    for (let i = 0; i < n; i++) shoot(e.x, e.y, b + (i / (n - 1) - 0.5) * arc, sp * (1 + loop * 0.15));
  }
  function ringShot(e: { x: number; y: number }, n: number, sp: number) {
    const o = Math.random();
    for (let i = 0; i < n; i++) shoot(e.x, e.y, ((i + o) / n) * 6.283, sp);
  }
  function spawn(task: QTask) {
    const c = ECFG[task.pr], x = rand(24, W - 24);
    enemies.push({
      task, pr: task.pr, m: MODELS[task.pr], x, y: -16, x0: x, hp: Math.ceil(c.hp * (1 + loop * 0.5)), r: c.r, t: 0, ang: Math.PI,
      flash: 0, ft: rand(60, 100), ph: rand(0, 6.28), mode: 0, mt: 0, ty: rand(60, 110),
    });
  }
  function spawnBoss() {
    const hp = Math.ceil(70 * (1 + loop * 0.5));
    boss = { x: W / 2, y: -30, hp, max: hp, t: 0, ang: Math.PI, flash: 0, r: 17, dying: 0 };
    state = "boss"; stateT = 120;
  }
  function hitPlayer() {
    if (player.inv > 0 || player.dead) return;
    lives--; explode(player.x, player.y, 2); shake = 9; player.inv = 120; hurt = 14; hitstop = 5;
    if (lives <= 0) { player.dead = true; explode(player.x, player.y, 3); state = "over"; stateT = 60; }
  }
  function killEnemy(e: Enemy) {
    const c = ECFG[e.pr];
    explode(e.x, e.y, c.sz); bump(c.score * (1 + loop)); done++;
    if (c.sz >= 2) hitstop = c.sz >= 3 ? 6 : 3;
    addText(`DONE: ${e.task.title}`, e.x, e.y - 12, "#8dff9a", 80);
  }
  function updEnemy(e: Enemy) {
    e.t++;
    const L = 1 + loop * 0.2, ox = e.x, oy = e.y;
    switch (e.pr) {
      case "low":
        e.y += 1.0 * L; e.x = e.x0 + Math.sin(e.t * 0.045 + e.ph) * 22;
        e.ang = Math.atan2(e.x - ox, -(e.y - oy));
        break;
      case "medium":
        if (e.mode === 0) { e.y += 1.3 * L; e.ang = Math.PI; if (e.y > e.ty) { e.mode = 1; aimShot(e, 1.6); } }
        else {
          if (++e.mt < 50) e.ang += angDiff(aimAt(e.x, e.y), e.ang) * 0.08;
          const sp = 2.1 * L;
          e.x += Math.sin(e.ang) * sp; e.y -= Math.cos(e.ang) * sp;
        }
        break;
      case "high":
        if (e.mode === 0) { e.y += Math.max(0.4, (e.ty - e.y) * 0.04) * L; e.ang = Math.PI; if (e.y >= e.ty - 1) e.mode = 1; }
        else if (e.mode === 1) {
          e.mt++;
          const vx = Math.sin(e.mt * 0.03 + e.ph) * 1.1;
          e.x = clamp(e.x + vx, 14, W - 14); e.ang = Math.PI - vx * 0.4;
          if (--e.ft <= 0) { aimShot(e, 1.7); e.ft = 70 / L; }
          if (e.mt > 300) e.mode = 2;
        } else { e.y += 1.6 * L; e.ang += angDiff(Math.PI, e.ang) * 0.1; }
        break;
      case "urgent":
        e.y += 0.38 * L; e.x += clamp((player.x - e.x) * 0.004, -0.3, 0.3);
        e.ang += clamp(angDiff(aimAt(e.x, e.y), e.ang), -0.6, 0.6) * 0.02;
        if (--e.ft <= 0) { fan(e, 5, 0.9, 1.4); e.ft = 110 / L; }
        break;
    }
    if (e.flash > 0) e.flash--;
  }

  function update() {
    t++;
    if (hurt > 0) hurt--;
    if (muzzle > 0) muzzle--;
    if (hitstop > 0) { hitstop--; return; }
    camR += SCROLL;
    for (const c of cloudSet) {
      c.y += c.hi ? SCROLL * 2.6 : SCROLL * 1.5;
      if (c.y > H + 30) { c.spr = clouds()[(Math.random() * 10) | 0]; c.y = -c.spr.h - rand(0, 140); c.x = rand(-30, W - 10); }
    }
    updParts();
    if (shake > 0) { shake *= 0.86; if (shake < 0.4) shake = 0; }
    if (state === "title" || state === "win") { if (stateT > 0) stateT--; return; }
    if (state === "over") { if (stateT > 0) stateT--; updBullets(); return; }

    const kx = (keys.has("ArrowRight") || keys.has("KeyD") ? 1 : 0) - (keys.has("ArrowLeft") || keys.has("KeyA") ? 1 : 0);
    const ky = (keys.has("ArrowDown") || keys.has("KeyS") ? 1 : 0) - (keys.has("ArrowUp") || keys.has("KeyW") ? 1 : 0);
    player.tx = clamp(player.tx + kx * 2, 8, W - 8);
    player.ty = clamp(player.ty + ky * 2, 40, H - 16);
    player.px = player.x;
    player.x += (player.tx - player.x) * 0.35;
    player.y += (player.ty - player.y) * 0.35;
    player.ang += (clamp((player.x - player.px) * 0.14, -0.4, 0.4) - player.ang) * 0.2;
    if (player.inv > 0) player.inv--;
    if (player.spread > 0) player.spread--;
    const ca = Math.cos(player.ang), sa = Math.sin(player.ang);
    for (const s of [-1, 1]) {
      const [wx, wy] = toScreen(player.x, player.y, player.ang, 0.5 + s * 6.5, 4);
      trail.push({ x: wx - 0.5, y: wy, l: 26 });
    }
    if (state !== "intro" && --player.fire <= 0) {
      player.fire = 7; muzzle = 2;
      for (const s of [-3, 3]) pbul.push({ x: player.x + s * ca, y: player.y - 8 + s * sa, vx: 0, vy: -5 });
      if (player.spread > 0) for (const s of [-1, 1]) pbul.push({ x: player.x, y: player.y - 6, vx: s * 1.2, vy: -4.6 });
    }

    if (state === "intro" && --stateT <= 0) state = "play";
    if (state === "play") {
      if (--spawnT <= 0 && queue.length) {
        const task = queue.shift()!;
        spawn(task);
        spawnT = ECFG[task.pr].gap / (1 + loop * 0.25);
      }
      if (!queue.length && !enemies.length) spawnBoss();
    }
    if ((state === "play" || state === "boss") && --noteT <= 0 && noteQ.length) {
      pickups.push({ x: rand(20, W - 20), y: -10, ang: 0, title: noteQ.shift()! });
      noteT = rand(420, 620);
    }

    for (const e of enemies) updEnemy(e);
    enemies = enemies.filter((e) => {
      if (e.hp <= 0) return false;
      if (e.y > H + 24 || e.x < -30 || e.x > W + 30) {
        queue.push(e.task);
        addText("CARRIED OVER", clamp(e.x, 28, W - 28), H - 34, "#ff9a6b", 60);
        return false;
      }
      return true;
    });

    if (boss) {
      const b = boss;
      b.t++;
      if (b.flash > 0) b.flash--;
      if (b.dying > 0) {
        b.dying--;
        if (b.dying % 6 === 0) explode(b.x + rand(-16, 16), b.y + rand(-12, 12), 2);
        if (b.dying === 0) { explode(b.x, b.y, 5); boss = null; state = "clear"; stateT = 200; bump(1000 * (1 + loop)); lives = Math.min(5, lives + 1); }
      } else {
        if (b.y < 72) b.y += 0.6;
        else {
          b.x = W / 2 + Math.sin(b.t * 0.012) * (W / 2 - 42);
          if (b.t % 55 === 0) fan(b, 3, 0.5, 1.8);
          if (b.t % 150 === 0) ringShot(b, 14, 1.2);
        }
        b.ang = Math.PI + Math.sin(b.t * 0.025) * 0.28;
      }
      if (state === "boss" && stateT > 0) stateT--;
    }
    if (state === "clear" && --stateT <= 0) {
      levelIdx++;
      if (levelIdx >= PROJECTS.length) { levelIdx = 0; loop++; state = "win"; stateT = 60; return; }
      startLevel();
    }

    for (const p of pickups) {
      p.y += SCROLL * 1.8; p.ang += 0.05;
      if (!player.dead && Math.hypot(p.x - player.x, p.y - player.y) < 12) {
        p.got = true; player.spread = 600; bump(50);
        addText(`NOTE: ${p.title}`, p.x, p.y - 10, "#9fd2ff", 80);
        for (let i = 0; i < 10; i++) parts.push({ x: p.x, y: p.y, vx: rand(-1.5, 1.5), vy: rand(-1.5, 1.5), l: 20, m: 20, s: 1, k: 3 });
      }
    }
    pickups = pickups.filter((p) => !p.got && p.y < H + 12);
    updBullets();
    for (const tr of trail) { tr.y += 2.2; tr.l--; }
    trail = trail.filter((tr) => tr.l > 0);
  }
  function updBullets() {
    for (const b of pbul) { b.x += b.vx; b.y += b.vy; }
    for (const b of ebul) { b.x += b.vx; b.y += b.vy; }
    for (const b of pbul) {
      for (const e of enemies) {
        if (e.hp > 0 && Math.abs(b.x - e.x) < e.r && Math.abs(b.y - e.y) < e.r) {
          b.dead = true; e.hp--; e.flash = 3; sparks(b.x, b.y);
          if (e.hp <= 0) killEnemy(e);
          break;
        }
      }
      if (!b.dead && boss && !boss.dying && Math.hypot(b.x - boss.x, b.y - boss.y) < boss.r) {
        b.dead = true; boss.hp--; boss.flash = 3; sparks(b.x, b.y);
        if (boss.hp <= 0) { boss.dying = 70; ebul = []; addText("PROJECT SHIPPED!", boss.x, boss.y - 24, "#8dff9a", 120); }
      }
    }
    if (!player.dead) {
      for (const b of ebul) if (Math.abs(b.x - player.x) < 4 && Math.abs(b.y - player.y) < 5) { b.dead = true; hitPlayer(); }
      for (const e of enemies)
        if (e.hp > 0 && Math.hypot(e.x - player.x, e.y - player.y) < e.r + 5) {
          e.hp -= 3; e.flash = 3; hitPlayer();
          if (e.hp <= 0) killEnemy(e);
        }
    }
    pbul = pbul.filter((b) => !b.dead && b.y > -8 && b.x > -8 && b.x < W + 8);
    ebul = ebul.filter((b) => !b.dead && b.y > -10 && b.y < H + 10 && b.x > -10 && b.x < W + 10);
  }
  function updParts() {
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy + SCROLL * 0.6; p.l--;
      const d = p.k === 1 ? 0.96 : 0.93;
      p.vx *= d; p.vy *= d;
    }
    parts = parts.filter((p) => p.l > 0);
    for (const r of rings) r.r += 1;
    rings = rings.filter((r) => r.r <= r.max);
    for (const x of texts) { x.y -= 0.3; x.l--; }
    texts = texts.filter((x) => x.l > 0);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function partColor(p: Part): string {
    const f = p.l / p.m;
    if (p.k === 1) return f > 0.5 ? "#59607a" : "#3c4258";
    if (p.k === 2) return "#2a2f3a";
    if (p.k === 3) return f > 0.5 ? "#ffffff" : "#9fd2ff";
    return FIRE[f > 0.8 ? 0 : f > 0.6 ? 1 : f > 0.4 ? 2 : f > 0.2 ? 3 : 4];
  }
  /** Model-space point → screen, matching drawStack's transform. */
  function toScreen(x: number, y: number, ang: number, lx: number, ly: number): [number, number] {
    const c = Math.cos(ang), s = Math.sin(ang);
    return [x + lx * c - ly * s, y + lx * s + ly * c];
  }
  /** Two flames from the outer nozzle voxels. */
  function afterburners(x: number, y: number, ang: number, k: number, minLen: number, size: number) {
    const s = Math.sin(ang), c = Math.cos(ang);
    for (const side of [-1, 1]) {
      const [bx, by] = toScreen(x, y - 1, ang, (0.5 + side) * k, 10 * k);
      const len = (minLen + Math.random() * minLen) | 0;
      for (let i = 0; i < len; i++) px(bx - i * s - size / 2, by + i * c, FIRE[Math.min(4, ((i * 4) / len) | 0)], size);
    }
  }
  function drawPlayer() {
    if (player.dead || (player.inv > 0 && (t >> 2) & 1)) return;
    const ca = Math.cos(player.ang), sa = Math.sin(player.ang);
    drawStack(PLAYER, player.x, player.y, player.ang);
    afterburners(player.x, player.y, player.ang, 1, 3, 1);
    if (muzzle)
      for (const s of [-3, 3]) {
        px(player.x + s * ca + 10 * sa, player.y - 10 + s * sa, "#ffffff");
        px(player.x + s * ca + 11 * sa - 1, player.y - 10 + s * sa, "#fff2a0");
        px(player.x + s * ca + 11 * sa + 1, player.y - 10 + s * sa, "#fff2a0");
      }
  }
  const dim = (y: number, h: number, a = 0.5) => { ctx.globalAlpha = a; ctx.fillStyle = INK; ctx.fillRect(0, y, W, h); ctx.globalAlpha = 1; };

  function render() {
    scr.sx = shake ? Math.round(rand(-shake, shake)) : 0;
    scr.sy = shake ? Math.round(rand(-shake, shake)) : 0;
    const ox = clamp(Math.round((player.x - W / 2) * 0.08) + scr.sx, -M, M);
    terrain.render(camR, ox, scr.sy, t);
    blit();

    ctx.globalAlpha = 0.16;
    for (const c of cloudSet) ctx.drawImage(c.spr.s, Math.round(c.x + (c.hi ? 34 : 18)), Math.round(c.y + (c.hi ? 46 : 26)));
    ctx.globalAlpha = 1;
    for (const c of cloudSet) if (!c.hi) ctx.drawImage(c.spr.c, Math.round(c.x), Math.round(c.y));

    for (const p of pickups) drawShadow(NOTE, p.x, p.y, p.ang, 4, 6, 0.25);
    for (const e of enemies) drawShadow(e.m, e.x, e.y, e.ang, 7, 10);
    if (boss) drawShadow(BOSS, boss.x, boss.y, boss.ang, 10, 16, 0.3);
    if (!player.dead && state !== "title") drawShadow(PLAYER, player.x, player.y, player.ang, 10, 15);

    ctx.globalAlpha = 0.75;
    for (const tr of trail) if (tr.l > 3) px(tr.x, tr.y, tr.l > 14 ? "#ffffff" : "#d4e2f5", 1);
    ctx.globalAlpha = 1;

    for (const p of pickups) {
      drawStack(NOTE, p.x, p.y, p.ang);
      if ((t >> 3) & 1) px(p.x - 1, p.y - 9, "#ffffff");
    }
    for (const e of enemies) {
      drawStack(e.m, e.x, e.y, e.ang, { flash: e.flash > 0 });
      if ((e.pr === "urgent" || e.pr === "high" || e.flash > 0) && e.y > 8) {
        const s = e.task.title.length > 14 ? e.task.title.slice(0, 13) + "." : e.task.title;
        drawTextC(s, clamp(e.x, textW(s) / 2 + 2, W - textW(s) / 2 - 2), e.y + e.r + 3, e.pr === "urgent" ? "#ffb4a8" : "#ffe7a8");
      }
    }
    if (boss) drawStack(BOSS, boss.x, boss.y, boss.ang, { flash: boss.flash > 0 });
    if (state !== "title") drawPlayer();

    for (const b of pbul) { px(b.x, b.y, "#fff6a0"); px(b.x, b.y + 1, "#fff6a0"); px(b.x, b.y + 2, "#ffb347"); }
    for (const b of ebul) {
      ctx.fillStyle = "#ff5e8a";
      ctx.fillRect(Math.round(b.x) - 1 + scr.sx, Math.round(b.y) + scr.sy, 3, 1);
      ctx.fillRect(Math.round(b.x) + scr.sx, Math.round(b.y) - 1 + scr.sy, 1, 3);
      px(b.x, b.y, (t >> 2) & 1 ? "#ffffff" : "#ffd2e0");
    }
    for (const p of parts) px(p.x, p.y, partColor(p), p.s);
    for (const r of rings) {
      const n = Math.max(8, r.r * 5), c = r.r < r.max * 0.5 ? "#ffffff" : "#ffb347";
      for (let i = 0; i < n; i++) px(r.x + Math.cos((i / n) * 6.283) * r.r, r.y + Math.sin((i / n) * 6.283) * r.r, c);
    }
    for (const c of cloudSet) if (c.hi) ctx.drawImage(c.spr.c, Math.round(c.x), Math.round(c.y));

    for (const x of texts) {
      if (x.l < 16 && (x.l >> 1) & 1) continue;
      const s = x.s.length > 24 ? x.s.slice(0, 23) + "." : x.s;
      drawTextC(s, clamp(x.x, textW(s) / 2 + 2, W - textW(s) / 2 - 2), Math.max(30, Math.round(x.y)), x.c);
    }
    if (hurt) {
      ctx.globalAlpha = (hurt / 14) * 0.45;
      ctx.fillStyle = "#ff3d6e";
      ctx.fillRect(0, 0, W, 3); ctx.fillRect(0, H - 3, W, 3); ctx.fillRect(0, 0, 3, H); ctx.fillRect(W - 3, 0, 3, H);
      ctx.globalAlpha = (hurt / 14) * 0.12;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    scr.sx = scr.sy = 0;
    drawHud();
  }
  function heart(x: number, y: number, c: string) {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, 2, 1); ctx.fillRect(x + 3, y, 2, 1); ctx.fillRect(x, y + 1, 5, 1); ctx.fillRect(x + 1, y + 2, 3, 1); ctx.fillRect(x + 2, y + 3, 1, 1);
  }
  function drawHud() {
    if (state === "title") return drawTitle();
    drawText(String(score).padStart(6, "0"), 4, 4, "#ffffff");
    for (let i = 0; i < 5; i++) heart(W - 8 - i * 7, 4, i < lives ? "#ff5e8a" : "#3a3f55");
    drawText(proj.name, 4, 12, proj.accent);
    const prog = `${done}/${total}`;
    drawText(prog, W - 4 - textW(prog), 12, "#ffffff");
    ctx.fillStyle = INK; ctx.fillRect(4, 20, W - 8, 3);
    ctx.fillStyle = proj.accent; ctx.fillRect(5, 21, Math.round(((W - 10) * done) / Math.max(1, total)), 1);
    if (player.spread > 0) {
      drawText("SPREAD", 4, H - 10, "#9fd2ff");
      ctx.fillStyle = "#9fd2ff"; ctx.fillRect(30, H - 8, Math.round((player.spread / 600) * 40), 1);
    }
    if (boss) {
      ctx.fillStyle = INK; ctx.fillRect(20, 28, W - 40, 4);
      ctx.fillStyle = "#ff3d6e"; ctx.fillRect(21, 29, Math.round(((W - 42) * Math.max(0, boss.hp)) / boss.max), 2);
    }
    if (state === "intro") {
      dim(102, 60);
      drawTextC(`PROJECT ${levelIdx + 1}/${PROJECTS.length}${loop ? `  LOOP ${loop + 1}` : ""}`, W / 2, 110, "#c9d3ea");
      drawTextC(proj.name, W / 2, 122, proj.accent, proj.name.length > 20 ? 1 : 2);
      drawTextC(`${total} TASKS  ${proj.notes.length} NOTES`, W / 2, 140, "#ffffff");
      if ((t >> 4) & 1) drawTextC("CLEAR THE BACKLOG", W / 2, 152, "#8dff9a");
    }
    if (state === "boss" && stateT > 0) dim(112, 36);
    if (state === "boss" && stateT > 0 && (t >> 3) & 1) {
      drawTextC("WARNING", W / 2, 120, "#ff3d6e", 2);
      drawTextC("PROJECT REVIEW INBOUND", W / 2, 138, "#ffffff");
    }
    if (state === "clear") {
      dim(112, 50);
      drawTextC("ALL TASKS CLEARED", W / 2, 120, "#8dff9a");
      drawTextC(proj.name, W / 2, 132, proj.accent, proj.name.length > 20 ? 1 : 2);
      drawTextC("+1 HEART", W / 2, 152, "#ff5e8a");
    }
    if (state === "over" || state === "win") {
      dim(96, 84, 0.55);
      if (state === "over") {
        drawTextC("GAME OVER", W / 2, 106, "#ff5e8a", 2);
        drawTextC(`${done} OF ${total} TASKS DONE`, W / 2, 128, "#ffffff");
        drawTextC(`IN ${proj.name}`, W / 2, 138, proj.accent);
      } else {
        drawTextC("ALL CAUGHT UP!", W / 2, 106, "#8dff9a", 2);
        drawTextC("EVERY PROJECT SHIPPED", W / 2, 128, "#ffffff");
        drawTextC("NEXT LOOP IS HARDER", W / 2, 138, "#ffb347");
      }
      if (stateT <= 0 && (t >> 4) & 1) drawTextC(state === "over" ? "CLICK TO RETRY" : "CLICK TO CONTINUE", W / 2, 162, "#ffffff");
    }
  }
  function drawTitle() {
    dim(34, 54, 0.45);
    drawTextC("CAIRN PRESENTS", W / 2, 40, "#c9d3ea");
    drawTextC("TASK FORCE", W / 2, 52, "#ffffff", 3);
    drawTextC("CLEAR YOUR BACKLOG", W / 2, 74, "#2ec4b6");
    const a = t * 0.02;
    const ja = Math.sin(t * 0.025) * 0.28, jx = W / 2 - Math.cos(t * 0.025) * 10, jy = 138 + Math.sin(t * 0.05) * 2;
    drawShadow(PLAYER, jx, jy, ja, 12, 22, 0.3, 3);
    drawStack(PLAYER, jx, jy, ja, { k: 3, lift: 0.34 });
    afterburners(jx, jy, ja, 3, 7, 2);
    dim(200, 76, 0.6);
    ([["low", "LOW"], ["medium", "MED"], ["high", "HIGH"], ["urgent", "URGENT"]] as const).forEach(([k, l], i) => {
      const x = W / 2 - 64 + i * 43;
      drawStack(MODELS[k], x, 220, -a * 2 + i);
      drawTextC(l, x, 236, PRIORITY_PAL[k].h);
    });
    drawTextC("TASKS ARE ENEMIES", W / 2, 248, "#ffffff");
    drawStack(NOTE, W / 2 - 50, 263, a * 3);
    drawText("NOTES = SPREAD SHOT", W / 2 - 38, 261, "#9fd2ff");
    if ((t >> 4) & 1) drawTextC("CLICK TO FLY", W / 2, 288, "#ffffff", 2);
    drawTextC("DRAG OR ARROWS - AUTO FIRE", W / 2, 306, "#c9d3ea");
  }

  function go(): boolean {
    if (state === "title" || (state === "over" && stateT <= 0)) { startGame(); return true; }
    if (state === "win" && stateT <= 0) { startLevel(); return true; }
    return false;
  }
  const steer = (x: number, y: number) => { player.tx = clamp(x, 8, W - 8); player.ty = clamp(y - 10, 40, H - 16); };

  return {
    update,
    render,
    down(x, y) {
      if (!go()) steer(x, y);
      drag = true;
    },
    move(x, y) { if (drag) steer(x, y); },
    up() { drag = false; },
    key(code, down) {
      if (down) keys.add(code);
      else keys.delete(code);
      if (down && (code === "Space" || code === "Enter")) return go() || true;
      return /^(Arrow|Key[WASD]$)/.test(code);
    },
    resize(prevW) {
      const dx = (W - prevW) / 2;
      if (!dx) return;
      player.x = clamp(player.x + dx, 8, W - 8);
      player.tx = clamp(player.tx + dx, 8, W - 8);
      player.px += dx;
      for (const e of enemies) e.x += dx;
      if (boss) boss.x += dx;
      for (const p of pickups) p.x += dx;
      for (const b of pbul) b.x += dx;
      for (const b of ebul) b.x += dx;
      for (const p of parts) p.x += dx;
      for (const tr of trail) tr.x += dx;
      for (const tx of texts) tx.x += dx;
      for (const r of rings) r.x += dx;
      for (const c of cloudSet) c.x += dx;
    },
    get best() { return best; },
  };
};
