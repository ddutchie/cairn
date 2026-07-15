import { describe, it, expect } from "vitest";
import { escapeHtml, wikilinksToChips, calloutsToHtml } from "./note-html";

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
});
