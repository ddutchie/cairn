/**
 * Regression tests for views.isView (src/lib/views.ts) — pure function.
 */

import { describe, it, expect } from "vitest";
import { isView } from "./views";

describe("isView", () => {
  it("matches a single candidate", () => {
    expect(isView("board", "board")).toBe(true);
    expect(isView("board", "notes")).toBe(false);
  });

  it("matches any of multiple candidates", () => {
    expect(isView("graph", "board", "graph", "insights")).toBe(true);
    expect(isView("chat", "board", "graph", "insights")).toBe(false);
  });

  it("is null/undefined safe (returns false, never throws)", () => {
    expect(isView(null, "board")).toBe(false);
    expect(isView(undefined, "board")).toBe(false);
    expect(isView(null)).toBe(false);
    expect(isView(undefined)).toBe(false);
  });

  it("returns false with no candidates", () => {
    expect(isView("board")).toBe(false);
  });
});
