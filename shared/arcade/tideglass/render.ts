/**
 * Tideglass 3D renderer — real perspective 3D mountain traversal via
 * our shared Software 3D Z-buffer rasterizer (`Framebuffer3D`).
 *
 * Renders a chunky low-res 3D world (A Short Hike style) with a behind-the-
 * shoulder perspective camera looking down the mountain toward the sea,
 * Z-buffered lit terrain triangles, cliff rock faces, 3D voxel meshes
 * converted from `models.ts`, distance fog, and crisp 2D HUD overlays.
 */

import { textWidth } from "../pixel/font";
import { hudFrame } from "../pixel/hud";
import { clamp } from "../pixel/kinds";
import { INK, PixelPainter, type PixelBackend } from "../pixel/painter";
import { Framebuffer3D, makeCam3D, meshFromModel, screenRay, worldToCam, type Cam3D, type Mesh3D } from "../pixel/raster3d";
import { makeModel } from "../pixel/models";
import { hash2 } from "../pixel/terrain";
import {
  BRIDGE_MODEL,
  CHEST_MODEL,
  CRATE_MODEL,
  DOCK_MODEL,
  GEAR_MODEL,
  LIGHTHOUSE_MODEL,
  MILL_MODEL,
  PINE_MODEL,
  RADIO_MODEL,
  ROCK_MODEL,
  SHARD_MODEL,
  SIGN_MODEL,
  VAULT_MODEL,
  WICK_MODEL,
  hutModel,
  npcModel,
} from "./models";
import {
  CHEST_POS,
  CHANNEL,
  CYCLE_FRAMES,
  DOCK_POS,
  FLAT_POS,
  HUT_POS,
  LIGHTHOUSE_POS,
  MILL_POS,
  RADIO_POS,
  VAULT_POS,
  WORLD_H,
  WORLD_W,
  altZone,
  heightAt,
  trailDist,
  type TideglassPhase,
  type TideglassSim,
} from "./sim";

/** World-Z units per height ledge (0..3.2 ledges => 0..115 Z units). */
const H_SCALE = 36;
const GRID_STEP = 16;

const CLOUD_MODEL = makeModel(9, 5, 4, (x, y, z) => {
  const dx = (x - 4) / 4, dy = (y - 2) / 2, dz = (z - 1.5) / 1.8;
  if (dx * dx + dy * dy + dz * dz > 1.05) return null;
  return z >= 2 ? "#ffffff" : z === 1 ? "#e6f2fc" : "#c8dcee";
});

const PHASE_LABEL: Record<TideglassPhase, { label: string; col: string; skyTop: [number, number, number]; skyHor: [number, number, number] }> = {
  calm: { label: "CALM", col: "#a8f4e8", skyTop: [52, 128, 196], skyHor: [176, 224, 240] },
  wind: { label: "WIND", col: "#fff2a0", skyTop: [68, 114, 178], skyHor: [224, 210, 176] },
  squall: { label: "SQUALL", col: "#ff9e44", skyTop: [24, 38, 72], skyHor: [76, 102, 138] },
  ebb: { label: "EBB", col: "#8fb8ff", skyTop: [14, 24, 54], skyHor: [56, 86, 132] },
};

function zoneRgb(zone: string, alt: boolean): [number, number, number] {
  switch (zone) {
    case "PEAK":
      return alt ? [220, 232, 244] : [182, 196, 214];
    case "ALPINE":
      return alt ? [116, 142, 126] : [92, 114, 124];
    case "FOREST":
      return alt ? [68, 156, 88] : [48, 120, 68];
    default:
      return alt ? [226, 206, 148] : [192, 168, 116];
  }
}

export class TideglassRenderer<Img = unknown, Frame = unknown> extends PixelPainter<Img, Frame> {
  private readonly sim: TideglassSim;
  private fb: Framebuffer3D;
  private lastCam: Cam3D | null = null;

