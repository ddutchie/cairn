import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { livePreview, foldedBlockFromCursor } from "@/lib/livePreview";
import { parseCalloutSource } from "@/lib/callout-widget";
import { parseFencedCode } from "@/lib/code-block-widget";
import { isTableSource } from "@/lib/table-block-widget";

/**
 * Live Preview decoration tests. The main risk in mixing replace + mark + line
 * decorations is a RangeSet ordering throw at construction/measure time, so
 * these tests build a real EditorView in jsdom and assert it renders without
 * error and produces the expected inline classes.
 */
function mount(doc: string, cursor = 0): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const anchor = Math.min(cursor, doc.length);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage }), livePreview()],
    }),
    parent,
  });
  view.dispatch({}); // force a measure pass
  return view;
}

describe("livePreview decorations", () => {
  it("renders a mixed document without a RangeSet ordering error", () => {
    const doc = [
      "# Heading",
      "",
      "Some **bold** and ==highlighted== text with a [[Wikilink]].",
      "",
      "> a blockquote line",
      "> second quote line",
      "",
      "- bullet one",
      "",
      "A [real link](https://example.com) here.",
    ].join("\n");
    // Cursor on line 1; everything else is "inactive" so markers hide.
    const view = mount(doc, 2);
    expect(view.dom).toBeTruthy();
    view.destroy();
  });

  it("hides the '#' marker on inactive heading lines", () => {
    // Cursor at end (line 3), so the heading on line 1 is inactive.
    const view = mount("# Title\n\nbody text here", 12);
    const firstLine = view.contentDOM.querySelector(".cm-line");
    // The rendered text should not include the leading "# " once hidden.
    expect(firstLine?.textContent).toBe("Title");
    view.destroy();
  });

  it("applies the highlight mark class to ==text==", () => {
    const view = mount("plain ==marked== plain", 100);
    const mark = view.contentDOM.querySelector(".cm-lp-highlight");
    expect(mark).toBeTruthy();
    expect(mark?.textContent).toBe("marked");
    view.destroy();
  });

  it("applies the wikilink chip class to [[Title]]", () => {
    const view = mount("see [[My Note]] here", 100);
    const chip = view.contentDOM.querySelector(".cm-lp-wikilink");
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toBe("My Note");
    view.destroy();
  });

  it("applies the blockquote line class to each quote line", () => {
    const view = mount("> line one\n> line two", 100);
    const quoted = view.contentDOM.querySelectorAll(".cm-lp-blockquote");
    expect(quoted.length).toBe(2);
    view.destroy();
  });

  it("reveals markers on the active line", () => {
    // Cursor inside the highlight on line 1 → markers should NOT be hidden.
    const view = mount("==marked== text", 3);
    const firstLine = view.contentDOM.querySelector(".cm-line");
    // The raw "==" should still be present in the text on the active line.
    expect(firstLine?.textContent).toContain("==marked==");
    view.destroy();
  });

  it("renders a callout widget when the cursor is outside the block", () => {
    const doc = "intro line\n\n> [!note] Heads up\n> body text here\n\nafter";
    // Cursor on line 1, well outside the callout → it should render as a widget.
    const view = mount(doc, 0);
    const widget = view.contentDOM.querySelector(".cm-lp-callout");
    expect(widget).toBeTruthy();
    view.destroy();
  });

  it("shows raw source (no widget) when the cursor is inside the callout", () => {
    const doc = "intro line\n\n> [!note] Heads up\n> body text here\n\nafter";
    // Place the cursor inside the callout's directive line so it unfolds to the
    // editable `>` source instead of the widget.
    const cursor = doc.indexOf("Heads up");
    const view = mount(doc, cursor);
    expect(view.contentDOM.querySelector(".cm-lp-callout")).toBeNull();
    // The raw markers are visible for editing on the active block.
    expect(view.contentDOM.textContent).toContain("[!note]");
    view.destroy();
  });

  it("keeps document positions after a callout addressable (cursor-drift guard)", () => {
    // The regression this whole card exists for: a callout widget must not
    // desync the lines below it, so a position AFTER the callout must still map
    // back to the correct line. estimatedHeight=-1 + the ResizeObserver keep the
    // widget's measured height honest, so lineBlockAt for a later position stays sane.
    const doc = "intro\n\n> [!note] Title\n> body\n\ntarget line after callout";
    const view = mount(doc, 0);
    expect(view.contentDOM.querySelector(".cm-lp-callout")).toBeTruthy();

    const pos = doc.indexOf("target line after callout");
    const line = view.state.doc.lineAt(pos);
    // The line the widget-relative geometry resolves to for this position must
    // be the same line the document model reports — i.e. no off-by-N drift.
    const block = view.lineBlockAt(pos);
    expect(view.state.doc.lineAt(block.from).number).toBe(line.number);
    view.destroy();
  });

  it("observes the callout widget for later height changes and stops on destroy", () => {
    // The widget renders async and its height keeps shifting (markdown/image
    // resolution, font load, collapsible toggle), which is what desyncs the
    // cursor. A ResizeObserver must watch the widget so
    // CM re-measures once the content settles — and disconnect on teardown.
    const observed: Element[] = [];
    let disconnects = 0;
    const RealRO = globalThis.ResizeObserver;
    class SpyRO {
      observe(el: Element) { observed.push(el); }
      unobserve() {}
      disconnect() { disconnects += 1; }
    }
    globalThis.ResizeObserver = SpyRO as unknown as typeof ResizeObserver;
    try {
      const doc = "intro\n\n> [!note] Title\n> body\n\nafter";
      const view = mount(doc, 0);
      const widget = view.contentDOM.querySelector(".cm-lp-callout");
      expect(widget).toBeTruthy();
      // The rendered widget container is being observed for resize.
      expect(observed).toContain(widget);
      view.destroy();
      expect(disconnects).toBeGreaterThan(0);
    } finally {
      globalThis.ResizeObserver = RealRO;
    }
  });

  it("detects a folded callout the cursor would skip when moving down/up", () => {
    // A block widget is atomic, so CM's default ArrowDown skips the whole
    // callout and it never unfolds. foldedBlockFromCursor is the decision that
    // redirects the move into the callout's first line instead. Callouts sit
    // between blank lines (a blockquote needs a blank line to terminate), so the
    // adjacent line is the blank line directly above/below the widget.
    const doc = "intro\n\n> [!note] Title\n> body\n\nafter";
    const view = mount(doc, 0);
    const block = view.state.doc.lineAt(doc.indexOf("> [!note]")).number; // 3
    const blankAbove = block - 1; // line 2
    const blankBelow = view.state.doc.lineAt(doc.indexOf("after")).number - 1; // line 5

    // Cursor on the blank line directly above → ArrowDown enters the callout.
    view.dispatch({ selection: { anchor: view.state.doc.line(blankAbove).from } });
    expect(foldedBlockFromCursor(view.state, 1)?.lineStart).toBe(block);

    // Cursor on the blank line directly below → ArrowUp enters the callout.
    view.dispatch({ selection: { anchor: view.state.doc.line(blankBelow).from } });
    expect(foldedBlockFromCursor(view.state, -1)?.lineStart).toBe(block);
    view.destroy();
  });

  it("does not redirect when the cursor is already inside (unfolded) callout or none is adjacent", () => {
    const doc = "intro\n\n> [!note] Title\n> body\n\nafter";
    // Cursor inside the callout source → it's unfolded, so no redirect.
    const inside = mount(doc, doc.indexOf("Title"));
    expect(foldedBlockFromCursor(inside.state, 1)).toBeNull();
    expect(foldedBlockFromCursor(inside.state, -1)).toBeNull();
    inside.destroy();

    // A plain document with no callout adjacent to the cursor.
    const plain = mount("line one\nline two\nline three", 0);
    expect(foldedBlockFromCursor(plain.state, 1)).toBeNull();
    plain.destroy();
  });

  it("renders a code-block widget when the cursor is outside the fence", () => {
    const doc = "text\n\n```js\nconst x = 1;\n```\n\nafter";
    const view = mount(doc, 0); // cursor on line 1, outside the fence
    expect(view.contentDOM.querySelector(".cm-lp-codeblock")).toBeTruthy();
    view.destroy();
  });

  it("shows raw source (no code widget) when the cursor is inside the fence", () => {
    const doc = "text\n\n```js\nconst x = 1;\n```\n\nafter";
    const view = mount(doc, doc.indexOf("const x")); // cursor inside the code
    expect(view.contentDOM.querySelector(".cm-lp-codeblock")).toBeNull();
    expect(view.contentDOM.textContent).toContain("const x = 1;");
    view.destroy();
  });

  it("arrow-navigates into a folded code block from the adjacent line", () => {
    const doc = "text\n\n```js\nconst x = 1;\n```\n\nafter";
    const view = mount(doc, 0);
    const fenceLine = view.state.doc.lineAt(doc.indexOf("```js")).number;
    // Cursor on the blank line directly above the fence → ArrowDown enters it.
    view.dispatch({ selection: { anchor: view.state.doc.line(fenceLine - 1).from } });
    expect(foldedBlockFromCursor(view.state, 1)?.lineStart).toBe(fenceLine);
    view.destroy();
  });

  it("renders a table widget when the cursor is outside it", () => {
    const doc = "intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter";
    const view = mount(doc, 0);
    expect(view.contentDOM.querySelector(".cm-lp-tableblock")).toBeTruthy();
    // Cursor inside → raw pipe source, no widget.
    view.dispatch({ selection: { anchor: doc.indexOf("| 1 | 2 |") } });
    expect(view.contentDOM.querySelector(".cm-lp-tableblock")).toBeNull();
    expect(view.contentDOM.textContent).toContain("| 1 | 2 |");
    view.destroy();
  });

  it("renders a math widget for a $$ block when the cursor is outside it", () => {
    const doc = "intro\n\n$$\nx = y^2\n$$\n\nafter";
    const view = mount(doc, 0);
    expect(view.contentDOM.querySelector(".cm-lp-mathblock")).toBeTruthy();
    view.dispatch({ selection: { anchor: doc.indexOf("x = y^2") } });
    expect(view.contentDOM.querySelector(".cm-lp-mathblock")).toBeNull();
    view.destroy();
  });

  it("renders a mermaid fence as a code widget (diagram), not lingering raw", () => {
    const doc = "intro\n\n```mermaid\ngraph TD\nA-->B\n```\n\nafter";
    const view = mount(doc, 0);
    // Mermaid renders through the code widget container.
    expect(view.contentDOM.querySelector(".cm-lp-codeblock")).toBeTruthy();
    view.destroy();
  });

  it("does not let a callout with no trailing blank line swallow the next paragraph", () => {
    // The blockquote node can over-extend into the following paragraph when
    // there's no blank line; the widget range must stop at the `>` lines so
    // "after" stays editable text below the callout.
    const doc = "> [!note] Title\n> body\nafter paragraph";
    const view = mount(doc, doc.indexOf("after paragraph") + 2); // cursor in the paragraph
    // The callout is folded (cursor outside it) …
    expect(view.contentDOM.querySelector(".cm-lp-callout")).toBeTruthy();
    // … but the paragraph after it is NOT part of the widget — its text shows.
    expect(view.contentDOM.textContent).toContain("after paragraph");
    view.destroy();
  });
});

