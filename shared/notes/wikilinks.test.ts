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

describe("parseWikilinks bracket handling", () => {
  it("keeps a single trailing ] in the title", () => {
    expect(parseWikilinks("see [[Project [WIP]]]").map((l) => l.title)).toEqual(["Project [WIP]"]);
  });
  it("rejects four or more closing brackets", () => {
    expect(parseWikilinks("[[note]]]]")).toEqual([]);
  });
  it("still parses ordinary links", () => {
    expect(parseWikilinks("[[a]] and [[b]]").map((l) => l.title)).toEqual(["a", "b"]);
  });
});
