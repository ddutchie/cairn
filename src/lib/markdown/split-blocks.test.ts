import { describe, expect, it } from "vitest";
import { MIN_SPLIT_LENGTH, splitMarkdownBlocks } from "./split-blocks";

const pad = "word ".repeat(Math.ceil(MIN_SPLIT_LENGTH / 5));

describe("splitMarkdownBlocks", () => {
  it("leaves short content as one chunk", () => {
    expect(splitMarkdownBlocks("# a\n\ntext\n\n# b")).toEqual(["# a\n\ntext\n\n# b"]);
  });

  it("splits before a heading that follows a blank line and round-trips", () => {
    const md = `# One\n\n${pad}\n\n## Two\n\n- a\n- b\n\n## Three\n\nend`;
    const chunks = splitMarkdownBlocks(md);
    expect(chunks.length).toBe(3);
    expect(chunks[1].startsWith("## Two")).toBe(true);
    expect(chunks.join("\n")).toBe(md);
  });

  it("does not split on a heading-like line inside a code fence", () => {
    const md = `${pad}\n\n\`\`\`md\n\n# not a heading\n\n\`\`\`\n\nafter`;
    expect(splitMarkdownBlocks(md)).toHaveLength(1);
  });

  it("does not split on a heading without a preceding blank line", () => {
    const md = `${pad}\n# glued`;
    expect(splitMarkdownBlocks(md)).toHaveLength(1);
  });

  it("disables splitting when a reference definition, footnote, HTML comment or raw HTML block exists", () => {
    for (const extra of ["[x]: https://a.b", "[x]:https://a.b", "note[^1]", "<details>\n</details>", "<!--\n\n# hidden\n\n-->"]) {
      const md = `# A\n\n${pad}\n\n${extra}\n\n## B\n\ntext`;
      expect(splitMarkdownBlocks(md)).toHaveLength(1);
    }
  });

  it("keeps a still-open fence together to the end", () => {
    const md = `# A\n\n${pad}\n\n\`\`\`ts\n\n# inside\n\nmore`;
    expect(splitMarkdownBlocks(md)).toHaveLength(1);
  });
});