  private readonly wickMesh: Mesh3D;
  private readonly lightMesh: Mesh3D;
  private readonly millMesh: Mesh3D;
  private readonly radioMesh: Mesh3D;
  private readonly dockMesh: Mesh3D;
  private readonly chestMesh: Mesh3D;
  private readonly vaultMesh: Mesh3D;
  private readonly crateMesh: Mesh3D;
  private readonly gearMesh: Mesh3D;
  private readonly shardMesh: Mesh3D;
  private readonly pineMesh: Mesh3D;
  private readonly rockMesh: Mesh3D;
  private readonly signMesh: Mesh3D;
  private readonly bridgeMesh: Mesh3D;
  private readonly cloudMesh: Mesh3D;
  private readonly huts = new Map<string, Mesh3D>();
  private readonly npcsMap = new Map<string, Mesh3D>();
  private readonly trees: [number, number][];
  private readonly rocks: [number, number][];

  constructor(backend: PixelBackend<Img, Frame>, sim: TideglassSim) {
    super(backend, sim.W, sim.H);
    this.sim = sim;
    this.fb = this.allocFB(sim.W, sim.H);
    sim.raycast = (sx, sy) => this.pickWorld(sx, sy);

    this.wickMesh = meshFromModel(WICK_MODEL, 1.35, 1.5);
    this.lightMesh = meshFromModel(LIGHTHOUSE_MODEL, 2.2, 2.4);
    this.millMesh = meshFromModel(MILL_MODEL, 2.0, 2.0);
    this.radioMesh = meshFromModel(RADIO_MODEL, 2.0, 2.2);
    this.dockMesh = meshFromModel(DOCK_MODEL, 2.0, 1.8);
    this.chestMesh = meshFromModel(CHEST_MODEL, 1.4, 1.4);
    this.vaultMesh = meshFromModel(VAULT_MODEL, 2.0, 2.0);
    this.crateMesh = meshFromModel(CRATE_MODEL, 1.4, 1.4);
    this.gearMesh = meshFromModel(GEAR_MODEL, 1.3, 1.3);
    this.shardMesh = meshFromModel(SHARD_MODEL, 1.5, 1.6);
    this.pineMesh = meshFromModel(PINE_MODEL, 2.1, 2.3);
    this.rockMesh = meshFromModel(ROCK_MODEL, 1.8, 1.8);
    this.signMesh = meshFromModel(SIGN_MODEL, 1.4, 1.5);
    this.bridgeMesh = meshFromModel(BRIDGE_MODEL, 2.4, 1.8);
    this.cloudMesh = meshFromModel(CLOUD_MODEL, 5.5, 4.0);

    const landmarks = [LIGHTHOUSE_POS, MILL_POS, RADIO_POS, HUT_POS, VAULT_POS, DOCK_POS, FLAT_POS];
    const clearSpot = (x: number, y: number): boolean =>
      trailDist(x, y) > 24 && landmarks.every((p) => Math.hypot(x - p.x, y - p.y) > 42);
    const trees: [number, number][] = [];
    for (let i = 0; i < 140 && trees.length < 56; i++) {
      const tx = 70 + Math.floor(hash2(i, 11, 7) * (WORLD_W - 140));
      const ty = 150 + Math.floor(hash2(i, 23, 7) * (WORLD_H - 240));
      const z = altZone(heightAt(tx, ty));
      if ((z === "FOREST" || z === "ALPINE") && clearSpot(tx, ty)) trees.push([tx, ty]);
    }
    this.trees = trees;
    const rocks: [number, number][] = [];
    for (let i = 0; i < 70 && rocks.length < 24; i++) {
      const rx = 60 + Math.floor(hash2(i, 37, 13) * (WORLD_W - 120));
      const ry = 80 + Math.floor(hash2(i, 41, 13) * (WORLD_H - 140));
      if (clearSpot(rx, ry)) rocks.push([rx, ry]);
    }
    this.rocks = rocks;
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

  private hutMesh(accent: string): Mesh3D {
    let m = this.huts.get(accent);
    if (!m) {
      m = meshFromModel(hutModel(accent), 2.0, 2.0);
      this.huts.set(accent, m);
    }
    return m;
  }

  private npcMesh(accent: string): Mesh3D {
    let m = this.npcsMap.get(accent);
    if (!m) {
      m = meshFromModel(npcModel(accent), 1.35, 1.45);
      this.npcsMap.set(accent, m);
    }
    return m;
  }

  private buildCam(): Cam3D {
    const s = this.sim;
    const hGround = heightAt(s.wick.x, s.wick.y);
    const wz = Math.max(hGround, s.wick.z) * H_SCALE;
    const jx = s.shake > 0 && !s.calm ? (s.rand() * 2 - 1) * s.shake * 1.4 : 0;
    const jz = s.shake > 0 && !s.calm ? (s.rand() * 2 - 1) * s.shake * 0.8 : 0;
    const eye = { x: s.wick.x + 14 + jx, y: s.wick.y - 110, z: wz + 88 + jz };
    const target = { x: s.wick.x, y: s.wick.y + 42, z: wz + 10 };
    return makeCam3D(eye, target, this.fb.w, this.fb.h, 55, 8, 860);
  }

  /** Raycast from full-screen (sx, sy) onto the 3D mountain heightfield. */
  pickWorld(sx: number, sy: number): { x: number; y: number } | null {
    const cam = this.lastCam ?? this.buildCam();
    const rx = (sx / Math.max(1, this.W)) * this.fb.w;
    const ry = (sy / Math.max(1, this.H)) * this.fb.h;
    const ray = screenRay(cam, rx, ry);
    let prevT = 10;
    for (let t = 20; t <= 820; t += 14) {
      const px = ray.origin.x + ray.dir.x * t;
      const py = ray.origin.y + ray.dir.y * t;
      const pz = ray.origin.z + ray.dir.z * t;
      const hz = heightAt(px, py) * H_SCALE;
      if (pz <= hz) {
        // Binary refine between prevT and t.
        let lo = prevT, hi = t;
        for (let k = 0; k < 5; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = ray.origin.x + ray.dir.x * mid;
          const my = ray.origin.y + ray.dir.y * mid;
          const mz = ray.origin.z + ray.dir.z * mid;
          if (mz <= heightAt(mx, my) * H_SCALE) hi = mid;
          else lo = mid;
        }
        const hitT = (lo + hi) * 0.5;
        return {
          x: clamp(ray.origin.x + ray.dir.x * hitT, 20, WORLD_W - 20),
          y: clamp(ray.origin.y + ray.dir.y * hitT, 28, WORLD_H - 20),
        };
      }
      prevT = t;
    }
    return null;
  }

  /** Project a world point to full-screen 2D (for labels/rings). */
  private toScreen2D(cam: Cam3D, wx: number, wy: number, wz: number): { x: number; y: number; z: number } | null {
    const c = worldToCam(cam, wx, wy, wz);
    if (c.z < cam.near || c.z > cam.far) return null;
    const inv = cam.focal / c.z;
    const fx = cam.hw + c.x * inv;
    const fy = cam.hh - c.y * inv;
    return {
      x: (fx / this.fb.w) * this.W,
      y: (fy / this.fb.h) * this.H,
      z: c.z,
    };
  }

  private drawTerrain3D(cam: Cam3D): void {
    const s = this.sim;
    const fb = this.fb;

    // Subdivided 3D ocean tiles around the camera (prevents huge-tri depth warping).
    const seaZ = 1.2;
    const seaStep = 160;
    const ox0 = Math.floor((s.wick.x - 640) / seaStep) * seaStep;
    const ox1 = Math.ceil((s.wick.x + 640) / seaStep) * seaStep;
    const oy0 = Math.floor((s.wick.y - 160) / seaStep) * seaStep;
    const oy1 = Math.ceil((s.wick.y + 820) / seaStep) * seaStep;
    for (let y = oy0; y < oy1; y += seaStep) {
      for (let x = ox0; x < ox1; x += seaStep) {
        fb.drawTri(cam, x, y, seaZ, x + seaStep, y, seaZ, x + seaStep, y + seaStep, seaZ, 24, 86, 124);
        fb.drawTri(cam, x, y, seaZ, x + seaStep, y + seaStep, seaZ, x, y + seaStep, seaZ, 22, 82, 118);
      }
    }

    // Local 3D mountain mesh around the camera.
    const xMin = Math.max(0, Math.floor((s.wick.x - 380) / GRID_STEP) * GRID_STEP);
    const xMax = Math.min(WORLD_W, Math.ceil((s.wick.x + 380) / GRID_STEP) * GRID_STEP);
    const yMin = Math.max(0, Math.floor((s.wick.y - 160) / GRID_STEP) * GRID_STEP);
    const yMax = Math.min(WORLD_H, Math.ceil((s.wick.y + 580) / GRID_STEP) * GRID_STEP);

    const sunX = -0.55, sunY = -0.4, sunZ = 0.73;

    const emitTri = (
      x0: number, y0: number, z0: number,
      x1: number, y1: number, z1: number,
      x2: number, y2: number, z2: number,
    ) => {
      const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
      const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      if (nz < 0) {
        nx = -nx; ny = -ny; nz = -nz;
      }

      const cx = (x0 + x1 + x2) * 0.3333;
      const cy = (y0 + y1 + y2) * 0.3333;
      const cz = (z0 + z1 + z2) * 0.3333;
      const h = cz / H_SCALE;
      const zone = altZone(h);

      let cr: number, cg: number, cb: number;
      const edgeDist = Math.min(cx, WORLD_W - cx, cy - 22, WORLD_H - cy);
      if (edgeDist < 12) {
        [cr, cg, cb] = edgeDist < 6 ? [26, 94, 130] : [194, 232, 248];
      } else if (cx > CHANNEL.x0 && cx < CHANNEL.x1 && cy >= CHANNEL.y - 9 && cy < CHANNEL.y + 9) {
        [cr, cg, cb] = s.bridgeDown && Math.abs(cx - 240) < 28 ? [138, 90, 50] : [29, 84, 118];
      } else if (!s.causewayOpen && Math.hypot(cx - FLAT_POS.x, cy - FLAT_POS.y) < 42) {
        [cr, cg, cb] = [29, 82, 114];
      } else if (nz < 0.78) {
        // Steep slope => exposed 3D rocky cliff face!
        [cr, cg, cb] = zone === "FOREST" ? [102, 82, 66] : zone === "SHORE" ? [146, 120, 86] : [88, 98, 124];
      } else if (trailDist(cx, cy) < 11) {
        [cr, cg, cb] = [222, 198, 152];
      } else {
        const checker = (((Math.floor(cx / GRID_STEP) + Math.floor(cy / GRID_STEP)) & 1) === 0);
        [cr, cg, cb] = zoneRgb(zone, checker);
      }

      const ndotl = clamp(nx * sunX + ny * sunY + nz * sunZ, 0, 1);
      const shade = 0.56 + ndotl * 0.48;
      fb.drawTri(
        cam, x0, y0, z0, x1, y1, z1, x2, y2, z2,
        clamp(Math.round(cr * shade), 0, 255),
        clamp(Math.round(cg * shade), 0, 255),
        clamp(Math.round(cb * shade), 0, 255),
        true,
      );
    };

    for (let y = yMin; y < yMax; y += GRID_STEP) {
      const yNext = Math.min(WORLD_H, y + GRID_STEP);
      for (let x = xMin; x < xMax; x += GRID_STEP) {
        const xNext = Math.min(WORLD_W, x + GRID_STEP);
        const z00 = heightAt(x, y) * H_SCALE;
        const z10 = heightAt(xNext, y) * H_SCALE;
        const z01 = heightAt(x, yNext) * H_SCALE;
        const z11 = heightAt(xNext, yNext) * H_SCALE;
        emitTri(x, y, z00, xNext, y, z10, xNext, yNext, z11);
        emitTri(x, y, z00, xNext, yNext, z11, x, yNext, z01);
      }
    }
  }

  private drawShadow3D(cam: Cam3D, wx: number, wy: number, _wz: number, r: number): void {
    const zc = heightAt(wx, wy) * H_SCALE + 2.4;
    const N = 8;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2;
      const a1 = ((i + 1) / N) * Math.PI * 2;
      const x0 = wx + Math.cos(a0) * r, y0 = wy + Math.sin(a0) * r;
      const x1 = wx + Math.cos(a1) * r, y1 = wy + Math.sin(a1) * r;
      const z0 = Math.max(zc, heightAt(x0, y0) * H_SCALE + 2.4);
      const z1 = Math.max(zc, heightAt(x1, y1) * H_SCALE + 2.4);
      this.fb.drawTri(cam, wx, wy, zc, x1, y1, z1, x0, y0, z0, 16, 24, 42, true);
    }
  }