describe("parseCalloutSource", () => {
  it("parses type, title and body from a callout block", () => {
    const raw = "> [!warning] Be careful\n> line one\n> line two";
    const data = parseCalloutSource(raw);
    expect(data).not.toBeNull();
    expect(data?.type).toBe("warning");
    expect(data?.title).toBe("Be careful");
    expect(data?.body).toBe("line one\nline two");
  });

  it("detects collapsible modifiers", () => {
    expect(parseCalloutSource("> [!tip]- Closed")?.collapsible).toBe(true);
    expect(parseCalloutSource("> [!tip]- Closed")?.defaultOpen).toBe(false);
    expect(parseCalloutSource("> [!tip]+ Open")?.defaultOpen).toBe(true);
  });

  it("returns null for an ordinary blockquote", () => {
    expect(parseCalloutSource("> just a quote\n> more")).toBeNull();
  });
});

describe("parseFencedCode", () => {
  it("parses language and code from a closed fence", () => {
    const data = parseFencedCode("```js\nconst x = 1;\nconst y = 2;\n```");
    expect(data).not.toBeNull();
    expect(data?.language).toBe("js");
    expect(data?.code).toBe("const x = 1;\nconst y = 2;");
  });

  it("handles a fence with no language", () => {
    expect(parseFencedCode("```\nplain\n```")).toEqual({ language: "", code: "plain" });
  });

  it("takes only the first info-string token as the language", () => {
    expect(parseFencedCode("```ts title=foo\ncode\n```")?.language).toBe("ts");
  });

  it("supports ~~~ fences", () => {
    expect(parseFencedCode("~~~python\nprint(1)\n~~~")).toEqual({ language: "python", code: "print(1)" });
  });

  it("renders an unclosed fence that already has body (block being typed)", () => {
    expect(parseFencedCode("```js\nconst x = 1;")).toEqual({ language: "js", code: "const x = 1;" });
  });

  it("returns null for a bare opening fence with no body or close yet", () => {
    expect(parseFencedCode("```js")).toBeNull();
  });

  it("returns null for non-fence input", () => {
    expect(parseFencedCode("not a fence")).toBeNull();
  });
});

describe("isTableSource", () => {
  it("accepts a well-formed GFM table (header + delimiter row)", () => {
    expect(isTableSource("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
    expect(isTableSource("| a | b |\n| :-- | --: |")).toBe(true);
  });

  it("rejects prose with a stray pipe and single-line input", () => {
    expect(isTableSource("a | b just prose")).toBe(false);
    expect(isTableSource("| only one row |")).toBe(false);
    expect(isTableSource("| a | b |\nno delimiter here")).toBe(false);
  });
});
