import { UMAP } from "umap-js";

export interface ProjectionPoint {
  x: number;
  y: number;
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function projectTo2d(
  vectors: Float32Array[],
  opts?: { nNeighbors?: number; minDist?: number; random?: number },
): ProjectionPoint[] {
  if (vectors.length === 0) return [];
  if (vectors.length === 1) return [{ x: 0, y: 0 }];
  const nNeighbors = Math.min(opts?.nNeighbors ?? 12, Math.max(2, vectors.length - 1));
  const minDist = opts?.minDist ?? 0.1;
  const rng = seededRandom(opts?.random ?? 42);
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors,
    minDist,
    random: rng,
  });
  const input: number[][] = vectors.map((v) => Array.from(v));
  const proj = umap.fit(input);
  return proj.map(([x, y]) => ({ x: x as number, y: y as number }));
}

export function normaliseProjection(
  points: ProjectionPoint[],
  targetRange = 1.0,
): ProjectionPoint[] {
  if (points.length === 0) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scale = (targetRange * 2) / Math.max(rangeX, rangeY);
  return points.map((p) => ({
    x: (p.x - (minX + maxX) / 2) * scale,
    y: (p.y - (minY + maxY) / 2) * scale,
  }));
}
