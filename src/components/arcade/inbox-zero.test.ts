import { describe, expect, it } from "vitest";
import { boardLayout, canBuildCore } from "@cairn/shared/arcade/inbox-zero/models";

describe("inbox-zero board layout", () => {
  it("matches the original 180px phone grid at MIN_W", () => {
    const lay = boardLayout(180);
    expect(lay).toEqual({
      coreX: 0,
      minC: 0,
      maxC: 14,
      shopW: 45,
      shopX0: 0,
    });
  });

  it("centers the 15-cell core and shop on wider screens", () => {
    const lay = boardLayout(480);
    expect(lay.coreX).toBe(150);
    expect(lay.minC).toBe(-12);
    expect(lay.maxC).toBe(26);
    expect(lay.shopW).toBe(72);
    expect(lay.shopX0).toBe(96);
  });

  it("keeps the original 15x21 off-flow cells buildable and excludes path cells", () => {
    expect(canBuildCore(1, 0)).toBe(false);
    expect(canBuildCore(7, 4)).toBe(false);
    expect(canBuildCore(0, 0)).toBe(true);
    expect(canBuildCore(0, 20)).toBe(true);
    expect(canBuildCore(14, 20)).toBe(true);
  });

  it("extends buildable cells into side wings within #FOCUS range and blocks far dead zones", () => {
    expect(canBuildCore(-1, 4)).toBe(true);
    expect(canBuildCore(-4, 4)).toBe(true);
    expect(canBuildCore(15, 4)).toBe(true);
    expect(canBuildCore(18, 4)).toBe(true);
    expect(canBuildCore(-12, 4)).toBe(false);
    expect(canBuildCore(26, 4)).toBe(false);
  });
});
