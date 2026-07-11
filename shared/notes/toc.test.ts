import { describe, it, expect } from "vitest";
import { buildNoteOutline, sliceLines, extractHeadings } from "./toc";

const DOC = [
  "# Title",              // 1
  "",                     // 2
  "intro paragraph",      // 3
  "",                     // 4
  "## Section A",         // 5
  "a body",               // 6
  "```md",                // 7
  "## Not a heading",     // 8 (in fence)
  "```",                  // 9
  "### Sub A1",           // 10
  "more",                 // 11
  "## Section B",         // 12
  "b body",               // 13
].join("\n");

describe("buildNoteOutline", () => {
  it("returns line-numbered headings (1-based), skipping fenced code", () => {
    const o = buildNoteOutline(DOC);
    expect(o.totalLines).toBe(13);
    expect(o.headings).toEqual([
      { level: 1, text: "Title", line: 1 },
      { level: 2, text: "Section A", line: 5 },
      { level: 3, text: "Sub A1", line: 10 },
      { level: 2, text: "Section B", line: 12 },
    ]);
  });

  it("agrees with extractHeadings on which headings exist", () => {
    expect(buildNoteOutline(DOC).headings.map((h) => h.text)).toEqual(
      extractHeadings(DOC).map((h) => h.text),
    );
  });

  it("handles empty input", () => {
    expect(buildNoteOutline("")).toEqual({ totalLines: 1, headings: [] });
  });
});

describe("sliceLines", () => {
  it("returns an inclusive 1-based range", () => {
    expect(sliceLines(DOC, 5, 6)).toBe("## Section A\na body");
  });
  it("clamps out-of-range end and reads to EOF when end omitted", () => {
    expect(sliceLines(DOC, 12)).toBe("## Section B\nb body");
    expect(sliceLines(DOC, 12, 999)).toBe("## Section B\nb body");
  });
  it("clamps start to >=1", () => {
    expect(sliceLines(DOC, 0, 1)).toBe("# Title");
  });
  it("returns empty when start is past the end", () => {
    expect(sliceLines(DOC, 999)).toBe("");
  });
});
