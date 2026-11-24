/**
 * Inbox Zero Skia renderer: bakes the Kanban backdrop and centered serpentine
 * flow once per playfield size, then draws cards, towers, shots, rings,
 * floating labels, and the bottom tag shop each frame.
 */

import { Skia, type SkCanvas, type SkImage } from "@shopify/react-native-skia";
import type { Priority } from "@cairn/shared/types/domain";
import { clip, textWidth } from "@/games/pixel/font";
import { INK, PixelPainter, stackAtlas, type StackAtlas } from "@/games/pixel/painter";
import { hash2, mulberry32 } from "@/games/pixel/terrain";
import { CARD_MODELS, PRIO, TAGS, TOWER_MODELS, type TagId } from "./models";
import { CELL, CORE_GY, CORE_SEG, InboxZeroSim, PATH_LEN, canBuildCore } from "./sim";

export class InboxZeroRenderer extends PixelPainter {
  private readonly sim: InboxZeroSim;
  private readonly cards: Record<Priority, StackAtlas>;
  private readonly towers: Record<TagId, StackAtlas[]>;
  private readonly board: SkImage;
  private readonly fx = mulberry32(17);

  constructor(sim: InboxZeroSim) {
    super(sim.W, sim.H);
    this.sim = sim;
    this.cards = {
      low: stackAtlas(CARD_MODELS.low),
      medium: stackAtlas(CARD_MODELS.medium),
      high: stackAtlas(CARD_MODELS.high),
      urgent: stackAtlas(CARD_MODELS.urgent),
    };
    this.towers = Object.fromEntries(
      TAGS.map((t) => [t.id, TOWER_MODELS[t.id].map((m) => stackAtlas(m))]),
    ) as Record<TagId, StackAtlas[]>;
    this.board = this.bakeBoard();
  }

  private bakeBoard(): SkImage {
    const s = this.sim, W = this.W, H = this.H;
    const surf = Skia.Surface.Make(W, H);
    if (!surf) throw new Error("inbox-zero: board surface allocation failed");
    const cv = surf.getCanvas();
    this.rect(cv, 0, 0, W, H, "#151b2e");
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (hash2(x, y, 5) < 0.05) cv.drawRect(Skia.XYWHRect(x, y, 1, 1), this.paint("#1a2138"));

    const boardH = CORE_GY * CELL;
    for (let i = 0; i < 3; i++) {
      const x0 = Math.round((i * W) / 3), x1 = Math.round(((i + 1) * W) / 3);
      this.rect(cv, x0, s.coreY, x1 - x0, boardH, i % 2 ? "#171e33" : "#141a2c");
    }

    const dotP = this.paint("#26304d");
    for (let r = 0; r < CORE_GY; r++)
      for (let c = s.minC; c <= s.maxC; c++)
        if (canBuildCore(c, r)) cv.drawRect(Skia.XYWHRect(s.coreX + c * CELL + 6, s.coreY + r * CELL + 6, 1, 1), dotP);

    for (const { a, b } of CORE_SEG) {
      const ax = a.x + s.coreX, bx = b.x + s.coreX, ay = a.y + s.coreY, by = b.y + s.coreY;
      const x0 = Math.min(ax, bx) - 5, y0 = Math.min(ay, by) - 5, w = Math.abs(bx - ax) + 10, h = Math.abs(by - ay) + 10;
      this.rect(cv, x0 - 1, y0 - 1, w + 2, h + 3, "#0b1020");
      this.rect(cv, x0, y0, w, h, "#2a3350");
      this.rect(cv, x0, y0, w, 1, "#35406a");
    }

    const arrowP = this.paint("#3d4a78");
    for (let d = 6; d < PATH_LEN; d += 12) {
      const p = s.along(d), c = Math.cos(p.dir), sn = Math.sin(p.dir);
      for (const [lx, ly] of [[0, -1], [-1, 0], [1, 0], [-2, 1], [2, 1]]) {
        cv.drawRect(Skia.XYWHRect(Math.round(p.x + lx * c - ly * sn), Math.round(p.y + lx * sn + ly * c), 1, 1), arrowP);
      }
    }

    // Deadline at the bottom of the flow.
    const deadY = s.coreY + boardH - 2;
    this.rect(cv, 0, deadY, W, 2, "#3a1424");
    for (let x = 0; x < W; x += 4) this.rect(cv, x, deadY, 2, 1, "#ff3d6e");
    return surf.makeImageSnapshot();
  }

  private heart(cv: SkCanvas, x: number, y: number, c: string): void {
    this.rect(cv, x, y, 2, 1, c);
    this.rect(cv, x + 3, y, 2, 1, c);
    this.rect(cv, x, y + 1, 5, 1, c);
    this.rect(cv, x + 1, y + 2, 3, 1, c);
    this.rect(cv, x + 2, y + 3, 1, 1, c);
  }

