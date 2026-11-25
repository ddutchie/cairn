/**
 * Powder Run 3D renderer — the U-shaped halfpipe through the shared software
 * Z-buffer rasterizer (`Framebuffer3D`), under a sky that changes with each
 * run (day, dusk, night, dawn) and a mountain ridge behind it.
 */

import type { Priority } from "../../types/domain";
import { textWidth } from "../pixel/font";
import { hudFrame } from "../pixel/hud";
import { clamp } from "../pixel/kinds";
import { INK, PixelPainter, type PixelBackend } from "../pixel/painter";
import { Framebuffer3D, fbSizeFor, makeCam3D, meshFromModel, type Cam3D, type Mesh3D } from "../pixel/raster3d";
import { mulberry32, rgb } from "../pixel/terrain";
import { BOULDER_MODEL, BOARDER_MODEL, NOTE_MODEL, PINE_MODEL, RAMP_MODEL, taskGemModel } from "./models";
import { CRUISE, MAX_HEARTS, MAX_SPEED, PAR_FRAMES, PIPE_HALF_W, RUN_LEN, TRICK_DEFS, pipeHeightAt, type PowderRunSim, type RunSky } from "./sim";

const X_BANDS = [-86, -64, -40, -16, 16, 40, 64, 86];
const Y_STEP = 28;
const GATE_EVERY = 640;
const LAMP_EVERY = 140;

interface SkyLook {
  top: [number, number, number];
  hor: [number, number, number];
  /** Multiplier on snow colours. */
  snow: [number, number, number];
  ridge: [number, number, number];
  fogStart: number;
  fogEnd: number;
  stars: boolean;
  lamps: boolean;
  label: string;
}

const SKIES: Record<RunSky, SkyLook> = {
  day: { top: [46, 112, 188], hor: [178, 216, 242], snow: [1, 1, 1], ridge: [120, 150, 196], fogStart: 240, fogEnd: 560, stars: false, lamps: false, label: "MIDDAY" },
  dusk: { top: [62, 40, 112], hor: [252, 160, 116], snow: [1.02, 0.86, 0.84], ridge: [118, 74, 124], fogStart: 220, fogEnd: 540, stars: false, lamps: true, label: "DUSK" },
  night: { top: [6, 10, 30], hor: [34, 52, 98], snow: [0.56, 0.64, 0.86], ridge: [22, 30, 60], fogStart: 160, fogEnd: 470, stars: true, lamps: true, label: "NIGHT" },
  dawn: { top: [84, 104, 168], hor: [255, 204, 168], snow: [1.02, 0.94, 0.92], ridge: [140, 120, 160], fogStart: 230, fogEnd: 560, stars: false, lamps: false, label: "DAWN" },
};

const GRADE_COLOR: Record<string, string> = { S: "#fff2a0", A: "#8dff9a", B: "#a8f4e8", C: "#c7d0e6" };
const HEART = ["0110110", "1111111", "1111111", "0111110", "0011100", "0001000"];

