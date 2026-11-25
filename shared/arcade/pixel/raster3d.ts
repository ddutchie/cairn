/**
 * Pure-TypeScript Software 3D Z-Buffer Rasterizer for Cairn Arcade.
 *
 * Renders flat-shaded, Z-buffered, distance-fogged 3D triangles and
 * voxel-to-mesh models into a raw RGBA Uint8Array buffer, so it works
 * identically on Desktop Canvas2D and Mobile Skia via `PixelBackend.makeImage`.
 */

import type { Model } from "./models";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Tri3D {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
  r: number; g: number; b: number;
}

export interface Mesh3D {
  tris: Tri3D[];
}

export interface Cam3D {
  ex: number; ey: number; ez: number;
  rx: number; ry: number; rz: number;
  ux: number; uy: number; uz: number;
  fx: number; fy: number; fz: number;
  focal: number;
  hw: number;
  hh: number;
  near: number;
  far: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Build a right-handed look-at camera where +Z is up in world space. */
export function makeCam3D(
  eye: Vec3,
  target: Vec3,
  w: number,
  h: number,
  fovDeg = 54,
  near = 6,
  far = 900,
): Cam3D {
  let fx = target.x - eye.x, fy = target.y - eye.y, fz = target.z - eye.z;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;

  // right = normalize(forward x worldUp(0, 0, 1))
  let rx = fy * 1 - fz * 0;
  let ry = fz * 0 - fx * 1;
  let rz = fx * 0 - fy * 0;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;

  // up = right x forward
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  const focal = (h * 0.5) / Math.tan((fovDeg * Math.PI) / 360);
  return { ex: eye.x, ey: eye.y, ez: eye.z, rx, ry, rz, ux, uy, uz, fx, fy, fz, focal, hw: w * 0.5, hh: h * 0.5, near, far };
}

/** Transform world point into camera space (X right, Y up, Z forward). */
export function worldToCam(c: Cam3D, wx: number, wy: number, wz: number): Vec3 {
  const dx = wx - c.ex, dy = wy - c.ey, dz = wz - c.ez;
  return {
    x: dx * c.rx + dy * c.ry + dz * c.rz,
    y: dx * c.ux + dy * c.uy + dz * c.uz,
    z: dx * c.fx + dy * c.fy + dz * c.fz,
  };
}

/** Cast a world-space ray from screen pixel (sx, sy) in [0..w, 0..h]. */
export function screenRay(c: Cam3D, sx: number, sy: number): { origin: Vec3; dir: Vec3 } {
  const nx = (sx - c.hw) / c.focal;
  const ny = (c.hh - sy) / c.focal;
  const dx = c.fx + c.rx * nx + c.ux * ny;
  const dy = c.fy + c.ry * nx + c.uy * ny;
  const dz = c.fz + c.rz * nx + c.uz * ny;
  const l = Math.hypot(dx, dy, dz) || 1;
  return { origin: { x: c.ex, y: c.ey, z: c.ez }, dir: { x: dx / l, y: dy / l, z: dz / l } };
}

/** Convert a Cairn `Model` (stacked voxel slices) into a culled, shaded 3D mesh. */
export function meshFromModel(m: Model, scale = 1.6, zScale = scale): Mesh3D {
  const tris: Tri3D[] = [];
  const hw = m.w * 0.5, hd = m.d * 0.5;
  const at = (x: number, y: number, z: number): [number, number, number] | null => {
    if (x < 0 || y < 0 || z < 0 || x >= m.w || y >= m.d || z >= m.h) return null;
    const o = (y * m.w + x) * 4;
    const buf = m.layers[z];
    if (buf[o + 3] < 128) return null;
    return [buf[o], buf[o + 1], buf[o + 2]];
  };

  const quad = (
    p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3,
    r: number, g: number, b: number, shade: number,
  ) => {
    const cr = clamp(Math.round(r * shade), 0, 255);
    const cg = clamp(Math.round(g * shade), 0, 255);
    const cb = clamp(Math.round(b * shade), 0, 255);
    tris.push({
      ax: p0.x, ay: p0.y, az: p0.z,
      bx: p1.x, by: p1.y, bz: p1.z,
      cx: p2.x, cy: p2.y, cz: p2.z,
      r: cr, g: cg, b: cb,
    });
    tris.push({
      ax: p0.x, ay: p0.y, az: p0.z,
      bx: p2.x, by: p2.y, bz: p2.z,
      cx: p3.x, cy: p3.y, cz: p3.z,
      r: cr, g: cg, b: cb,
    });
  };

  for (let z = 0; z < m.h; z++) {
    const z0 = z * zScale, z1 = (z + 1) * zScale;
    for (let y = 0; y < m.d; y++) {
      const y0 = (y - hd) * scale, y1 = (y + 1 - hd) * scale;
      for (let x = 0; x < m.w; x++) {
        const col = at(x, y, z);
        if (!col) continue;
        const x0 = (x - hw) * scale, x1 = (x + 1 - hw) * scale;
        const [r, g, b] = col;
        // +Z top
        if (!at(x, y, z + 1)) {
          quad({ x: x0, y: y0, z: z1 }, { x: x1, y: y0, z: z1 }, { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 }, r, g, b, 1.06);
        }
        // -Y north (facing camera when looking south)
        if (!at(x, y - 1, z)) {
          quad({ x: x0, y: y0, z: z0 }, { x: x1, y: y0, z: z0 }, { x: x1, y: y0, z: z1 }, { x: x0, y: y0, z: z1 }, r, g, b, 0.92);
        }
        // +Y south
        if (!at(x, y + 1, z)) {
          quad({ x: x1, y: y1, z: z0 }, { x: x0, y: y1, z: z0 }, { x: x0, y: y1, z: z1 }, { x: x1, y: y1, z: z1 }, r, g, b, 0.72);
        }
        // -X west
        if (!at(x - 1, y, z)) {
          quad({ x: x0, y: y1, z: z0 }, { x: x0, y: y0, z: z0 }, { x: x0, y: y0, z: z1 }, { x: x0, y: y1, z: z1 }, r, g, b, 0.84);
        }
        // +X east
        if (!at(x + 1, y, z)) {
          quad({ x: x1, y: y0, z: z0 }, { x: x1, y: y1, z: z0 }, { x: x1, y: y1, z: z1 }, { x: x1, y: y0, z: z1 }, r, g, b, 0.78);
        }
      }
    }
  }
  return { tris };
}

interface ClipV {
  x: number; y: number; z: number;
}

/** Software 3D framebuffer with Z-buffer and sky/fog gradient. */
export class Framebuffer3D {
  readonly w: number;
  readonly h: number;
  readonly rgba: Uint8Array;
  readonly buf32: Uint32Array;
  readonly zbuf: Float32Array;
  fogR = 135;
  fogG = 195;
  fogB = 225;
  fogStart = 280;
  fogEnd = 760;

