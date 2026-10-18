import { polygonHull } from "d3-polygon";
import { line, curveCatmullRomClosed } from "d3-shape";

export const HULL_PAD = 22;

interface Member {
  x: number;
  y: number;
}

/**
 * Cluster hulls: for each project with at least 3 positioned members, the
 * convex hull pushed outward by HULL_PAD and smoothed with a closed
 * Catmull-Rom curve. Returned as SVG path strings (in world coords) so the
 * renderer can turn each into a Skia path.
 */
export function hullPaths(membersByProject: ReadonlyMap<string, readonly Member[]>): string[] {
  const out: string[] = [];
  const smooth = line().curve(curveCatmullRomClosed.alpha(0.6));
  for (const members of membersByProject.values()) {
    const pts: [number, number][] = [];
    for (const m of members) if (Number.isFinite(m.x) && Number.isFinite(m.y)) pts.push([m.x, m.y]);
    if (pts.length < 3) continue;
    const hull = polygonHull(pts);
    if (!hull || hull.length < 3) continue;
    let cx = 0;
    let cy = 0;
    for (const p of hull) {
      cx += p[0];
      cy += p[1];
    }
    cx /= hull.length;
    cy /= hull.length;
    const expanded = hull.map((p): [number, number] => {
      const dx = p[0] - cx;
      const dy = p[1] - cy;
      const m = Math.hypot(dx, dy) || 1;
      return [p[0] + (dx / m) * HULL_PAD, p[1] + (dy / m) * HULL_PAD];
    });
    const d = smooth(expanded);
    if (d) out.push(d);
  }
  return out;
}