export class PowderRunRenderer<Img = unknown, Frame = unknown> extends PixelPainter<Img, Frame> {
  private readonly sim: PowderRunSim;
  private fb: Framebuffer3D;
  private readonly boarder: Mesh3D;
  private readonly note: Mesh3D;
  private readonly pine: Mesh3D;
  private readonly boulder: Mesh3D;
  private readonly ramp: Mesh3D;
  private readonly gems: Record<Priority, Mesh3D>;
  /** Mountain ridge heights (0…1) per framebuffer column, rebuilt per run. */
  private ridge = new Float32Array(0);
  private ridgeKey = "";

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
    const size = fbSizeFor(w, h);
    return new Framebuffer3D(size.w, size.h);
  }

  override resize(width: number, height: number): void {
    this.sim.resize(width, height);
    super.resize(width, height);
    this.fb = this.allocFB(width, height);
    this.ridgeKey = "";
  }

  /** Two layers of peaks, wider than the frame so they can slide with the rider. */
  private buildRidge(): void {
    const key = `${this.fb.w}:${this.sim.levelIdx}`;
    if (key === this.ridgeKey) return;
    this.ridgeKey = key;
    const n = this.fb.w * 2;
    const rand = mulberry32(this.sim.levelIdx * 31 + 5);
    const peaks: { x: number; h: number; w: number }[] = [];
    for (let i = 0; i < 9; i++) peaks.push({ x: rand() * n, h: 0.35 + rand() * 0.65, w: n * (0.06 + rand() * 0.08) });
    this.ridge = new Float32Array(n);
    for (let x = 0; x < n; x++) {
      let h = 0.12 + Math.sin(x * 0.05) * 0.03;
      for (const p of peaks) {
        const d = Math.min(Math.abs(x - p.x), n - Math.abs(x - p.x));
        h = Math.max(h, p.h * (1 - d / p.w));
      }
      this.ridge[x] = h;
    }
  }

  private paintBackdrop(look: SkyLook): void {
    const fb = this.fb, s = this.sim;
    const w = fb.w, h = fb.h, buf = fb.buf32;
    if (look.stars) {
      const rand = mulberry32(77);
      for (let i = 0; i < 40; i++) {
        const x = Math.floor(rand() * w), y = Math.floor(rand() * h * 0.3);
        const tw = (s.t + i * 13) % 90 < 6 && !s.calm ? 150 : 235;
        buf[y * w + x] = ((255 << 24) | (tw << 16) | (tw << 8) | tw) >>> 0;
      }
    }
    this.buildRidge();
    const n = this.ridge.length;
    const base = Math.round(h * 0.42), span = h * 0.16;
    const shift = Math.round(s.rider.x * 0.25 + s.levelIdx * 37);
    const [rr, rg, rb] = look.ridge;
    const [sr, sg, sb] = look.snow;
    const snowPx = ((255 << 24) | (Math.min(255, Math.round(236 * sb)) << 16) | (Math.min(255, Math.round(242 * sg)) << 8) | Math.min(255, Math.round(248 * sr))) >>> 0;
    const rockPx = ((255 << 24) | (rb << 16) | (rg << 8) | rr) >>> 0;
    for (let x = 0; x < w; x++) {
      const v = this.ridge[(((x + shift) % n) + n) % n];
      const top = Math.round(base - v * span);
      for (let y = Math.max(0, top); y < Math.min(h, base + 30); y++) {
        buf[y * w + x] = y - top < 1 + v * 3 && v > 0.45 ? snowPx : rockPx;
      }
    }
  }

  private drawPipe(cam: Cam3D, look: SkyLook): void {
    const s = this.sim;
    const fb = this.fb;
    const [ar, ag, ab] = rgb(s.project.accent);
    const [kr, kg, kb] = look.snow;
    const y0 = Math.max(0, Math.floor((s.rider.y - 120) / Y_STEP) * Y_STEP);
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
          r = Math.round(r * 0.6 + ar * 0.4);
          g = Math.round(g * 0.6 + ag * 0.4);
          b = Math.round(b * 0.6 + ab * 0.4);
        }
        r = clamp(Math.round(r * wallShade * kr), 0, 255);
        g = clamp(Math.round(g * wallShade * kg), 0, 255);
        b = clamp(Math.round(b * wallShade * kb), 0, 255);
        fb.drawTri(cam, x0, y, z00, x1, y, z10, x1, yn, z11, r, g, b);
        fb.drawTri(cam, x0, y, z00, x1, yn, z11, x0, yn, z01, r, g, b);
      }
      // Outer snowy deck beyond the halfpipe rims
      const zL0 = pipeHeightAt(-PIPE_HALF_W, y), zL1 = pipeHeightAt(-PIPE_HALF_W, yn);
      const zR0 = pipeHeightAt(PIPE_HALF_W, y), zR1 = pipeHeightAt(PIPE_HALF_W, yn);
      const dr = Math.round(195 * kr), dg = Math.round(214 * kg), db = Math.min(255, Math.round(234 * kb));
      fb.drawTri(cam, -260, y, zL0, -PIPE_HALF_W, y, zL0, -PIPE_HALF_W, yn, zL1, dr, dg, db);
      fb.drawTri(cam, -260, y, zL0, -PIPE_HALF_W, yn, zL1, -260, yn, zL1, dr, dg, db);
      fb.drawTri(cam, PIPE_HALF_W, y, zR0, 260, y, zR0, 260, yn, zR1, dr + 10, dg + 10, Math.min(255, db + 8));
      fb.drawTri(cam, PIPE_HALF_W, y, zR0, 260, yn, zR1, PIPE_HALF_W, yn, zR1, dr + 10, dg + 10, Math.min(255, db + 8));
    }
  }

  /** Split gates every few hundred metres, and the finish arch. */
  private drawGates(cam: Cam3D): void {
    const s = this.sim, fb = this.fb;
    const [ar, ag, ab] = rgb(s.project.accent);
    const from = Math.ceil((s.rider.y - 20) / GATE_EVERY) * GATE_EVERY;
    for (let y = Math.max(GATE_EVERY, from); y <= Math.min(RUN_LEN, s.rider.y + 480); y += GATE_EVERY) {
      const finish = y >= RUN_LEN - GATE_EVERY / 2;
      const gy = finish ? RUN_LEN : y;
      const zl = pipeHeightAt(-PIPE_HALF_W, gy), zr = pipeHeightAt(PIPE_HALF_W, gy);
      const top = Math.max(zl, zr) + 34;
      const px = PIPE_HALF_W + 4;
      fb.drawBox(cam, -px - 3, gy - 2, zl - 2, -px + 3, gy + 2, top, 70, 80, 104);
      fb.drawBox(cam, px - 3, gy - 2, zr - 2, px + 3, gy + 2, top, 70, 80, 104);
      if (finish) {
        // Checkered finish banner.
        const cells = 12, cw = (px * 2) / cells;
        for (let i = 0; i < cells; i++) {
          for (let j = 0; j < 2; j++) {
            const dark = (i + j) & 1;
            const x0 = -px + i * cw, z0 = top - 10 + j * 5;
            fb.drawBox(cam, x0, gy - 1, z0, x0 + cw, gy + 1, z0 + 5, dark ? 24 : 245, dark ? 28 : 245, dark ? 40 : 245);
          }
        }
      } else {
        fb.drawBox(cam, -px, gy - 1, top - 6, px, gy + 1, top, ar, ag, ab);
      }
    }
  }

  private drawLamps(cam: Cam3D): void {
    const s = this.sim, fb = this.fb;
    const from = Math.max(LAMP_EVERY, Math.floor((s.rider.y - 20) / LAMP_EVERY) * LAMP_EVERY);
    for (let y = from; y <= Math.min(RUN_LEN + 80, s.rider.y + 420); y += LAMP_EVERY) {
      for (const side of [-1, 1]) {
        const x = side * (PIPE_HALF_W + 9), ly = y + (side > 0 ? LAMP_EVERY / 2 : 0);
        const z = pipeHeightAt(x, ly);
        fb.drawBox(cam, x - 1, ly - 1, z, x + 1, ly + 1, z + 24, 40, 44, 60);
        fb.drawBox(cam, x - 3, ly - 3, z + 24, x + 3, ly + 3, z + 29, 255, 236, 160);
      }
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
    const look = SKIES[s.sky];
    fb.fogR = look.hor[0];
    fb.fogG = look.hor[1];
    fb.fogB = look.hor[2];
    fb.fogStart = look.fogStart;
    fb.fogEnd = look.fogEnd;
    fb.clearSky(look.top[0], look.top[1], look.top[2], look.hor[0], look.hor[1], look.hor[2], 0.4);
    this.paintBackdrop(look);

    const r = s.rider;
    const jx = s.shake > 0 && !s.calm ? (s.rand() * 2 - 1) * s.shake : 0;
    // The camera pulls back and widens with speed.
    const speedK = clamp((r.vy - CRUISE) / (MAX_SPEED - CRUISE), 0, 1);
    const back = 78 + speedK * 18;
    const fov = 58 + speedK * 8;
    const camZ = Math.max(pipeHeightAt(r.x * 0.55, r.y) + 52, r.z + 26);
    const cam = makeCam3D(
      { x: r.x * 0.55 + jx, y: r.y - back, z: camZ },
      { x: r.x * 0.65, y: r.y + 84, z: Math.max(pipeHeightAt(r.x * 0.65, r.y + 84) + 10, r.z - 30) },
      fb.w,
      fb.h,
      fov,
      6,
      620,
    );

    this.drawPipe(cam, look);
    this.drawGates(cam);
    if (look.lamps) this.drawLamps(cam);

    // Pines lining both rims of the halfpipe, thicker toward the treeline.
    const pineY0 = Math.max(40, Math.floor((r.y - 20) / 70) * 70);
    const pineY1 = Math.min(RUN_LEN + 80, r.y + 460);
    for (let y = pineY0; y <= pineY1; y += 70) {
      const zl = pipeHeightAt(-PIPE_HALF_W - 14, y);
      const zr = pipeHeightAt(PIPE_HALF_W + 14, y);
      fb.drawMesh(cam, this.pine, -PIPE_HALF_W - 14, y, zl, 0, 1);
      fb.drawMesh(cam, this.pine, PIPE_HALF_W + 14, y + 32, zr, 0, 1);
      if (((y / 70) & 1) === 0) {
        fb.drawMesh(cam, this.pine, -PIPE_HALF_W - 40, y + 20, zl, 0, 1.3);
        fb.drawMesh(cam, this.pine, PIPE_HALF_W + 44, y + 52, zr, 0, 1.2);
      }
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
        fb.drawMesh(cam, this.note, it.x, it.y, iz + 18 + Math.sin(s.t * 0.1 + it.id) * 2, s.t * 0.05, 1);
      } else {
        this.drawShadow(cam, it.x, it.y, 5);
        fb.drawMesh(cam, this.gems[it.pr], it.x, it.y, iz + 5 + Math.sin(s.t * 0.1 + it.id) * 2, s.t * 0.06, it.pr === "urgent" ? 1.25 : 1);
      }
    }

    // Rider + ground shadow
    if (r.inv === 0 || (r.inv & 3) < 2) {
      const airH = Math.max(0, r.z - pipeHeightAt(r.x, r.y));
      this.drawShadow(cam, r.x, r.y, clamp(6 - airH * 0.06, 2.5, 6));
      fb.drawMeshPose(cam, this.boarder, r.x, r.y, r.z, r.yaw, r.pitch, r.roll, 1);
    }

    const img = this.makeImage(fb.w, fb.h, fb.rgba);
    this.imageRect(img, 0, 0, fb.w, fb.h, 0, 0, this.W, this.H);

    this.drawWeather(look, speedK);
    if (s.flash > 0 && !s.calm) {
      this.rect(0, 0, this.W, this.H, "#ffffff", clamp(s.flash / 8, 0, 0.55));
    }

    this.drawHud();
    for (let i = 0; i < s.pops.length; i++) {
      const p = s.pops[i];
      this.textC(p.text, this.W / 2, Math.round(this.H * 0.3 - (55 - p.life) * 0.35 + i * 9), p.color);
    }
    this.drawOverlays();
    return this.snapshot();
  }

  /** Snowfall, and speed lines when the rider is flying. */
  private drawWeather(look: SkyLook, speedK: number): void {
    const s = this.sim;
    if (s.calm) return;
    const flakes = look.stars ? 26 : 18;
    const drift = s.rider.vy * 2.2;
    for (let i = 0; i < flakes; i++) {
      const fx = ((i * 97 + s.t * (0.4 + (i % 3) * 0.2) - s.rider.x * 0.8) % this.W + this.W) % this.W;
      const fy = ((i * 53 + s.t * (0.8 + (i % 4) * 0.25) + drift * (i % 5)) % this.H + this.H) % this.H;
      this.px(Math.round(fx), Math.round(fy), "#ffffff", i % 4 === 0 ? 2 : 1, 0.75);
    }
    if (s.state === "ride" && speedK > 0.35) {
      const cx = this.W / 2, cy = this.H * 0.55;
      const n = Math.round(4 + speedK * 8);
      for (let i = 0; i < n; i++) {
        const a = ((i * 2.399 + s.t * 0.37) % (Math.PI * 2));
        const r0 = Math.max(this.W, this.H) * (0.42 + ((s.t * 7 + i * 31) % 40) / 200);
        const r1 = r0 + 14 + speedK * 18;
        this.line(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, "#ffffff", 0.35 + speedK * 0.3);
      }
    }
  }

  private heart(x: number, y: number, full: boolean): void {
    for (let j = 0; j < HEART.length; j++) {
      for (let i = 0; i < HEART[j].length; i++) {
        if (HEART[j][i] === "1") this.px(x + i, y + j, full ? "#ff5e8a" : "#3a4256");
      }
    }
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

    for (let i = 0; i < MAX_HEARTS; i++) this.heart(lx + i * 9, ty + 8, i < s.hearts);
    this.text(`${s.collected}/${s.totalCollect}`, lx + MAX_HEARTS * 9 + 4, ty + 9, "#c7e4ff");
    const secs = s.runFrames / 60, par = PAR_FRAMES / 60;
    const tm = `${secs.toFixed(1)}S PAR ${Math.round(par)}`;
    this.text(tm, rx - textWidth(tm), ty + 9, s.runFrames <= PAR_FRAMES ? "#8dff9a" : "#ff9e7a");
    const frac = clamp(s.rider.y / RUN_LEN, 0, 1);
    this.rect(lx, ty + 17, rx - lx, 2, INK);
    this.rect(lx, ty + 17, Math.round((rx - lx) * frac), 2, s.project.accent);
    // Speed meter along the bottom of the band.
    const spd = clamp((s.rider.vy - 2) / (MAX_SPEED - 2), 0, 1);
    this.rect(lx, ty + 20, Math.round((rx - lx) * spd), 1, spd > 0.6 ? "#fff2a0" : "#7fa8d8");

    // Trick feed: what's held, what's rotating, and the chain.
    const by = f.bottom.y - 22;
    if (s.chain > 1) {
      const cb = `CHAIN X${s.chain}`;
      this.text(cb, f.bottom.rx - textWidth(cb), f.bottom.y - 6, "#8dff9a");
    }
    if (s.held.length) this.textC(`${s.held.join(" + ")}  ${s.heldPts}`, f.content.cx, by, "#fff2a0");
    if (s.trick) {
      const def = TRICK_DEFS[s.trick];
      const w = 48, x0 = Math.round(f.content.cx - w / 2), y0 = by + 9;
      this.rect(x0 - 1, y0 - 1, w + 2, 5, INK);
      const ok = s.trickT > 0.85;
      this.rect(x0, y0, Math.round(w * s.trickT), 3, ok ? "#8dff9a" : "#ff9e7a");
      this.textC(def.name, f.content.cx, y0 + 6, ok ? "#8dff9a" : "#ffffff");
    } else if (s.rider.air && !s.held.length) {
      const hint = s.inputMode === "pointer" ? "ARROWS: SPIN / FLIP / GRAB" : "SWIPE: SPIN / FLIP / GRAB";
      this.textC(hint, f.content.cx, by, "#c7e4ff");
    }
  }

  private drawOverlays(): void {
    const s = this.sim;
    const f = hudFrame(s.hud, this.W, this.H);
    const cx = f.content.cx;
    const pointer = s.inputMode === "pointer";
    if (s.state === "title") {
      const top = Math.max(44, s.hud.top + 28);
      this.band(top, 82, 0.58);
      this.textC("3D HALFPIPE SNOWBOARD", cx, top + 6, "#c7e4ff");
      this.textC("POWDER RUN", cx, top + 18, "#fff2a0", 3);
      this.textC("CARVE THE WALLS TO BUILD SPEED", cx, top + 44, "#e6eefc");
      this.textC(pointer ? "IN THE AIR: ARROWS SPIN, FLIP, GRAB" : "IN THE AIR: SWIPE TO SPIN, FLIP, GRAB", cx, top + 54, "#a8f4e8");
      this.textC("LAND IT CLEAN OR LOSE A HEART", cx, top + 64, "#ff9e7a");
      const bot = this.H - s.hud.bottom - 64;
      this.band(bot, 42, 0.58);
      if ((s.t >> 5) & 1) this.textC(pointer ? "CLICK OR SPACE TO DROP IN" : "TAP TO DROP IN", cx, bot + 10, "#ffffff");
      this.textC(`BEST ${s.best}`, cx, bot + 26, "#c7d0e6");
    } else if (s.state === "intro") {
      const by = Math.round(this.H * 0.4);
      this.band(by - 8, 52, 0.65);
      this.textC(`RUN ${s.levelIdx + 1} OF ${s.projects.length} - ${SKIES[s.sky].label}`, cx, by, "#c7e4ff");
      this.textC(PixelPainter.clip(s.project.name, 20), cx, by + 12, s.project.accent, 2);
      this.textC(`${s.totalCollect} NOTES & TASKS - PAR ${Math.round(PAR_FRAMES / 60)}S`, cx, by + 28, "#ffffff");
      this.textC("URGENT TASKS RIDE HIGH ON THE WALLS", cx, by + 37, "#ff9e7a");
    } else if (s.state === "clear" && s.result) {
      const res = s.result;
      const by = Math.round(this.H * 0.3);
      this.band(by - 8, 92, 0.72);
      this.textC("RUN COMPLETE", cx, by, "#8dff9a");
      this.textC(res.grade, cx, by + 10, GRADE_COLOR[res.grade], 4);
      this.textC(`COLLECTED ${res.collected}/${res.total}`, cx, by + 36, "#ffffff");
      const tm = `TIME ${(res.frames / 60).toFixed(1)}S / PAR ${Math.round(PAR_FRAMES / 60)}S`;
      this.textC(tm, cx, by + 45, res.frames <= PAR_FRAMES ? "#8dff9a" : "#ff9e7a");
      this.textC(`BAILS ${res.bails} - BEST CHAIN X${res.bestChain}`, cx, by + 54, "#c7e4ff");
      this.textC(`BONUS +${res.bonus}`, cx, by + 66, "#fff2a0");
      if (s.levelIdx + 1 < s.projects.length && s.hearts < MAX_HEARTS) this.textC("+1 HEART", cx, by + 76, "#ff5e8a");
    } else if (s.state === "over") {
      const by = Math.round(this.H * 0.38);
      this.band(by - 8, 58, 0.75);
      this.textC("WIPED OUT", cx, by, "#ff5e8a", 2);
      this.textC(`${PixelPainter.clip(s.project.name, 16)} - ${Math.round(s.rider.y / 10)}M OF ${RUN_LEN / 10}M`, cx, by + 18, "#ffffff");
      this.textC(`SCORE ${s.score} - BEST ${s.best}`, cx, by + 28, "#fff2a0");
      if (s.stateT <= 0 && ((s.t >> 5) & 1)) this.textC(pointer ? "CLICK OR SPACE TO RETRY THIS RUN" : "TAP TO RETRY THIS RUN", cx, by + 40, "#ffffff");
    } else if (s.state === "win") {
      const by = Math.round(this.H * 0.4);
      this.band(by - 8, 56, 0.72);
      this.textC("ALL RUNS CLEARED!", cx, by, "#8dff9a", 2);
      this.textC(`SCORE ${s.score} - BEST ${s.best}`, cx, by + 20, "#fff2a0");
      if (s.stateT <= 0 && ((s.t >> 5) & 1)) {
        this.textC(pointer ? "CLICK OR SPACE TO RIDE AGAIN" : "TAP TO RIDE AGAIN", cx, by + 38, "#ffffff");
      }
    }
  }
}
