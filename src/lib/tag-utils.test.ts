import { describe, it, expect } from "vitest";
import { sortTagsByUsage, capTags } from "./tag-utils";
import type { Tag } from "@/types";

const tag = (id: string): Tag => ({ id, name: id, color: "#000", workspaceId: "w" });

describe("sortTagsByUsage", () => {
  it("sorts by combined usage across notes and cards, descending", () => {
    const tags = [tag("a"), tag("b"), tag("c")];
    const notes = [
      { tagIds: ["a", "b"] },
      { tagIds: ["a"] },
    ];
    const cards = [{ tagIds: ["c"] }];
    expect(sortTagsByUsage(tags, notes, cards).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves order for tags with equal usage", () => {
    const tags = [tag("x"), tag("y"), tag("z")];
    expect(sortTagsByUsage(tags, [{ tagIds: ["x", "y", "z"] }]).map((t) => t.id)).toEqual(["x", "y", "z"]);
  });

  it("does not mutate the input array", () => {
    const tags = [tag("a"), tag("b")];
    const original = [...tags];
    sortTagsByUsage(tags, [{ tagIds: ["b"] }]);
    expect(tags).toEqual(original);
  });
});

describe("capTags", () => {
  it("splits into shown and hidden", () => {
    const tags = [tag("a"), tag("b"), tag("c")];
    expect(capTags(tags, 2).shown.map((t) => t.id)).toEqual(["a", "b"]);
    expect(capTags(tags, 2).hidden.map((t) => t.id)).toEqual(["c"]);
  });

  it("returns empty hidden when under the cap", () => {
    expect(capTags([tag("a")], 2).hidden).toEqual([]);
  });
});
