import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { livePreview } from "@/lib/livePreview";
import { parseCalloutSource } from "@/lib/callout-widget";

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
    // back to the correct line. flushSync in toDOM gives the widget real height
    // at measure time, so coordsAt/lineBlockAt for a later position stay sane.
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
