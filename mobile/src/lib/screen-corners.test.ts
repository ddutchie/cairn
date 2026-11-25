import { describe, expect, it } from "vitest";
import { cornerClearance, cornerSafeInsets } from "./screen-corners";

describe("screen corners", () => {
  it("needs no clearance past the curve, the full radius at the edge", () => {
    expect(cornerClearance(60, 56)).toBe(0);
    expect(cornerClearance(0, 56)).toBe(56);
    expect(cornerClearance(56, 56)).toBe(0);
    const mid = cornerClearance(20, 56);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(30);
  });

  it("leaves a phone's top row alone below the Dynamic Island", () => {
    const s = cornerSafeInsets({ top: 59, right: 0, bottom: 34, left: 0 }, { maxBottom: 12 });
    expect(s.top).toBe(59);
    expect(s.topLeft).toBe(0);
    expect(s.bottom).toBe(12);
    // The bottom row still sits inside the lower curve.
    expect(s.bottomLeft).toBeGreaterThan(0);
  });

  it("pushes the top row in from the corner when the top inset is gone (unfolded Duo)", () => {
    const s = cornerSafeInsets({ top: 0, right: 62, bottom: 0, left: 0 });
    expect(s.top).toBe(10);
    expect(s.topLeft).toBeGreaterThan(20);
    // The rail already clears the right-hand corners.
    expect(s.topRight).toBe(62);
    expect(s.left).toBe(0);
  });
});
