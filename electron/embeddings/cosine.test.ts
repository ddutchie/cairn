import { describe, it, expect } from "vitest";
import { cosine, topK, toFloat32, dotNormalized, magnitude } from "./cosine";

describe("cosine", () => {
  it("returns 1 for identical vectors", () => {
    const a = toFloat32([1, 2, 3]);
    expect(cosine(a, a)).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = toFloat32([1, 0, 0]);
    const b = toFloat32([0, 1, 0]);
    expect(cosine(a, b)).toBeCloseTo(0, 6);
  });

  it("returns -1 for opposite vectors", () => {
    const a = toFloat32([1, 2, 3]);
    const b = toFloat32([-1, -2, -3]);
    expect(cosine(a, b)).toBeCloseTo(-1, 6);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosine(toFloat32([1, 2]), toFloat32([1, 2, 3]))).toThrow(/dim mismatch/);
  });

  it("returns 0 for zero vectors (denominator guard)", () => {
    const z = toFloat32([0, 0, 0]);
    expect(cosine(z, toFloat32([1, 2, 3]))).toBe(0);
  });
});

describe("dotNormalized", () => {
  it("equals cosine for unit-norm vectors", () => {
    const a = toFloat32([0.6, 0.8, 0]);
    const b = toFloat32([0.8, -0.6, 0]);
    expect(dotNormalized(a, b)).toBeCloseTo(cosine(a, b), 6);
  });
});

describe("magnitude", () => {
  it("computes L2 norm", () => {
    expect(magnitude(toFloat32([3, 4]))).toBeCloseTo(5, 6);
  });
});

describe("topK", () => {
  const pool = [
    { noteId: "a", vector: toFloat32([1, 0, 0]) },
    { noteId: "b", vector: toFloat32([0, 1, 0]) },
    { noteId: "c", vector: toFloat32([0.9, 0.1, 0]) },
    { noteId: "d", vector: toFloat32([0, 0, 1]) },
  ];

  it("returns top-k sorted by descending score", () => {
    const res = topK(toFloat32([1, 0, 0]), pool, 3, 0.1);
    expect(res.map((r) => r.item.noteId)).toEqual(["a", "c"]);
    expect(res.length).toBe(2);
    expect(res[0].score).toBeGreaterThanOrEqual(res[1].score);
  });

  it("respects threshold", () => {
    const res = topK(toFloat32([1, 0, 0]), pool, 10, 0.95);
    expect(res.map((r) => r.item.noteId)).toEqual(["a", "c"]);
    expect(res.every((r) => r.score >= 0.95)).toBe(true);
  });

  it("excludes ids in the excludeSet", () => {
    const res = topK(toFloat32([1, 0, 0]), pool, 10, 0.5, new Set(["a"]));
    expect(res.map((r) => r.item.noteId)).toEqual(["c"]);
  });

  it("returns empty pool unchanged", () => {
    expect(topK(toFloat32([1, 0]), [], 5)).toEqual([]);
  });

  it("handles k larger than pool size", () => {
    const res = topK(toFloat32([1, 0, 0]), pool, 100);
    expect(res.length).toBe(pool.length);
  });
});
