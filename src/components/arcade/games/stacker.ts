/**
 * Cairn Stacker. A stone slides; click to drop it, the overhang is cut off, a
 * near-perfect drop snaps and builds a combo, a miss ends the run. Each stone
 * is a project, note, task or tag; the sky walks from day to night as you climb.
 */

import type { EntityKind, Label } from "../data";
import type { GameFactory } from "../game";
import { KINDS, icon } from "../pixel/kinds";
import {
  BAYER, FIRE, H, INK, W, band, blit, clamp, clouds, ctx2d, drawTextC, fbm, glyphs, hash2, lerpHex, mkCanvas, px, rand, scr, u32,
} from "../pixel/kit";

/** Stone height: 3px top face + 8px front. */
export const SH = 11;
const BASE_W = 104;
const GROUND = H - 44;
/** Px of misalignment that still counts as perfect. */
const PERFECT = 2;

const clipLabel = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + ".");

export function stoneSprite(w: number, kind: EntityKind, label: string, seed: number): HTMLCanvasElement {
  const c = mkCanvas(Math.max(1, w), SH), g = ctx2d(c), S = KINDS[kind].stone;
  const fill = (x: number, y: number, ww: number, hh: number, col: string) => { g.fillStyle = col; g.fillRect(x, y, ww, hh); };
  fill(0, 0, w, SH, INK);
  if (w <= 2) return c;
  // Top face (lit), front face (speckled), a darker bottom lip.
  fill(1, 1, w - 2, 1, S[4]);
  fill(1, 2, w - 2, 1, S[3]);
  fill(1, 3, w - 2, SH - 4, S[2]);
  fill(1, SH - 2, w - 2, 1, S[1]);
  // Light from the left.
  fill(1, 3, 1, SH - 5, S[3]);
  fill(w - 2, 2, 1, SH - 3, S[1]);
  for (let y = 3; y < SH - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const h = hash2(x, y, seed);
      if (h < 0.07) fill(x, y, 1, 1, S[1]);
      else if (h > 0.95) fill(x, y, 1, 1, S[3]);
    }
  // Engraved label: dark glyphs with a light lip underneath.
  const room = Math.floor((w - 12) / 4);
  if (room >= 2) {
    icon(kind, 3, 4, S[4], g);
    icon(kind, 3, 3, S[0], g);
    const s = clipLabel(label, room).toUpperCase();
    g.fillStyle = S[4];
    glyphs(s, 10, 4, 1, g);
    g.fillStyle = S[0];
    glyphs(s, 10, 3, 1, g);
  }
  return c;
}

/** A cut-off piece of a sprite, with a fresh outline on the cut edge. */
function crop(src: HTMLCanvasElement, sx: number, w: number, cutLeft: boolean): HTMLCanvasElement {
  const c = mkCanvas(Math.max(1, w), SH), g = ctx2d(c);
  if (w > 0) g.drawImage(src, sx, 0, w, SH, 0, 0, w, SH);
  g.fillStyle = INK;
  g.fillRect(cutLeft ? 0 : w - 1, 0, 1, SH);
  return c;
}

/** Altitude walks the sky from day through sunset to a starry night. */
const SKY: [number, string, string][] = [
  [0.0, "#3f8fd2", "#b9e3f2"],
  [0.3, "#4d6fb8", "#f6c48a"],
  [0.5, "#3b3a78", "#f08a5d"],
  [0.72, "#1c1d44", "#7a4a7a"],
  [1.0, "#070b1a", "#1d2550"],
];
function skyAt(f: number): [string, string] {
  f = clamp(f, 0, 1);
  let i = 0;
  while (i < SKY.length - 2 && f > SKY[i + 1][0]) i++;
  const [a, ta, ba] = SKY[i], [b, tb, bb] = SKY[i + 1], k = (f - a) / (b - a);
  return [lerpHex(ta, tb, k), lerpHex(ba, bb, k)];
}