  constructor(w: number, h: number) {
    this.w = Math.max(1, w | 0);
    this.h = Math.max(1, h | 0);
    this.rgba = new Uint8Array(this.w * this.h * 4);
    this.buf32 = new Uint32Array(this.rgba.buffer);
    this.zbuf = new Float32Array(this.w * this.h);
  }

  /** Fill sky-to-horizon vertical gradient and reset 1/Z depth buffer. */
  clearSky(topR: number, topG: number, topB: number, horR: number, horG: number, horB: number, horFrac = 0.45): void {
    this.zbuf.fill(0);
    const w = this.w, h = this.h;
    const horY = Math.max(1, Math.round(h * horFrac));
    for (let y = 0; y < h; y++) {
      const t = clamp(y / horY, 0, 1);
      const r = Math.round(topR + (horR - topR) * t);
      const g = Math.round(topG + (horG - topG) * t);
      const b = Math.round(topB + (horB - topB) * t);
      const packed = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
      const row = y * w;
      this.buf32.fill(packed, row, row + w);
    }
  }

  /** Draw a world-space triangle with near-plane clipping, Z-buffer, and distance fog. */
  drawTri(
    cam: Cam3D,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    r: number, g: number, b: number,
    doubleSided = false,
  ): void {
    const p0 = worldToCam(cam, ax, ay, az);
    const p1 = worldToCam(cam, bx, by, bz);
    const p2 = worldToCam(cam, cx, cy, cz);

    const near = cam.near;
    const far = cam.far;
    if (p0.z < near && p1.z < near && p2.z < near) return;
    if (p0.z > far && p1.z > far && p2.z > far) return;

    // Fast path: all 3 vertices in front of near plane.
    if (p0.z >= near && p1.z >= near && p2.z >= near) {
      this.rasterCamTri(cam, p0, p1, p2, r, g, b, doubleSided);
      return;
    }

    // Sutherland-Hodgman clip against z >= near.
    const pts: ClipV[] = [p0, p1, p2];
    const out: ClipV[] = [];
    for (let i = 0; i < 3; i++) {
      const a = pts[i], d = pts[(i + 1) % 3];
      const aIn = a.z >= near, dIn = d.z >= near;
      if (aIn) out.push(a);
      if (aIn !== dIn) {
        const t = (near - a.z) / (d.z - a.z);
        out.push({ x: a.x + (d.x - a.x) * t, y: a.y + (d.y - a.y) * t, z: near });
      }
    }
    for (let i = 1; i + 1 < out.length; i++) {
      this.rasterCamTri(cam, out[0], out[i], out[i + 1], r, g, b, doubleSided);
    }
  }

