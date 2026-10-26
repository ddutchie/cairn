import { describe, expect, it } from "vitest";
import path from "node:path";
import { augmentPath } from "./stdio-path";

const SEP = path.delimiter;

describe("augmentPath", () => {
  it("keeps inherited entries first and appends missing runtime dirs", () => {
    const out = augmentPath(["/a", "/b"].join(SEP), ["/c", "/a"]).split(SEP);
    expect(out).toEqual(["/a", "/b", "/c"]);
  });
  it("handles an undefined base PATH and blank entries", () => {
    expect(augmentPath(undefined, ["/x", "", "  "])).toBe("/x");
  });
});
