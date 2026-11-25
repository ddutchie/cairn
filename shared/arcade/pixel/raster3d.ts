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
  /** Bounding sphere in mesh space (centre on the Z axis), for culling whole meshes. */
  cz: number;
  rad: number;
  /** Half-resolution stand-in, drawn when the mesh is small on screen. */
  lod?: Mesh3D;
}

/** Below this projected radius (framebuffer pixels) a mesh draws its `lod`. */
export const LOD_PX = 14;

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

/**
 * Convert a Cairn `Model` (stacked voxel slices) into a culled, shaded 3D mesh.
 * Visible faces of the same colour that touch on one plane merge into a single
 * rectangle (greedy meshing), so a prop costs tens of triangles, not hundreds.
 */
export function meshFromModel(m: Model, scale = 1.6, zScale = scale): Mesh3D {
  const W = m.w, D = m.d, H = m.h;
  // Packed 0xRRGGBB + 1 per voxel, 0 = empty.
  const vox = new Int32Array(W * D * H);
  for (let z = 0; z < H; z++) {
    const buf = m.layers[z];
    for (let i = 0; i < W * D; i++) {
      const o = i * 4;
      if (buf[o + 3] >= 128) vox[z * W * D + i] = ((buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2]) + 1;
    }
  }
  const mesh = meshVoxels(vox, W, D, H, scale, zScale);
  if (mesh.tris.length > 96 && W > 4 && D > 4 && H > 4) {
    const half = halveVoxels(vox, W, D, H);
    const lod = meshVoxels(half.vox, half.w, half.d, half.h, scale * (W / half.w), zScale * (H / half.h));
    if (lod.tris.length < mesh.tris.length * 0.7) mesh.lod = lod;
  }
  return mesh;
}

/**
 * Halve a voxel grid: each 2×2×2 block becomes one voxel when at least half of
 * it is solid, coloured by its most common colour.
 */
function halveVoxels(vox: Int32Array, W: number, D: number, H: number): { vox: Int32Array; w: number; d: number; h: number } {
  const w = Math.ceil(W / 2), d = Math.ceil(D / 2), h = Math.ceil(H / 2);
  const out = new Int32Array(w * d * h);
  const keys: number[] = [], counts: number[] = [];
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) {
    keys.length = counts.length = 0;
    let solid = 0;
    for (let k = 0; k < 8; k++) {
      const X = x * 2 + (k & 1), Y = y * 2 + ((k >> 1) & 1), Z = z * 2 + (k >> 2);
      if (X >= W || Y >= D || Z >= H) continue;
      const v = vox[(Z * D + Y) * W + X];
      if (!v) continue;
      solid++;
      const i = keys.indexOf(v);
      if (i < 0) { keys.push(v); counts.push(1); } else counts[i]++;
    }
    if (solid < 4) continue;
    let best = 0;
    for (let i = 1; i < keys.length; i++) if (counts[i] > counts[best]) best = i;
    out[(z * d + y) * w + x] = keys[best];
  }
  return { vox: out, w, d, h };
}

