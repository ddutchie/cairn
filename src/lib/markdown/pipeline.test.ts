/**
 * End-to-end guard for the note markdown pipeline's custom elements.
 *
 * Regression context: `rehypeEscapeUnknownTags` serializes any element whose
 * tagName isn't in its allow-list back to literal text (so unknown
 * `<angle-bracket>` tags render as typed instead of crashing the preview). When
 * `"wikilink"` was omitted from that allow-list, `[[Note]]` links — emitted by
 * `remarkWikilinks` as a custom `<wikilink data-title="...">` element — were
 * escaped to the literal text `<wikilink dataTitle="Note">` instead of reaching
 * the ReactMarkdown `wikilink` component. These tests run the real remark→rehype
 * stack and assert the custom elements SURVIVE as elements.
 */

import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import { visit } from "unist-util-visit";
import type { Root, Element } from "hast";
import {
  remarkCallout,
  remarkObsidianEmbeds,
  remarkWikilinks,
  rehypeEscapeUnknownTags,
  makeRehypeChangedLines,
  makeLatexPlugins,
  buildNoteRemarkPlugins,
  buildNoteRehypePlugins,
  contentHasMath,
  contentHasHighlight,
} from "@/lib/markdown/pipeline";

/** Run the markdown → hast pipeline (mirrors note-editor's plugin order). */
function toHast(md: string): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkCallout)
    .use(remarkObsidianEmbeds)
    .use(remarkWikilinks)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeEscapeUnknownTags);
  return processor.runSync(processor.parse(md)) as Root;
}

/** Collect the tagNames of every element in the tree. */
function tagNames(tree: Root): string[] {
  const tags: string[] = [];
  visit(tree, "element", (n: Element) => tags.push(n.tagName));
  return tags;
}

/** Concatenate every text node's value. */
function allText(tree: Root): string {
  let s = "";
  visit(tree, "text", (n: { value: string }) => { s += n.value; });
  return s;
}

describe("markdown pipeline: custom elements survive rehypeEscapeUnknownTags", () => {
  it("renders [[Wikilinks]] as a <wikilink> element with data-title (not literal text)", () => {
    const tree = toHast("A link to [[Feature Matrix]] here.");
    const wikilinks: Element[] = [];
    visit(tree, "element", (n: Element) => { if (n.tagName === "wikilink") wikilinks.push(n); });

    expect(wikilinks).toHaveLength(1);
    expect(wikilinks[0].properties?.["dataTitle"]).toBe("Feature Matrix");
    // The regression symptom: the element serialized to literal text.
    expect(allText(tree)).not.toContain("<wikilink");
    expect(allText(tree)).not.toContain("dataTitle");
  });

  it("keeps callouts as <callout> elements", () => {
    const tree = toHast("> [!note] Heads up\n> body");
    expect(tagNames(tree)).toContain("callout");
    expect(allText(tree)).not.toContain("<callout");
  });

  it("still escapes genuinely unknown tags to literal text (no crash)", () => {
    const tree = toHast("Config in <repo>/etc/foo</repo>.");
    expect(tagNames(tree)).not.toContain("repo");
    expect(allText(tree)).toContain("<repo>");
  });

  it("escapes a stray SVG <text> outside an <svg> to literal text (was: React crash)", () => {
    const tree = toHast("Agent replied: <text>hello</text>");
    expect(tagNames(tree)).not.toContain("text");
    expect(allText(tree)).toContain("<text>hello</text>");
  });

  it("keeps SVG <text> children when nested inside an <svg>", () => {
    const tree = toHast('<svg width="10" height="10"><text x="1" y="2">Hi</text></svg>');
    expect(tagNames(tree)).toContain("svg");
    expect(tagNames(tree)).toContain("text");
  });

  it("resolves multiple wikilinks in one paragraph", () => {
    const tree = toHast("See [[Alpha]] and [[Beta Note]].");
    const titles: string[] = [];
    visit(tree, "element", (n: Element) => {
      if (n.tagName === "wikilink") titles.push(String(n.properties?.["dataTitle"] ?? ""));
    });
    expect(titles).toEqual(["Alpha", "Beta Note"]);
  });
});

// ── makeRehypeChangedLines ────────────────────────────────────────────────────

/** Run the pipeline with the changed-lines plugin (mirrors note-editor order). */
function toHastWithChanges(md: string, changedLines: number[]): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkCallout)
    .use(remarkObsidianEmbeds)
    .use(remarkWikilinks)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(makeRehypeChangedLines(changedLines))
    .use(rehypeEscapeUnknownTags);
  return processor.runSync(processor.parse(md)) as Root;
}

/** Tag names of every element carrying the cm-changed-line class. */
function changedTags(tree: Root): string[] {
  const tags: string[] = [];
  visit(tree, "element", (n: Element) => {
    const cls = n.properties?.className;
    const arr = Array.isArray(cls) ? cls.map(String) : [];
    if (arr.includes("cm-changed-line")) tags.push(n.tagName);
  });
  return tags;
}

