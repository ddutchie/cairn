import { describe, it, expect } from "vitest";
import { parseWikilinks, linksToTitle } from "./wikilinks";

describe("parseWikilinks", () => {
  it("returns trimmed titles with offsets, skipping empty links", () => {
    const src = "a [[ One ]] b [[]] c [[Two]]";
    expect(parseWikilinks(src)).toEqual([
      { raw: "[[ One ]]", title: "One", index: 2, end: 11 },
      { raw: "[[Two]]", title: "Two", index: 21, end: 28 },
    ]);
  });
  it("does not span lines", () => {
    expect(parseWikilinks("[[a\nb]]")).toEqual([]);
  });
});

describe("linksToTitle", () => {
  it("matches case-insensitively", () => {
    expect(linksToTitle("see [[my note]]", "My Note")).toBe(true);
    expect(linksToTitle("see [[other]]", "My Note")).toBe(false);
  });
});