  draw(): Frame {
    const s = this.sim;
    const pl = PHASE_LABEL[s.phase];
    const fb = this.fb;
    fb.fogR = pl.skyHor[0];
    fb.fogG = pl.skyHor[1];
    fb.fogB = pl.skyHor[2];
    fb.clearSky(pl.skyTop[0], pl.skyTop[1], pl.skyTop[2], pl.skyHor[0], pl.skyHor[1], pl.skyHor[2], 0.36);

    const cam = this.buildCam();
    this.lastCam = cam;

    // 1. 3D Mountain terrain + Ocean
    this.drawTerrain3D(cam);

    // 2. 3D Landmarks, trees, rocks, pickups, NPCs, and Wick
    const drawProp = (x: number, y: number, mesh: Mesh3D, yaw = 0, scale = 1, lift = 0, shadowR = 8) => {
      if (Math.hypot(x - s.wick.x, y - s.wick.y) > 640) return;
      const gz = heightAt(x, y) * H_SCALE;
      if (shadowR > 0) this.drawShadow3D(cam, x, y, gz, shadowR);
      fb.drawMesh(cam, mesh, x, y, gz + lift, yaw, scale);
    };

    drawProp(LIGHTHOUSE_POS.x, LIGHTHOUSE_POS.y, this.lightMesh, 0, 1, 0, 12);
    if (s.lampCrank >= 3 || s.beaconHeld) {
      const lh = heightAt(LIGHTHOUSE_POS.x, LIGHTHOUSE_POS.y) * H_SCALE + 44;
      const ba = s.t * 0.03;
      const bx1 = LIGHTHOUSE_POS.x + Math.cos(ba - 0.14) * 140;
      const by1 = LIGHTHOUSE_POS.y + Math.sin(ba - 0.14) * 140;
      const bx2 = LIGHTHOUSE_POS.x + Math.cos(ba + 0.14) * 140;
      const by2 = LIGHTHOUSE_POS.y + Math.sin(ba + 0.14) * 140;
      fb.drawTri(cam, LIGHTHOUSE_POS.x, LIGHTHOUSE_POS.y, lh, bx1, by1, lh - 18, bx2, by2, lh - 18, 255, 240, 158, true);
    }
    drawProp(MILL_POS.x, MILL_POS.y, this.millMesh, 0, 1, 0, 11);
    if (s.bridgeDown) drawProp(240, CHANNEL.y, this.bridgeMesh, Math.PI / 2, 1, 1, 0);
    drawProp(RADIO_POS.x, RADIO_POS.y, this.radioMesh, 0, 1, 0, 9);
    drawProp(DOCK_POS.x, DOCK_POS.y, this.dockMesh, 0, 1, 0, 0);
    drawProp(HUT_POS.x, HUT_POS.y, this.hutMesh(s.islandAccent), 0, 1, 0, 11);
    drawProp(VAULT_POS.x, VAULT_POS.y, this.vaultMesh, 0, 1, 0, 10);
    drawProp(530, 340, this.signMesh, 0.2, 1, 0, 3);
    drawProp(520, 660, this.signMesh, -0.3, 1, 0, 3);
    if (!s.chestOpened) drawProp(CHEST_POS.x, CHEST_POS.y, this.chestMesh, 0, 1, 0, 6);
    const cratePos = s.crateAtDock ? { x: DOCK_POS.x - 6, y: DOCK_POS.y - 14 } : { x: FLAT_POS.x + 34, y: FLAT_POS.y - 6 };
    drawProp(cratePos.x, cratePos.y, this.crateMesh, 0.2, 1, 0, 6);

    for (const pk of s.pickups) {
      if (pk.taken) continue;
      if (pk.kind === "shard" && !(s.phase === "ebb" && s.causewayOpen)) continue;
      const bob = Math.sin(pk.bob) * 3 + 2;
      drawProp(pk.x, pk.y, pk.kind === "gear" ? this.gearMesh : this.shardMesh, s.t * 0.04, 1, bob, 4);
    }

    for (const [px, py] of this.trees) {
      const sway = Math.sin(s.t * 0.03 + px * 0.05) * 0.05;
      drawProp(px, py, this.pineMesh, sway, 1, 0, 7);
    }
    for (const [rx, ry] of this.rocks) {
      drawProp(rx, ry, this.rockMesh, 0, 1, 0, 6);
    }

    for (const n of s.npcs) {
      drawProp(n.x, n.y, this.npcMesh(n.accent), n.a, 1, 0, 5);
    }

    // Wick + 3D ground shadow + spread oilskin glider wings when soaring
    {
      const gz = heightAt(s.wick.x, s.wick.y) * H_SCALE;
      const wz = Math.max(gz, s.wick.z * H_SCALE);
      const airH = Math.max(0, wz - gz);
      const shR = clamp(7 - airH * 0.05, 3, 7);
      this.drawShadow3D(cam, s.wick.x, s.wick.y, gz, shR);
      const stride = s.wick.air === 0 ? Math.abs(Math.sin(s.wick.walkPhase)) * 2.2 : 0;
      fb.drawMesh(cam, this.wickMesh, s.wick.x, s.wick.y, wz + stride, s.wick.a, 1.05);
      if (s.wick.gliding) {
        const wingZ = wz + 12;
        const c = Math.cos(s.wick.a), sn = Math.sin(s.wick.a);
        const lx = s.wick.x - c * 14, ly = s.wick.y - sn * 14;
        const rx = s.wick.x + c * 14, ry = s.wick.y + sn * 14;
        const bx = s.wick.x + sn * 8, by = s.wick.y - c * 8;
        fb.drawTri(cam, s.wick.x, s.wick.y, wingZ + 2, lx, ly, wingZ - 1, bx, by, wingZ, 232, 163, 61, true);
        fb.drawTri(cam, s.wick.x, s.wick.y, wingZ + 2, rx, ry, wingZ - 1, bx, by, wingZ, 245, 198, 96, true);
      }
    }

    // 3. Puffy 3D voxel clouds floating far ahead in the sky (never clipping camera)
    if (!s.calm) {
      for (let i = 0; i < 8; i++) {
        const cx = ((i * 210 + s.t * 0.22) % (WORLD_W + 320)) - 160;
        const cy = 180 + ((i * 175) % (WORLD_H - 120));
        if (cy < s.wick.y + 120 || Math.hypot(cx - s.wick.x, cy - s.wick.y) > 760) continue;
        const cz = 185 + (i % 3) * 16;
        fb.drawMesh(cam, this.cloudMesh, cx, cy, cz, 0, 1);
      }
    }

    // Blit chunky 3D framebuffer scaled nearest-neighbor to full canvas
    const img = this.makeImage(fb.w, fb.h, fb.rgba);
    this.imageRect(img, 0, 0, fb.w, fb.h, 0, 0, this.W, this.H);

    // 4. Crisp 2D projected overlays (NPC names, speech, pops, rain)
    for (const n of s.npcs) {
      const sp = this.toScreen2D(cam, n.x, n.y, heightAt(n.x, n.y) * H_SCALE + 20);
      if (!sp) continue;
      this.textC(n.name, sp.x, sp.y - 6, n.accent);
      if (n.sayTimer > 0) {
        const msg = n.say.slice(0, 30);
        const wpx = textWidth(msg, 1) + 8;
        this.rect(sp.x - wpx / 2, sp.y - 20, wpx, 11, INK, 0.85);
        this.text(msg, sp.x - wpx / 2 + 4, sp.y - 17, "#ffffff");
      }
    }
    for (const p of s.pops) {
      if (!p.text || (p.life < 20 && (p.life & 2))) continue;
      const sp = this.toScreen2D(cam, p.x, p.y, heightAt(p.x, p.y) * H_SCALE + 16);
      if (sp) this.textC(p.text.slice(0, 26), sp.x, sp.y, p.color);
    }
    if (s.phase === "squall" && !s.calm) {
      for (let i = 0; i < 28; i++) {
        const x = ((i * 67 + s.t * 3) % (this.W + 20)) - 10;
        const y = ((i * 41 + s.t * 7) % (this.H + 20)) - 10;
        this.line(x, y, x - 3, y + 7, "#8fb8ff", 0.45);
      }
    }

    if (s.flash > 0 && !s.calm) {
      this.rect(0, 0, this.W, this.H, "#ffffff", clamp(s.flash / 8, 0, 0.55));
    }

    this.drawHud();
    if (s.bannerTimer > 0 && s.state === "play") {
      const f = hudFrame(s.hud, this.W, this.H);
      const by = f.top.y + 26;
      this.band(by - 2, 13, 0.55);
      this.textC(s.bannerText.slice(0, 40), f.content.cx, by + 2, s.bannerColor);
    }
    if (s.state === "title") this.drawTitle();
    else if (s.showLog) this.drawLog();
    else if (s.nearby) this.drawAct();
    if (s.showWin) this.drawWin();

    return this.snapshot();
  }