describe("makeRehypeChangedLines — read-mode change highlight", () => {
  it("tags a paragraph whose source line changed", () => {
    // line 1 = "First", line 3 = "Second"
    const tree = toHastWithChanges("First\n\nSecond", [3]);
    const tags = changedTags(tree);
    expect(tags).toContain("p");
    // Only the second paragraph should be tagged, not both.
    expect(tags.filter((t) => t === "p")).toHaveLength(1);
  });

  it("tags a heading on the changed line", () => {
    const tree = toHastWithChanges("# Title\n\nbody", [1]);
    expect(changedTags(tree)).toContain("h1");
  });

  it("tags list items independently by line", () => {
    // - a (line 1), - b (line 2), - c (line 3)
    const tree = toHastWithChanges("- a\n- b\n- c", [2]);
    const tree2 = toHastWithChanges("- a\n- b\n- c", [1, 3]);
    expect(changedTags(tree).filter((t) => t === "li")).toHaveLength(1);
    expect(changedTags(tree2).filter((t) => t === "li")).toHaveLength(2);
  });

  it("adds no class when the changed set is empty", () => {
    const tree = toHastWithChanges("# Title\n\nbody", []);
    expect(changedTags(tree)).toEqual([]);
  });

  it("does not tag blocks whose lines are unchanged", () => {
    const tree = toHastWithChanges("First\n\nSecond\n\nThird", [1]);
    // Only the first paragraph is on line 1.
    expect(changedTags(tree).filter((t) => t === "p")).toHaveLength(1);
  });

  it("preserves an existing className while adding the highlight", () => {
    // rehypeRaw HTML passthrough keeps a class on the element.
    const tree = toHastWithChanges('<p class="foo">hi</p>', [1]);
    let found = false;
    visit(tree, "element", (n: Element) => {
      if (n.tagName === "p") {
        const arr = Array.isArray(n.properties?.className) ? n.properties!.className.map(String) : [];
        if (arr.includes("foo") && arr.includes("cm-changed-line")) found = true;
      }
    });
    expect(found).toBe(true);
  });
});

// ── Content-aware plugin builders ─────────────────────────────────────────────

describe("content probes", () => {
  it("contentHasMath detects a $ dollar sign", () => {
    expect(contentHasMath("cost is $5")).toBe(true);
    expect(contentHasMath("no math here")).toBe(false);
  });
  it("contentHasHighlight detects ==", () => {
    expect(contentHasHighlight("a ==b== c")).toBe(true);
    expect(contentHasHighlight("plain")).toBe(false);
  });
});

/** Full string→hast run using the production builders, mirroring the renderer. */
function runBuilders(md: string): Root {
  const latex = makeLatexPlugins(md);
  const remarkPlugins = buildNoteRemarkPlugins(md, { wikilinks: true });
  const rehypePlugins = buildNoteRehypePlugins(md, { latex });
  const proc = unified().use(remarkParse);
  // Pass the whole PluggableList at once so tuple entries like
  // [remarkMath, { singleDollarTextMath: false }] are applied with their
  // options (iterating + proc.use(tuple) would misread the options as a preset).
  proc.use(remarkPlugins);
  proc.use(remarkRehype, { allowDangerousHtml: true });
  proc.use(rehypePlugins);
  return proc.runSync(proc.parse(md)) as Root;
}

describe("buildNote{Remark,Rehype}Plugins — content-aware assembly", () => {
  it("renders display math to a <mathblock> when the source has math", () => {
    const tree = runBuilders("Formula:\n\n$$x^2$$\n");
    expect(tagNames(tree)).toContain("mathblock");
  });

  it("still renders ==highlight== marks in a math-free note", () => {
    // Math stack is omitted, but the merged pass must still split highlights.
    const tree = runBuilders("This is ==important== text.");
    expect(tagNames(tree)).toContain("mark");
    // And no math artifacts leak in.
    expect(tagNames(tree)).not.toContain("mathblock");
  });

  it("renders callouts in a math-free note", () => {
    const tree = runBuilders("> [!note] Heads up\n> body");
    expect(tagNames(tree)).toContain("callout");
  });

  it("resolves wikilinks when the wikilinks option is set", () => {
    const tree = runBuilders("See [[Alpha]].");
    expect(tagNames(tree)).toContain("wikilink");
  });

  it("produces no math elements for a math-free note (katex skipped)", () => {
    const tree = runBuilders("# Title\n\nJust prose, no math.\n");
    const tags = tagNames(tree);
    expect(tags).not.toContain("mathblock");
    // rehype-katex would emit spans with class 'katex' — none should exist.
    let hasKatex = false;
    visit(tree, "element", (n: Element) => {
      const cls = Array.isArray(n.properties?.className) ? n.properties!.className.map(String) : [];
      if (cls.some((c) => c.startsWith("katex"))) hasKatex = true;
    });
    expect(hasKatex).toBe(false);
  });

  it("renders both math and highlights together", () => {
    const tree = runBuilders("A ==mark== here.\n\n$$y=1$$\n");
    const tags = tagNames(tree);
    expect(tags).toContain("mark");
    expect(tags).toContain("mathblock");
  });

  it("does NOT treat currency like '$145.000 - $250.000' as inline math", () => {
    // singleDollarTextMath is disabled, so a $…$ pair on a line is plain text,
    // not KaTeX. The $ signs must survive and no katex/math node is produced.
    const tree = runBuilders("Budget: $145.000 - $250.000 total.");

    // No KaTeX artifacts.
    expect(tagNames(tree)).not.toContain("mathblock");
    let hasKatex = false;
    visit(tree, "element", (n: Element) => {
      const cls = Array.isArray(n.properties?.className) ? n.properties!.className.map(String) : [];
      if (cls.some((c) => c.startsWith("katex"))) hasKatex = true;
    });
    expect(hasKatex).toBe(false);

    // Both dollar signs survive in the rendered text.
    let text = "";
    visit(tree, "text", (n: { value?: string }) => { text += n.value ?? ""; });
    expect(text).toContain("$145.000");
    expect(text).toContain("$250.000");
  });

  it("still renders explicit $$…$$ display math (currency fix does not disable block math)", () => {
    const tree = runBuilders("Total cost model:\n\n$$c = 145 + 250$$\n");
    expect(tagNames(tree)).toContain("mathblock");
  });
});
