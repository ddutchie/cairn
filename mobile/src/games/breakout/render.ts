/**
 * Breakout renderer: the island drifting under a dark scrim, sprite-stacked
 * bricks bobbing over their shadows, the hover-pad paddle yawing with its
 * speed, a pixel orb with a trail, shards and floating labels, then the HUD.
 */

import { Skia, type SkCanvas, type SkImage } from "@shopify/react-native-skia";
import { clip, textWidth } from "@/games/pixel/font";
import { FIRE, INK, PixelPainter, stackAtlas, type StackAtlas } from "@/games/pixel/painter";
import type { EntityKind } from "@/games/pixel/kinds";
import { clamp } from "@/games/pixel/kinds";
import { BIOMES, mulberry32 } from "@/games/pixel/terrain";
import { BRICKS, PADDLE } from "./models";
import type { BreakoutSim, Brick } from "./sim";

export class BreakoutRenderer extends PixelPainter {
  private readonly sim: BreakoutSim;
  private readonly bricks: Record<EntityKind, StackAtlas> = {
    project: stackAtlas(BRICKS.project),
    note: stackAtlas(BRICKS.note),
    card: stackAtlas(BRICKS.card),
    tag: stackAtlas(BRICKS.tag),
  };
  private readonly paddle = stackAtlas(PADDLE);
  private readonly fx = mulberry32(17);
  /** Shown behind the title: a full board that isn't in play. */
  private readonly demo: Brick[];

  constructor(sim: BreakoutSim) {
    super(sim.W, sim.H);
    this.sim = sim;
    this.demo = sim.bricks.map((b) => ({ ...b }));
  }

  private centreX(): number {
    return (this.sim.left + this.sim.right) / 2;
  }

  draw(): SkImage {
    const sim = this.sim, W = this.W, H = this.H, t = sim.t, cv = this.canvas();
    this.SX = this.SY = 0;
    cv.clear(Skia.Color(BIOMES[sim.terrain.biome].water[0]));
    this.drawTerrain(cv, sim.terrain, sim.terrainGen, sim.camR, 0, ((t >> 5) & 1) as 0 | 1);
    this.rect(cv, 0, 0, W, H, INK, 0.64);
    const sh = sim.shake;
    this.SX = sh > 0 ? Math.round((this.fx() * 2 - 1) * sh) : 0;
    this.SY = sh > 0 ? Math.round((this.fx() * 2 - 1) * sh) : 0;

    const bricks = sim.state === "title" ? this.demo : sim.bricks;
    for (const b of bricks) this.shadow(cv, this.bricks[b.kind], b.x, b.y, 0, 4, 6, 0.35);
    for (const b of bricks) this.stack(cv, this.bricks[b.kind], b.x, b.y + Math.round(Math.sin(t * 0.04 + b.ph) * 0.6), 0);

    if (sim.state === "title") {
      this.drawTitle(cv);
      return this.snapshot();
    }

    const pad = sim.pad, yaw = clamp(pad.vx * 0.05, -0.22, 0.22);
    this.shadow(cv, this.paddle, pad.x, sim.padY, yaw, 4, 7, 0.35);
    for (const dx of [-11, 11]) {
      this.px(cv, pad.x + dx, sim.padY + 5 + (t & 1), FIRE[((t >> 1) % 3) + 1]);
      this.px(cv, pad.x + dx, sim.padY + 7, FIRE[3]);
    }
    this.stack(cv, this.paddle, pad.x, sim.padY, yaw);

    if (sim.state === "play" || sim.state === "win") {
      const n = sim.trail.length;
      sim.trail.forEach((p, i) => this.px(cv, p.x - 1, p.y - 1, "#a8f4ff", 2, ((i + 1) / (n + 2)) * 0.6));
      this.px(cv, sim.ball.x + 2, sim.ball.y + 4, INK, 3, 0.35);
      this.ball(cv, sim.ball.x, sim.ball.y);
    }
    for (const p of sim.parts) this.px(cv, p.x, p.y, p.c);
    for (const p of sim.pops) {
      if (p.t > 36 && p.t & 2) continue;
      const k = p.big ? 2 : 1, s = p.big ? p.s : clip(p.s, Math.floor((W - 6) / 4));
      this.textIn(cv, s, p.x, Math.round(p.y - Math.min(p.t, 24) * 0.5), p.c, k);
    }

    this.SX = this.SY = 0;
    this.drawHud(cv);
    return this.snapshot();
  }

