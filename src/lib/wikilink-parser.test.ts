/**
 * Unit tests for src/lib/wikilink-parser.ts and
 * src/components/notes/TableOfContents.tsx (extractWikiLinks helper)
 */

import { describe, it, expect } from "vitest";
import {
  parseWikilinks,
  resolveWikilinks,
  segmentContent,
  getActiveWikilink,
} from "./wikilink-parser";
import {
  extractWikiLinks,
  extractHeadings,
  headingSlug,
} from "../components/notes/toc-utils.js";

// ── parseWikilinks ─────────────────────────────────────────────────────────────

describe("parseWikilinks", () => {
  it("returns empty array for content with no wikilinks", () => {
    expect(parseWikilinks("No links here.")).toEqual([]);
  });

  it("parses a single wikilink", () => {
    const result = parseWikilinks("See [[My Note]] for details.");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("My Note");
    expect(result[0].raw).toBe("[[My Note]]");
    expect(result[0].index).toBe(4);
    expect(result[0].end).toBe(15);
  });

  it("parses multiple wikilinks in order", () => {
    const result = parseWikilinks("[[Alpha]] and [[Beta]] and [[Gamma]]");
    expect(result.map((r) => r.title)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("trims whitespace inside brackets", () => {
    const result = parseWikilinks("[[  Spaced Title  ]]");
    expect(result[0].title).toBe("Spaced Title");
  });

  it("skips empty wikilinks [[]]", () => {
    expect(parseWikilinks("[[]]")).toEqual([]);
  });

  it("skips wikilinks with only whitespace", () => {
    expect(parseWikilinks("[[   ]]")).toEqual([]);
  });

  it("does not match across newlines", () => {
    expect(parseWikilinks("[[\nfoo\n]]")).toEqual([]);
  });

  it("handles wikilinks at start and end of string", () => {
    const result = parseWikilinks("[[Start]] middle [[End]]");
    expect(result[0].title).toBe("Start");
    expect(result[1].title).toBe("End");
  });

  it("correctly records index and end positions", () => {
    const content = "abc[[Note]]xyz";
    const [m] = parseWikilinks(content);
    expect(content.slice(m.index, m.end)).toBe("[[Note]]");
  });
});

// ── resolveWikilinks ───────────────────────────────────────────────────────────

describe("resolveWikilinks", () => {
  const notes = [
    { id: "n1", title: "Alpha" },
    { id: "n2", title: "Beta Note" },
    { id: "n3", title: "Gamma" },
  ];

  it("resolves an exact-match wikilink", () => {
    const result = resolveWikilinks("See [[Alpha]].", notes);
    expect(result[0].noteId).toBe("n1");
  });

  it("resolves case-insensitively", () => {
    const result = resolveWikilinks("[[ALPHA]] and [[beta note]]", notes);
    expect(result[0].noteId).toBe("n1");
    expect(result[1].noteId).toBe("n2");
  });

  it("returns null noteId for unresolved links", () => {
    const result = resolveWikilinks("[[Unknown Note]]", notes);
    expect(result[0].noteId).toBeNull();
  });

  it("first note wins when titles collide", () => {
    const dupes = [
      { id: "first", title: "Dupe" },
      { id: "second", title: "dupe" },
    ];
    const result = resolveWikilinks("[[Dupe]]", dupes);
    expect(result[0].noteId).toBe("first");
  });

  it("returns empty array for content with no wikilinks", () => {
    expect(resolveWikilinks("plain text", notes)).toEqual([]);
  });
});

// ── segmentContent ─────────────────────────────────────────────────────────────

describe("segmentContent", () => {
  const notes = [{ id: "n1", title: "World" }];

  it("returns a single text segment when no wikilinks present", () => {
    const segs = segmentContent("Hello plain text", notes);
    expect(segs).toEqual([{ type: "text", text: "Hello plain text" }]);
  });

  it("segments text around a single wikilink", () => {
    const segs = segmentContent("Hello [[World]] foo", notes);
    expect(segs).toEqual([
      { type: "text", text: "Hello " },
      { type: "wikilink", text: "World", noteId: "n1" },
      { type: "text", text: " foo" },
    ]);
  });

  it("handles wikilink at the start", () => {
    const segs = segmentContent("[[World]] bar", notes);
    expect(segs[0]).toEqual({ type: "wikilink", text: "World", noteId: "n1" });
    expect(segs[1]).toEqual({ type: "text", text: " bar" });
  });

  it("handles wikilink at the end", () => {
    const segs = segmentContent("foo [[World]]", notes);
    expect(segs[0]).toEqual({ type: "text", text: "foo " });
    expect(segs[1]).toEqual({ type: "wikilink", text: "World", noteId: "n1" });
  });

  it("handles adjacent wikilinks", () => {
    const segs = segmentContent("[[World]][[World]]", notes);
    expect(segs).toHaveLength(2);
    expect(segs[0].type).toBe("wikilink");
    expect(segs[1].type).toBe("wikilink");
  });

  it("sets noteId to null for unresolved links", () => {
    const segs = segmentContent("[[Unknown]]", notes);
    expect(segs[0]).toEqual({ type: "wikilink", text: "Unknown", noteId: null });
  });
});

// ── getActiveWikilink ──────────────────────────────────────────────────────────

describe("getActiveWikilink", () => {
  it("returns null when no [[ before cursor", () => {
    expect(getActiveWikilink("hello world", 11)).toBeNull();
  });

  it("detects an open wikilink at cursor", () => {
    const content = "Go [[My N";
    const result = getActiveWikilink(content, content.length);
    expect(result).not.toBeNull();
    expect(result!.query).toBe("My N");
    expect(result!.triggerFrom).toBe(3);
  });

  it("returns null when [[ is already closed before cursor", () => {
    const content = "[[Done]] more text";
    expect(getActiveWikilink(content, content.length)).toBeNull();
  });

  it("returns null when newline between [[ and cursor", () => {
    const content = "[[foo\nbar";
    expect(getActiveWikilink(content, content.length)).toBeNull();
  });

  it("returns empty query when cursor is immediately after [[", () => {
    const content = "[[";
    const result = getActiveWikilink(content, 2);
    expect(result).not.toBeNull();
    expect(result!.query).toBe("");
    expect(result!.triggerFrom).toBe(0);
  });

  it("uses the latest [[ if multiple are present", () => {
    const content = "[[done]] text [[partial";
    const result = getActiveWikilink(content, content.length);
    expect(result).not.toBeNull();
    expect(result!.query).toBe("partial");
    expect(result!.triggerFrom).toBe(14);
  });
});

// ── TableOfContents helpers ────────────────────────────────────────────────────

describe("headingSlug", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(headingSlug("Hello World")).toBe("hello-world");
  });

  it("strips non-alphanumeric characters", () => {
    expect(headingSlug("C++ & Rust!")).toBe("c-rust");
  });

  it("collapses multiple hyphens", () => {
    expect(headingSlug("foo -- bar")).toBe("foo-bar");
  });

  it("trims leading and trailing hyphens", () => {
    expect(headingSlug("!Hello!")).toBe("hello");
  });
});