function meshVoxels(vox: Int32Array, W: number, D: number, H: number, scale: number, zScale: number): Mesh3D {
  const tris: Tri3D[] = [];
  const hw = W * 0.5, hd = D * 0.5;
  const at = (x: number, y: number, z: number): number =>
    x < 0 || y < 0 || z < 0 || x >= W || y >= D || z >= H ? 0 : vox[(z * D + y) * W + x];

  const X = (x: number) => (x - hw) * scale, Y = (y: number) => (y - hd) * scale, Z = (z: number) => z * zScale;
  const emit = (p: number[], key: number, shade: number) => {
    const c = key - 1;
    const r = clamp(Math.round(((c >> 16) & 255) * shade), 0, 255);
    const g = clamp(Math.round(((c >> 8) & 255) * shade), 0, 255);
    const b = clamp(Math.round((c & 255) * shade), 0, 255);
    tris.push({ ax: p[0], ay: p[1], az: p[2], bx: p[3], by: p[4], bz: p[5], cx: p[6], cy: p[7], cz: p[8], r, g, b });
    tris.push({ ax: p[0], ay: p[1], az: p[2], bx: p[6], by: p[7], bz: p[8], cx: p[9], cy: p[10], cz: p[11], r, g, b });
  };

  /**
   * One face direction: for each slice, mask the visible faces by colour, then
   * cover the mask with rectangles. `corners(slice, u0, u1, v0, v1)` returns
   * the quad in the same winding the single-voxel face used.
   */
  const sweep = (
    slices: number, nu: number, nv: number,
    face: (s: number, u: number, v: number) => number,
    corners: (s: number, u0: number, u1: number, v0: number, v1: number) => number[],
    shade: number,
  ) => {
    const mask = new Int32Array(nu * nv);
    for (let sl = 0; sl < slices; sl++) {
      for (let v = 0; v < nv; v++) for (let u = 0; u < nu; u++) mask[v * nu + u] = face(sl, u, v);
      for (let v = 0; v < nv; v++) {
        for (let u = 0; u < nu; ) {
          const key = mask[v * nu + u];
          if (!key) { u++; continue; }
          let du = 1;
          while (u + du < nu && mask[v * nu + u + du] === key) du++;
          let dv = 1;
          grow: while (v + dv < nv) {
            for (let k = 0; k < du; k++) if (mask[(v + dv) * nu + u + k] !== key) break grow;
            dv++;
          }
          for (let j = 0; j < dv; j++) mask.fill(0, (v + j) * nu + u, (v + j) * nu + u + du);
          emit(corners(sl, u, u + du, v, v + dv), key, shade);
          u += du;
        }
      }
    }
  };

  const vis = (x: number, y: number, z: number, nx: number, ny: number, nz: number): number => {
    const k = at(x, y, z);
    return k && !at(x + nx, y + ny, z + nz) ? k : 0;
  };
  // +Z top (u = x, v = y)
  sweep(H, W, D, (z, x, y) => vis(x, y, z, 0, 0, 1),
    (z, x0, x1, y0, y1) => [X(x0), Y(y0), Z(z + 1), X(x1), Y(y0), Z(z + 1), X(x1), Y(y1), Z(z + 1), X(x0), Y(y1), Z(z + 1)], 1.06);
  // -Y north (u = x, v = z)
  sweep(D, W, H, (y, x, z) => vis(x, y, z, 0, -1, 0),
    (y, x0, x1, z0, z1) => [X(x0), Y(y), Z(z0), X(x1), Y(y), Z(z0), X(x1), Y(y), Z(z1), X(x0), Y(y), Z(z1)], 0.92);
  // +Y south
  sweep(D, W, H, (y, x, z) => vis(x, y, z, 0, 1, 0),
    (y, x0, x1, z0, z1) => [X(x1), Y(y + 1), Z(z0), X(x0), Y(y + 1), Z(z0), X(x0), Y(y + 1), Z(z1), X(x1), Y(y + 1), Z(z1)], 0.72);
  // -X west (u = y, v = z)
  sweep(W, D, H, (x, y, z) => vis(x, y, z, -1, 0, 0),
    (x, y0, y1, z0, z1) => [X(x), Y(y1), Z(z0), X(x), Y(y0), Z(z0), X(x), Y(y0), Z(z1), X(x), Y(y1), Z(z1)], 0.84);
  // +X east
  sweep(W, D, H, (x, y, z) => vis(x, y, z, 1, 0, 0),
    (x, y0, y1, z0, z1) => [X(x + 1), Y(y0), Z(z0), X(x + 1), Y(y1), Z(z0), X(x + 1), Y(y1), Z(z1), X(x + 1), Y(y0), Z(z1)], 0.78);

  const cz = (H * zScale) / 2;
  const rad = Math.hypot(hw * scale, hd * scale, cz);
  return { tris, cz, rad };
}

/**
 * Render size for a 3D view shown at `w × h` game pixels: the same aspect,
 * scaled to about `budget` pixels so cost doesn't depend on the screen's
 * shape (a tall folded phone and a wide unfolded Duo cost the same).
 */
