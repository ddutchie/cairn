/**
 * The Cairn Arcade picker: an island drifting under a scrim, a title, and one
 * cartridge per game with a live preview and its best score. Click one (or
 * arrow + Enter); it blinks, then the host opens that game.
 */

import type { ArcadeGameId, GameFactory } from "../game";
import { loadBest } from "../PixelScreen";
import {
  FIRE, H, INK, Terrain, W, blit, clamp, drawShadow, drawStack, drawText, drawTextC, rect, scr, textW,
} from "../pixel/kit";
import { brickModels, padModel } from "./breakout";
import { cardModels, towerModels } from "./inbox-zero";
import { SH, stoneSprite } from "./stacker";
import { playerModel } from "./task-force";
import { boatModel } from "./wayfinder";

export const CARTRIDGES: { id: ArcadeGameId; name: string; title: string; blurb: string; accent: string }[] = [
  { id: "task-force", name: "Task Force", title: "TASK FORCE", blurb: "SHOOT DOWN YOUR BACKLOG", accent: "#2ec4b6" },
  { id: "wayfinder", name: "Wayfinder", title: "WAYFINDER", blurb: "SAIL YOUR NOTES", accent: "#47a3e6" },
  { id: "inbox-zero", name: "Inbox Zero", title: "INBOX ZERO", blurb: "DEFEND YOUR BOARD", accent: "#7cc46a" },
  { id: "stacker", name: "Stacker", title: "STACKER", blurb: "BUILD A CAIRN OF WORK", accent: "#e3a23b" },
  { id: "breakout", name: "Breakout", title: "BREAKOUT", blurb: "BREAK THROUGH IT ALL", accent: "#5b8dd6" },
];

const CARD_H = 46, GAP = 6, Y0 = 52, PW = 48, BLINK = 14;
/** Cartridges keep the phone width and sit centred on a wider screen. */
const CW = 164;
const cardX = () => Math.round((W - CW) / 2);
const cardY = (i: number) => Y0 + i * (CARD_H + GAP);

