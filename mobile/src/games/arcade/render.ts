/**
 * Arcade renderer: the Task Force island drifting under a scrim, a title, and
 * one cartridge per game with a live preview of it (the jet weaving, a little
 * cairn swaying, bricks over a paddle) and its best score.
 */

import { Skia, type SkCanvas, type SkImage } from "@shopify/react-native-skia";
import { textWidth } from "@/games/pixel/font";
import { FIRE, INK, PixelPainter, makeImage, stackAtlas, type StackAtlas } from "@/games/pixel/painter";
import { BIOMES, CHUNK, Terrain } from "@/games/pixel/terrain";
import { BRICKS, PADDLE } from "@/games/breakout/models";
import { CARD_MODELS, TOWER_MODELS } from "@/games/inbox-zero/models";
import { SH } from "@/games/stacker/sim";
import { stoneSprite } from "@/games/stacker/sprites";
import { PLAYER } from "@/games/task-force/models";
import { BOAT_MODEL } from "@/games/wayfinder/models";
import type { ArcadeMenu, Cartridge } from "./menu";

export class ArcadeRenderer extends PixelPainter {
  private readonly menu: ArcadeMenu;
  private readonly terrain: Terrain;
  private readonly jet = stackAtlas(PLAYER);
  private readonly boat = stackAtlas(BOAT_MODEL);
  private readonly paddle = stackAtlas(PADDLE);
  private readonly bricks: StackAtlas[] = [stackAtlas(BRICKS.project), stackAtlas(BRICKS.note), stackAtlas(BRICKS.card)];
  private readonly cards = {
    low: stackAtlas(CARD_MODELS.low),
    medium: stackAtlas(CARD_MODELS.medium),
    high: stackAtlas(CARD_MODELS.high),
    urgent: stackAtlas(CARD_MODELS.urgent),
  };
  private readonly focusTower = stackAtlas(TOWER_MODELS.focus[1]);
  private readonly stones: { img: SkImage; w: number }[];
  private camR = 0;

  constructor(menu: ArcadeMenu) {
    super(menu.W, menu.H);
    this.menu = menu;
    this.terrain = new Terrain(menu.W, "tropic", 5);
    this.stones = (
      [
        [34, "project", "Cairn"],
        [28, "note", "Notes"],
        [22, "card", "Tasks"],
      ] as const
    ).map(([w, kind, label], i) => ({ img: makeImage(w, SH, stoneSprite(w, kind, label, i * 7 + 3)), w }));
  }

  draw(): SkImage {
    const m = this.menu, W = this.W, H = this.H, t = m.t, cv = this.canvas();
    this.camR += 0.15;
    this.terrain.pump(Math.floor(this.camR) + H + CHUNK, 3);
    cv.clear(Skia.Color(BIOMES.tropic.water[0]));
    this.drawTerrain(cv, this.terrain, 0, this.camR, 0, ((t >> 5) & 1) as 0 | 1);
    this.rect(cv, 0, 0, W, H, INK, 0.55);

    const cx = (m.hud.left + W - m.hud.right) / 2;
    this.band(cv, m.titleY - 4, 34, 0.5);
    this.textC(cv, "YOU FOUND A SECRET", cx, m.titleY, "#c9d3ea");
    this.textC(cv, "CAIRN ARCADE", cx, m.titleY + 11, "#fff2a0", 2);
    m.cards.forEach((c, i) => this.card(cv, c, i));
    const last = m.cards[m.cards.length - 1];
    if (m.chosen === null && (t >> 5) & 1) this.textC(cv, "TAP A GAME", cx, last.y + last.h + 8, "#ffffff");
    return this.snapshot();
  }

