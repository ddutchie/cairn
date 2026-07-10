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

  it("resolves multiple wikilinks in one paragraph", () => {
    const tree = toHast("See [[Alpha]] and [[Beta Note]].");
    const titles: string[] = [];
    visit(tree, "element", (n: Element) => {
      if (n.tagName === "wikilink") titles.push(String(n.properties?.["dataTitle"] ?? ""));
    });
    expect(titles).toEqual(["Alpha", "Beta Note"]);
  });
});
