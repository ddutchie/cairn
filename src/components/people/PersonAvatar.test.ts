import { describe, it, expect } from "vitest";
import { initialsOf } from "./PersonAvatar";

describe("initialsOf", () => {
  it("takes the first and last name's first letters", () => {
    expect(initialsOf("Ana Maria Lopez")).toBe("AL");
    expect(initialsOf("  ben ")).toBe("B");
    expect(initialsOf("")).toBe("?");
  });
  it("keeps a whole character that is outside the basic plane", () => {
    expect(initialsOf("𠮷田 太郎")).toBe("𠮷太");
  });
});
