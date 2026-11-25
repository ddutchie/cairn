/**
 * Powder Run 3D renderer — sweeping U-shaped 3D snow halfpipe via
 * our shared Software 3D Z-buffer rasterizer (`Framebuffer3D`).
 */

import type { Priority } from "../../types/domain";
import { textWidth } from "../pixel/font";
import { hudFrame } from "../pixel/hud";
import { clamp } from "../pixel/kinds";
import { INK, PixelPainter, type PixelBackend } from "../pixel/painter";
import { Framebuffer3D, makeCam3D, meshFromModel, type Cam3D, type Mesh3D } from "../pixel/raster3d";
import { rgb } from "../pixel/terrain";
import { BOULDER_MODEL, BOARDER_MODEL, NOTE_MODEL, PINE_MODEL, RAMP_MODEL, taskGemModel } from "./models";
import { PIPE_HALF_W, RUN_LEN, pipeHeightAt, type PowderRunSim } from "./sim";

const X_BANDS = [-86, -64, -40, -16, 16, 40, 64, 86];
const Y_STEP = 28;

export class PowderRunRenderer<Img = unknown, Frame = unknown> extends PixelPainter<Img, Frame> {
  private readonly sim: PowderRunSim;
  private fb: Framebuffer3D;
  private readonly boarder: Mesh3D;
  private readonly note: Mesh3D;
  private readonly pine: Mesh3D;
  private readonly boulder: Mesh3D;
  private readonly ramp: Mesh3D;
  private readonly gems: Record<Priority, Mesh3D>;

  constructor(backend: PixelBackend<Img, Frame>, sim: PowderRunSim) {
    super(backend, sim.W, sim.H);
    this.sim = sim;
    this.fb = this.allocFB(sim.W, sim.H);
    this.boarder = meshFromModel(BOARDER_MODEL, 1.4, 1.4);
    this.note = meshFromModel(NOTE_MODEL, 1.5, 1.5);
    this.pine = meshFromModel(PINE_MODEL, 2.2, 2.5);
    this.boulder = meshFromModel(BOULDER_MODEL, 1.8, 1.8);
    this.ramp = meshFromModel(RAMP_MODEL, 2.0, 2.0);
    this.gems = {
      low: meshFromModel(taskGemModel("low"), 1.6, 1.6),
      medium: meshFromModel(taskGemModel("medium"), 1.6, 1.6),
      high: meshFromModel(taskGemModel("high"), 1.6, 1.6),
      urgent: meshFromModel(taskGemModel("urgent"), 1.6, 1.6),
    };
  }

  private allocFB(w: number, h: number): Framebuffer3D {
    const rw = Math.max(120, Math.min(w, 230));
    const rh = Math.max(100, Math.round((rw * h) / Math.max(1, w)));
    return new Framebuffer3D(rw, rh);
  }

  override resize(width: number, height: number): void {
    this.sim.resize(width, height);
    super.resize(width, height);
    this.fb = this.allocFB(width, height);
  }

  private drawPipe(cam: Cam3D): void {
    const s = this.sim;
    const fb = this.fb;
    const [ar, ag, ab] = rgb(s.project.accent);
    const y0 = Math.max(0, Math.floor((s.rider.y - 40) / Y_STEP) * Y_STEP);
    const y1 = Math.min(RUN_LEN + 200, Math.ceil((s.rider.y + 520) / Y_STEP) * Y_STEP);

    for (let y = y0; y < y1; y += Y_STEP) {
      const yn = y + Y_STEP;
      const stripe = ((Math.floor(y / Y_STEP) & 1) === 0);
      for (let i = 0; i < X_BANDS.length - 1; i++) {
        const x0 = X_BANDS[i], x1 = X_BANDS[i + 1];
        const z00 = pipeHeightAt(x0, y), z10 = pipeHeightAt(x1, y);
        const z01 = pipeHeightAt(x0, yn), z11 = pipeHeightAt(x1, yn);
        const isRim = i === 0 || i === X_BANDS.length - 2;
        const wallShade = i === 0 ? 0.84 : i === X_BANDS.length - 2 ? 0.96 : i === 1 ? 0.9 : i === X_BANDS.length - 3 ? 0.98 : 1.0;
        let r = stripe ? 236 : 216;
        let g = stripe ? 244 : 230;
        let b = stripe ? 252 : 244;
        if (isRim && stripe) {
          r = Math.round(r * 0.7 + ar * 0.3);
          g = Math.round(g * 0.7 + ag * 0.3);
          b = Math.round(b * 0.7 + ab * 0.3);
        }
        r = clamp(Math.round(r * wallShade), 0, 255);
        g = clamp(Math.round(g * wallShade), 0, 255);
        b = clamp(Math.round(b * wallShade), 0, 255);
        fb.drawTri(cam, x0, y, z00, x1, y, z10, x1, yn, z11, r, g, b);
        fb.drawTri(cam, x0, y, z00, x1, yn, z11, x0, yn, z01, r, g, b);
      }
      // Outer snowy deck beyond the halfpipe rims
      const zL0 = pipeHeightAt(-PIPE_HALF_W, y), zL1 = pipeHeightAt(-PIPE_HALF_W, yn);
      const zR0 = pipeHeightAt(PIPE_HALF_W, y), zR1 = pipeHeightAt(PIPE_HALF_W, yn);
      fb.drawTri(cam, -260, y, zL0, -PIPE_HALF_W, y, zL0, -PIPE_HALF_W, yn, zL1, 195, 214, 234);
      fb.drawTri(cam, -260, y, zL0, -PIPE_HALF_W, yn, zL1, -260, yn, zL1, 195, 214, 234);
      fb.drawTri(cam, PIPE_HALF_W, y, zR0, 260, y, zR0, 260, yn, zR1, 206, 224, 242);
      fb.drawTri(cam, PIPE_HALF_W, y, zR0, 260, yn, zR1, PIPE_HALF_W, yn, zR1, 206, 224, 242);
    }
  }

