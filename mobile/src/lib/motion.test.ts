import { describe, it, expect } from "vitest";
import { digitsOf, durationScale, nextIndex, rollTokens, scaleDuration, staggerDelay } from "./motion";

describe("durationScale / scaleDuration", () => {
  it("is 1 normally and 0 under reduce motion", () => {
    expect(durationScale(false)).toBe(1);
    expect(durationScale(true)).toBe(0);
    expect(scaleDuration(300, false)).toBe(300);
    expect(scaleDuration(300, true)).toBe(0);
  });
});

describe("staggerDelay", () => {
  it("steps by index and stops at the cap", () => {
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(3)).toBe(120);
    expect(staggerDelay(7)).toBe(280);
    expect(staggerDelay(8)).toBeNull();
    expect(staggerDelay(50)).toBeNull();
  });
  it("does not animate under reduce motion or for a bad index", () => {
    expect(staggerDelay(0, { reduced: true })).toBeNull();
    expect(staggerDelay(-1)).toBeNull();
  });
  it("honours a custom step and cap", () => {
    expect(staggerDelay(2, { stepMs: 10, cap: 3 })).toBe(20);
    expect(staggerDelay(3, { stepMs: 10, cap: 3 })).toBeNull();
  });
});

describe("nextIndex", () => {
  it("wraps and tolerates tiny lists", () => {
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(2, 3)).toBe(0);
    expect(nextIndex(0, 1)).toBe(0);
    expect(nextIndex(4, 0)).toBe(0);
  });
});

describe("digitsOf", () => {
  it("splits an integer into digits", () => {
    expect(digitsOf(0)).toEqual([0]);
    expect(digitsOf(407)).toEqual([4, 0, 7]);
  });
  it("clamps negatives, NaN and fractions", () => {
    expect(digitsOf(-5)).toEqual([0]);
    expect(digitsOf(NaN)).toEqual([0]);
    expect(digitsOf(12.6)).toEqual([1, 3]);
  });
});

describe("rollTokens", () => {
  it("marks digits and keeps separators static", () => {
    const tokens = rollTokens("1,204");
    expect(tokens.map((x) => x.digit)).toEqual([1, null, 2, 0, 4]);
    expect(tokens.map((x) => x.ch).join("")).toBe("1,204");
  });
  it("keys from the right so a new leading digit leaves the rest in place", () => {
    const a = rollTokens("99");
    const b = rollTokens("100");
    expect(b.slice(1).map((x) => x.key)).toEqual(a.map((x) => x.key));
  });
});
