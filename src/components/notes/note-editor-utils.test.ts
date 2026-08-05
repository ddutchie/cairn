import { describe, it, expect } from "vitest";
import { toggleCheckboxInSource, diffChangedLines, extractStructuredBlockAtOffset, migrateEditorMode, initialLivePreviewOn } from "./note-editor-utils";

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

  it("indexes every whitespace-bounded checkbox in a cell, in order", () => {
    // Cells can hold a whole checklist, so mid-cell checkboxes DO render and DO
    // consume an index (mirrors renderCellWithCheckboxes). A `[ ]` fused to a
    // word (no boundary) is still ignored.
    const row = "| [ ] | note [ ] here | [ ] |";
    // index 0 → cell 1's box; index 1 → cell 2's box; index 2 → cell 3's box.
    expect(toggleCheckboxInSource(row, 0)).toBe("| [x] | note [ ] here | [ ] |");
    expect(toggleCheckboxInSource(row, 1)).toBe("| [ ] | note [x] here | [ ] |");
    expect(toggleCheckboxInSource(row, 2)).toBe("| [ ] | note [ ] here | [x] |");
  });

  it("handles multiple dash-prefixed checkboxes in one cell (space-separated)", () => {
    const row = "| Setup | - [ ] install - [x] configure |";
    expect(toggleCheckboxInSource(row, 0)).toBe("| Setup | - [x] install - [x] configure |");
    expect(toggleCheckboxInSource(row, 1)).toBe("| Setup | - [ ] install - [ ] configure |");
  });

  it("handles a <br>-separated checklist inside one cell", () => {
    const row = "| Onboarding | - [ ] Create account<br>- [ ] Verify email<br>- [x] Set password |";
    expect(toggleCheckboxInSource(row, 0)).toBe(
      "| Onboarding | - [x] Create account<br>- [ ] Verify email<br>- [x] Set password |",
    );
    expect(toggleCheckboxInSource(row, 2)).toBe(
      "| Onboarding | - [ ] Create account<br>- [ ] Verify email<br>- [ ] Set password |",
    );
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

describe("diffChangedLines", () => {
  it("returns [] when content is identical", () => {
    expect(diffChangedLines("a\nb\nc", "a\nb\nc")).toEqual([]);
  });

  it("marks every line as new when prev is empty", () => {
    expect(diffChangedLines("", "a\nb\nc")).toEqual([1, 2, 3]);
  });

  it("marks an appended line", () => {
    // "c" is added at line 3.
    expect(diffChangedLines("a\nb", "a\nb\nc")).toEqual([3]);
  });

  it("marks a modified line (1-indexed) and leaves unchanged lines alone", () => {
    // line 2 changed from "b" → "B".
    expect(diffChangedLines("a\nb\nc", "a\nB\nc")).toEqual([2]);
  });

  it("marks an inserted line in the middle", () => {
    // "x" inserted between a and b → new line 2.
    expect(diffChangedLines("a\nb", "a\nx\nb")).toEqual([2]);
  });

  it("does not mark lines that were only deleted", () => {
    // "b" removed; nothing added, so no new lines to highlight.
    expect(diffChangedLines("a\nb\nc", "a\nc")).toEqual([]);
  });

  it("handles a mix of insert + append", () => {
    // a, (insert x at 2), b, (append y at 4)
    expect(diffChangedLines("a\nb", "a\nx\nb\ny")).toEqual([2, 4]);
  });

  it("returns sorted, de-duplicated line numbers", () => {
    const out = diffChangedLines("a\nb\nc", "a\nB\nC\nD");
    expect(out).toEqual([...out].sort((x, y) => x - y));
    expect(new Set(out).size).toBe(out.length);
  });
});

describe("extractStructuredBlockAtOffset — live current-block preview", () => {
  // Cursor helper: offset of the first occurrence of `needle` in `doc`.
  const at = (doc: string, needle: string) => doc.indexOf(needle);

  it("returns the table when the cursor is inside one", () => {
    const doc = "intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter";
    const block = extractStructuredBlockAtOffset(doc, at(doc, "| 1 | 2 |"));
    expect(block?.kind).toBe("table");
    expect(block?.text).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("does not treat a lone pipe line (no separator row) as a table", () => {
    const doc = "a | b is just prose with a pipe";
    expect(extractStructuredBlockAtOffset(doc, 3)).toBeNull();
  });

  it("returns the callout when the cursor is inside a blockquote directive", () => {
    const doc = "text\n\n> [!note] Title\n> body line\n\nafter";
    const block = extractStructuredBlockAtOffset(doc, at(doc, "body line"));
    expect(block?.kind).toBe("callout");
    expect(block?.text).toBe("> [!note] Title\n> body line");
  });

  it("does not treat an ordinary blockquote as a callout", () => {
    const doc = "> just a quote\n> more";
    expect(extractStructuredBlockAtOffset(doc, 3)).toBeNull();
  });

  it("returns the fenced code block (incl. an unclosed one being typed)", () => {
    const closed = "```js\nconst x = 1;\n```\nafter";
    expect(extractStructuredBlockAtOffset(closed, at(closed, "const x"))?.kind).toBe("code");
    const open = "text\n```js\nconst x = 1;";
    const b = extractStructuredBlockAtOffset(open, at(open, "const x"));
    expect(b?.kind).toBe("code");
    expect(b?.text).toBe("```js\nconst x = 1;");
  });

  it("does not close a fence on a shorter same-char fence inside it (CommonMark)", () => {
    // A 4-backtick fence can CONTAIN a 3-backtick line; that inner line is
    // content, not a close. The block must run to the real 4-backtick close.
    const doc = "````md\n```\ninner\n```\n````\nafter";
    const b = extractStructuredBlockAtOffset(doc, at(doc, "inner"));
    expect(b?.kind).toBe("code");
    expect(b?.text).toBe("````md\n```\ninner\n```\n````");
  });

  it("returns a math block between $$ fences", () => {
    const doc = "text\n\n$$\nx = y^2\n$$\n\nafter";
    expect(extractStructuredBlockAtOffset(doc, at(doc, "x = y^2"))?.kind).toBe("math");
  });

  it("returns null for plain prose / headings / lists", () => {
    const doc = "# Heading\n\nJust a paragraph.\n\n- a list item";
    expect(extractStructuredBlockAtOffset(doc, at(doc, "paragraph"))).toBeNull();
    expect(extractStructuredBlockAtOffset(doc, at(doc, "Heading"))).toBeNull();
    expect(extractStructuredBlockAtOffset(doc, at(doc, "list item"))).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(extractStructuredBlockAtOffset("", 0)).toBeNull();
  });
});

describe("editor mode migration (Write/Raw/Read → Edit/Read + Live Preview)", () => {
  it("migrates legacy modes to edit/read", () => {
    expect(migrateEditorMode("write")).toBe("edit");
    expect(migrateEditorMode("raw")).toBe("edit");
    expect(migrateEditorMode("read")).toBe("read");
    expect(migrateEditorMode("edit")).toBe("edit");
    expect(migrateEditorMode(null)).toBe("edit");
    expect(migrateEditorMode(undefined)).toBe("edit");
  });

  it("initial Live Preview honours an explicit stored preference over everything", () => {
    expect(initialLivePreviewOn(true, "raw")).toBe(true);
    expect(initialLivePreviewOn(false, "write")).toBe(false);
  });

  it("with no stored preference, a legacy 'raw' mode starts Live Preview OFF", () => {
    // Regression: raw meant "edit with Live Preview off"; migrating must not
    // silently turn Live Preview back on for those users.
    expect(initialLivePreviewOn(null, "raw")).toBe(false);
    expect(initialLivePreviewOn(undefined, "raw")).toBe(false);
  });

  it("with no stored preference and a non-raw legacy mode, defaults ON", () => {
    expect(initialLivePreviewOn(null, "write")).toBe(true);
    expect(initialLivePreviewOn(null, "read")).toBe(true);
    expect(initialLivePreviewOn(null, null)).toBe(true);
    expect(initialLivePreviewOn(undefined, undefined)).toBe(true);
  });
});
