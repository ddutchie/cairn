import { describe, expect, it } from "vitest";
import { calloutsToAlerts, colorLiteralsToLinks, contrastText, findColorLiterals, parseColor, escapeSpoilers, inlineEmbedsToText, markDeadWikilinks, splitSegments } from "./native-markdown";

describe("calloutsToAlerts", () => {
  it("maps Obsidian types to GitHub alerts and keeps the title", () => {
    expect(calloutsToAlerts("> [!warning] Careful\n> body")).toBe("> [!WARNING]\n> **Careful**\n>\n> body");
  });
  it("names a non-GitHub type when there is no title", () => {
    expect(calloutsToAlerts("> [!question]\n> why")).toBe("> [!NOTE]\n> **Question**\n>\n> why");
  });
  it("leaves a plain GitHub alert alone and drops the fold marker", () => {
    expect(calloutsToAlerts("> [!NOTE]\n> hi")).toBe("> [!NOTE]\n> hi");
    expect(calloutsToAlerts("> [!tip]- Fold\n> hi")).toContain("[!TIP]");
  });
  it("ignores callouts inside code fences", () => {
    const src = "```\n> [!note] x\n```";
    expect(calloutsToAlerts(src)).toBe(src);
  });
});

describe("escapeSpoilers", () => {
  it("escapes || in prose but not in code or tables", () => {
    expect(escapeSpoilers("a || b")).toBe("a \\|\\| b");
    expect(escapeSpoilers("run `a || b` now")).toBe("run `a || b` now");
    expect(escapeSpoilers("| a || b |")).toBe("| a || b |");
    expect(escapeSpoilers("```\na || b\n```")).toBe("```\na || b\n```");
  });
});

describe("splitSegments", () => {
  it("pulls out closed mermaid fences and standalone image embeds", () => {
    const src = "intro\n```mermaid\ngraph TD;\n```\n![a.png](cairn://embed/a.png)\noutro";
    expect(splitSegments(src)).toEqual([
      { kind: "markdown", text: "intro" },
      { kind: "mermaid", code: "graph TD;" },
      { kind: "image", name: "a.png" },
      { kind: "markdown", text: "outro" },
    ]);
  });
  it("keeps an unclosed mermaid fence in the markdown", () => {
    const src = "```mermaid\ngraph TD;";
    expect(splitSegments(src)).toEqual([{ kind: "markdown", text: src }]);
  });
  it("decodes the embed name", () => {
    expect(splitSegments("![x](cairn://embed/my%20pic.png)")).toEqual([{ kind: "image", name: "my pic.png" }]);
  });
});

describe("inline embeds and dead links", () => {
  it("turns an inline embed into text", () => {
    expect(inlineEmbedsToText("see ![a.png](cairn://embed/a.png) here")).toBe("see _(image: a.png)_ here");
  });
  it("re-points unresolved wikilinks", () => {
    const src = "[Gone](cairn://note/Gone) and [Ok](cairn://note/n1)";
    expect(markDeadWikilinks(src, new Set(["Gone"]))).toBe("[Gone](cairn://dead/Gone) and [Ok](cairn://note/n1)");
  });
});

describe("colour literals", () => {
  it("finds colours written as inline code only", () => {
    const src = "use `#ff0000` and `rgb(0, 128, 255)`, not `npm i` or #00ff00 bare\n```\n`#123456`\n```";
    expect(findColorLiterals(src)).toEqual(["#ff0000", "rgb(0, 128, 255)"]);
  });
  it("turns colour inline code into colour links", () => {
    expect(colorLiteralsToLinks("a `#f00` b `npm i`")).toBe("a [#f00](cairn://color/%23f00) b `npm i`");
    expect(colorLiteralsToLinks("```\n`#f00`\n```")).toBe("```\n`#f00`\n```");
  });
  it("parses hex, rgb and hsl", () => {
    expect(parseColor("#f00")).toEqual([255, 0, 0]);
    expect(parseColor("#00ff0080")).toEqual([0, 255, 0]);
    expect(parseColor("rgb(0, 128, 255)")).toEqual([0, 128, 255]);
    expect(parseColor("hsl(120, 100%, 50%)")).toEqual([0, 255, 0]);
    expect(parseColor("nope")).toBeNull();
  });
  it("picks a readable text colour", () => {
    expect(contrastText("#ffffff")).toBe("#000000");
    expect(contrastText("#102030")).toBe("#ffffff");
  });
});