  private ball(cv: SkCanvas, x: number, y: number): void {
    const X = Math.round(x) - 2 + this.SX, Y = Math.round(y) - 2 + this.SY;
    this.rect(cv, X - 1, Y + 1, 7, 3, INK);
    this.rect(cv, X + 1, Y - 1, 3, 7, INK);
    this.rect(cv, X, Y + 1, 5, 3, "#c7e4ff");
    this.rect(cv, X + 1, Y, 3, 5, "#c7e4ff");
    this.rect(cv, X + 1, Y + 1, 2, 2, "#ffffff");
    this.rect(cv, X + 3, Y + 3, 1, 1, "#5b8dd6");
  }

  private drawHud(cv: SkCanvas): void {
    const sim = this.sim, W = this.W, hud = sim.hud, top = hud.top + 4, cx = this.centreX();
    this.rect(cv, 0, 0, W, top + 10, INK, 0.6);
    this.text(cv, String(sim.score), 4 + hud.topLeft, top, "#ffffff");
    const best = `BEST ${sim.best}`;
    this.text(cv, best, W - 4 - hud.topRight - textWidth(best), top, sim.newBest ? "#fff2a0" : "#c7d0e6");
    this.textC(cv, `${sim.bricks.length} LEFT`, cx, top, "#7f8aa6");
    const t = sim.t;
    if (sim.state === "play" && sim.ball.stuck && (t >> 5) & 1) this.textC(cv, "TAP TO LAUNCH", cx, sim.padY - 32, "#ffffff");
    if (sim.state === "over") this.banner(cv, "BALL LOST", "#ef5a24", `${sim.score} CLEARED`);
    if (sim.state === "win") this.banner(cv, "BOARD CLEAR", "#7cc46a", `ALL ${sim.score} DONE`);
  }

  private banner(cv: SkCanvas, title: string, col: string, sub: string): void {
    const sim = this.sim, cx = this.centreX(), y = Math.round(sim.padY - 140);
    this.band(cv, y, 58, 0.65);
    this.textC(cv, title, cx, y + 8, col, 2);
    this.textC(cv, sub, cx, y + 26, "#ffffff");
    if (sim.newBest) this.textC(cv, "NEW BEST!", cx, y + 36, "#fff2a0");
    if (sim.stateT > 40 && (sim.t >> 5) & 1) this.textC(cv, "TAP TO PLAY AGAIN", cx, y + 46, "#c7d0e6");
  }

  private drawTitle(cv: SkCanvas): void {
    const sim = this.sim, t = sim.t, cx = this.centreX();
    const last = this.demo[this.demo.length - 1], y = Math.round(Math.min(last.y + 24, sim.padY - 100));
    this.band(cv, y, 62, 0.6);
    this.textC(cv, "CAIRN", cx, y + 6, "#fff2a0", 4);
    this.textC(cv, "BREAKOUT", cx, y + 30, "#ffffff", 2);
    if ((t >> 5) & 1) this.textC(cv, "TAP TO PLAY", cx, y + 76, "#ffffff");
    this.textC(cv, `BEST ${sim.best}`, cx, y + 90, "#c7d0e6");
    this.stack(cv, this.paddle, cx + Math.sin(t * 0.03) * 30, sim.padY, Math.cos(t * 0.03) * 0.15);
  }
}
