import { describe, expect, it } from "vitest";
import { buildHljsPalette } from "@/lib/syntax-palette";
import { renderHast, type HastNode } from "./render-hast";

describe("shared highlight palette", () => {
  it("matches the retired DiffFile literals in both themes", () => {
    const dark = buildHljsPalette("dark");
    const light = buildHljsPalette("light");
    // Spot-check the values DiffFile.tsx hardcoded before F16.
    expect(dark["hljs-keyword"]).toBe("#c678dd");
    expect(dark["hljs-string"]).toBe("#98c379");
    expect(dark["hljs-addition"]).toBe("#98c379");
    expect(dark["hljs-deletion"]).toBe("#e06c75");
    expect(light["hljs-keyword"]).toBe("#7c3aed");
    expect(light["hljs-string"]).toBe("#16a34a");
    expect(light["hljs-addition"]).toBe("#16a34a");
    expect(light["hljs-deletion"]).toBe("#dc2626");
    // Every retired DiffFile class resolves in the shared palette.
    for (const cls of [
      "hljs-keyword", "hljs-built_in", "hljs-literal", "hljs-number",
      "hljs-string", "hljs-comment", "hljs-variable", "hljs-attr",
      "hljs-title", "hljs-type", "hljs-operator", "hljs-punctuation",
      "hljs-tag", "hljs-meta", "hljs-addition", "hljs-deletion",
    ]) {
      expect(dark[cls], cls).toMatch(/^#[0-9a-f]{6}$/);
      expect(light[cls], cls).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("renderHast renders text, coloured elements and unknowns", () => {
    const palette = { "hljs-keyword": "#c678dd" };
    expect(renderHast({ type: "text", value: "hi" }, palette, "0")).toBe("hi");
    expect(renderHast({ type: "comment" } as unknown as HastNode, palette, "0")).toBeNull();
    const el = renderHast(
      { type: "element", properties: { className: ["hljs-keyword"] }, children: [{ type: "text", value: "if" }] },
      palette,
      "1",
    );
    expect(el).toBeTruthy();
  });
});
