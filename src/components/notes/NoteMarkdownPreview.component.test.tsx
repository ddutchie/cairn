import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { NoteMarkdownPreview } from "./NoteMarkdownPreview";

/**
 * Regression: GFM task-list checkboxes rendered by NoteMarkdownPreview must be
 * STABLE controlled read-only inputs. Raw GFM emits <input type="checkbox">
 * with `checked` present only when checked, so re-rendering with changed
 * content (e.g. the editor's live preview updating as you drag-select across
 * checkboxes) flipped React from uncontrolled → controlled and warned. The
 * `input` component override fixes this.
 */
describe("NoteMarkdownPreview — task-list checkboxes", () => {
  afterEach(cleanup);

  it("renders task-list items as read-only, controlled checkboxes", () => {
    const { container } = render(
      <NoteMarkdownPreview content={"- [ ] todo\n- [x] done"} />,
    );
    const boxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    expect(boxes.length).toBe(2);
    expect(boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(true);
    // Read-only + disabled → controlled without an onChange handler is legal.
    for (const b of boxes) {
      expect(b.readOnly || b.disabled).toBe(true);
    }
  });

  it("does not warn about uncontrolled→controlled when content changes", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(<NoteMarkdownPreview content={"- [ ] a"} />);
    // Change content (mirrors the live preview updating) — an unchecked box
    // becoming checked must not flip the input's controlled-ness.
    rerender(<NoteMarkdownPreview content={"- [x] a"} />);
    rerender(<NoteMarkdownPreview content={"- [ ] a\n- [x] b"} />);
    const controlledWarning = errSpy.mock.calls.some((args) =>
      String(args[0]).includes("changing an uncontrolled input to be controlled"),
    );
    expect(controlledWarning).toBe(false);
    errSpy.mockRestore();
  });

  it("inline mode drops the full-pane chrome (padding / h-full / overflow)", () => {
    // Embedded inside a callout body or block widget, the preview must sit
    // compactly — not carry the standalone pane's px-6 py-5 h-full overflow,
    // which was inflating callout/table widgets and making them look different
    // from read mode.
    const { container: pane } = render(<NoteMarkdownPreview content={"hi"} />);
    const { container: inline } = render(<NoteMarkdownPreview content={"hi"} inline />);
    const paneRoot = pane.querySelector(".prose-cairn") as HTMLElement;
    const inlineRoot = inline.querySelector(".prose-cairn") as HTMLElement;
    expect(paneRoot.className).toContain("h-full");
    expect(paneRoot.className).toContain("px-6");
    expect(inlineRoot.className).not.toContain("h-full");
    expect(inlineRoot.className).not.toContain("px-6");
    expect(inlineRoot.className).not.toContain("overflow-y-auto");
    // Inline zeroes the first/last child margins so the block (e.g. a table
    // wrapper's my-3) hugs the top of its host — no empty space above it.
    expect(inlineRoot.className).toContain("[&>*:first-child]:mt-0");
  });
});
