/**
 * Low-poly mesh builder for the software rasterizer (`raster3d.ts`).
 *
 * Voxel models (`meshFromModel`) are right for characters, but scenery built
 * from voxels costs hundreds to thousands of triangles a piece. These
 * primitives build trees, rocks and crags from a few dozen faceted triangles,
 * flat-shaded at build time with the same light as voxel meshes (from the
 * north-west, above), so both kinds of mesh sit together in one scene.
 *
 * Mesh space: +Z up, the base on z = 0, centred on the Z axis.
 */

import type { Mesh3D, Tri3D } from "./raster3d";

type V3 = [number, number, number];

/** The voxel meshes' light: tops brightest, the south and east sides darkest. */
const LIGHT: V3 = (() => {
  const v: V3 = [-0.42, -0.5, 0.76], l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

function hexRgb(hex: string): V3 {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export interface FaceStyle {
  /** Base colour. */
  c: string;
  /** Colour for faces turned up (normal z above `topAt`): snow, moss, ash. */
  top?: string;
  topAt?: number;
  /** Random brightness spread per face, 0..1 (default 0.06). */
  vary?: number;
}

export class LowPoly {
  readonly tris: Tri3D[] = [];
  constructor(private readonly rand: () => number) {}

  /** One flat-shaded triangle, wound to face away from `inside`; `both` adds the back face too. */
  tri(a: V3, b: V3, c: V3, style: FaceStyle, inside: V3 | null, both = false): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-6) return;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    if (inside) {
      const mx = (a[0] + b[0] + c[0]) / 3 - inside[0], my = (a[1] + b[1] + c[1]) / 3 - inside[1], mz = (a[2] + b[2] + c[2]) / 3 - inside[2];
      if (nx * mx + ny * my + nz * mz < 0) {
        [b, c] = [c, b];
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
    }
    this.face(a, b, c, nx, ny, nz, style);
    if (both) this.face(a, c, b, -nx, -ny, -nz, style);
  }

  private face(a: V3, b: V3, c: V3, nx: number, ny: number, nz: number, style: FaceStyle): void {
    const base = hexRgb(style.top && nz > (style.topAt ?? 0.62) ? style.top : style.c);
    const lit = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    const k = (0.66 + lit * 0.42) * (1 + (this.rand() - 0.5) * 2 * (style.vary ?? 0.06));
    const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
    this.tris.push({ ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], cx: c[0], cy: c[1], cz: c[2], r: ch(base[0]), g: ch(base[1]), b: ch(base[2]) });
  }

  /**
   * A tapered column from (x, y, z0) up `h`: `sides`-gon of radius r0 at the
   * base to r1 at the top (0 makes a cone), with a top cap. `lean` shifts the
   * top; `jitter` roughens the rings (for rock).
   */
  column(x: number, y: number, z0: number, r0: number, r1: number, h: number, sides: number, style: FaceStyle, opts: { lean?: [number, number]; jitter?: number; spin?: number; cap?: boolean } = {}): void {
    const j = opts.jitter ?? 0, [lx, ly] = opts.lean ?? [0, 0], spin = opts.spin ?? this.rand() * Math.PI * 2;
    const ring = (r: number, z: number, ox: number, oy: number): V3[] =>
      Array.from({ length: sides }, (_, i) => {
        const a = spin + (i / sides) * Math.PI * 2, rr = r * (1 + (this.rand() - 0.5) * j);
        return [x + ox + Math.cos(a) * rr, y + oy + Math.sin(a) * rr, z + (this.rand() - 0.5) * j * h * 0.3] as V3;
      });
    const lo = ring(r0, z0, 0, 0), top = z0 + h;
    const inside: V3 = [x + lx / 2, y + ly / 2, z0 + h / 2];
    if (r1 <= 0.01) {
      const apex: V3 = [x + lx, y + ly, top];
      for (let i = 0; i < sides; i++) this.tri(lo[i], lo[(i + 1) % sides], apex, style, inside);
      return;
    }
    const hi = ring(r1, top, lx, ly);
    for (let i = 0; i < sides; i++) {
      const k = (i + 1) % sides;
      this.tri(lo[i], lo[k], hi[k], style, inside);
      this.tri(lo[i], hi[k], hi[i], style, inside);
    }
    if (opts.cap !== false) {
      const mid: V3 = [x + lx, y + ly, top];
      for (let i = 0; i < sides; i++) this.tri(hi[i], hi[(i + 1) % sides], mid, style, [mid[0], mid[1], top - 1]);
    }
  }

  /** A faceted lump: an octahedron (detail 0) or icosahedron (detail 1), squashed to its radii and roughened. */
  blob(x: number, y: number, z: number, rx: number, ry: number, rz: number, style: FaceStyle, detail: 0 | 1 = 1, jitter = 0.22): void {
    const base: V3[] = detail
      ? (() => {
          const t = (1 + Math.sqrt(5)) / 2, s = Math.hypot(1, t);
          const v: V3[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
          return v.map(([a, b, c]) => [a / s, b / s, c / s] as V3);
        })()
      : [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const faces: [number, number, number][] = detail
      ? [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
      : [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
    const spin = this.rand() * Math.PI * 2, cs = Math.cos(spin), sn = Math.sin(spin);
    const pts = base.map(([a, b, c]) => {
      const k = 1 + (this.rand() - 0.5) * 2 * jitter, ax = a * cs - b * sn, by = a * sn + b * cs;
      return [x + ax * rx * k, y + by * ry * k, z + c * rz * k] as V3;
    });
    for (const [a, b, c] of faces) this.tri(pts[a], pts[b], pts[c], style, [x, y, z]);
  }

  /** A palm frond or leaf: a drooping diamond, seen from both sides. */
  frond(x: number, y: number, z: number, ang: number, len: number, width: number, droop: number, style: FaceStyle): void {
    const dx = Math.cos(ang), dy = Math.sin(ang), px = -dy * width, py = dx * width;
    // A diamond bent along its spine: the arch up from the root, the drop to the tip.
    const mid: V3 = [x + dx * len * 0.5, y + dy * len * 0.5, z + len * 0.1];
    const tip: V3 = [x + dx * len, y + dy * len, z - droop];
    const root: V3 = [x, y, z];
    const ml: V3 = [mid[0] + px, mid[1] + py, mid[2] - width * 0.4], mr: V3 = [mid[0] - px, mid[1] - py, mid[2] - width * 0.4];
    this.tri(root, ml, tip, style, null, true);
    this.tri(root, tip, mr, style, null, true);
  }

  build(): Mesh3D {
    let z0 = Infinity, z1 = -Infinity;
    for (const t of this.tris) {
      z0 = Math.min(z0, t.az, t.bz, t.cz);
      z1 = Math.max(z1, t.az, t.bz, t.cz);
    }
    const cz = (z0 + z1) / 2;
    let rad = 0;
    for (const t of this.tris) {
      rad = Math.max(rad, Math.hypot(t.ax, t.ay, t.az - cz), Math.hypot(t.bx, t.by, t.bz - cz), Math.hypot(t.cx, t.cy, t.cz - cz));
    }
    const mesh: Mesh3D = { tris: this.tris, cz, rad };
    // Far away, the biggest faces carry the shape: keep the largest third.
    if (this.tris.length > 24) {
      const area = (t: Tri3D) => {
        const ux = t.bx - t.ax, uy = t.by - t.ay, uz = t.bz - t.az, vx = t.cx - t.ax, vy = t.cy - t.ay, vz = t.cz - t.az;
        return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      };
      const keep = Math.max(12, Math.round(this.tris.length / 3));
      mesh.lod = { tris: [...this.tris].sort((a, b) => area(b) - area(a)).slice(0, keep), cz, rad };
    }
    return mesh;
  }
}
