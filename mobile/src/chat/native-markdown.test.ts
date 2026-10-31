import { describe, expect, it } from "vitest";
import { calloutsToAlerts, colorLiteralsToLinks, findColorLiterals, escapeSpoilers, inlineEmbedsToText, markDeadWikilinks, splitSegments } from "./native-markdown";

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
  it("finds colours in code and prose, but not in fences", () => {
    const src = "use `#ff0000` and `rgb(0, 128, 255)`, not `npm i` or #00ff00 bare\n```\n`#123456`\n```";
    expect(findColorLiterals(src)).toEqual(["#ff0000", "rgb(0, 128, 255)", "#00ff00"]);
  });
  it("turns colour inline code into colour links", () => {
    expect(colorLiteralsToLinks("a `#f00` b `npm i`")).toBe("a [\u00A0\u00A0\u00A0\u00A0](cairn://swatch/%23f00) `#f00` b `npm i`");
    expect(colorLiteralsToLinks("```\n`#f00`\n```")).toBe("```\n`#f00`\n```");
  });
  it("also chips bare 6/8-digit hex and rgb() in prose, but not #123 or URL fragments", () => {
    expect(colorLiteralsToLinks("| Tag | #6366f1 |")).toBe("| Tag | [\u00A0\u00A0\u00A0\u00A0](cairn://swatch/%236366f1) `#6366f1` |");
    expect(colorLiteralsToLinks("blue is rgb(0, 128, 255).")).toBe("blue is [\u00A0\u00A0\u00A0\u00A0](cairn://swatch/rgb(0%2C%20128%2C%20255)) `rgb(0, 128, 255)`."  );
    expect(colorLiteralsToLinks("fixes #123 see https://x.io/#ff0000")).toBe("fixes #123 see https://x.io/#ff0000");
  });
});