export function fbSizeFor(w: number, h: number, budget = 48_000): { w: number; h: number } {
  const k = Math.min(1, Math.sqrt(budget / Math.max(1, w * h)));
  return { w: Math.max(96, Math.round(w * k)), h: Math.max(72, Math.round(h * k)) };
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
    // World to camera space, inline (no per-vertex objects on the hot path).
    let dx = ax - cam.ex, dy = ay - cam.ey, dz = az - cam.ez;
    const x0 = dx * cam.rx + dy * cam.ry + dz * cam.rz, y0 = dx * cam.ux + dy * cam.uy + dz * cam.uz, z0 = dx * cam.fx + dy * cam.fy + dz * cam.fz;
    dx = bx - cam.ex; dy = by - cam.ey; dz = bz - cam.ez;
    const x1 = dx * cam.rx + dy * cam.ry + dz * cam.rz, y1 = dx * cam.ux + dy * cam.uy + dz * cam.uz, z1 = dx * cam.fx + dy * cam.fy + dz * cam.fz;
    dx = cx - cam.ex; dy = cy - cam.ey; dz = cz - cam.ez;
    const x2 = dx * cam.rx + dy * cam.ry + dz * cam.rz, y2 = dx * cam.ux + dy * cam.uy + dz * cam.uz, z2 = dx * cam.fx + dy * cam.fy + dz * cam.fz;

    const near = cam.near;
    const far = cam.far;
    if (z0 < near && z1 < near && z2 < near) return;
    if (z0 > far && z1 > far && z2 > far) return;

    // Fast path: all 3 vertices in front of near plane.
    if (z0 >= near && z1 >= near && z2 >= near) {
      this.rasterCamTri(cam, x0, y0, z0, x1, y1, z1, x2, y2, z2, r, g, b, doubleSided);
      return;
    }

    // Sutherland-Hodgman clip against z >= near.
    const pts: ClipV[] = [{ x: x0, y: y0, z: z0 }, { x: x1, y: y1, z: z1 }, { x: x2, y: y2, z: z2 }];
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
    const o = out[0];
    for (let i = 1; i + 1 < out.length; i++) {
      const p = out[i], q = out[i + 1];
      this.rasterCamTri(cam, o.x, o.y, o.z, p.x, p.y, p.z, q.x, q.y, q.z, r, g, b, doubleSided);
    }
  }

  /**
   * True when a world-space sphere is wholly off screen, behind the camera or
   * past the far plane, so a whole mesh can be skipped before its triangles.
   */
  sphereHidden(cam: Cam3D, wx: number, wy: number, wz: number, rad: number): boolean {
    const dx = wx - cam.ex, dy = wy - cam.ey, dz = wz - cam.ez;
    const z = dx * cam.fx + dy * cam.fy + dz * cam.fz;
    if (z + rad < cam.near || z - rad > cam.far) return true;
    const x = dx * cam.rx + dy * cam.ry + dz * cam.rz;
    const y = dx * cam.ux + dy * cam.uy + dz * cam.uz;
    // Distance from each side plane through the eye; the plane's normal is (1, 0, -a) / |…|.
    const ax = cam.hw / cam.focal, ay = cam.hh / cam.focal;
    const kx = rad * Math.sqrt(1 + ax * ax), ky = rad * Math.sqrt(1 + ay * ay);
    return x - ax * z > kx || -x - ax * z > kx || y - ay * z > ky || -y - ay * z > ky;
  }

  /** Draw a Mesh3D at world (tx, ty, tz) rotated around Z by `yaw`. */
  drawMesh(cam: Cam3D, mesh: Mesh3D, tx: number, ty: number, tz: number, yaw = 0, scale = 1, tint = 1): void {
    const wz = tz + mesh.cz * scale, rad = mesh.rad * scale;
    if (this.sphereHidden(cam, tx, ty, wz, rad)) return;
    if (mesh.lod) {
      const depth = (tx - cam.ex) * cam.fx + (ty - cam.ey) * cam.fy + (wz - cam.ez) * cam.fz;
      if (depth > 0 && (rad * cam.focal) / depth < LOD_PX) mesh = mesh.lod;
    }
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

  /**
   * Draw a Mesh3D with a full pose, pivoting on its bounding-sphere centre:
   * `roll` tips it about the forward (+Y) axis, `pitch` about the side (+X)
   * axis, then `yaw` turns it about +Z. For riders mid-flip; static props
   * should use `drawMesh`.
   */
  drawMeshPose(cam: Cam3D, mesh: Mesh3D, tx: number, ty: number, tz: number, yaw: number, pitch: number, roll: number, scale = 1): void {
    if (pitch === 0 && roll === 0) {
      this.drawMesh(cam, mesh, tx, ty, tz, yaw, scale);
      return;
    }
    const pz = mesh.cz;
    const wz = tz + pz * scale;
    if (this.sphereHidden(cam, tx, ty, wz, mesh.rad * scale)) return;
    // R = Rz(yaw) · Rx(pitch) · Ry(roll)
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const m00 = cy * cr - sy * sp * sr, m01 = -sy * cp, m02 = cy * sr + sy * sp * cr;
    const m10 = sy * cr + cy * sp * sr, m11 = cy * cp, m12 = sy * sr - cy * sp * cr;
    const m20 = -cp * sr, m21 = sp, m22 = cp * cr;
    const k = scale;
    const tris = mesh.tris;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      const az = t.az - pz, bz = t.bz - pz, cz = t.cz - pz;
      this.drawTri(
        cam,
        (m00 * t.ax + m01 * t.ay + m02 * az) * k + tx, (m10 * t.ax + m11 * t.ay + m12 * az) * k + ty, (m20 * t.ax + m21 * t.ay + m22 * az) * k + wz,
        (m00 * t.bx + m01 * t.by + m02 * bz) * k + tx, (m10 * t.bx + m11 * t.by + m12 * bz) * k + ty, (m20 * t.bx + m21 * t.by + m22 * bz) * k + wz,
        (m00 * t.cx + m01 * t.cy + m02 * cz) * k + tx, (m10 * t.cx + m11 * t.cy + m12 * cz) * k + ty, (m20 * t.cx + m21 * t.cy + m22 * cz) * k + wz,
        t.r, t.g, t.b,
      );
    }
  }

  /** An axis-aligned box (no bottom face), for posts, gates and banners. */
  drawBox(cam: Cam3D, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, g: number, b: number): void {
    const sh = (v: number, k: number) => Math.round(v * k);
    // top
    this.drawTri(cam, x0, y0, z1, x1, y0, z1, x1, y1, z1, r, g, b, true);
    this.drawTri(cam, x0, y0, z1, x1, y1, z1, x0, y1, z1, r, g, b, true);
    // front/back (±y)
    const fr = sh(r, 0.84), fg = sh(g, 0.84), fb = sh(b, 0.84);
    this.drawTri(cam, x0, y0, z0, x1, y0, z0, x1, y0, z1, fr, fg, fb, true);
    this.drawTri(cam, x0, y0, z0, x1, y0, z1, x0, y0, z1, fr, fg, fb, true);
    this.drawTri(cam, x0, y1, z0, x1, y1, z0, x1, y1, z1, fr, fg, fb, true);
    this.drawTri(cam, x0, y1, z0, x1, y1, z1, x0, y1, z1, fr, fg, fb, true);
    // sides (±x)
    const sr = sh(r, 0.72), sg = sh(g, 0.72), sb = sh(b, 0.72);
    this.drawTri(cam, x0, y0, z0, x0, y1, z0, x0, y1, z1, sr, sg, sb, true);
    this.drawTri(cam, x0, y0, z0, x0, y1, z1, x0, y0, z1, sr, sg, sb, true);
    this.drawTri(cam, x1, y0, z0, x1, y1, z0, x1, y1, z1, sr, sg, sb, true);
    this.drawTri(cam, x1, y0, z0, x1, y1, z1, x1, y0, z1, sr, sg, sb, true);
  }

  private rasterCamTri(
    cam: Cam3D,
    cx0: number, cy0: number, cz0: number,
    cx1: number, cy1: number, cz1: number,
    cx2: number, cy2: number, cz2: number,
    r: number, g: number, b: number,
    doubleSided: boolean,
  ): void {
    const inv0 = cam.focal / cz0, inv1 = cam.focal / cz1, inv2 = cam.focal / cz2;
    const x0 = cam.hw + cx0 * inv0, y0 = cam.hh - cy0 * inv0;
    const x1 = cam.hw + cx1 * inv1, y1 = cam.hh - cy1 * inv1;
    const x2 = cam.hw + cx2 * inv2, y2 = cam.hh - cy2 * inv2;

    const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (!doubleSided && area >= 0) return;
    if (Math.abs(area) < 0.25) return;

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(this.w - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) return;

    // Fog factor computed per triangle (fast & clean at retro pixel res).
    const avgZ = (cz0 + cz1 + cz2) * 0.3333;
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
    const iz0 = 1 / cz0, iz1 = 1 / cz1, iz2 = 1 / cz2;

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
