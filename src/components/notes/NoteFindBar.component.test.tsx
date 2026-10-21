import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NoteFindBar } from "./NoteFindBar";
import { noteFindExtension } from "./note-find-extension";

let view: EditorView | null = null;
afterEach(() => { cleanup(); view?.destroy(); view = null; });

function setup(doc: string, initialQuery = "") {
  view = new EditorView({ state: EditorState.create({ doc, extensions: [noteFindExtension] }), parent: document.body });
  const onClose = vi.fn();
  const v = view;
  render(<TooltipProvider><NoteFindBar initialQuery={initialQuery} requestId={1} mode="edit" content={doc}
    getView={() => v} getReadRoot={() => null} onClose={onClose} /></TooltipProvider>);
  return { onClose, v };
}

describe("NoteFindBar (edit mode)", () => {
  it("shows the match count for a prefilled query and highlights in the editor", () => {
    const { v } = setup("one two one two one", "one");
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(v.dom.querySelectorAll(".cm-find-match")).toHaveLength(3);
  });

  it("Enter advances and wraps, Shift+Enter goes back", () => {
    setup("x x", "x");
    const input = screen.getByLabelText("Find in note");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2/2")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("2/2")).toBeTruthy();
  });

  it("reports no results and closes on Escape", () => {
    const { onClose } = setup("hello", "zzz");
    expect(screen.getByText("No results")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Find in note"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("whole-word toggle narrows matches", () => {
    setup("cat concat", "cat");
    expect(screen.getByText("1/2")).toBeTruthy();
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Whole word" })); });
    expect(screen.getByText("1/1")).toBeTruthy();
  });
});

describe("NoteFindBar (read mode)", () => {
  it("matches across inline elements", () => {
    Element.prototype.scrollIntoView = vi.fn(); // not implemented in jsdom
    const root = document.createElement("div");
    root.innerHTML = "<p>say hello <strong>world</strong> now</p>";
    document.body.appendChild(root);
    render(<TooltipProvider><NoteFindBar initialQuery="hello world" requestId={1} mode="read" content="x"
      getView={() => null} getReadRoot={() => root} onClose={() => {}} /></TooltipProvider>);
    expect(screen.getByText("1/1")).toBeTruthy();
    root.remove();
  });
});