  private drawShadow(cam: Cam3D, wx: number, wy: number, r: number): void {
    const z0 = pipeHeightAt(wx, wy) + 1.5;
    this.fb.drawTri(cam, wx - r, wy - r, z0, wx + r, wy - r, z0, wx + r, wy + r, z0, 42, 62, 96, true);
    this.fb.drawTri(cam, wx - r, wy - r, z0, wx + r, wy + r, z0, wx - r, wy + r, z0, 42, 62, 96, true);
  }

  draw(): Frame {
    const s = this.sim;
    const fb = this.fb;
    fb.fogR = 178;
    fb.fogG = 216;
    fb.fogB = 242;
    fb.fogStart = 240;
    fb.fogEnd = 560;
    fb.clearSky(46, 112, 188, 178, 216, 242, 0.34);

    const r = s.rider;
    const jx = s.shake > 0 && !s.calm ? (s.rand() * 2 - 1) * s.shake : 0;
    const cam = makeCam3D(
      { x: r.x * 0.55 + jx, y: r.y - 78, z: pipeHeightAt(r.x * 0.55, r.y) + 52 },
      { x: r.x * 0.65, y: r.y + 84, z: pipeHeightAt(r.x * 0.65, r.y + 84) + 10 },
      fb.w,
      fb.h,
      58,
      6,
      620,
    );

    this.drawPipe(cam);

    // Pines lining both rims of the halfpipe
    const pineY0 = Math.max(40, Math.floor((r.y - 20) / 70) * 70);
    const pineY1 = Math.min(RUN_LEN + 80, r.y + 460);
    for (let y = pineY0; y <= pineY1; y += 70) {
      const zl = pipeHeightAt(-PIPE_HALF_W - 14, y);
      const zr = pipeHeightAt(PIPE_HALF_W + 14, y);
      fb.drawMesh(cam, this.pine, -PIPE_HALF_W - 14, y, zl, 0, 1);
      fb.drawMesh(cam, this.pine, PIPE_HALF_W + 14, y + 32, zr, 0, 1);
    }

    // Collectibles, ramps, boulders
    for (const it of s.items) {
      if (it.taken || it.y < r.y - 30 || it.y > r.y + 460) continue;
      const iz = pipeHeightAt(it.x, it.y);
      if (it.kind === "ramp") {
        fb.drawMesh(cam, this.ramp, it.x, it.y, iz, 0, 1);
      } else if (it.kind === "boulder") {
        this.drawShadow(cam, it.x, it.y, 7);
        fb.drawMesh(cam, this.boulder, it.x, it.y, iz, 0, 1);
      } else if (it.kind === "note") {
        this.drawShadow(cam, it.x, it.y, 5);
        fb.drawMesh(cam, this.note, it.x, it.y, iz + 6 + Math.sin(s.t * 0.1 + it.id) * 2, s.t * 0.05, 1);
      } else {
        this.drawShadow(cam, it.x, it.y, 5);
        fb.drawMesh(cam, this.gems[it.pr], it.x, it.y, iz + 5 + Math.sin(s.t * 0.1 + it.id) * 2, s.t * 0.06, 1);
      }
    }

    // Rider + ground shadow
    if (r.inv === 0 || (r.inv & 3) < 2) {
      const airH = Math.max(0, r.z - pipeHeightAt(r.x, r.y));
      this.drawShadow(cam, r.x, r.y, clamp(6 - airH * 0.06, 2.5, 6));
      fb.drawMesh(cam, this.boarder, r.x, r.y, r.z, r.yaw, 1);
    }

    const img = this.makeImage(fb.w, fb.h, fb.rgba);
    this.imageRect(img, 0, 0, fb.w, fb.h, 0, 0, this.W, this.H);

    if (s.flash > 0 && !s.calm) {
      this.rect(0, 0, this.W, this.H, "#ffffff", clamp(s.flash / 8, 0, 0.55));
    }

    this.drawHud();
    for (const p of s.pops) {
      this.textC(p.text, this.W / 2, Math.round(this.H * 0.34 - (55 - p.life) * 0.35), p.color);
    }
    this.drawOverlays();
    return this.snapshot();
  }