interface Stone { x: number; w: number; lvl: number; kind: EntityKind; label: string; img: HTMLCanvasElement }
interface Mover extends Stone { dir: number }
interface Debris { img: HTMLCanvasElement; x: number; y: number; w: number; vx: number; vy: number; a: number; va: number }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; c: string }

export const createStacker: GameFactory = ({ data, best: best0 }) => {
  const ctx = scr.ctx, labels = data.labels;
  let state: "title" | "play" | "over" = "title", t = 0, stateT = 0;
  let tower: Stone[] = [], mover: Mover | null = null, debris: Debris[] = [], parts: Particle[] = [];
  let rings: { x: number; y: number; w: number; t: number }[] = [], pops: { s: string; x: number; y: number; t: number; c: string }[] = [];
  let score = 0, best = best0, combo = 0, speed = 1.25, labelI = 0, side = 0;
  let cam = 0, camT = 0, shake = 0, freeze = 0, squash = 0, newBest = false;

  const nextLabel = (): Label => labels[labelI++ % labels.length];
  const makeStone = (x: number, w: number, lvl: number, l: Label = nextLabel()): Stone =>
    ({ x, w, lvl, kind: l.kind, label: l.label, img: stoneSprite(Math.round(w), l.kind, l.label, lvl * 7 + 3) });
  const levelY = (lvl: number) => GROUND - (lvl + 1) * SH + cam;

  function reset() {
    tower = [makeStone((W - BASE_W) / 2, BASE_W, 0, { label: "WORKSPACE", kind: "project" })];
    debris = []; parts = []; rings = []; pops = [];
    score = 0; combo = 0; speed = 1.25; labelI = 0; side = 0; cam = camT = 0; newBest = false;
    spawn();
  }
  function spawn() {
    const top = tower[tower.length - 1];
    side ^= 1;
    mover = { ...makeStone(side ? -top.w * 0.6 : W - top.w * 0.4, top.w, top.lvl + 1), dir: side ? 1 : -1 };
  }
  function drop() {
    const top = tower[tower.length - 1], m = mover;
    if (!m) return;
    const dx = m.x - top.x;
    if (Math.abs(dx) <= PERFECT) {
      m.x = top.x;
      combo++;
      tower.push(makeStone(m.x, m.w, m.lvl, m));
      rings.push({ x: m.x, y: levelY(m.lvl), w: m.w, t: 0 });
      pops = [{ s: combo > 1 ? `PERFECT x${combo}` : "PERFECT", x: m.x + m.w / 2, y: levelY(m.lvl) - 6, t: 0, c: "#fff2a0" }];
      freeze = 3;
      for (let i = 0; i < 10; i++) parts.push({ x: m.x + Math.random() * m.w, y: levelY(m.lvl), vx: rand(-0.6, 0.6), vy: rand(-1.4, -0.4), life: 24, c: FIRE[1 + (i % 2)] });
    } else {
      const left = Math.max(m.x, top.x), right = Math.min(m.x + m.w, top.x + top.w), w = right - left;
      combo = 0;
      if (w <= 0) return lose(m);
      const keepFrom = Math.round(left - m.x), cutFromLeft = m.x < top.x;
      const kept = crop(m.img, keepFrom, Math.round(w), !cutFromLeft);
      const offW = Math.round(m.w - w), offX = cutFromLeft ? 0 : Math.round(w);
      debris.push({
        img: crop(m.img, offX, offW, cutFromLeft), x: cutFromLeft ? m.x : left + w, y: levelY(m.lvl), w: offW,
        vx: (cutFromLeft ? -0.5 : 0.5) + m.dir * 0.3, vy: -0.6, a: 0, va: (cutFromLeft ? -1 : 1) * rand(0.04, 0.08),
      });
      tower.push({ x: left, w, lvl: m.lvl, kind: m.kind, label: m.label, img: kept });
      shake = 3;
      dust(cutFromLeft ? left : left + w, levelY(m.lvl) + SH - 2, KINDS[m.kind].stone[3]);
    }
    score++;
    squash = 6;
    speed = Math.min(3.1, speed + 0.045);
    camT = Math.max(0, (tower.length - 1) * SH - (GROUND - 150));
    if (score > best) { best = score; newBest = true; }
    spawn();
  }
  function lose(m: Mover) {
    debris.push({ img: m.img, x: m.x, y: levelY(m.lvl), w: m.w, vx: m.dir * 0.8, vy: -0.4, a: 0, va: m.dir * 0.05 });
    mover = null;
    state = "over"; stateT = 0; shake = 8;
    dust(m.x + m.w / 2, levelY(m.lvl) + SH, "#c9b48a");
  }
  function dust(x: number, y: number, c: string) {
    for (let i = 0; i < 12; i++) parts.push({ x: x + rand(-3, 3), y, vx: rand(-1, 1), vy: rand(-1, 0), life: 20 + (i % 8), c: i % 3 ? c : "#e8e0cc" });
  }
  function tap() {
    if (state === "title" || (state === "over" && stateT > 40)) { state = "play"; stateT = 0; reset(); }
    else if (state === "play") drop();
  }

  function update() {
    t++; stateT++;
    if (freeze > 0) { freeze--; return; }
    if (state === "play" && mover) {
      mover.x += mover.dir * speed;
      const lo = -mover.w * 0.6, hi = W - mover.w * 0.4;
      if (mover.x < lo) { mover.x = lo; mover.dir = 1; }
      else if (mover.x > hi) { mover.x = hi; mover.dir = -1; }
    }
    if (state === "title") camT = 0;
    cam += (camT - cam) * 0.12;
    for (const d of debris) { d.vy += 0.16; d.x += d.vx; d.y += d.vy; d.a += d.va; }
    debris = debris.filter((d) => d.y < H + 40);
    for (const p of parts) { p.vy += 0.06; p.x += p.vx; p.y += p.vy; p.life--; }
    parts = parts.filter((p) => p.life > 0);
    for (const r of rings) r.t++;
    rings = rings.filter((r) => r.t < 16);
    for (const p of pops) p.t++;
    pops = pops.filter((p) => p.t < 50);
    if (shake > 0) shake -= 0.5;
    if (squash > 0) squash--;
  }

  // ── Sky, hills, ground ─────────────────────────────────────────────────────
  function drawSky(f: number) {
    const buf = scr.buf, [top, bot] = skyAt(f), steps = 7, cols: number[] = [];
    for (let i = 0; i <= steps; i++) cols.push(u32(lerpHex(top, bot, i / steps)));
    for (let y = 0; y < H; y++) {
      const q = (y / H) * steps, lo = q | 0, fr = q - lo;
      for (let x = 0; x < W; x++) buf[y * W + x] = cols[fr > BAYER[(y & 3) * 4 + (x & 3)] ? Math.min(steps, lo + 1) : lo];
    }
    blit();
    // Stars fade in after dusk and drift slowly with the climb.
    const sa = clamp((f - 0.55) / 0.3, 0, 1);
    if (sa > 0)
      for (let i = 0; i < 70; i++) {
        const x = (hash2(i, 1, 9) * W) | 0, y = ((hash2(i, 2, 9) * H * 1.4 + cam * 0.08) % (H * 1.4)) | 0;
        if (y >= H || hash2(i, 3, 9) > sa) continue;
        const tw = (t + i * 13) % 90 < 6;
        px(x, y, tw ? "#ffffff" : hash2(i, 4, 9) > 0.7 ? "#c7e4ff" : "#8b93b8");
      }
    // The sun sinks as you climb; the moon rises after.
    const sy = 40 + f * 330 + cam * 0.02;
    if (sy < H) disc(Math.round(W * 0.73), sy, 9, "#fff2a0", "#ffd36b");
    const my = 300 - (f - 0.6) * 520;
    if (f > 0.6 && my > -20) disc(Math.round(W * 0.24), my, 7, "#e8ecf5", "#b8c2d6");
  }
  function disc(cx: number, cy: number, r: number, c: string, edge: string) {
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        const d = x * x + y * y;
        if (d <= r * r) px(cx + x, cy + y, d > (r - 1.5) * (r - 1.5) ? edge : c);
      }
  }
  function hills(par: number, base: number, amp: number, freq: number, s: number, col: string) {
    const oy = base + cam * par;
    if (oy - amp > H) return;
    ctx.fillStyle = col;
    for (let x = 0; x < W; x++) {
      const y = Math.round(oy - fbm(x * freq, 3.3, s) * amp);
      if (y < H) ctx.fillRect(x, y, 1, H - y);
    }
  }
  function drawGround(f: number) {
    const bot = skyAt(f)[1], haze = (c: string, k: number) => lerpHex(c, bot, k);
    hills(0.18, H - 90, 70, 0.018, 21, haze("#3d5a74", 0.55));
    hills(0.32, H - 64, 46, 0.03, 22, haze("#2f5b4f", 0.35));
    hills(0.55, H - 46, 26, 0.05, 23, haze("#3f7a36", 0.12));
    // Ground under the cairn: grass lip, dithered soil, pebbles.
    const gy = Math.round(GROUND + cam);
    if (gy < H) {
      const buf = scr.buf;
      for (let y = gy; y < H; y++)
        for (let x = 0; x < W; x++) {
          const d = y - gy;
          let c = d < 2 ? "#7cc46a" : d < 4 ? (BAYER[(y & 3) * 4 + (x & 3)] > 0.5 ? "#5a9a4c" : "#4d8a42") : d < 6 ? "#5a4433" : "#4a3729";
          if (d >= 6 && hash2(x, y - Math.round(cam), 4) < 0.05) c = "#6b5440";
          buf[y * W + x] = u32(c);
        }
      ctx.putImageData(scr.img, 0, 0, 0, gy, W, H - gy);
      for (let i = 0; i < 26; i++) {
        const x = (hash2(i, 5, 2) * W) | 0;
        px(x, gy - 1, "#9fe08a");
        if (i % 3 === 0) px(x + 1, gy - 2, "#9fe08a");
      }
    }
  }
  const cloudLayer = Array.from({ length: 7 }, (_, i) => ({ c: clouds()[i % 10], x: hash2(i, 6, 1) * (W + 60) - 30, y: -i * 140 + 120, v: 0.08 + hash2(i, 7, 1) * 0.12 }));
  function drawClouds(f: number) {
    ctx.globalAlpha = 0.85 - clamp(f - 0.6, 0, 0.5);
    for (const c of cloudLayer) {
      const x = ((c.x + t * c.v) % (W + 80)) - 40, y = c.y + cam * 0.45;
      if (y < -60 || y > H) continue;
      ctx.drawImage(c.c.c, Math.round(x), Math.round(y));
    }
    ctx.globalAlpha = 1;
  }

  const demo = ([["WORKSPACE", "project", 104], ["RELEASE CHECKLIST", "note", 92], ["FIX SYNC CONFLICT", "card", 84], ["URGENT", "tag", 70], ["CAIRN", "project", 58]] as const)
    .map(([label, kind, w], i) => {
      const l = i === 0 ? { label, kind } : labels.find((x) => x.kind === kind) ?? { label, kind };
      return { w, img: stoneSprite(w, l.kind, l.label, i * 7 + 3) };
    });

  function render() {
    const f = cam / (SH * 70);
    scr.sx = scr.sy = 0;
    drawSky(f);
    drawClouds(f);
    drawGround(f);
    scr.sx = shake > 0 ? Math.round(rand(-shake, shake)) : 0;
    scr.sy = shake > 0 ? Math.round(rand(-shake, shake) * 0.5) : 0;
    const SX = scr.sx, SY = scr.sy;

    if (state === "title") return renderTitle();

    // Tower: only what's on screen. The newest stone squashes on landing.
    for (let i = 0; i < tower.length; i++) {
      const s = tower[i], y = levelY(s.lvl);
      if (y > H || y < -SH) continue;
      const sq = i === tower.length - 1 && squash > 0 ? 1 : 0;
      ctx.drawImage(s.img, Math.round(s.x) + SX, Math.round(y) + SY + sq);
    }
    if (mover) {
      const top = tower[tower.length - 1], y = levelY(mover.lvl);
      const l = Math.max(mover.x, top.x), r = Math.min(mover.x + mover.w, top.x + top.w);
      if (r > l) { ctx.globalAlpha = 0.25; ctx.fillStyle = INK; ctx.fillRect(Math.round(l), Math.round(y) + SH + 1, Math.round(r - l), 2); ctx.globalAlpha = 1; }
      const bob = Math.round(Math.sin(t * 0.12) * 0.6);
      ctx.drawImage(mover.img, Math.round(mover.x) + SX, Math.round(y) + bob + SY - 1);
    }
    for (const d of debris) {
      ctx.setTransform(Math.cos(d.a), Math.sin(d.a), -Math.sin(d.a), Math.cos(d.a), Math.round(d.x + d.w / 2) + SX, Math.round(d.y + SH / 2) + SY);
      ctx.drawImage(d.img, -Math.round(d.w / 2), -Math.round(SH / 2));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    for (const r of rings) {
      const g = r.t;
      ctx.globalAlpha = 1 - g / 16;
      ctx.strokeStyle = "#fff2a0";
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(r.x - g) + 0.5, Math.round(r.y - g * 0.5) + 0.5, Math.round(r.w + g * 2) - 1, SH + g - 1);
      ctx.globalAlpha = 1;
    }
    for (const p of parts) px(p.x, p.y, p.c);
    for (const p of pops) {
      if (p.t > 40 && p.t & 2) continue;
      drawTextC(p.s, clamp(p.x, 30, W - 30), Math.round(p.y - Math.min(p.t, 20) * 0.6), p.c);
    }

    scr.sx = scr.sy = 0;
    drawTextC(String(score), W / 2, 14, "#ffffff", 3);
    drawTextC(`BEST ${best}`, W / 2, 34, newBest ? "#fff2a0" : "#c7d0e6");
    if (state === "over") {
      band(118, 64, 0.6);
      drawTextC("TOPPLED", W / 2, 126, "#ef5a24", 3);
      drawTextC(score === 1 ? "1 STONE" : `${score} STONES`, W / 2, 150, "#ffffff");
      if (newBest) drawTextC("NEW BEST!", W / 2, 160, "#fff2a0");
      if (stateT > 40 && (t >> 5) & 1) drawTextC("CLICK TO RETRY", W / 2, 170, "#c7d0e6");
    }
  }
  function renderTitle() {
    demo.forEach((d, i) => {
      const sway = i === demo.length - 1 ? Math.round(Math.sin(t * 0.05) * 3) : 0;
      ctx.drawImage(d.img, Math.round((W - d.w) / 2) + sway + (i % 2 ? 2 : -1), GROUND - (i + 1) * SH);
    });
    band(70, 52, 0.45);
    drawTextC("CAIRN", W / 2, 76, "#fff2a0", 4);
    drawTextC("STACKER", W / 2, 100, "#ffffff", 2);
    if ((t >> 5) & 1) drawTextC("CLICK OR SPACE TO STACK", W / 2, 160, "#ffffff");
    drawTextC(`BEST ${best}`, W / 2, 174, "#c7d0e6");
  }

  return {
    update,
    render,
    down() { tap(); },
    move() {},
    up() {},
    key(code, down) {
      if (down && (code === "Space" || code === "Enter")) { tap(); return true; }
      return code === "Space";
    },
    resize(prevW) {
      const dx = (W - prevW) / 2;
      if (!dx) return;
      for (const s of tower) s.x += dx;
      if (mover) mover.x += dx;
      for (const d of debris) d.x += dx;
      for (const r of rings) r.x += dx;
      for (const p of parts) p.x += dx;
      for (const p of pops) p.x += dx;
    },
    get best() { return best; },
  };
};
