import { describe, it, expect } from "vitest";
import { projectTo2d, normaliseProjection } from "./projection";

describe("projectTo2d", () => {
  it("returns empty array for empty input", () => {
    expect(projectTo2d([])).toEqual([]);
  });

  it("handles a single vector (degenerate to origin)", () => {
    const v = new Float32Array([1, 0, 0, 1]);
    const pts = projectTo2d([v]);
    expect(pts.length).toBe(1);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
  });

  it("produces 2D points for many vectors", () => {
    const vectors: Float32Array[] = [];
    for (let i = 0; i < 20; i++) {
      const v = new Float32Array(8);
      for (let j = 0; j < 8; j++) v[j] = Math.sin(i * 0.3 + j);
      vectors.push(v);
    }
    const pts = projectTo2d(vectors);
    expect(pts.length).toBe(vectors.length);
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("is deterministic with the same random seed", () => {
    const vectors: Float32Array[] = [];
    for (let i = 0; i < 20; i++) {
      const v = new Float32Array(4);
      for (let j = 0; j < 4; j++) v[j] = i * 0.1 + j;
      vectors.push(v);
    }
    const a = projectTo2d(vectors, { random: 42 });
    const b = projectTo2d(vectors, { random: 42 });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].x).toBeCloseTo(b[i].x, 6);
      expect(a[i].y).toBeCloseTo(b[i].y, 6);
    }
  });
});

describe("normaliseProjection", () => {
  it("returns empty for empty input", () => {
    expect(normaliseProjection([])).toEqual([]);
  });

  it("centres points around the origin", () => {
    const points = [
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ];
    const out = normaliseProjection(points, 1);
    const cx = (out[0].x + out[1].x) / 2;
    const cy = (out[0].y + out[1].y) / 2;
    expect(Math.abs(cx)).toBeLessThan(1e-6);
    expect(Math.abs(cy)).toBeLessThan(1e-6);
  });

  it("scales to the target range", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 5 },
    ];
    const out = normaliseProjection(points, 1);
    const maxX = Math.max(...out.map((p) => Math.abs(p.x)));
    const maxY = Math.max(...out.map((p) => Math.abs(p.y)));
    expect(maxX).toBeLessThanOrEqual(1.001);
    expect(maxY).toBeLessThanOrEqual(1.001);
  });

  it("handles a single point (no NaN)", () => {
    const out = normaliseProjection([{ x: 5, y: 5 }], 1);
    expect(out.length).toBe(1);
    expect(Number.isFinite(out[0].x)).toBe(true);
    expect(Number.isFinite(out[0].y)).toBe(true);
  });
});
