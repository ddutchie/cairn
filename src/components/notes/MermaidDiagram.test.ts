import { describe, it, expect } from "vitest";
import { parseColor, colorLuminance } from "./MermaidDiagram";

describe("parseColor", () => {
  it("parses 6-digit hex", () => {
    expect(parseColor("#1a1917")).toEqual([26, 25, 23]);
    expect(parseColor("#e8e4dc")).toEqual([232, 228, 220]);
  });

  it("parses rgb()", () => {
    expect(parseColor("rgb(240, 238, 235)")).toEqual([240, 238, 235]);
  });

  it("rejects unknown formats", () => {
    expect(parseColor("")).toBeNull();
    expect(parseColor("none")).toBeNull();
    expect(parseColor("url(#grad)")).toBeNull();
    expect(parseColor("#fff")).toBeNull();
  });
});

describe("colorLuminance", () => {
  it("returns a low value for dark colours", () => {
    expect(colorLuminance("#1a1917")).not.toBeNull();
    expect(colorLuminance("#1a1917")!).toBeLessThan(0.1);
  });

  it("returns a high value for light colours", () => {
    expect(colorLuminance("#f0eeeb")!).toBeGreaterThan(0.8);
  });

  it("returns null for unparseable input", () => {
    expect(colorLuminance("none")).toBeNull();
  });
});