  /** Draw a Mesh3D at world (tx, ty, tz) rotated around Z by `yaw`. */
  drawMesh(cam: Cam3D, mesh: Mesh3D, tx: number, ty: number, tz: number, yaw = 0, scale = 1, tint = 1): void {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const tris = mesh.tris;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      const ax = (t.ax * c - t.ay * s) * scale + tx;
      const ay = (t.ax * s + t.ay * c) * scale + ty;
      const az = t.az * scale + tz;
      const bx = (t.bx * c - t.by * s) * scale + tx;
      const by = (t.bx * s + t.by * c) * scale + ty;
      const bz = t.bz * scale + tz;
      const cx = (t.cx * c - t.cy * s) * scale + tx;
      const cy = (t.cx * s + t.cy * c) * scale + ty;
      const cz = t.cz * scale + tz;
      this.drawTri(
        cam, ax, ay, az, bx, by, bz, cx, cy, cz,
        Math.min(255, Math.round(t.r * tint)),
        Math.min(255, Math.round(t.g * tint)),
        Math.min(255, Math.round(t.b * tint)),
      );
    }
  }

  private rasterCamTri(
    cam: Cam3D,
    p0: ClipV, p1: ClipV, p2: ClipV,
    r: number, g: number, b: number,
    doubleSided: boolean,
  ): void {
    const inv0 = cam.focal / p0.z, inv1 = cam.focal / p1.z, inv2 = cam.focal / p2.z;
    const x0 = cam.hw + p0.x * inv0, y0 = cam.hh - p0.y * inv0;
    const x1 = cam.hw + p1.x * inv1, y1 = cam.hh - p1.y * inv1;
    const x2 = cam.hw + p2.x * inv2, y2 = cam.hh - p2.y * inv2;

    const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (!doubleSided && area >= 0) return;
    if (Math.abs(area) < 0.25) return;

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(this.w - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) return;

    // Fog factor computed per triangle (fast & clean at retro pixel res).
    const avgZ = (p0.z + p1.z + p2.z) * 0.3333;
    const fog = clamp((avgZ - this.fogStart) / (this.fogEnd - this.fogStart), 0, 0.85);
    const fr = Math.round(r + (this.fogR - r) * fog);
    const fg = Math.round(g + (this.fogG - g) * fog);
    const fb = Math.round(b + (this.fogB - b) * fog);
    const packed = ((255 << 24) | (fb << 16) | (fg << 8) | fr) >>> 0;

    const invArea = 1 / area;
    const w = this.w;
    const zbuf = this.zbuf;
    const buf32 = this.buf32;

    const dx12 = y1 - y2, dy12 = x2 - x1;
    const dx20 = y2 - y0, dy20 = x0 - x2;

    // Perspective-correct 1/z depth interpolation eliminates Z-fighting on large/steep tris.
    const iz0 = 1 / p0.z, iz1 = 1 / p1.z, iz2 = 1 / p2.z;

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      const row = y * w;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = (dx12 * (px - x2) + dy12 * (py - y2)) * invArea;
        if (w0 < -0.001) continue;
        const w1 = (dx20 * (px - x0) + dy20 * (py - y0)) * invArea;
        if (w1 < -0.001) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < -0.001) continue;

        const iz = w0 * iz0 + w1 * iz1 + w2 * iz2;
        const idx = row + x;
        if (iz > zbuf[idx]) {
          zbuf[idx] = iz;
          buf32[idx] = packed;
        }
      }
    }
  }
}