  private drawHud(): void {
    const s = this.sim;
    if (s.state !== "play") return;
    const f = hudFrame(s.hud, this.W, this.H);
    const pl = PHASE_LABEL[s.phase];
    const h = heightAt(s.wick.x, s.wick.y);
    const zone = altZone(h);
    const lx = f.top.lx, rx = f.top.rx, ty = f.top.y;

    this.band(0, ty + 22, 0.62);
    this.text(this.clock(), lx, ty, "#ffffff");
    this.text(pl.label, lx + 24, ty, pl.col);
    const lb = s.logButtonRect();
    this.rect(lb.x, lb.y, lb.w, lb.h, s.showLog ? "#fff2a0" : INK, s.showLog ? 1 : 0.85);
    this.strokeRect(lb.x, lb.y, lb.w, lb.h, "#fff2a0", 0.7);
    this.textC(`LOG ${s.secrets.size}/5`, lb.x + lb.w / 2, lb.y + 3, s.showLog ? INK : "#fff2a0", 1, null);

    const sh = `SH ${s.shards}/3`;
    this.text(sh, lb.x - textWidth(sh) - 6, ty + 1, "#a8f4e8");

    this.text(`${zone} ^${h.toFixed(1)}`, lx, ty + 9, "#c7e4ff");
    const sc = String(s.score).padStart(5, "0");
    this.text(sc, rx - textWidth(sc), ty + 9, "#fff2a0");

    const frac = Math.min(s.cycleTick / CYCLE_FRAMES, 1);
    this.rect(lx, ty + 17, rx - lx, 2, INK);
    this.rect(lx, ty + 17, Math.round((rx - lx) * frac), 2, pl.col);

    // Altitude ribbon on right edge
    const altx = f.content.rx - 6, ry0 = ty + 26, ry1 = f.bottom.y - 28;
    if (ry1 > ry0 + 30) {
      const zones: [string, string][] = [["PEAK", "#aeb9cc"], ["ALPINE", "#7d8aa0"], ["FOREST", "#3d8a52"], ["SHORE", "#d9c48a"]];
      const segH = (ry1 - ry0) / zones.length;
      zones.forEach(([, col], i) => this.rect(altx, ry0 + i * segH, 4, segH, col, 0.72));
      const afrac = clamp((3.2 - h) / 3.2, 0, 1);
      this.circle(altx + 2, ry0 + afrac * (ry1 - ry0), 3, "#ffffff");
      this.circle(altx + 2, ry0 + afrac * (ry1 - ry0), 3, "#0a0f1e", 0.35, true);
    }

    if (s.t < 240 && !s.nearby && ((s.t >> 5) & 1)) {
      const hint = s.inputMode === "pointer" ? "WASD MOVE · SPACE GLIDE/ACT · L LOG" : "DRAG TO MOVE · TAP TO WALK";
      this.textC(hint, f.content.cx, f.bottom.y - 10, "#c7e4ff");
    }
  }