describe("extractHeadings", () => {
  it("extracts h1 / h2 / h3 headings", () => {
    const md = "# Title\n## Section\n### Subsection\nsome text";
    const headings = extractHeadings(md);
    expect(headings).toEqual([
      { level: 1, text: "Title", id: "title" },
      { level: 2, text: "Section", id: "section" },
      { level: 3, text: "Subsection", id: "subsection" },
    ]);
  });

  it("ignores headings inside code fences", () => {
    const md = "```\n# not a heading\n```\n## Real";
    const headings = extractHeadings(md);
    expect(headings).toHaveLength(1);
    expect(headings[0].text).toBe("Real");
  });

  it("returns empty array for content with no headings", () => {
    expect(extractHeadings("just prose")).toEqual([]);
  });

  it("ignores h4+ headings", () => {
    const md = "#### Deep\n## Shallow";
    const headings = extractHeadings(md);
    expect(headings).toHaveLength(1);
    expect(headings[0].text).toBe("Shallow");
  });
});

describe("extractWikiLinks", () => {
  const notes = [
    { id: "n1", title: "Alpha" },
    { id: "n2", title: "Beta" },
  ];

  it("returns empty array for content with no wikilinks", () => {
    expect(extractWikiLinks("no links", notes)).toEqual([]);
  });

  it("extracts and resolves wikilinks", () => {
    const result = extractWikiLinks("See [[Alpha]] and [[Beta]].", notes);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ title: "Alpha", noteId: "n1" });
    expect(result[1]).toEqual({ title: "Beta", noteId: "n2" });
  });

  it("deduplicates repeated wikilinks by title", () => {
    const result = extractWikiLinks("[[Alpha]] [[Alpha]] [[alpha]]", notes);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Alpha");
  });

  it("sets noteId to null for unresolved links", () => {
    const result = extractWikiLinks("[[Unknown]]", notes);
    expect(result[0]).toEqual({ title: "Unknown", noteId: null });
  });

  it("works with an empty notes array", () => {
    const result = extractWikiLinks("[[Alpha]]", []);
    expect(result[0].noteId).toBeNull();
  });
});
