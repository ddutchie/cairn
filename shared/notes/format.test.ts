import { describe, it, expect } from "vitest";
import { insertEmbedAtSelection } from "./format";

describe("insertEmbedAtSelection", () => {
  const E = "![[photo-ab12cd34.jpg]]";

  it("puts the embed on its own line mid-paragraph", () => {
    const r = insertEmbedAtSelection("hello world", { start: 5, end: 5 }, E);
    expect(r.text).toBe(`hello\n${E}\n world`);
    expect(r.selection.start).toBe(r.text.indexOf(" world"));
  });

  it("adds no extra blank lines at the start of an empty note or a line", () => {
    expect(insertEmbedAtSelection("", { start: 0, end: 0 }, E).text).toBe(`${E}\n`);
    expect(insertEmbedAtSelection("a\nb", { start: 2, end: 2 }, E).text).toBe(`a\n${E}\nb`);
  });

  it("does not double the newline when one already follows", () => {
    expect(insertEmbedAtSelection("a\n", { start: 1, end: 1 }, E).text).toBe(`a\n${E}\n`);
  });

  it("replaces a selection and clamps an out-of-range caret", () => {
    expect(insertEmbedAtSelection("abc", { start: 0, end: 3 }, E).text).toBe(`${E}\n`);
    expect(insertEmbedAtSelection("abc", { start: 99, end: 99 }, E).text).toBe(`abc\n${E}\n`);
  });
});
