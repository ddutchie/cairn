/**
 * Inbox Zero renderer — extends PixelPainter for Canvas2D & Skia parity.
 */

import type { Priority } from "../../types/domain";
import { fontSafe } from "../pixel/font";
import { hudFrame, type PixelHud } from "../pixel/hud";
import { INK, PixelPainter, type AtlasHandle, type PixelBackend } from "../pixel/painter";
import { hash2 } from "../pixel/terrain";
import {
  CARD_MODELS,
  CELL,
  CORE_GY,
  CORE_SEGMENTS,
  PATH_LEN,
  PRIO,
  TAGS,
  TOWER_MODELS,
  alongFlow,
  canBuildCore,
  type TagId,
} from "./models";
import type { Card, InboxZeroSim, Tower } from "./sim";

function hexBytes(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class InboxZeroRenderer<Img = unknown, Frame = unknown> extends PixelPainter<Img, Frame> {
  private readonly sim: InboxZeroSim;
  private readonly cardAtlases: Record<Priority, AtlasHandle<Img>>;
  private readonly towerAtlases: Record<TagId, AtlasHandle<Img>[]>;

  private boardImg: Img | null = null;
  private bakedGen = -1;

  constructor(backend: PixelBackend<Img, Frame>, sim: InboxZeroSim) {
    super(backend, sim.W, sim.H);
    this.sim = sim;
    this.cardAtlases = {
      low: this.makeAtlas(CARD_MODELS.low),
      medium: this.makeAtlas(CARD_MODELS.medium),
      high: this.makeAtlas(CARD_MODELS.high),
      urgent: this.makeAtlas(CARD_MODELS.urgent),
    };
    this.towerAtlases = {
      quick: TOWER_MODELS.quick.map((m) => this.makeAtlas(m)),
      bug: TOWER_MODELS.bug.map((m) => this.makeAtlas(m)),
      focus: TOWER_MODELS.focus.map((m) => this.makeAtlas(m)),
      batch: TOWER_MODELS.batch.map((m) => this.makeAtlas(m)),
    };
    this.bakeBoard();
  }

  override resize(width: number, height: number, hud?: PixelHud): void {
    this.sim.resize(width, height, hud);
    super.resize(width, height);
  }

  private bakeBoard(): void {
    const s = this.sim;
    const lay = s.lay;
    this.bakedGen = s.boardGen;
    const W = s.W, H = s.H;
    const buf = new Uint8Array(W * H * 4);

    const fill = (x0: number, y0: number, rw: number, rh: number, col: string) => {
      const [r, g, b] = hexBytes(col);
      const x1 = Math.min(W, Math.round(x0 + rw));
      const y1 = Math.min(H, Math.round(y0 + rh));
      for (let y = Math.max(0, Math.round(y0)); y < y1; y++) {
        for (let x = Math.max(0, Math.round(x0)); x < x1; x++) {
          const i = (y * W + x) * 4;
          buf[i] = r;
          buf[i + 1] = g;
          buf[i + 2] = b;
          buf[i + 3] = 255;
        }
      }
    };

    fill(0, 0, W, H, "#151b2e");
    const [sr, sg, sb] = hexBytes("#1a2138");
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (hash2(x, y, 5) < 0.05) {
          const i = (y * W + x) * 4;
          buf[i] = sr;
          buf[i + 1] = sg;
          buf[i + 2] = sb;
          buf[i + 3] = 255;
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      const x0 = Math.round((i * W) / 3);
      const x1 = Math.round(((i + 1) * W) / 3);
      fill(x0, lay.topY, x1 - x0, CORE_GY * CELL, i % 2 ? "#171e33" : "#141a2c");
    }
    for (let r = 0; r < CORE_GY; r++) {
      for (let c = lay.minC; c <= lay.maxC; c++) {
        if (canBuildCore(c, r)) fill(lay.coreX + c * CELL + 6, lay.topY + r * CELL + 6, 1, 1, "#26304d");
      }
    }
    for (const { a, b } of CORE_SEGMENTS) {
      const ax = a.x + lay.coreX, ay = a.y + lay.topY;
      const bx = b.x + lay.coreX, by = b.y + lay.topY;
      const x0 = Math.min(ax, bx) - 5, y0 = Math.min(ay, by) - 5;
      const rw = Math.abs(bx - ax) + 10, rh = Math.abs(by - ay) + 10;
      fill(x0 - 1, y0 - 1, rw + 2, rh + 3, "#0b1020");
      fill(x0, y0, rw, rh, "#2a3350");
      fill(x0, y0, rw, 1, "#35406a");
    }
    for (let d = 6; d < PATH_LEN; d += 12) {
      const p = alongFlow(d, lay);
      const cs = Math.cos(p.dir), sn = Math.sin(p.dir);
      for (const [lx, ly] of [[0, -1], [-1, 0], [1, 0], [-2, 1], [2, 1]] as const) {
        fill(p.x + lx * cs - ly * sn, p.y + lx * sn + ly * cs, 1, 1, "#3d4a78");
      }
    }
    const deadY = lay.topY + CORE_GY * CELL - 2;
    fill(0, deadY, W, 2, "#3a1424");
    for (let x = 0; x < W; x += 4) fill(x, deadY, 2, 1, "#ff3d6e");

    this.boardImg = this.makeImage(W, H, buf);
  }

  private heart(x: number, y: number, c: string): void {
    this.rect(x, y, 2, 1, c);
    this.rect(x + 3, y, 2, 1, c);
    this.rect(x, y + 1, 5, 1, c);
    this.rect(x + 1, y + 2, 3, 1, c);
    this.rect(x + 2, y + 3, 1, 1, c);
  }

  draw(): Frame {
    const s = this.sim;
    if (this.bakedGen !== s.boardGen || !this.boardImg) this.bakeBoard();
    const lay = s.lay;
    this.SX = s.shake > 0 ? Math.round((s.rand() * 2 - 1) * s.shake) : 0;
    this.SY = 0;

    if (this.boardImg) this.image(this.boardImg, this.SX, 0);
    ["TO DO", "DOING", "REVIEW"].forEach((lbl, i) => {
      this.textC(lbl, Math.round(((i + 0.5) * s.W) / 3), lay.topY + 2, "#3a4670", 1, null);
    });

    const showPreview = s.cursor && s.state !== "title" && s.cursor.y < lay.shopY && (s.inputMode === "pointer" || s.dragging);
    if (showPreview && s.cursor) {
      const c = Math.floor((s.cursor.x - lay.coreX) / CELL);
      const r = Math.floor((s.cursor.y - lay.topY) / CELL);
      if (c >= lay.minC && c <= lay.maxC && r >= 0 && r < CORE_GY) {
        const tw = s.tagAt(c, r);
        const cx = lay.coreX + c * CELL;
        const cy = lay.topY + r * CELL;
        if (tw) {
          const tg = TAGS.find((t) => t.id === tw.id)!;
          const nextLvl = Math.min(2, tw.lvl + 1);
          const nextRange = tg.range * (1 + nextLvl * 0.15);
          const cost = Math.round(tg.cost * (tw.lvl + 1) * 0.8);
          const ok = tw.lvl < 2 && s.focus >= cost;
          this.strokeRect(cx, cy, CELL, CELL, ok ? "#fff2a0" : "#ff5e8a");
          this.circle(cx + 6, cy + 6, nextRange, ok ? tg.c : "#ff5e8a", 0.14);
          this.circle(cx + 6, cy + 6, nextRange, ok ? "#fff2a0" : "#ff5e8a", 0.45, true);
        } else if (canBuildCore(c, r)) {
          const tg = TAGS[s.picked];
          const ok = s.focus >= tg.cost;
          this.strokeRect(cx, cy, CELL, CELL, ok ? "#8dff9a" : "#ff5e8a");
          this.circle(cx + 6, cy + 6, tg.range, ok ? tg.c : "#ff5e8a", 0.14);
          this.circle(cx + 6, cy + 6, tg.range, ok ? "#8dff9a" : "#ff5e8a", 0.45, true);
        } else {
          this.strokeRect(cx, cy, CELL, CELL, "#ff5e8a");
        }
      }
    }

    for (const c of s.cards) {
      this.shadow(this.cardAtlases[c.pr], c.x, c.y, c.dir + Math.sin(s.t * 0.2 + c.d) * 0.08, 2, 3, 0.35);
    }
    for (const tw of s.towers) {
      this.shadow(this.towerAtlases[tw.id][tw.lvl], tw.x, tw.y, tw.a, 3, 4, 0.35);
    }

    const things: ({ y: number; c: Card } | { y: number; tw: Tower })[] = [
      ...s.cards.map((c) => ({ y: c.y, c })),
      ...s.towers.map((tw) => ({ y: tw.y, tw })),
    ].sort((a, b) => a.y - b.y);

    for (const th of things) {
      if ("c" in th) {
        const c = th.c;
        const bob = Math.abs(Math.sin(s.t * 0.2 + c.d)) * 1.2;
        this.stack(this.cardAtlases[c.pr], c.x, c.y - bob, c.dir + Math.sin(s.t * 0.2 + c.d) * 0.08, { flash: c.flash > 0 });
        if (c.slow > 0 && (s.t >> 2) & 1) this.px(c.x - 5, c.y - 8 - bob, "#ffd2f0");
        if (c.hp < c.max) {
          this.rect(Math.round(c.x) - 5 + this.SX, Math.round(c.y) + 6, 10, 2, INK);
          this.rect(Math.round(c.x) - 5 + this.SX, Math.round(c.y) + 6, Math.max(1, Math.round((10 * c.hp) / c.max)), 1, PRIO[c.pr].h);
        }
      } else {
        const tw = th.tw, k = tw.kick;
        this.stack(this.towerAtlases[tw.id][tw.lvl], tw.x - Math.sin(tw.a) * k * 0.4, tw.y + Math.cos(tw.a) * k * 0.4, tw.a);
        for (let i = 0; i < tw.lvl; i++) this.px(tw.x - 4 + i * 3, tw.y + 5, "#fff2a0");
      }
    }

    for (const sh of s.shots) {
      if (sh.beam) {
        this.line(sh.x, sh.y, sh.tx ?? sh.x, sh.ty ?? sh.y, sh.c, sh.life / 6);
      } else if (sh.T?.splash) {
        this.px(sh.x, sh.y + 3, INK);
        this.px(sh.x - 1, sh.y - 1, sh.c, 3);
      } else {
        this.px(sh.x, sh.y, sh.c, sh.T?.slow ? 2 : 1);
      }
    }
    for (const p of s.parts) this.px(p.x, p.y, p.c);
    for (const r of s.rings) {
      const n = Math.max(8, r.r * 5);
      const a = 1 - r.r / 14;
      for (let i = 0; i < n; i++) {
        this.px(r.x + Math.cos((i / n) * 6.283) * r.r, r.y + Math.sin((i / n) * 6.283) * r.r * 0.8, r.c, 1, a);
      }
    }
    for (const c of s.cards) {
      if (c.title && (c.pr === "urgent" || c.pr === "high")) {
        const lbl = PixelPainter.clip(fontSafe(c.title), 14);
        this.textIn(lbl, c.x, c.y - 16, c.pr === "urgent" ? "#ffb4a8" : "#ffe7a8");
      }
    }
    for (const p of s.pops) {
      if (p.t > 46 && (p.t & 2)) continue;
      const lbl = PixelPainter.clip(`${p.s}: ${fontSafe(p.title)}`, 30);
      this.textIn(lbl, p.x, Math.round(p.y - p.t * 0.3), p.c);
    }

    this.SX = 0;
    if (s.state === "title") {
      this.band(lay.topY + 34, 64, 0.75);
      this.textC("TOWER DEFENCE FOR YOUR BOARD", s.W / 2, lay.topY + 40, "#c9d3ea");
      this.textC("INBOX", s.W / 2, lay.topY + 52, "#ffffff", 3);
      this.textC("ZERO", s.W / 2, lay.topY + 72, "#8dff9a", 3);
      this.band(lay.topY + 124, 92, 0.75);
      TAGS.forEach((tg, i) => {
        const x = Math.round(s.W / 2 + (i - 1.5) * Math.min(44, (s.W - 12) / 4));
        this.stack(this.towerAtlases[tg.id][1], x, lay.topY + 150, Math.sin(s.t * 0.03 + i) * 0.8);
        this.textC(tg.name, x, lay.topY + 162, tg.l);
      });
      this.textC("PIN TAGS BESIDE THE FLOW", s.W / 2, lay.topY + 176, "#ffffff");
      this.textC("TRIAGE TASKS BEFORE THE DEADLINE", s.W / 2, lay.topY + 186, "#ffffff");
      const upgradeCopy = s.inputMode === "pointer" ? "CLICK A TAG TO UPGRADE IT" : "DRAG TO PREVIEW · TAP A TAG TO UPGRADE";
      this.textC(upgradeCopy, s.W / 2, lay.topY + 196, "#7f8aa6");
      if ((s.t >> 5) & 1) {
        this.textC(s.inputMode === "pointer" ? "CLICK TO START" : "TAP TO START", s.W / 2, lay.shopY - 26, "#ffffff", 2);
      }
      const bestLine = s.inputMode === "pointer" ? `BEST ${s.best}   KEYS 1-4 PICK A TAG` : `BEST ${s.best}`;
      this.textC(bestLine, s.W / 2, lay.shopY - 8, "#c7d0e6");
      return this.snapshot();
    }

    // Top HUD.
    this.band(0, lay.topY, 0.7);
    const row = hudFrame(s.hud, s.W, s.H).top, hx = row.lx, hy = row.y;
    for (let i = 0; i < 5; i++) this.heart(hx + i * 7, hy, i < s.hearts ? "#ff5e8a" : "#3a3f55");
    const focStr = `FOCUS ${s.focus}`;
    this.text(focStr, row.rx - focStr.length * 4, hy, "#fff2a0");

    const wv = s.waves[Math.min(s.wave, s.waves.length - 1)];
    const r2Y = hy + 10;
    this.text(`${Math.min(s.wave + 1, s.waves.length)}/${s.waves.length}`, hx, r2Y, "#c9d3ea");
    const left = s.queue.length + s.cards.length;
    const leftS = `${left} LEFT`;
    const room = Math.max(6, Math.floor((row.rx - hx - leftS.length * 4 - 28) / 4));
    this.text(PixelPainter.clip(fontSafe(wv.name), room), hx + 18, r2Y, wv.accent);
    this.text(leftS, row.rx - leftS.length * 4, r2Y, "#7f8aa6");

    // Bottom tag shop.
    const sw = lay.shopW, sx0 = lay.shopX0, pad = Math.max(0, Math.floor((sw - 41) / 2));
    this.rect(0, lay.shopY - 2, s.W, s.H - lay.shopY + 2, "#0b1020");
    TAGS.forEach((tg, i) => {
      const x = sx0 + i * sw, sel = i === s.picked, can = s.focus >= tg.cost;
      this.rect(x + 1, lay.shopY, sw - 2, lay.shopH - 2, sel ? tg.c : "#1b2236");
      this.rect(x + 2, lay.shopY + 1, sw - 4, lay.shopH - 4, sel ? "#0b1020" : "#141a2c");
      const stackY = lay.shopY + Math.min(18, Math.round(lay.shopH * 0.5));
      this.stack(this.towerAtlases[tg.id][0], x + pad + 9, stackY, -0.5 + Math.sin(s.t * 0.05 + i) * 0.3);
      this.text(tg.name.slice(1), x + pad + 17, lay.shopY + 4, can ? tg.l : "#59607a", 1, null);
      this.text(tg.blurb, x + pad + 17, lay.shopY + 12, "#7f8aa6", 1, null);
      this.text(String(tg.cost), x + pad + 17, lay.shopY + 20, can ? "#fff2a0" : "#59607a", 1, null);
    });

    const cy = lay.topY + 90;
    if (s.state === "intro") {
      this.band(cy - 6, 50, 0.65);
      this.textC(`PROJECT ${s.wave + 1} OF ${s.waves.length}`, s.W / 2, cy, "#c9d3ea");
      const wv2 = s.waves[s.wave];
      const nameClean = fontSafe(wv2.name);
      const big = nameClean.length * 8 < s.W - 8;
      this.textC(nameClean, s.W / 2, cy + 11, wv2.accent, big ? 2 : 1);
      this.textC(`${wv2.tasks.length} TASKS INCOMING`, s.W / 2, cy + 30, "#ffffff");
    }
    if (s.toast) this.textC(s.toast.s, s.W / 2, lay.shopY - 10, "#ffffff");
    if (s.state === "over" || s.state === "win") {
      this.band(cy - 10, 74, 0.75);
      if (s.state === "win") {
        this.textC("INBOX ZERO!", s.W / 2, cy - 2, "#8dff9a", 2);
        this.textC("EVERY PROJECT TRIAGED", s.W / 2, cy + 18, "#ffffff");
      } else {
        this.textC("SNOWED UNDER", s.W / 2, cy - 2, "#ff5e8a", 2);
        this.textC(`${s.leaked} TASKS WENT OVERDUE`, s.W / 2, cy + 18, "#ffffff");
      }
      this.textC(`${s.triaged} TRIAGED  SCORE ${s.score}`, s.W / 2, cy + 30, "#fff2a0");
      this.textC(`BEST ${s.best}`, s.W / 2, cy + 40, "#c7d0e6");
      if (s.stateT > 60 && (s.t >> 5) & 1) {
        this.textC(s.inputMode === "pointer" ? "CLICK TO PLAY AGAIN" : "TAP TO PLAY AGAIN", s.W / 2, cy + 54, "#c7d0e6");
      }
    }
    return this.snapshot();
  }
}
