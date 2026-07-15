import { describe, it, expect } from "vitest";
import { diffLines, diffStats } from "./line-diff";

describe("diffLines", () => {
  it("marks identical text as all-equal", () => {
    const rows = diffLines("a\nb\nc", "a\nb\nc");
    expect(rows.every((r) => r.op === "equal")).toBe(true);
    expect(diffStats(rows)).toEqual({ added: 0, removed: 0 });
  });

  it("marks an added line at the end", () => {
    const rows = diffLines("a\nb", "a\nb\nc");
    expect(rows.map((r) => r.op)).toEqual(["equal", "equal", "add"]);
    expect(rows[2].text).toBe("c");
    expect(diffStats(rows)).toEqual({ added: 1, removed: 0 });
  });

  it("marks a removed line", () => {
    const rows = diffLines("a\nb\nc", "a\nc");
    expect(diffStats(rows)).toEqual({ added: 0, removed: 1 });
    const removed = rows.find((r) => r.op === "remove");
    expect(removed?.text).toBe("b");
  });

  it("marks a changed line as remove + add", () => {
    const rows = diffLines("a\nb\nc", "a\nB\nc");
    const ops = rows.map((r) => r.op);
    expect(ops).toContain("remove");
    expect(ops).toContain("add");
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
    // The unchanged anchors are preserved.
    expect(rows.filter((r) => r.op === "equal").map((r) => r.text)).toEqual(["a", "c"]);
  });

  it("marks an inserted line in the middle as add", () => {
    const rows = diffLines("a\nb", "a\nx\nb");
    expect(diffStats(rows)).toEqual({ added: 1, removed: 0 });
    expect(rows.find((r) => r.op === "add")?.text).toBe("x");
  });

  it("handles empty left (everything added)", () => {
    const rows = diffLines("", "a\nb");
    // "" splits to [""], so one equal empty line then adds — assert additions present.
    expect(diffStats(rows).added).toBeGreaterThanOrEqual(2);
  });

  it("handles empty right (everything removed)", () => {
    const rows = diffLines("a\nb", "");
    expect(diffStats(rows).removed).toBeGreaterThanOrEqual(2);
  });

  it("normalises CRLF so cross-platform bodies diff cleanly", () => {
    const rows = diffLines("a\r\nb", "a\nb");
    expect(rows.every((r) => r.op === "equal")).toBe(true);
    expect(diffStats(rows)).toEqual({ added: 0, removed: 0 });
  });

  it("preserves the correct order (removes before adds at a divergence)", () => {
    const rows = diffLines("old line", "new line");
    // A single changed line → remove old, then add new.
    const ops = rows.map((r) => r.op);
    const removeIdx = ops.indexOf("remove");
    const addIdx = ops.indexOf("add");
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(removeIdx);
  });
});
