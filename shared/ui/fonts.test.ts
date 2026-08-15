import { describe, it, expect } from "vitest";
import { FONT_PRESETS, FONT_PRESET_BY_ID, DEFAULT_FONT_ID, resolveFontPreset } from "./fonts";

describe("fonts catalog", () => {
  it("ships sans / serif / mono presets in a stable order", () => {
    expect(FONT_PRESETS.map((p) => p.id)).toEqual(["sans", "serif", "mono"]);
  });

  it("defaults to sans", () => {
    expect(DEFAULT_FONT_ID).toBe("sans");
  });

  it("gives every preset a cssFamily and an rnFamily per platform", () => {
    for (const p of FONT_PRESETS) {
      expect(p.cssFamily.length).toBeGreaterThan(0);
      // Keys must exist; values may be undefined (sans = platform default font).
      expect(Object.prototype.hasOwnProperty.call(p.rnFamily, "ios")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(p.rnFamily, "android")).toBe(true);
    }
  });

  it("serif uses a system-renderable stack (PDF-safe, no webfont-only entry)", () => {
    const serif = FONT_PRESET_BY_ID["serif"];
    // Must reference a family the OS print engine can resolve — i.e. real
    // installed system fonts, NOT app-bundled webfonts like Geist.
    expect(serif.cssFamily).toMatch(/Georgia|Palatino|New York|Iowan Old Style/);
  });

  it("resolves an unknown id to the default sans preset", () => {
    expect(resolveFontPreset("nope").id).toBe("sans");
    expect(resolveFontPreset(undefined).id).toBe("sans");
    expect(resolveFontPreset(null).id).toBe("sans");
  });

  it("resolves a known id to its preset", () => {
    expect(resolveFontPreset("mono").name).toBe("Mono");
    expect(resolveFontPreset("serif").id).toBe("serif");
  });
});
