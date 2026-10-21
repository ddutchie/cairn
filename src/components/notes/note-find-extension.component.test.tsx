/**
 * In-note find (CodeMirror side): matches are located, the current one is
 * marked, navigation clamps/wraps via the bar, and clearing removes decorations.
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { noteFindExtension, setFind, getFindState } from "./note-find-extension";

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; });

function make(doc: string): EditorView {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [noteFindExtension] }),
    parent: document.body,
  });
  return view;
}

describe("noteFindExtension", () => {
  it("counts matches and marks the current one", () => {
    const v = make("Cat cat concat");
    const r = setFind(v, { query: "cat", opts: {}, current: 1 }, false);
    expect(r).toEqual({ count: 3, current: 1 });
    expect(v.dom.querySelectorAll(".cm-find-match")).toHaveLength(3);
    expect(v.dom.querySelectorAll(".cm-find-current")).toHaveLength(1);
  });

  it("clamps an out-of-range current index", () => {
    const v = make("a a");
    expect(setFind(v, { query: "a", opts: {}, current: 9 }, false).current).toBe(1);
  });

  it("recomputes when the document changes", () => {
    const v = make("foo");
    setFind(v, { query: "foo", opts: {}, current: 0 }, false);
    v.dispatch({ changes: { from: 3, insert: " foo" } });
    expect(getFindState(v).count).toBe(2);
  });

  it("clears on null", () => {
    const v = make("foo");
    setFind(v, { query: "foo", opts: {}, current: 0 }, false);
    setFind(v, null);
    expect(getFindState(v).count).toBe(0);
    expect(v.dom.querySelectorAll(".cm-find-match")).toHaveLength(0);
  });
});