export function createArcadeMenu(onPick: (id: ArcadeGameId) => void): GameFactory {
  return () => {
    const ctx = scr.ctx, terrain = new Terrain("tropic", 5);
    const jet = playerModel(), pad = padModel(), bricks = brickModels(), boat = boatModel(), cards = cardModels(), towers = towerModels();
    const stones = ([[34, "project", "CAIRN"], [28, "note", "NOTES"], [22, "card", "TASKS"]] as const).map(([w, kind, label], i) => ({ w, img: stoneSprite(w, kind, label, i * 7 + 3) }));
    const bests = CARTRIDGES.map((c) => loadBest(c.id));
    let t = 0, camR = 0, sel = 0, chosen: number | null = null, blink = 0;

    const hitCard = (x: number, y: number) => CARTRIDGES.findIndex((_, i) => x >= cardX() && x < cardX() + CW && y >= cardY(i) && y < cardY(i) + CARD_H);
    function choose(i: number) {
      if (chosen !== null || i < 0) return;
      chosen = sel = i;
      blink = BLINK;
    }

    function preview(id: ArcadeGameId, cx: number, cy: number, tt: number) {
      if (id === "task-force") {
        const a = Math.sin(tt * 0.04) * 0.3, x = cx - Math.cos(tt * 0.04) * 6;
        drawShadow(jet, x, cy + 2, a, 6, 9, 0.35);
        drawStack(jet, x, cy + 2, a);
        for (const s of [-1, 1]) rect(Math.round(x + s), Math.round(cy + 13 + (tt & 1)), 1, 2, FIRE[((tt >> 1) % 3) + 1]);
      } else if (id === "stacker") {
        const base = cy + 16;
        stones.forEach((s, i) => {
          const sway = i === 2 ? Math.round(Math.sin(tt * 0.06) * 3) : 0;
          ctx.drawImage(s.img, Math.round(cx - s.w / 2 + sway), Math.round(base - (i + 1) * SH));
        });
        rect(cx - 24, base, 48, 2, "#7cc46a");
      } else if (id === "breakout") {
        drawStack(bricks.project, cx - 14, cy - 10, 0);
        drawStack(bricks.card, cx + 14, cy - 10, 0);
        drawStack(bricks.note, cx, cy - 1, 0);
        const bx = cx + Math.sin(tt * 0.05) * 10;
        drawStack(pad, bx, cy + 15, Math.cos(tt * 0.05) * 0.1);
        const by = cy + 10 - Math.abs(Math.sin(tt * 0.05)) * 12;
        rect(Math.round(bx) - 1, Math.round(by), 3, 3, "#c7e4ff");
      } else if (id === "wayfinder") {
        rect(cx - PW / 2, cy - 30, PW, 60, "#1f55b5");
        for (let i = 0; i < 6; i++) rect(Math.round(cx - 20 + ((i * 13 + tt * 0.2) % 40)), Math.round(cy - 14 + i * 6), 2, 1, "#47a3e6");
        const a = tt * 0.02, x = cx + Math.sin(a) * 9, y = cy + 2 - Math.cos(a) * 7;
        for (let i = 1; i < 6; i++) rect(Math.round(x - Math.sin(a + Math.PI / 2) * i * 2), Math.round(y + Math.cos(a + Math.PI / 2) * i * 2), 1, 1, "#e6f6ff");
        drawShadow(boat, x, y, a + Math.PI / 2, 2, 3, 0.3);
        drawStack(boat, x, y + Math.sin(tt * 0.08) * 0.6, a + Math.PI / 2);
      } else {
        rect(cx - 4, cy - 30, 8, 60, "#2a3350");
        const d = (tt * 0.4) % 50, pr = (["low", "medium", "high", "urgent"] as const)[((tt * 0.4) / 50) % 4 | 0];
        drawStack(cards[pr], cx, cy - 22 + d, Math.PI);
        drawStack(towers.focus[1], cx + 14, cy + 6, Math.atan2(cx - (cx + 14), -(cy - 22 + d - (cy + 6))));
      }
    }

    function card(i: number) {
      const c = CARTRIDGES[i], X = cardX(), y = cardY(i), lit = chosen === i && (blink >> 1) & 1, hot = sel === i && chosen === null;
      rect(X - 1, y - 1, CW + 2, CARD_H + 2, hot ? "#ffffff" : INK);
      rect(X, y, CW, CARD_H, lit ? "#ffffff" : c.accent);
      rect(X + 2, y + 2, CW - 4, CARD_H - 4, lit ? "#c9d3ea" : "#141b2e");
      rect(X + 2, y + 2, CW - 4, 1, "#2a3350");
      const px0 = X + 4, py0 = y + 4, ph = CARD_H - 8;
      rect(px0, py0, PW, ph, "#0e1424");
      ctx.save();
      ctx.beginPath();
      ctx.rect(px0, py0, PW, ph);
      ctx.clip();
      preview(c.id, px0 + PW / 2, py0 + ph / 2, t + i * 40);
      ctx.restore();
      const tx = px0 + PW + 6, sh = lit ? null : INK;
      drawText(c.title, tx, y + 7, lit ? INK : c.accent, 2, sh);
      drawText(c.blurb, tx, y + 22, lit ? INK : "#ffffff", 1, sh);
      const best = bests[i] ? `BEST ${bests[i]}` : "NEW";
      drawText(best, X + CW - 6 - textW(best), y + CARD_H - 11, lit ? INK : "#fff2a0", 1, sh);
    }

    return {
      update() {
        t++;
        camR += 0.15;
        if (chosen !== null && blink > 0 && --blink === 0) onPick(CARTRIDGES[chosen].id);
      },
      render() {
        scr.sx = scr.sy = 0;
        terrain.render(camR, 0, 0, t);
        blit();
        rect(0, 0, W, H, INK, 0.55);
        rect(0, 8, W, 36, INK, 0.5);
        drawTextC("YOU FOUND A SECRET", W / 2, 13, "#c9d3ea");
        drawTextC("CAIRN ARCADE", W / 2, 25, "#fff2a0", 2);
        CARTRIDGES.forEach((_, i) => card(i));
        if (chosen === null && (t >> 5) & 1) drawTextC("CLICK A GAME", W / 2, H - 9, "#ffffff");
      },
      down(x, y) { choose(hitCard(x, y)); },
      move(x, y) {
        const i = hitCard(x, y);
        if (i >= 0 && chosen === null) sel = i;
      },
      up() {},
      key(code, down) {
        if (!down || chosen !== null) return false;
        if (code === "ArrowDown" || code === "ArrowUp") {
          sel = clamp(sel + (code === "ArrowDown" ? 1 : -1), 0, CARTRIDGES.length - 1);
          return true;
        }
        if (code === "Enter" || code === "Space") { choose(sel); return true; }
        return false;
      },
      resize() {},
      best: 0,
    };
  };
}
