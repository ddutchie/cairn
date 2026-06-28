import { describe, it, expect } from "vitest";
import { toggleCheckboxInSource } from "./note-editor-utils";

describe("toggleCheckboxInSource — list-item checkboxes", () => {
  it("toggles an unchecked list item to checked", () => {
    expect(toggleCheckboxInSource("- [ ] task", 0)).toBe("- [x] task");
  });

  it("toggles a checked list item back to unchecked", () => {
    expect(toggleCheckboxInSource("- [x] task", 0)).toBe("- [ ] task");
  });

  it("treats uppercase [X] as checked → unchecks it", () => {
    expect(toggleCheckboxInSource("- [X] task", 0)).toBe("- [ ] task");
  });

  it("toggles the correct item by document-order index", () => {
    const src = "- [ ] a\n- [ ] b\n- [ ] c";
    expect(toggleCheckboxInSource(src, 1)).toBe("- [ ] a\n- [x] b\n- [ ] c");
  });

  it("supports *, + and ordered list markers", () => {
    expect(toggleCheckboxInSource("* [ ] a", 0)).toBe("* [x] a");
    expect(toggleCheckboxInSource("+ [ ] a", 0)).toBe("+ [x] a");
    expect(toggleCheckboxInSource("1. [ ] a", 0)).toBe("1. [x] a");
    expect(toggleCheckboxInSource("2) [ ] a", 0)).toBe("2) [x] a");
  });

  it("preserves indentation of nested items", () => {
    const src = "- [ ] parent\n  - [ ] child";
    expect(toggleCheckboxInSource(src, 1)).toBe("- [ ] parent\n  - [x] child");
  });

  it("toggles only the marker checkbox, not literal [x] text later on the line", () => {
    // The marker box must flip; the literal "[x]" inside the item text must not.
    const src = "- [ ] see the [x] in this text";
    expect(toggleCheckboxInSource(src, 0)).toBe("- [x] see the [x] in this text");
  });
});

describe("toggleCheckboxInSource — table-cell checkboxes", () => {
  const table = [
    "| Task | Done |",
    "| --- | --- |",
    "| Write tests | [ ] |",
    "| Ship it | [x] |",
  ].join("\n");

  it("toggles a checkbox inside a table body cell", () => {
    const out = toggleCheckboxInSource(table, 0);
    expect(out.split("\n")[2]).toBe("| Write tests | [x] |");
  });

  it("toggles the second table checkbox by index", () => {
    const out = toggleCheckboxInSource(table, 1);
    expect(out.split("\n")[3]).toBe("| Ship it | [ ] |");
  });

  it("handles multiple checkboxes in a single row in order", () => {
    const row = "| [ ] | [ ] | [ ] |";
    expect(toggleCheckboxInSource(row, 0)).toBe("| [x] | [ ] | [ ] |");
    expect(toggleCheckboxInSource(row, 2)).toBe("| [ ] | [ ] | [x] |");
  });

  it("does not treat the delimiter row as a checkbox", () => {
    const out = toggleCheckboxInSource(table, 0);
    expect(out.split("\n")[1]).toBe("| --- | --- |");
  });

  it("ignores non-cell-leading checkbox text when indexing cells", () => {
    // Only the cell-leading `[ ]` renders as a checkbox (mirrors
    // renderCellWithCheckboxes); the mid-cell literal "[ ]" must not consume an
    // index or be toggled.
    const row = "| [ ] | note [ ] here | [ ] |";
    // index 0 → first cell-leading box; index 1 → the THIRD cell's leading box
    // (the literal mid-text box in cell 2 is skipped entirely).
    expect(toggleCheckboxInSource(row, 0)).toBe("| [x] | note [ ] here | [ ] |");
    expect(toggleCheckboxInSource(row, 1)).toBe("| [ ] | note [ ] here | [x] |");
  });
});

describe("toggleCheckboxInSource — mixed lists and tables (document order)", () => {
  const mixed = [
    "- [ ] before-table",      // index 0
    "",
    "| x | y |",
    "| - | - |",
    "| [ ] | a |",             // index 1
    "",
    "- [ ] after-table",       // index 2
  ].join("\n");

  it("indexes a list item that precedes a table", () => {
    expect(toggleCheckboxInSource(mixed, 0).split("\n")[0]).toBe("- [x] before-table");
  });

  it("indexes a table checkbox between list items", () => {
    expect(toggleCheckboxInSource(mixed, 1).split("\n")[4]).toBe("| [x] | a |");
  });

  it("indexes a list item that follows a table", () => {
    expect(toggleCheckboxInSource(mixed, 2).split("\n")[6]).toBe("- [x] after-table");
  });
});

describe("toggleCheckboxInSource — boundaries", () => {
  it("returns source unchanged for out-of-range index", () => {
    const src = "- [ ] only";
    expect(toggleCheckboxInSource(src, 5)).toBe(src);
  });

  it("returns source unchanged for negative index", () => {
    const src = "- [ ] only";
    expect(toggleCheckboxInSource(src, -1)).toBe(src);
  });

  it("returns source unchanged when there are no checkboxes", () => {
    const src = "# heading\n\nplain text";
    expect(toggleCheckboxInSource(src, 0)).toBe(src);
  });

  it("only mutates the targeted checkbox, leaving others untouched", () => {
    const src = "- [x] a\n- [ ] b";
    expect(toggleCheckboxInSource(src, 0)).toBe("- [ ] a\n- [ ] b");
  });
});
