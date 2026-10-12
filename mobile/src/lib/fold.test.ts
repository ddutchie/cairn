import { describe, it, expect } from "vitest";
import { foldGeometry, foldHalves, FOLD_GUTTER } from "./fold";

describe("foldGeometry", () => {
  it("laptop pose (portrait inner, half-open) → horizontal crease at mid-height", () => {
    expect(foldGeometry({ width: 669, height: 951 }, "partiallyOpen")).toEqual({
      axis: "horizontal",
      position: 475.5,
      gutter: FOLD_GUTTER,
    });
  });

  it("book pose (landscape inner, half-open) → vertical crease at mid-width", () => {
    expect(foldGeometry({ width: 951, height: 669 }, "partiallyOpen")).toEqual({
      axis: "vertical",
      position: 475.5,
      gutter: FOLD_GUTTER,
    });
  });

  it("flat or closed poses have no fold", () => {
    expect(foldGeometry({ width: 669, height: 951 }, "fullyOpen")).toBeNull();
    expect(foldGeometry({ width: 951, height: 669 }, "fullyOpen")).toBeNull();
    expect(foldGeometry({ width: 466, height: 678 }, "closed")).toBeNull();
    expect(foldGeometry({ width: 669, height: 951 }, null)).toBeNull();
    expect(foldGeometry({ width: 669, height: 951 }, "unknown")).toBeNull();
  });

  it("ignores the transient half-open report on the outer display (466x678)", () => {
    expect(foldGeometry({ width: 466, height: 678 }, "partiallyOpen")).toBeNull();
  });
});

describe("foldHalves", () => {
  it("splits the extent around the gutter", () => {
    const fold = foldGeometry({ width: 669, height: 951 }, "partiallyOpen")!;
    const { before, after } = foldHalves(fold, 951);
    expect(before).toBe(465.5);
    expect(after).toBe(465.5);
  });
});