  private clock(): string {
    const cyc = this.sim.cycleTick % CYCLE_FRAMES;
    const sec = Math.floor(cyc / 60);
    return `${(sec / 60) | 0}:${String(sec % 60).padStart(2, "0")}`;
  }

  private drawAct(): void {
    const s = this.sim;
    if (!s.nearby || s.showLog || s.state !== "play") return;
    const r = s.actButtonRect();
    this.rect(r.x, r.y, r.w, r.h, INK, 0.88);
    this.strokeRect(r.x, r.y, r.w, r.h, s.nearby.urgent ? "#fff2a0" : "#2ec4b6");
    const label = PixelPainter.clip(s.nearby.prompt, Math.floor((r.w - 10) / 4));
    const msg = s.inputMode === "pointer" ? `${label} (E)` : label;
    this.textC(PixelPainter.clip(msg, Math.floor((r.w - 6) / 4)), r.x + r.w / 2, r.y + 4, "#ffffff");
    this.textC("PRESS SPACE OR E", r.x + r.w / 2, r.y + 12, s.nearby.urgent ? "#fff2a0" : "#a8f4e8", 1, null);
  }

  private drawTitle(): void {
    const s = this.sim;
    const f = hudFrame(s.hud, this.W, this.H);
    const cx = f.content.cx;
    const top = Math.max(44, s.hud.top + 28);
    this.band(top, 70, 0.58);
    this.textC("ONE MOUNTAIN, ONE DAY", cx, top + 6, "#c7e4ff");
    this.textC("TIDEGLASS", cx, top + 18, "#fff2a0", 3);
    this.textC("SUMMIT TO SHORE · HOLD SPACE TO GLIDE", cx, top + 44, "#e6eefc");
    this.textC("LEARN THE ISLAND · FIVE SECRETS", cx, top + 54, "#a8f4e8");

    const bot = this.H - s.hud.bottom - 70;
    this.band(bot, 46, 0.58);
    this.textC("NO GRIND · NO RESET · ONE DESCENT", cx, bot + 6, "#ff9e44");
    this.textC("DISCOVER WHAT EACH ISLANDER KNOWS", cx, bot + 16, "#fff2a0");
    if ((s.t >> 5) & 1) {
      this.textC(s.inputMode === "pointer" ? "CLICK OR SPACE TO DESCEND" : "TAP TO DESCEND", cx, bot + 30, "#ffffff");
    }
    this.textC(`BEST ${s.best}`, cx, this.H - s.hud.bottom - 16, "#c7d0e6");
  }

