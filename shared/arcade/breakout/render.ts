/**
 * Breakout renderer — extends PixelPainter for Canvas2D and Skia parity.
 */

import { fontSafe } from "../pixel/font";
import { hudFrame } from "../pixel/hud";
import { clamp, type EntityKind } from "../pixel/kinds";
import { FIRE, INK, PixelPainter, type AtlasHandle, type PixelBackend } from "../pixel/painter";
import { BIOMES, mulberry32 } from "../pixel/terrain";
import { BRICKS, PADDLE } from "./models";
import type { BreakoutSim, Brick } from "./sim";

export class BreakoutRenderer<Img = unknown, Frame = unknown> extends PixelPainter<Img, Frame> {
  private readonly sim: BreakoutSim;
  private readonly bricks: Record<EntityKind, AtlasHandle<Img>>;
  private readonly paddle: AtlasHandle<Img>;
  private readonly fx = mulberry32(17);
  private demo: Brick[];

  constructor(backend: PixelBackend<Img, Frame>, sim: BreakoutSim) {
    super(backend, sim.W, sim.H);
    this.sim = sim;
    this.bricks = {
      project: this.makeAtlas(BRICKS.project),
      note: this.makeAtlas(BRICKS.note),
      card: this.makeAtlas(BRICKS.card),
      tag: this.makeAtlas(BRICKS.tag),
    };
    this.paddle = this.makeAtlas(PADDLE);
    this.demo = sim.bricks.map((b) => ({ ...b }));
  }

  override resize(width: number, height: number): void {
    this.sim.resize(width, height);
    super.resize(width, height);
    const saved = this.sim.bricks;
    this.sim.layout();
    this.demo = this.sim.bricks.map((b) => ({ ...b }));
    this.sim.bricks = saved;
  }

  private centreX(): number {
    return (this.sim.left + this.sim.right) / 2;
  }

  private drawBall(x: number, y: number): void {
    const X = Math.round(x) - 2 + this.SX;
    const Y = Math.round(y) - 2 + this.SY;
    this.rect(X - 1, Y + 1, 7, 3, INK);
    this.rect(X + 1, Y - 1, 3, 7, INK);
    this.rect(X, Y + 1, 5, 3, "#c7e4ff");
    this.rect(X + 1, Y, 3, 5, "#c7e4ff");
    this.rect(X + 1, Y + 1, 2, 2, "#ffffff");
    this.rect(X + 3, Y + 3, 1, 1, "#5b8dd6");
  }

  private drawBanner(title: string, col: string, sub: string): void {
    const sim = this.sim;
    const cx = this.centreX();
    const y = Math.round(sim.padY - 140);
    this.band(y, 58, 0.65);
    this.textC(title, cx, y + 8, col, 2);
    this.textC(sub, cx, y + 26, "#ffffff");
    if (sim.newBest) this.textC("NEW BEST!", cx, y + 36, "#fff2a0");
    if (sim.stateT > 40 && (sim.t >> 5) & 1) {
      this.textC(sim.inputMode === "pointer" ? "CLICK OR SPACE TO PLAY AGAIN" : "TAP TO PLAY AGAIN", cx, y + 46, "#c7d0e6");
    }
  }

  draw(): Frame {
    const sim = this.sim;
    const W = sim.W;
    const H = sim.H;
    const t = sim.t;
    this.SX = this.SY = 0;
    this.clear(BIOMES[sim.terrain.biome].water[0]);
    this.drawTerrain(sim.terrain, sim.terrainGen, sim.camR, 0, ((t >> 5) & 1) as 0 | 1);
    this.rect(0, 0, W, H, INK, 0.64);
    const sh = sim.shake;
    this.SX = sh > 0 ? Math.round((this.fx() * 2 - 1) * sh) : 0;
    this.SY = sh > 0 ? Math.round((this.fx() * 2 - 1) * sh) : 0;

    const bricks = sim.state === "title" ? this.demo : sim.bricks;
    for (const b of bricks) this.shadow(this.bricks[b.kind], b.x, b.y, 0, 4, 6, 0.35);
    for (const b of bricks) this.stack(this.bricks[b.kind], b.x, b.y + Math.round(Math.sin(t * 0.04 + b.ph) * 0.6), 0);

    if (sim.state === "title") {
      const cx = this.centreX();
      const last = this.demo[this.demo.length - 1];
      const y = Math.round(Math.min((last ? last.y : 120) + 24, sim.padY - 100));
      this.band(y, 62, 0.6);
      this.textC("CAIRN", cx, y + 6, "#fff2a0", 4);
      this.textC("BREAKOUT", cx, y + 30, "#ffffff", 2);
      if ((t >> 5) & 1) {
        this.textC(sim.inputMode === "pointer" ? "CLICK OR SPACE TO PLAY" : "TAP TO PLAY", cx, y + 76, "#ffffff");
      }
      this.textC(`BEST ${sim.best}`, cx, y + 90, "#c7d0e6");
      this.stack(this.paddle, cx + Math.sin(t * 0.03) * 30, sim.padY, Math.cos(t * 0.03) * 0.15);
      return this.snapshot();
    }

    const pad = sim.pad;
    const yaw = clamp(pad.vx * 0.05, -0.22, 0.22);
    this.shadow(this.paddle, pad.x, sim.padY, yaw, 4, 7, 0.35);
    for (const dx of [-11, 11]) {
      this.px(pad.x + dx, sim.padY + 5 + (t & 1), FIRE[((t >> 1) % 3) + 1]);
      this.px(pad.x + dx, sim.padY + 7, FIRE[3]);
    }
    this.stack(this.paddle, pad.x, sim.padY, yaw);

    if (sim.state === "play" || sim.state === "win") {
      const n = sim.trail.length;
      sim.trail.forEach((p, i) => this.px(p.x - 1, p.y - 1, "#a8f4ff", 2, ((i + 1) / (n + 2)) * 0.6));
      this.px(sim.ball.x + 2, sim.ball.y + 4, INK, 3, 0.35);
      this.drawBall(sim.ball.x, sim.ball.y);
    }
    for (const p of sim.parts) this.px(p.x, p.y, p.c);
    for (const p of sim.pops) {
      if (p.t > 36 && (p.t & 2)) continue;
      const k = p.big ? 2 : 1;
      const safe = fontSafe(p.s);
      const s = p.big ? safe : PixelPainter.clip(safe, Math.floor((W - 6) / 4));
      this.textIn(s, p.x, Math.round(p.y - Math.min(p.t, 24) * 0.5), p.c, k);
    }

    this.SX = this.SY = 0;
    const row = hudFrame(sim.hud, W, sim.H).top, top = row.y;
    const cx = this.centreX();
    this.rect(0, 0, W, top + 10, INK, 0.6);
    this.text(String(sim.score), row.lx, top, "#ffffff");
    const best = `BEST ${sim.best}`;
    this.text(best, row.rx - best.length * 4, top, sim.newBest ? "#fff2a0" : "#c7d0e6");
    this.textC(`${sim.bricks.length} LEFT`, cx, top, "#7f8aa6");
    if (sim.state === "play" && sim.ball.stuck && (t >> 5) & 1) {
      this.textC(sim.inputMode === "pointer" ? "CLICK OR SPACE TO LAUNCH" : "TAP TO LAUNCH", cx, sim.padY - 32, "#ffffff");
    }
    if (sim.state === "over") this.drawBanner("BALL LOST", "#ef5a24", `${sim.score} CLEARED`);
    if (sim.state === "win") this.drawBanner("BOARD CLEAR", "#7cc46a", `ALL ${sim.score} DONE`);
    return this.snapshot();
  }
}