  private card(cv: SkCanvas, c: Cartridge, i: number): void {
    const m = this.menu, t = m.t, lit = m.chosen === i && (m.blink >> 1) & 1;
    // Cartridge: ink outline, accent label strip on the left, dark face.
    this.rect(cv, c.x - 1, c.y - 1, c.w + 2, c.h + 2, INK);
    this.rect(cv, c.x, c.y, c.w, c.h, lit ? "#ffffff" : c.accent);
    this.rect(cv, c.x + 2, c.y + 2, c.w - 4, c.h - 4, lit ? "#c9d3ea" : "#141b2e");
    this.rect(cv, c.x + 2, c.y + 2, c.w - 4, 1, "#2a3350");
    // Preview window.
    const px = c.x + 4, py = c.y + 4, pw = 48, ph = c.h - 8;
    this.rect(cv, px, py, pw, ph, "#0e1424");
    cv.save();
    cv.clipRect(Skia.XYWHRect(px, py, pw, ph), 1, false);
    this.preview(cv, c.id, px + pw / 2, py + ph / 2, t + i * 40);
    cv.restore();
    const tx = px + pw + 6, ink = lit ? INK : "#ffffff";
    this.text(cv, c.title, tx, c.y + 6, lit ? INK : c.accent, 2, lit ? null : INK);
    this.text(cv, c.blurb.length * 4 <= c.x + c.w - tx - 4 ? c.blurb : c.blurb.split(" ").slice(0, 3).join(" "), tx, c.y + 21, ink, 1, lit ? null : INK);
    const best = c.best ? `BEST ${c.best}` : "NEW";
    this.text(cv, best, c.x + c.w - 6 - textWidth(best), c.y + c.h - 10, lit ? INK : "#fff2a0", 1, lit ? null : INK);
  }

  private preview(cv: SkCanvas, id: Cartridge["id"], cx: number, cy: number, t: number): void {
    if (id === "task-force") {
      const a = Math.sin(t * 0.04) * 0.3, x = cx - Math.cos(t * 0.04) * 6;
      this.shadow(cv, this.jet, x, cy + 2, a, 6, 9, 0.35);
      this.stack(cv, this.jet, x, cy + 2, a);
      for (const s of [-1, 1]) this.rect(cv, Math.round(x + s), Math.round(cy + 13 + (t & 1)), 1, 2, FIRE[(t >> 1) % 3 + 1]);
    } else if (id === "wayfinder") {
      this.rect(cv, cx - 24, cy - 30, 48, 60, "#1f55b5");
      for (let i = 0; i < 6; i++) this.rect(cv, Math.round(cx - 20 + ((i * 13 + t * 0.2) % 40)), Math.round(cy - 14 + i * 6), 2, 1, "#47a3e6");
      const a = t * 0.02, x = cx + Math.sin(a) * 9, y = cy + 2 - Math.cos(a) * 7;
      for (let i = 1; i < 6; i++) this.rect(cv, Math.round(x - Math.sin(a + Math.PI / 2) * i * 2), Math.round(y + Math.cos(a + Math.PI / 2) * i * 2), 1, 1, "#e6f6ff");
      this.shadow(cv, this.boat, x, y, a + Math.PI / 2, 2, 3, 0.3);
      this.stack(cv, this.boat, x, y + Math.sin(t * 0.08) * 0.6, a + Math.PI / 2);
    } else if (id === "inbox-zero") {
      this.rect(cv, cx - 4, cy - 30, 8, 60, "#2a3350");
      const d = (t * 0.4) % 50, pr = (["low", "medium", "high", "urgent"] as const)[((t * 0.4) / 50) % 4 | 0];
      this.stack(cv, this.cards[pr], cx, cy - 22 + d, Math.PI);
      this.stack(cv, this.focusTower, cx + 14, cy + 6, Math.atan2(cx - (cx + 14), -(cy - 22 + d - (cy + 6))));
    } else if (id === "stacker") {
      const base = cy + 16;
      this.stones.forEach((s, i) => {
        const sway = i === 2 ? Math.round(Math.sin(t * 0.06) * 3) : 0;
        this.sprite(cv, s.img, 0, 0, s.w, SH, cx + sway, base - i * SH - SH / 2);
      });
      this.rect(cv, cx - 24, base + 1, 48, 2, "#7cc46a");
    } else {
      for (let r = 0; r < 2; r++)
        for (let k = 0; k < 2; k++) this.stack(cv, this.bricks[(r + k) % 3], cx - 14 + k * 28, cy - 12 + r * 11, 0);
      const bx = cx + Math.sin(t * 0.05) * 14;
      this.stack(cv, this.paddle, bx, cy + 15, Math.cos(t * 0.05) * 0.1);
      const by = cy + 10 - Math.abs(Math.sin(t * 0.05)) * 12;
      this.rect(cv, Math.round(bx) - 1, Math.round(by), 3, 3, "#c7e4ff");
    }
  }
}
