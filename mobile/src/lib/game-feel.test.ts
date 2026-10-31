import { describe, expect, it } from "vitest";
import { comboTier, pushTrail, seedTrail, packParticles, PARTICLE_STRIDE } from "./game-feel";

describe("comboTier", () => {
  it("steps up at 3, 5 and 8", () => {
    expect([0, 1, 2].map(comboTier)).toEqual(["tick", "tick", "tick"]);
    expect([3, 4].map(comboTier)).toEqual(["knock", "knock"]);
    expect([5, 7].map(comboTier)).toEqual(["thud", "thud"]);
    expect([8, 20].map(comboTier)).toEqual(["flourish", "flourish"]);
  });
});

describe("trail", () => {
  it("seeds max points at one position", () => {
    expect(seedTrail(1, 2, 3)).toEqual([1, 2, 1, 2, 1, 2]);
  });
  it("pushes newest first and caps the length", () => {
    expect(pushTrail([1, 1, 2, 2], 3, 3, 2)).toEqual([3, 3, 1, 1]);
    expect(pushTrail([], 5, 6, 4)).toEqual([5, 6]);
  });
});

describe("packParticles", () => {
  const p = (life: number, color = 0) => ({ x: 10, y: 20, life, maxLife: 20, size: 4, color });
  it("fills a fixed pool with zeroed spare slots", () => {
    const out = packParticles([p(10, 2)], 3);
    expect(out).toHaveLength(3 * PARTICLE_STRIDE);
    expect(out.slice(0, 5)).toEqual([10, 20, 0.5, 4, 2]);
    expect(out.slice(5)).toEqual(new Array(10).fill(0));
  });
  it("drops particles beyond the pool and clamps life", () => {
    const out = packParticles([p(40), p(5), p(1)], 2);
    expect(out).toHaveLength(10);
    expect(out[2]).toBe(1);
    expect(out[7]).toBe(0.25);
  });
});