  draw(): SkImage {
    const s = this.sim, W = this.W, t = s.t, cv = this.canvas();
    this.SX = s.shake > 0 ? Math.round((this.fx() * 2 - 1) * s.shake) : 0;
    this.SY = 0;
    cv.drawImage(this.board, this.SX, 0);

    ["TO DO", "DOING", "REVIEW"].forEach((lbl, i) => {
      this.textC(cv, lbl, Math.round(((i + 0.5) * W) / 3), s.coreY + 2, "#3a4670", 1, null);
    });

    for (const c of s.cards) this.shadow(cv, this.cards[c.pr], c.x, c.y, c.dir + Math.sin(t * 0.2 + c.d) * 0.08, 2, 3, 0.35);
    for (const tw of s.towers) this.shadow(cv, this.towers[tw.id][tw.lvl], tw.x, tw.y, tw.a, 3, 4, 0.35);

    const things: ({ y: number; c: (typeof s.cards)[number] } | { y: number; tw: (typeof s.towers)[number] })[] = [
      ...s.cards.map((c) => ({ y: c.y, c })),
      ...s.towers.map((tw) => ({ y: tw.y, tw })),
    ].sort((a, b) => a.y - b.y);

    for (const th of things) {
      if ("c" in th) {
        const c = th.c, bob = Math.abs(Math.sin(t * 0.2 + c.d)) * 1.2;
        this.stack(cv, this.cards[c.pr], c.x, c.y - bob, c.dir + Math.sin(t * 0.2 + c.d) * 0.08, { flash: c.flash > 0 });
        if (c.slow > 0 && (t >> 2) & 1) this.px(cv, c.x - 5, c.y - 8 - bob, "#ffd2f0");
        if (c.hp < c.max) {
          this.rect(cv, Math.round(c.x) - 5 + this.SX, Math.round(c.y) + 6, 10, 2, INK);
          this.rect(cv, Math.round(c.x) - 5 + this.SX, Math.round(c.y) + 6, Math.max(1, Math.round((10 * c.hp) / c.max)), 1, PRIO[c.pr].h);
        }
      } else {
        const tw = th.tw, k = tw.kick;
        this.stack(cv, this.towers[tw.id][tw.lvl], tw.x - Math.sin(tw.a) * k * 0.4, tw.y + Math.cos(tw.a) * k * 0.4, tw.a);
        for (let i = 0; i < tw.lvl; i++) this.px(cv, tw.x - 4 + i * 3, tw.y + 5, "#fff2a0");
      }
    }

    for (const sh of s.shots) {
      if (sh.beam) {
        const p = this.paint(sh.c, sh.life / 6);
        p.setStrokeWidth(1);
        cv.drawLine(sh.x + 0.5, sh.y + 0.5, (sh.tx ?? sh.x) + 0.5, (sh.ty ?? sh.y) + 0.5, p);
      } else if (sh.T?.splash) {
        this.px(cv, sh.x, sh.y + 3, INK);
        this.px(cv, sh.x - 1, sh.y - 1, sh.c, 3);
      } else {
        this.px(cv, sh.x, sh.y, sh.c, sh.T?.slow ? 2 : 1);
      }
    }
    for (const p of s.parts) this.px(cv, p.x, p.y, p.c);
    for (const r of s.rings) {
      const n = Math.max(8, r.r * 5), a = Math.max(0, 1 - r.r / 14);
      for (let i = 0; i < n; i++) this.px(cv, r.x + Math.cos((i / n) * 6.283) * r.r, r.y + Math.sin((i / n) * 6.283) * r.r * 0.8, r.c, 1, a);
    }
    for (const c of s.cards) {
      if (c.title && (c.pr === "urgent" || c.pr === "high")) {
        this.textIn(cv, clip(c.title, 14), c.x, c.y - 16, c.pr === "urgent" ? "#ffb4a8" : "#ffe7a8");
      }
    }
    for (const p of s.pops) {
      if (p.t > 46 && p.t & 2) continue;
      this.textIn(cv, clip(`${p.s}: ${p.title}`, 30), p.x, Math.round(p.y - p.t * 0.3), p.c);
    }

    this.SX = this.SY = 0;
    if (s.state === "title") this.renderTitle(cv);
    else this.renderHud(cv);
    return this.snapshot();
  }

