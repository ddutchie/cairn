import { describe, it, expect } from "vitest";
import { escapeHtml, wikilinksToChips, escapeAndChipWikilinks, calloutsToHtml, transformOutsideCode } from "./note-html";

describe("escapeHtml", () => {
  it("escapes HTML-significant characters", () => {
    expect(escapeHtml('a<b>&"c')).toBe("a&lt;b&gt;&amp;&quot;c");
  });
});

describe("wikilinksToChips", () => {
  it("converts [[Title]] to a chip span, trimming + escaping", () => {
    expect(wikilinksToChips("see [[ My Note ]] here")).toBe(
      'see <span class="wikilink-chip">My Note</span> here',
    );
    expect(wikilinksToChips("[[a<b>]]")).toBe('<span class="wikilink-chip">a&lt;b&gt;</span>');
  });

  it("leaves plain text untouched", () => {
    expect(wikilinksToChips("no links here")).toBe("no links here");
  });
});

describe("escapeAndChipWikilinks", () => {
  it("escapes ordinary text AND the wikilink title each exactly once", () => {
    // Ordinary text with HTML chars is escaped; the chip HTML is emitted raw.
    expect(escapeAndChipWikilinks("a<b> & [[Note]] c")).toBe(
      'a&lt;b&gt; &amp; <span class="wikilink-chip">Note</span> c',
    );
  });

  it("does NOT double-escape a wikilink title containing HTML (regression)", () => {
    // [[a<b>]] must escape the title ONCE → a&lt;b&gt;, never a&amp;lt;b&amp;gt;.
    expect(escapeAndChipWikilinks("[[a<b>]]")).toBe(
      '<span class="wikilink-chip">a&lt;b&gt;</span>',
    );
  });
});

describe("calloutsToHtml", () => {
  it("converts an Obsidian callout block to [data-callout] HTML", () => {
    const src = "> [!warning] Heads up\n> line one\n> line two";
    const out = calloutsToHtml(src);
    expect(out).toContain('data-callout-type="warning"');
    expect(out).toContain("Heads up");
    expect(out).toContain("line one<br>line two");
    // Header structure the desktop CSS targets: <div><span></span>Title</div>
    expect(out).toContain("<div><span></span>Heads up</div>");
  });

  it("defaults the title to a capitalised type when none is given", () => {
    const out = calloutsToHtml("> [!tip]\n> be careful");
    expect(out).toContain('data-callout-type="tip"');
    expect(out).toContain("<div><span></span>Tip</div>");
  });

  it("chips wikilinks inside a callout body", () => {
    const out = calloutsToHtml("> [!note] N\n> see [[Other]]");
    expect(out).toContain('<span class="wikilink-chip">Other</span>');
  });

  it("single-escapes a callout body wikilink title with HTML (regression)", () => {
    // The body path previously escaped the line then chipped (escaping the title
    // a second time). [[a<b>]] must appear escaped exactly once.
    const out = calloutsToHtml("> [!note] N\n> [[a<b>]]");
    expect(out).toContain('<span class="wikilink-chip">a&lt;b&gt;</span>');
    expect(out).not.toContain("a&amp;lt;b&amp;gt;");
  });

  it("preserves line-break rendering between callout body lines", () => {
    const out = calloutsToHtml("> [!note] N\n> line one\n> line two");
    expect(out).toContain("line one<br>line two");
  });

  it("leaves ordinary markdown lines (incl. plain blockquotes) unchanged", () => {
    const src = "# Title\n\n> a normal quote\n\ntext";
    const out = calloutsToHtml(src);
    expect(out).toContain("# Title");
    expect(out).toContain("> a normal quote"); // not a callout — no [!type]
    expect(out).not.toContain("data-callout");
  });

  it("handles a callout followed by regular content", () => {
    const src = "> [!info] Info\n> body\n\nafter para";
    const out = calloutsToHtml(src);
    expect(out).toContain('data-callout-type="info"');
    expect(out).toContain("after para");
  });

  it("does NOT treat a blockquote inside a fenced code block as a callout", () => {
    const src = "```md\n> [!warning] not a callout\n> still code\n```";
    const out = calloutsToHtml(src);
    expect(out).not.toContain("data-callout");
    expect(out).toContain("> [!warning] not a callout"); // left verbatim
  });
});

describe("transformOutsideCode", () => {
  const chip = (t: string) => t.replace(/\[\[([^\]]+)\]\]/g, "<CHIP>$1</CHIP>");

  it("transforms ordinary text", () => {
    expect(transformOutsideCode("see [[Note]] ok", chip)).toBe("see <CHIP>Note</CHIP> ok");
  });

  it("skips fenced code blocks", () => {
    const src = "before [[A]]\n```\ncode [[B]] here\n```\nafter [[C]]";
    const out = transformOutsideCode(src, chip);
    expect(out).toContain("before <CHIP>A</CHIP>");
    expect(out).toContain("code [[B]] here"); // untouched inside fence
    expect(out).toContain("after <CHIP>C</CHIP>");
  });

  it("skips inline code spans", () => {
    expect(transformOutsideCode("text `[[A]]` and [[B]]", chip)).toBe(
      "text `[[A]]` and <CHIP>B</CHIP>",
    );
  });

  it("handles ~~~ fences too", () => {
    const out = transformOutsideCode("~~~\n[[A]]\n~~~\n[[B]]", chip);
    expect(out).toContain("[[A]]"); // untouched
    expect(out).toContain("<CHIP>B</CHIP>");
  });
});
