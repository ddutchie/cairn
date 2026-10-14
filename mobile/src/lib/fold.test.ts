import { describe, it, expect } from "vitest";
import { foldGeometry, foldFromRegion, foldHalves, resolveFold, FOLD_GUTTER } from "./fold";

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

describe("foldFromRegion", () => {
  it("full-width band → horizontal crease at its centre, gutter = its height", () => {
    expect(foldFromRegion({ x: 0, y: 455, width: 669, height: 40 }, { width: 669, height: 951 })).toEqual({
      axis: "horizontal",
      position: 475,
      gutter: 40,
    });
  });

  it("full-height band → vertical crease", () => {
    expect(foldFromRegion({ x: 455, y: 0, width: 40, height: 669 }, { width: 951, height: 669 })).toEqual({
      axis: "vertical",
      position: 475,
      gutter: 40,
    });
  });

  it("Split View: a window clear of the crease has no fold", () => {
    expect(foldFromRegion({ x: 455, y: 0, width: 40, height: 669 }, { width: 400, height: 669 })).toBeNull();
  });

  it("Split View: a window abutting the crease sees only the overlapping sliver", () => {
    expect(foldFromRegion({ x: 455, y: 0, width: 40, height: 669 }, { width: 465, height: 669 })).toEqual({
      axis: "vertical",
      position: 460,
      gutter: 10,
    });
  });

  it("clips a band that overhangs the window", () => {
    expect(foldFromRegion({ x: -20, y: 100, width: 700, height: 40 }, { width: 669, height: 951 })).toEqual({
      axis: "horizontal",
      position: 120,
      gutter: 40,
    });
  });
});

describe("resolveFold", () => {
  const win = { width: 669, height: 951 };
  it("falls back to the inferred crease when the native API is unavailable", () => {
    expect(resolveFold(win, "partiallyOpen", undefined)).toEqual(foldGeometry(win, "partiallyOpen"));
    expect(resolveFold(win, "fullyOpen", undefined)).toBeNull();
  });

  it("trusts the native answer over the hinge status", () => {
    expect(resolveFold(win, "fullyOpen", { x: 0, y: 455, width: 669, height: 40 })?.axis).toBe("horizontal");
    expect(resolveFold(win, "partiallyOpen", null)).toBeNull();
  });
});
