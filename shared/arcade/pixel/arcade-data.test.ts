import { describe, expect, it } from "vitest";
import { arcadeNoteLinks } from "./arcade-data";

describe("arcadeNoteLinks", () => {
  it("adds [[wikilinks]] to stored links, matched by title among the notes in play", () => {
    const links = arcadeNoteLinks([
      { id: "a", title: "Architecture", body: "See [[site map]] and [[Roadmap|the plan]], [[Missing]] and [[Architecture]].", linkedIds: ["c", "zz"] },
      { id: "b", title: "Site Map", body: null, linkedIds: [] },
      { id: "c", title: "Roadmap", body: "Back to [[Architecture#Overview]].", linkedIds: ["a"] },
    ]);
    // Stored link kept, wikilinks resolved case-insensitively; unknown ids, unknown titles and self-links dropped.
    expect(links.get("a")?.sort()).toEqual(["b", "c"]);
    expect(links.get("b")).toEqual([]);
    // A stored link and a wikilink to the same note count once.
    expect(links.get("c")).toEqual(["a"]);
  });
});
