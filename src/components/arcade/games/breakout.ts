/**
 * Cairn Breakout. One ball, +1 a brick, the streak resets on the paddle, clear
 * the board to win, drop the ball to lose. Bricks are sprite-stacked blocks for
 * the workspace's projects, notes, tasks and tags, floating over a slowly
 * drifting island (a new biome every board).
 */

import type { EntityKind } from "../data";
import type { GameFactory } from "../game";
import { ICONS, KINDS, KIND_LIST } from "../pixel/kinds";
import {
  BIOME_ORDER, FIRE, H, INK, Terrain, W, band, blit, clamp, clipText, drawShadow, drawStack, drawText, drawTextC, lazy, makeModel,
  px, rand, scr, textW, type Model,
} from "../pixel/kit";

export const BW = 26;
const ROWS = 7, BH = 10, GAP_X = 28, GAP_Y = 12, BY0 = 62;
const PAD_Y = H - 34, PAD_W = 32, BALL_R = 2;
const BASE_SPEED = 2.1;

/** A 24×8×3 block in its kind's colours, the kind icon on top. */
function brickModel(kind: EntityKind): Model {
  const K = KINDS[kind], ic = ICONS[kind];
  return makeModel(24, 8, 3, (x, y, z) => {
    if (z < 2) return z === 0 ? K.d : K.h;
    const ix = x - 2, iy = y - 1;
    if (ix >= 0 && ix < 5 && iy >= 0 && iy < 5 && ic.charCodeAt(iy * 5 + ix) === 49) return K.l;
    if (y === 0) return K.l;
    return (x + y) % 7 === 0 && x > 8 ? K.d : K.h;
  });
}
export const brickModels = lazy(() => Object.fromEntries(KIND_LIST.map((k) => [k, brickModel(k)])) as Record<EntityKind, Model>);
/** Hover pad: a slim hull, teal running lights, dark intakes. */
export const padModel = lazy(() =>
  makeModel(PAD_W, 7, 3, (x, y, z) => {
    const edge = x === 0 || x === PAD_W - 1;
    if (z === 0) return x > 2 && x < PAD_W - 3 ? "#343b4c" : null;
    if (z === 1) return edge && (y < 1 || y > 5) ? null : "#6b7488";
    if (y === 0 || y === 6 || edge) return null;
    if (y === 3 && (x < 4 || x > PAD_W - 5)) return "#2ec4b6";
    if (y === 3 && x > 12 && x < PAD_W - 13) return "#a8f4ff";
    return y === 1 ? "#d6dceb" : "#b8c2d6";
  }),
);

export interface Brick { x: number; y: number; kind: EntityKind; label: string; ph: number }
interface Particle { x: number; y: number; vx: number; vy: number; g: number; life: number; c: string }
interface Pop { s: string; x: number; y: number; t: number; c: string; big: boolean }

/**
 * Shift surviving bricks by `dx` when the playfield width changes; if any
 * surviving brick falls outside `[BW / 2 + 2, w - BW / 2 - 2]`, reflow the
 * surviving bricks cleanly inside `w` so every brick stays hittable.
 */
export function fitBricksToWidth(bricks: Brick[], dx: number, w: number): void {
  const minX = BW / 2 + 2, maxX = w - BW / 2 - 2;
  for (const b of bricks) b.x += dx;
  if (!bricks.some((b) => b.x < minX || b.x > maxX)) return;
  const cols = clamp(Math.floor((w - 8) / GAP_X), 6, 16);
  const bx0 = (w - (cols - 1) * GAP_X) / 2;
  const rows = Math.ceil(bricks.length / cols);
  const gapY = rows > ROWS ? Math.min(GAP_Y, Math.max(BH, Math.floor((PAD_Y - 30 - BY0) / Math.max(1, rows - 1)))) : GAP_Y;
  for (let i = 0; i < bricks.length; i++) {
    bricks[i].x = bx0 + (i % cols) * GAP_X;
    bricks[i].y = BY0 + Math.floor(i / cols) * gapY;
  }
}

