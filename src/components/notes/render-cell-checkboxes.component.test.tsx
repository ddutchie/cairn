/**
 * Tests for renderCellWithCheckboxes — the table-cell task-list recovery used by
 * the note preview, NoteMarkdownPreview, and chat renderers. GFM only parses
 * inline content inside table cells, so `[ ]`/`[x]` tokens crammed into a cell
 * (optionally dash-prefixed, space- or <br>-separated) arrive as plain text /
 * text+<br> children; this helper turns each token into a checkbox in
 * document order, preserving surrounding text and non-string children.
 *
 * Runs in the "component" project (jsdom) because it renders React to the DOM.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { renderCellWithCheckboxes } from "./note-markdown-components";

afterEach(cleanup);

function renderCell(children: React.ReactNode, onToggle?: (el: HTMLInputElement) => void) {
  return render(<table><tbody><tr><td>{renderCellWithCheckboxes(children, onToggle)}</td></tr></tbody></table>);
}

describe("renderCellWithCheckboxes", () => {
  it("renders a single leading checkbox", () => {
    const { container } = renderCell("[ ] done");
    const boxes = container.querySelectorAll("input[type='checkbox']");
    expect(boxes.length).toBe(1);
    expect((boxes[0] as HTMLInputElement).checked).toBe(false);
    expect(container.querySelector("td")?.textContent).toContain("done");
  });

  it("renders multiple dash-prefixed checkboxes in one text node (space-separated)", () => {
    const { container } = renderCell("- [ ] install - [x] configure");
    const boxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    expect(boxes.length).toBe(2);
    expect(boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(true);
    // The list-marker dashes are dropped; the labels remain.
    const text = container.querySelector("td")?.textContent ?? "";
    expect(text).toContain("install");
    expect(text).toContain("configure");
    expect(text).not.toContain("[ ]");
    expect(text).not.toContain("[x]");
  });

  it("recovers checkboxes across text nodes separated by <br> elements", () => {
    // Mirrors the remark-gfm shape for `- [ ] a<br>- [ ] b<br>- [x] c`.
    const children = [
      "- [ ] Create account",
      React.createElement("br", { key: "b1" }),
      "- [ ] Verify email",
      React.createElement("br", { key: "b2" }),
      "- [x] Set password",
    ];
    const { container } = renderCell(children);
    const boxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    expect(boxes.length).toBe(3);
    expect(Array.from(boxes).map((b) => b.checked)).toEqual([false, false, true]);
    // <br> elements are preserved between the items.
    expect(container.querySelectorAll("br").length).toBe(2);
  });

  it("renders read-only (non-interactive) checkboxes when no onToggle is given", () => {
    const { container } = renderCell("[x] done");
    const box = container.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    expect(box.readOnly).toBe(true);
  });

  it("wires onToggle for interactive checkboxes", () => {
    const onToggle = vi.fn();
    const { container } = renderCell("[ ] a - [x] b", onToggle);
    const boxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    fireEvent.click(boxes[1]);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle.mock.calls[0][0]).toBe(boxes[1]);
  });

  it("leaves a cell with no checkbox tokens untouched", () => {
    const { container } = renderCell("just some text");
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(container.querySelector("td")?.textContent).toBe("just some text");
  });

  it("does not treat a bracket fused to a word as a checkbox", () => {
    // No boundary before `[` → not a checkbox (mirrors CELL_CHECKBOX_RE).
    const { container } = renderCell("array[x] index");
    expect(container.querySelectorAll("input").length).toBe(0);
  });
});
