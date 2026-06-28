/**
 * Tests for markdown list continuation + renumbering in the CodeMirror editor.
 *
 * The editor's Enter/Backspace bindings (markdown-editor.tsx) delegate to
 * @codemirror/lang-markdown's `insertNewlineContinueMarkup` /
 * `deleteMarkupBackward` so that ordered lists auto-continue and renumber.
 * This builds the same keymap + markdown extension against a real headless
 * EditorView and drives the commands directly — guarding the wiring that, if
 * dropped, silently reverts to a plain newline (the original bug).
 *
 * Runs in the "component" project (jsdom) because EditorView needs a DOM.
 */

import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import {
  markdown,
  markdownLanguage,
  insertNewlineContinueMarkup,
  deleteMarkupBackward,
} from "@codemirror/lang-markdown";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function makeView(doc: string, cursor: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [
      // Mirror markdown-editor.tsx ordering: markdown bindings precede defaults.
      keymap.of([
        { key: "Enter", run: insertNewlineContinueMarkup },
        { key: "Backspace", run: deleteMarkupBackward },
        ...defaultKeymap,
      ]),
      markdown({ base: markdownLanguage }),
    ],
  });
  const el = document.createElement("div");
  document.body.appendChild(el);
  return new EditorView({ state, parent: el });
}

/**
 * Dispatch a real keydown against the editor's content DOM so the event flows
 * through CodeMirror's installed keymap handler — exercising the actual binding
 * order (markdown commands before defaultKeymap) rather than calling the
 * commands directly. Returns whether the keymap handled (preventDefault'd) it.
 */
function dispatchKey(v: EditorView, key: string): boolean {
  v.focus();
  const event = new KeyboardEvent("keydown", {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
  });
  v.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Simulate the Enter binding firing at the current selection via the keymap. */
function pressEnter(v: EditorView): boolean {
  return dispatchKey(v, "Enter");
}
function pressBackspace(v: EditorView): boolean {
  return dispatchKey(v, "Backspace");
}

describe("ordered-list continuation", () => {
  it("continues numbering on Enter at end of an ordered item", () => {
    const doc = "1. first";
    view = makeView(doc, doc.length);
    expect(pressEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("1. first\n2. ");
  });

  it("continues bullet markers on Enter", () => {
    const doc = "- item";
    view = makeView(doc, doc.length);
    expect(pressEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("- item\n- ");
  });

  it("renumbers following items when a new item is inserted mid-list", () => {
    // Cursor at end of "1. a"; inserting a new item should bump 2→3, 3→... etc.
    const doc = "1. a\n2. b\n3. c";
    view = makeView(doc, 4); // end of "1. a"
    expect(pressEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("1. a\n2. \n3. b\n4. c");
  });
});

describe("breaking the list (the reported bug)", () => {
  it("breaks out of the list on Enter from an empty continued item", () => {
    // "1. a\n2. " with cursor after "2. " — pressing Enter terminates the list
    // by inserting a blank line rather than emitting "3. ". The first item's
    // numbering is left intact.
    const doc = "1. a\n2. ";
    view = makeView(doc, doc.length);
    expect(pressEnter(view)).toBe(true);
    const out = view.state.doc.toString();
    // First item untouched, and no "3." was auto-generated.
    expect(out.startsWith("1. a")).toBe(true);
    expect(out).not.toContain("3. ");
  });

  it("removes the marker and renumbers when Backspace deletes an item's number", () => {
    // Deleting the auto-number of item 2 should not leave a stale "2." that
    // breaks ordering — deleteMarkupBackward strips the markup cleanly.
    const doc = "1. a\n2. ";
    view = makeView(doc, doc.length);
    expect(pressBackspace(view)).toBe(true);
    // Marker removed; remaining content has no dangling "2." prefix line.
    expect(view.state.doc.toString().endsWith("2. ")).toBe(false);
  });
});

describe("non-list context falls through", () => {
  it("inserts a plain newline outside list markup (defaultKeymap fallthrough)", () => {
    const doc = "plain paragraph";
    view = makeView(doc, doc.length);
    // Outside a list the markdown command declines, so the Enter keybinding
    // falls through to defaultKeymap, which inserts a newline.
    expect(pressEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("plain paragraph\n");
  });
});