  private drawHud(): void {
    const s = this.sim;
    if (s.state !== "ride") return;
    const f = hudFrame(s.hud, this.W, this.H);
    const lx = f.top.lx, rx = f.top.rx, ty = f.top.y;
    this.band(0, ty + 22, 0.62);
    this.text(PixelPainter.clip(s.project.name, 14), lx, ty, s.project.accent);
    const sc = String(s.score).padStart(5, "0");
    this.text(sc, rx - textWidth(sc), ty, "#fff2a0");

    this.text(`RUN ${s.levelIdx + 1}/${s.projects.length}`, lx, ty + 9, "#c7e4ff");
    if (s.combo > 1) {
      const cb = `COMBO x${s.combo}`;
      this.text(cb, rx - textWidth(cb), ty + 9, "#8dff9a");
    }
    const frac = clamp(s.rider.y / RUN_LEN, 0, 1);
    this.rect(lx, ty + 17, rx - lx, 2, INK);
    this.rect(lx, ty + 17, Math.round((rx - lx) * frac), 2, s.project.accent);

    if (s.rider.air) {
      this.textC("CLICK / SPACE FOR TRICK!", f.content.cx, f.bottom.y - 16, "#fff2a0");
    }
  }

  private drawOverlays(): void {
    const s = this.sim;
    const f = hudFrame(s.hud, this.W, this.H);
    const cx = f.content.cx;
    if (s.state === "title") {
      const top = Math.max(44, s.hud.top + 28);
      this.band(top, 70, 0.58);
      this.textC("3D HALFPIPE SNOWBOARD", cx, top + 6, "#c7e4ff");
      this.textC("POWDER RUN", cx, top + 18, "#fff2a0", 3);
      this.textC("CARVE THE PIPE · COLLECT NOTES & TASKS", cx, top + 44, "#e6eefc");
      this.textC("CLICK / SPACE IN MIDAIR FOR TRICKS", cx, top + 54, "#a8f4e8");
      const bot = this.H - s.hud.bottom - 64;
      this.band(bot, 42, 0.58);
      if ((s.t >> 5) & 1) this.textC(s.inputMode === "pointer" ? "CLICK OR SPACE TO DROP IN" : "TAP TO DROP IN", cx, bot + 10, "#ffffff");
      this.textC(`BEST ${s.best}`, cx, bot + 26, "#c7d0e6");
    } else if (s.state === "intro") {
      const by = Math.round(this.H * 0.42);
      this.band(by - 8, 42, 0.65);
      this.textC(`RUN ${s.levelIdx + 1} OF ${s.projects.length}`, cx, by, "#c7e4ff");
      this.textC(PixelPainter.clip(s.project.name, 20), cx, by + 12, s.project.accent, 2);
      this.textC(`${s.totalCollect} NOTES & TASKS`, cx, by + 28, "#ffffff");
    } else if (s.state === "clear") {
      const by = Math.round(this.H * 0.42);
      this.band(by - 4, 34, 0.65);
      this.textC("RUN COMPLETE!", cx, by + 4, "#8dff9a", 2);
      this.textC(`SCORE ${s.score}`, cx, by + 22, "#fff2a0");
    } else if (s.state === "win") {
      const by = Math.round(this.H * 0.4);
      this.band(by - 8, 56, 0.72);
      this.textC("ALL RUNS CLEARED!", cx, by, "#8dff9a", 2);
      this.textC(`SCORE ${s.score} · BEST ${s.best}`, cx, by + 20, "#fff2a0");
      if (s.stateT <= 0 && ((s.t >> 5) & 1)) {
        this.textC(s.inputMode === "pointer" ? "CLICK OR SPACE TO RIDE AGAIN" : "TAP TO RIDE AGAIN", cx, by + 38, "#ffffff");
      }
    }
  }
}