  private drawWin(): void {
    const s = this.sim;
    const f = hudFrame(s.hud, this.W, this.H);
    const w = Math.min(210, f.content.rx - f.content.lx - 16);
    const h = 92;
    const x = Math.round((f.content.lx + f.content.rx - w) / 2);
    const y = Math.round((f.top.y + f.bottom.y - h) / 2);
    this.rect(x - 2, y - 2, w + 4, h + 4, INK, 0.92);
    this.strokeRect(x - 2, y - 2, w + 4, h + 4, "#fff2a0");
    this.textC("DESCENT COMPLETE", f.content.cx, y + 8, "#fff2a0", 2);
    this.textC(`SCORE ${s.score} · BEST ${s.best}`, f.content.cx, y + 30, "#a8f4e8");
    this.textC(`${s.secrets.size}/5 SECRETS · KEEP WANDERING`, f.content.cx, y + 42, "#8fb8ff");
    if ((s.t >> 5) & 1) this.textC(s.inputMode === "pointer" ? "CLICK OR SPACE TO CONTINUE" : "TAP TO CONTINUE", f.content.cx, y + 58, "#ffffff");
  }

  private drawLog(): void {
    const s = this.sim;
    const f = hudFrame(s.hud, this.W, this.H);
    const x = f.content.lx + 6, y = f.top.y + 22, w = f.content.rx - f.content.lx - 12, h = Math.min(220, f.bottom.y - f.top.y - 60);
    this.rect(x - 3, y - 14, w + 6, h + 30, INK, 0.92);
    this.text("BRASS NOTEBOOK", x, y - 10, "#fff2a0");
    this.text(`L${s.loop} ${this.clock()} · ${s.secrets.size}/5 SECRETS`, x, y, "#8fb8ff");
    const rows = s.notes.slice(-11);
    rows.forEach((n, i) => {
      const mm = `${Math.floor((n.f * 720) / 60)}:${String(Math.floor(n.f * 720) % 60).padStart(2, "0")}`;
      this.text(`L${n.loop} ${mm} ${n.text.slice(0, 30)}`, x, y + 12 + i * 11, "#c7e4ff");
    });
    let sy = y + 12 + rows.length * 11 + 4;
    for (const g of s.getSecretList()) {
      this.text(`${g.unlocked ? "*" : "-"} ${g.title}`, x, sy, g.unlocked ? "#8dff9a" : "#5b6b82");
      if (!g.unlocked) this.text(g.clue.slice(0, 34), x + 8, sy + 9, "#3d4a63");
      sy += g.unlocked ? 11 : 21;
      if (sy > y + h) break;
    }
  }
}
