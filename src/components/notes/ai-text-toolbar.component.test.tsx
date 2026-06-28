/**
 * Tests for the note editor's text-formatting + AI-prompt logic
 * (ai-text-toolbar.tsx).
 *
 *  - buildAIActionPrompt: pure prompt builder; guards prompt drift and the
 *    custom-action branch.
 *  - applyFormat: the wrap/unwrap + line-prefix toggle logic, driven through a
 *    real headless CodeMirror EditorView. This has a huge branch surface and
 *    "toggle on then off" idempotency is exactly where edits regress.
 *
 * Runs in the "component" project (jsdom) because EditorView needs a DOM and
 * the module imports React UI.
 */

import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildAIActionPrompt, applyFormat, type FormatAction } from "./ai-text-toolbar";

// ── buildAIActionPrompt ───────────────────────────────────────────────────────
describe("buildAIActionPrompt", () => {
  it("embeds the selected text and an action-specific instruction", () => {
    const p = buildAIActionPrompt("summarize", "Hello world");
    expect(p).toContain('"Hello world"');
    expect(p).toContain("Summarize this text concisely");
    expect(p).toContain("Return only the summary");
  });

  it("uses the custom prompt for the custom action", () => {
    const p = buildAIActionPrompt("custom", "selected", "Translate to French");
    expect(p).toContain("Translate to French");
    expect(p).toContain("Return only the resulting text");
  });

  it("produces a distinct instruction per action", () => {
    const actions = ["rephrase", "summarize", "expand", "fix_grammar", "change_tone"] as const;
    const tails = actions.map((a) => buildAIActionPrompt(a, "x").split("highlighted text")[0]);
    // Each prompt should differ (no two actions collapse to the same text).
    expect(new Set(tails).size).toBe(actions.length);
  });
});

// ── applyFormat ───────────────────────────────────────────────────────────────
describe("applyFormat", () => {
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
  });

  /** Build a headless EditorView with the given doc and selection range. */
  function mk(doc: string, from: number, to: number): EditorView {
    const state = EditorState.create({ doc, selection: { anchor: from, head: to } });
    view = new EditorView({ state, parent: document.body });
    return view;
  }

  const docText = (v: EditorView) => v.state.doc.toString();

  it("wraps a selection in bold markers", () => {
    const v = mk("hello", 0, 5);
    applyFormat(v, "bold");
    expect(docText(v)).toBe("**hello**");
  });

  it("unwraps an already-bold selection (toggle off)", () => {
    const v = mk("**hello**", 0, 9);
    applyFormat(v, "bold");
    expect(docText(v)).toBe("hello");
  });

  it("is idempotent: wrap then unwrap restores the original", () => {
    const v = mk("text", 0, 4);
    const first = applyFormat(v, "italic");
    // Re-select the wrapped range and toggle again.
    v.dispatch({ selection: { anchor: first!.from, head: first!.to } });
    applyFormat(v, "italic");
    expect(docText(v)).toBe("text");
  });

  it("inserts a placeholder when wrapping an empty selection", () => {
    const v = mk("", 0, 0);
    applyFormat(v, "bold");
    expect(docText(v)).toBe("**bold text**");
  });

  it("wraps a selection as a link with a url placeholder", () => {
    const v = mk("Cairn", 0, 5);
    applyFormat(v, "link");
    expect(docText(v)).toBe("[Cairn](url)");
  });

  it("unwraps an existing markdown link back to its text", () => {
    const v = mk("[Cairn](https://x.com)", 0, 22);
    applyFormat(v, "link");
    expect(docText(v)).toBe("Cairn");
  });

  it("toggles a bullet-list line prefix", () => {
    const v = mk("item", 0, 4);
    applyFormat(v, "bullet");
    expect(docText(v)).toBe("- item");
    // toggle off
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    applyFormat(v, "bullet");
    expect(docText(v)).toBe("item");
  });

  it("toggles a heading prefix", () => {
    const v = mk("Title", 0, 5);
    applyFormat(v, "h2");
    expect(docText(v)).toBe("## Title");
  });

  it("returns a range for inline formatting (used to re-select)", () => {
    const v = mk("x", 0, 1);
    const r = applyFormat(v, "bold");
    expect(r).not.toBeNull();
    expect(r!.to).toBeGreaterThan(r!.from);
  });
});

// keep the FormatAction type referenced so an unused-import lint never trips
const _action: FormatAction = "bold";
void _action;
