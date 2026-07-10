import { describe, it, expect } from "vitest";
import { autoScrollDelta, clampScroll, adjustRectForScroll, pointInRect } from "./autoScroll";

describe("autoScrollDelta", () => {
  // viewport 100..500, edge 64 → lo=164, hi=436
  it("is 0 in the middle (no edge)", () => {
    expect(autoScrollDelta(300, 100, 500, 64, 14)).toBe(0);
  });

  it("is negative near the start edge (scroll toward start)", () => {
    expect(autoScrollDelta(150, 100, 500, 64, 14)).toBeLessThan(0);
  });

  it("is positive near the end edge (scroll toward end)", () => {
    expect(autoScrollDelta(470, 100, 500, 64, 14)).toBeGreaterThan(0);
  });

  it("ramps to max speed at the deepest point of each edge", () => {
    // pos == viewportStart → depth 1 → -maxSpeed
    expect(autoScrollDelta(100, 100, 500, 64, 14)).toBeCloseTo(-14, 5);
    // pos == viewportEnd → depth 1 → +maxSpeed
    expect(autoScrollDelta(500, 100, 500, 64, 14)).toBeCloseTo(14, 5);
  });

  it("ramps proportionally within the edge zone", () => {
    // 32px into a 64px edge → half speed
    expect(autoScrollDelta(164 - 32, 100, 500, 64, 14)).toBeCloseTo(-7, 5);
  });

  it("caps depth at the edge width even past the viewport", () => {
    expect(autoScrollDelta(-100, 100, 500, 64, 14)).toBeCloseTo(-14, 5);
  });

  it("returns 0 for a viewport smaller than two edges", () => {
    expect(autoScrollDelta(50, 0, 100, 64, 14)).toBe(0);
  });
});

describe("clampScroll", () => {
  it("clamps to bounds", () => {
    expect(clampScroll(-5, 0, 100)).toBe(0);
    expect(clampScroll(150, 0, 100)).toBe(100);
    expect(clampScroll(50, 0, 100)).toBe(50);
  });
});

describe("adjustRectForScroll", () => {
  const rect = { x: 10, y: 20, width: 100, height: 50 };
  it("shifts x by -delta on the x axis", () => {
    expect(adjustRectForScroll(rect, 30, "x")).toEqual({ x: -20, y: 20, width: 100, height: 50 });
  });
  it("shifts y by -delta on the y axis", () => {
    expect(adjustRectForScroll(rect, 30, "y")).toEqual({ x: 10, y: -10, width: 100, height: 50 });
  });
  it("no shift when delta is 0", () => {
    expect(adjustRectForScroll(rect, 0, "x")).toEqual(rect);
  });
});

describe("pointInRect", () => {
  const rect = { x: 0, y: 0, width: 100, height: 50 };
  it("true inside / on the edge", () => {
    expect(pointInRect(50, 25, rect)).toBe(true);
    expect(pointInRect(0, 0, rect)).toBe(true);
    expect(pointInRect(100, 50, rect)).toBe(true);
  });
  it("false outside", () => {
    expect(pointInRect(-1, 25, rect)).toBe(false);
    expect(pointInRect(50, 51, rect)).toBe(false);
  });

  it("hit-tests correctly after a scroll shift (x axis)", () => {
    // Zone measured at x=200; list scrolled 120px right → zone now at window x=80.
    const measured = { x: 200, y: 0, width: 100, height: 50 };
    const shifted = adjustRectForScroll(measured, 120, "x");
    // A finger at window x=100 (which is over the scrolled zone) hits it now,
    // but would have missed the stale measured rect.
    expect(pointInRect(100, 25, shifted)).toBe(true);
    expect(pointInRect(100, 25, measured)).toBe(false);
  });
});
