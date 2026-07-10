import { describe, it, expect } from "vitest";
import { splitIntoSections } from "./sections";

describe("splitIntoSections", () => {
  it("returns single section for content with no headers", () => {
    const sections = splitIntoSections("My Note", "just some text");
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("My Note");
    expect(sections[0].text).toBe("just some text");
    expect(sections[0].idx).toBe(0);
  });

  it("splits on ## headers", () => {
    const content = "## Architecture\nmicroservices\n## Marketing\ngo to market";
    const sections = splitIntoSections("Plan", content);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("Architecture");
    expect(sections[0].text).toBe("microservices");
    expect(sections[1].title).toBe("Marketing");
    expect(sections[1].text).toBe("go to market");
  });

  it("uses note title for pre-header content", () => {
    const content = "intro text\n## First Section\nbody";
    const sections = splitIntoSections("My Note", content);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("My Note");
    expect(sections[0].text).toBe("intro text");
    expect(sections[1].title).toBe("First Section");
    expect(sections[1].text).toBe("body");
  });

  it("splits on # (h1) headers too", () => {
    const content = "# Section A\ncontent a\n# Section B\ncontent b";
    const sections = splitIntoSections("Note", content);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("Section A");
    expect(sections[1].title).toBe("Section B");
  });

  it("does NOT split on ### (h3) headers — they stay in parent section", () => {
    const content = "## Architecture\nmicroservices\n### Sub-architecture\ndetails\n## Marketing\ngo to market";
    const sections = splitIntoSections("Plan", content);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("Architecture");
    expect(sections[0].text).toContain("Sub-architecture");
    expect(sections[0].text).toContain("details");
    expect(sections[1].title).toBe("Marketing");
  });

  it("does NOT split on #### (h4) headers", () => {
    const content = "## Top\nbody\n#### Deep\nnested";
    const sections = splitIntoSections("Note", content);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("Top");
    expect(sections[0].text).toContain("Deep");
    expect(sections[0].text).toContain("nested");
  });

  it("returns empty array for empty content", () => {
    expect(splitIntoSections("Note", "")).toHaveLength(0);
    expect(splitIntoSections("Note", "   ")).toHaveLength(0);
  });

  it("assigns sequential idx starting at 0", () => {
    const content = "## A\nx\n## B\ny\n## C\nz";
    const sections = splitIntoSections("Note", content);
    expect(sections.map((s) => s.idx)).toEqual([0, 1, 2]);
  });

  it("skips empty sections (header with no body)", () => {
    const content = "## A\n\n## B\nbody";
    const sections = splitIntoSections("Note", content);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("B");
  });

  it("handles headers with trailing whitespace", () => {
    const content = "## Architecture   \nbody";
    const sections = splitIntoSections("Note", content);
    expect(sections[0].title).toBe("Architecture");
  });

  it("handles note with only headers and no body text (fallback to whole content)", () => {
    const content = "## Section A\n## Section B";
    const sections = splitIntoSections("Note", content);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("Note");
  });

  it("preserves multi-line section body", () => {
    const content = "## Architecture\nline1\nline2\nline3";
    const sections = splitIntoSections("Note", content);
    expect(sections[0].text).toBe("line1\nline2\nline3");
  });
});