export const createBreakout: GameFactory = ({ data, best: best0 }) => {
  const ctx = scr.ctx, BRICK = brickModels(), PAD = padModel(), labels = data.labels;
  const terrain = new Terrain("tropic", 11);
  let state: "title" | "play" | "over" | "win" = "title", t = 0, stateT = 0, boards = 0;
  let bricks: Brick[] = [], parts: Particle[] = [], pops: Pop[] = [], trail: { x: number; y: number }[] = [];
  const pad = { x: W / 2, tx: W / 2, vx: 0 };
  const ball = { x: 0, y: 0, vx: 0, vy: 0, stuck: true };
  let score = 0, best = best0, streak = 0, shake = 0, freeze = 0, camR = 0, newBest = false;

  function layout(): Brick[] {
    // As many columns as the screen fits (6 on the phone shape, 16 at most).
    const cols = clamp(Math.floor((W - 8) / GAP_X), 6, 16), bx0 = (W - (cols - 1) * GAP_X) / 2;
    const out: Brick[] = [];
    for (let r = 0, i = 0; r < ROWS; r++)
      for (let c = 0; c < cols; c++, i++) {
        const l = labels[i % labels.length];
        out.push({ x: bx0 + c * GAP_X, y: BY0 + r * GAP_Y, kind: l.kind, label: l.label, ph: (c + r) * 0.7 });
      }
    return out;
  }
  const demo = layout();

  function reset() {
    bricks = layout();
    score = 0; streak = 0; parts = []; pops = []; trail = []; newBest = false;
    Object.assign(ball, { x: pad.x, y: PAD_Y - 8, vx: 0, vy: 0, stuck: true });
    boards++;
    terrain.set(BIOME_ORDER[boards % BIOME_ORDER.length], 11 + boards * 7);
    camR = 0;
  }
  function tap() {
    if (state === "title" || ((state === "over" || state === "win") && stateT > 40)) {
      state = "play"; stateT = 0; reset();
    } else if (state === "play" && ball.stuck) {
      ball.stuck = false;
      ball.vx = BASE_SPEED * (pad.vx >= 0 ? 0.45 : -0.45);
      ball.vy = -BASE_SPEED;
    }
  }

  function update() {
    t++; stateT++;
    camR += 0.12;
    if (freeze > 0) { freeze--; return; }
    // The paddle eases to the pointer; its speed sets the yaw.
    const nx = pad.x + (clamp(pad.tx, PAD_W / 2 + 2, W - PAD_W / 2 - 2) - pad.x) * 0.45;
    pad.vx = nx - pad.x; pad.x = nx;
    for (const p of parts) { p.vy += p.g; p.x += p.vx; p.y += p.vy; p.life--; }
    parts = parts.filter((p) => p.life > 0);
    for (const p of pops) p.t++;
    pops = pops.filter((p) => p.t < 46);
    if (shake > 0) shake -= 0.5;
    if (state !== "play") return;
    if (ball.stuck) { ball.x = pad.x; ball.y = PAD_Y - 8; return; }

    trail.push({ x: ball.x, y: ball.y });
    if (trail.length > 6) trail.shift();
    // Two half-steps a frame so a fast ball can't skip a 10px brick.
    for (let s = 0; s < 2; s++) {
      ball.x += ball.vx / 2; ball.y += ball.vy / 2;
      if (ball.x < BALL_R + 1) { ball.x = BALL_R + 1; ball.vx = Math.abs(ball.vx); wallPing(ball.x - 2, ball.y); }
      if (ball.x > W - BALL_R - 1) { ball.x = W - BALL_R - 1; ball.vx = -Math.abs(ball.vx); wallPing(ball.x + 2, ball.y); }
      if (ball.y < 22) { ball.y = 22; ball.vy = Math.abs(ball.vy); wallPing(ball.x, ball.y - 2); }
      // Paddle: where it hits sets the angle.
      if (ball.vy > 0 && ball.y + BALL_R >= PAD_Y - 5 && ball.y < PAD_Y + 2 && Math.abs(ball.x - pad.x) <= PAD_W / 2 + BALL_R) {
        const hit = clamp((ball.x - pad.x) / (PAD_W / 2), -1, 1);
        const sp = Math.hypot(ball.vx, ball.vy);
        ball.vx = hit * BASE_SPEED * 1.15 + pad.vx * 0.15;
        ball.vy = -Math.sqrt(Math.max(sp * sp - ball.vx * ball.vx, sp * sp * 0.3));
        ball.y = PAD_Y - 5 - BALL_R;
        streak = 0;
        for (let i = 0; i < 5; i++) parts.push({ x: ball.x + rand(-3, 3), y: PAD_Y - 4, vx: rand(-0.6, 0.6), vy: rand(-0.8, -0.2), g: 0.05, life: 12, c: i % 2 ? "#a8f4ff" : "#2ec4b6" });
      }
      if (hitBrick()) break;
    }
    if (ball.y > H + 6) { state = "over"; stateT = 0; shake = 6; trail = []; }
  }
  function hitBrick(): boolean {
    for (let i = 0; i < bricks.length; i++) {
      const b = bricks[i];
      const l = b.x - BW / 2, r = b.x + BW / 2, tp = b.y - BH / 2 - 2, bt = b.y + BH / 2 - 2;
      if (ball.x + BALL_R < l || ball.x - BALL_R > r || ball.y + BALL_R < tp || ball.y - BALL_R > bt) continue;
      // A side hit if the ball came in mostly sideways, else top / bottom.
      const ox = Math.min(ball.x + BALL_R - l, r - (ball.x - BALL_R)), oy = Math.min(ball.y + BALL_R - tp, bt - (ball.y - BALL_R));
      if (ox < oy) ball.vx = -ball.vx;
      else ball.vy = -ball.vy;
      bricks.splice(i, 1);
      breakBrick(b);
      return true;
    }
    return false;
  }
  function breakBrick(b: Brick) {
    score++; streak++;
    if (score > best) { best = score; newBest = true; }
    const K = KINDS[b.kind];
    for (let i = 0; i < 16; i++) parts.push({ x: b.x + rand(-11, 11), y: b.y + rand(-4, 2), vx: rand(-1.2, 1.2), vy: rand(-1.6, 0.2), g: 0.09, life: 22 + (i % 10), c: [K.l, K.h, K.d, "#ffffff"][i % 4] });
    pops.push({ s: `${K.name}: ${b.label}`, x: b.x, y: b.y - 8, t: 0, c: K.l, big: false });
    if (streak >= 3) pops.push({ s: `x${streak}`, x: b.x, y: b.y + 2, t: 0, c: streak >= 6 ? "#ffb347" : "#fff2a0", big: true });
    if (pops.length > 4) pops.splice(0, pops.length - 4);
    shake = Math.min(4, 1.5 + streak * 0.3);
    freeze = streak >= 5 ? 3 : 1;
    // A gentle speed-up keeps the late game from dragging.
    const sp = Math.hypot(ball.vx, ball.vy), k = Math.min(BASE_SPEED * 1.45, sp + 0.02) / sp;
    ball.vx *= k; ball.vy *= k;
    if (!bricks.length) { state = "win"; stateT = 0; freeze = 10; }
  }
  function wallPing(x: number, y: number) {
    for (let i = 0; i < 3; i++) parts.push({ x, y, vx: rand(-0.5, 0.5), vy: rand(-0.5, 0.5), g: 0, life: 8, c: "#c7d0e6" });
  }

  function render() {
    scr.sx = scr.sy = 0;
    // Island backdrop, dimmed so the bricks own the foreground.
    terrain.render(camR, 0, 0, t);
    blit();
    band(0, H, 0.64);
    scr.sx = shake > 0 ? Math.round(rand(-shake, shake)) : 0;
    scr.sy = shake > 0 ? Math.round(rand(-shake, shake)) : 0;

    const shown = state === "title" ? demo : bricks;
    for (const b of shown) drawShadow(BRICK[b.kind], b.x, b.y, 0, 4, 6, 0.35);
    for (const b of shown) drawStack(BRICK[b.kind], b.x, b.y + Math.round(Math.sin(t * 0.04 + b.ph) * 0.6), 0);
    if (state === "title") return renderTitle();

    const yaw = clamp(pad.vx * 0.05, -0.22, 0.22);
    drawShadow(PAD, pad.x, PAD_Y, yaw, 4, 7, 0.35);
    for (const dx of [-11, 11]) { px(pad.x + dx, PAD_Y + 5 + (t & 1), FIRE[((t >> 1) % 3) + 1]); px(pad.x + dx, PAD_Y + 7, FIRE[3]); }
    drawStack(PAD, pad.x, PAD_Y, yaw);

    if (state === "play" || state === "win") {
      trail.forEach((p, i) => { ctx.globalAlpha = ((i + 1) / (trail.length + 2)) * 0.6; px(p.x - 1, p.y - 1, "#a8f4ff", 2); });
      ctx.globalAlpha = 0.35; px(ball.x + 2, ball.y + 4, INK, 3); ctx.globalAlpha = 1;
      drawBall(ball.x, ball.y);
    }
    for (const p of parts) px(p.x, p.y, p.c);
    for (const p of pops) {
      if (p.t > 36 && p.t & 2) continue;
      const s = p.big ? p.s : clipText(p.s, 26), k = p.big ? 2 : 1;
      drawTextC(s, clamp(p.x, textW(s, k) / 2 + 2, W - textW(s, k) / 2 - 2), Math.round(p.y - Math.min(p.t, 24) * 0.5), p.c, k);
    }

    scr.sx = scr.sy = 0;
    band(0, 16, 0.6);
    drawText(String(score), 5, 5, "#ffffff");
    drawText(`BEST ${best}`, W - textW(`BEST ${best}`) - 5, 5, newBest ? "#fff2a0" : "#c7d0e6");
    drawTextC(`${bricks.length} LEFT`, W / 2, 5, "#7f8aa6");
    if (state === "play" && ball.stuck && (t >> 5) & 1) drawTextC("CLICK TO LAUNCH", W / 2, PAD_Y - 32, "#ffffff");
    if (state === "over") banner("BALL LOST", "#ef5a24", `${score} CLEARED`);
    if (state === "win") banner("BOARD CLEAR", "#7cc46a", `ALL ${score} DONE`);
  }
  function drawBall(x: number, y: number) {
    const X = Math.round(x) - 2 + scr.sx, Y = Math.round(y) - 2 + scr.sy;
    ctx.fillStyle = INK; ctx.fillRect(X - 1, Y + 1, 7, 3); ctx.fillRect(X + 1, Y - 1, 3, 7);
    ctx.fillStyle = "#c7e4ff"; ctx.fillRect(X, Y + 1, 5, 3); ctx.fillRect(X + 1, Y, 3, 5);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(X + 1, Y + 1, 2, 2);
    ctx.fillStyle = "#5b8dd6"; ctx.fillRect(X + 3, Y + 3, 1, 1);
  }
  function banner(title: string, col: string, sub: string) {
    band(150, 58, 0.65);
    drawTextC(title, W / 2, 158, col, 2);
    drawTextC(sub, W / 2, 176, "#ffffff");
    if (newBest) drawTextC("NEW BEST!", W / 2, 186, "#fff2a0");
    if (stateT > 40 && (t >> 5) & 1) drawTextC("CLICK TO PLAY AGAIN", W / 2, 196, "#c7d0e6");
  }
  function renderTitle() {
    band(150, 62, 0.6);
    drawTextC("CAIRN", W / 2, 156, "#fff2a0", 4);
    drawTextC("BREAKOUT", W / 2, 180, "#ffffff", 2);
    if ((t >> 5) & 1) drawTextC("CLICK TO PLAY", W / 2, 232, "#ffffff");
    drawTextC(`BEST ${best}`, W / 2, 246, "#c7d0e6");
    drawTextC("MOUSE OR < > TO STEER", W / 2, 262, "#7f8aa6");
    drawStack(PAD, W / 2 + Math.sin(t * 0.03) * 30, PAD_Y, Math.cos(t * 0.03) * 0.15);
  }

  return {
    update,
    render,
    down(x) { pad.tx = x; tap(); },
    move(x) { pad.tx = x; },
    up() {},
    key(code, down) {
      if (!down) return false;
      if (code === "Space" || code === "Enter") { tap(); return true; }
      if (code === "ArrowLeft") { pad.tx = pad.x - 24; return true; }
      if (code === "ArrowRight") { pad.tx = pad.x + 24; return true; }
      return false;
    },
    resize(prevW) {
      const dx = (W - prevW) / 2;
      if (!dx) return;
      pad.x = clamp(pad.x + dx, PAD_W / 2 + 2, W - PAD_W / 2 - 2);
      pad.tx = clamp(pad.tx + dx, PAD_W / 2 + 2, W - PAD_W / 2 - 2);
      ball.x = clamp(ball.x + dx, BALL_R + 1, W - BALL_R - 1);
      for (const p of trail) p.x += dx;
      for (const p of parts) p.x += dx;
      for (const p of pops) p.x += dx;
      fitBricksToWidth(bricks, dx, W);
      demo.splice(0, demo.length, ...layout());
    },
    get best() { return best; },
  };
};