  private renderHud(cv: SkCanvas): void {
    const s = this.sim, W = this.W, H = this.H, t = s.t, hud = s.hud;
    const lx = Math.max(4, hud.left + 4), rx = W - Math.max(4, hud.right + 4);
    const ty = Math.max(4, hud.top);
    this.band(cv, 0, s.topY, 0.72);
    for (let i = 0; i < 5; i++) this.heart(cv, lx + i * 7, ty, i < s.hearts ? "#ff5e8a" : "#3a3f55");
    const foc = `FOCUS ${s.focus}`;
    this.text(cv, foc, rx - textWidth(foc), ty, "#fff2a0");

    const wv = s.waves[Math.min(s.wave, s.waves.length - 1)];
    const wn = `${Math.min(s.wave + 1, s.waves.length)}/${s.waves.length}`;
    this.text(cv, wn, lx, ty + 10, "#c9d3ea");
    const left = s.queue.length + s.cards.length, leftS = `${left} LEFT`;
    const room = Math.max(6, Math.floor((rx - lx - textWidth(wn) - textWidth(leftS) - 10) / 4));
    this.text(cv, clip(wv.name, room), lx + textWidth(wn) + 5, ty + 10, wv.accent);
    this.text(cv, leftS, rx - textWidth(leftS), ty + 10, "#7f8aa6");

    // Bottom shop bar, clear of home indicator / rounded corners.
    this.rect(cv, 0, s.shopY - 2, W, H - s.shopY + 2, "#0b1020");
    const sw = s.shopW, pad = Math.max(0, Math.floor((sw - 41) / 2));
    TAGS.forEach((tg, i) => {
      const x = s.shopX0 + i * sw, sel = i === s.picked, can = s.focus >= tg.cost;
      this.rect(cv, x + 1, s.shopY, sw - 2, s.shopH - 2, sel ? tg.c : "#1b2236");
      this.rect(cv, x + 2, s.shopY + 1, sw - 4, s.shopH - 4, sel ? "#0b1020" : "#141a2c");
      this.stack(cv, this.towers[tg.id][0], x + pad + 9, s.shopY + 17, -0.5 + Math.sin(t * 0.05 + i) * 0.3);
      this.text(cv, tg.name.slice(1), x + pad + 17, s.shopY + 4, can ? tg.l : "#59607a", 1, null);
      this.text(cv, tg.blurb, x + pad + 17, s.shopY + 12, "#7f8aa6", 1, null);
      this.text(cv, String(tg.cost), x + pad + 17, s.shopY + 20, can ? "#fff2a0" : "#59607a", 1, null);
    });

    const cy = s.coreY + 90;
    const cx = (lx + rx) / 2;
    if (s.state === "intro") {
      this.band(cv, cy - 6, 50, 0.65);
      this.textC(cv, `PROJECT ${s.wave + 1} OF ${s.waves.length}`, cx, cy, "#c9d3ea");
      const wv2 = s.waves[s.wave], big = textWidth(wv2.name, 2) < rx - lx - 8;
      this.textC(cv, wv2.name, cx, cy + 11, wv2.accent, big ? 2 : 1);
      this.textC(cv, `${wv2.tasks.length} TASKS INCOMING`, cx, cy + 30, "#ffffff");
    }
    if (s.toast) this.textC(cv, s.toast.s, cx, s.shopY - 10, "#ffffff");
    if (s.state === "over" || s.state === "win") {
      this.band(cv, cy - 10, 74, 0.75);
      if (s.state === "win") {
        this.textC(cv, "INBOX ZERO!", cx, cy - 2, "#8dff9a", 2);
        this.textC(cv, "EVERY PROJECT TRIAGED", cx, cy + 18, "#ffffff");
      } else {
        this.textC(cv, "SNOWED UNDER", cx, cy - 2, "#ff5e8a", 2);
        this.textC(cv, `${s.leaked} TASKS WENT OVERDUE`, cx, cy + 18, "#ffffff");
      }
      this.textC(cv, `${s.triaged} TRIAGED  SCORE ${s.score}`, cx, cy + 30, "#fff2a0");
      this.textC(cv, `BEST ${s.best}`, cx, cy + 40, "#c7d0e6");
      if (s.stateT > 60 && (t >> 5) & 1) this.textC(cv, "TAP TO PLAY AGAIN", cx, cy + 54, "#c7d0e6");
    }
  }

  private renderTitle(cv: SkCanvas): void {
    const s = this.sim, t = s.t, cy = s.coreY;
    const cx = (s.hud.left + this.W - s.hud.right) / 2;
    this.band(cv, cy + 34, 64, 0.75);
    this.textC(cv, "TOWER DEFENCE FOR YOUR BOARD", cx, cy + 40, "#c9d3ea");
    this.textC(cv, "INBOX", cx, cy + 52, "#ffffff", 3);
    this.textC(cv, "ZERO", cx, cy + 72, "#8dff9a", 3);
    this.band(cv, cy + 124, 92, 0.75);
    TAGS.forEach((tg, i) => {
      const x = Math.round(cx + (i - 1.5) * 43);
      this.stack(cv, this.towers[tg.id][1], x, cy + 150, Math.sin(t * 0.03 + i) * 0.8);
      this.textC(cv, tg.name, x, cy + 162, tg.l);
    });
    this.textC(cv, "PIN TAGS BESIDE THE FLOW", cx, cy + 176, "#ffffff");
    this.textC(cv, "TRIAGE TASKS BEFORE THE DEADLINE", cx, cy + 186, "#ffffff");
    this.textC(cv, "TAP A TAG TO UPGRADE IT", cx, cy + 196, "#7f8aa6");
    if ((t >> 5) & 1) this.textC(cv, "TAP TO START", cx, cy + 236, "#ffffff", 2);
    this.textC(cv, `BEST ${s.best}`, cx, s.H - s.hud.bottom - 14, "#c7d0e6");
  }
}
