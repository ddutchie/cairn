import { describe, it, expect } from "vitest";
import { merge3 } from "./merge3";

const base = `#TODO

- [ ] Item 1
- [ ] Item 2`;

describe("merge3 — 3-way line merge", () => {
  // ── the headline case: two devices append different lines ──────────────────
  it("unions two non-overlapping appends (the checklist case)", () => {
    const ours = `${base}\n- [ ] Item 3 (desktop)`;
    const theirs = `${base}\n- [ ] Item 3 (mobile)`;
    const r = merge3(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.conflicts).toBe(0);
    expect(r.merged).toContain("Item 3 (desktop)");
    expect(r.merged).toContain("Item 3 (mobile)");
    expect(r.merged.match(/Item 1/g)?.length).toBe(1);
  });

  it("takes the changed side when only one side edited", () => {
    const ours = `${base}\n- [ ] Item 3`;
    const theirs = base; // mobile didn't change anything
    const r = merge3(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged).toContain("Item 3");
  });

  it("takes the change once when both made the identical edit", () => {
    const ours = `${base}\n- [ ] Same`;
    const theirs = `${base}\n- [ ] Same`;
    const r = merge3(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged.match(/Same/g)?.length).toBe(1);
  });

  it("preserves unchanged surrounding lines", () => {
    const ours = `${base}\n- [ ] Item 3`;
    const theirs = `${base}\n- [ ] Item 4`;
    const r = merge3(base, ours, theirs);
    expect(r.merged).toContain("#TODO");
    expect(r.merged).toContain("Item 1");
    expect(r.merged).toContain("Item 2");
  });

  // ── real conflicts (both changed the same region differently) ──────────────
  it("flags a conflict when both edited the SAME line differently", () => {
    const b = "Title\nshared line\nfooter";
    const ours = "Title\nMY version\nfooter";
    const theirs = "Title\nTHEIR version\nfooter";
    const r = merge3(b, ours, theirs);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toBe(1);
    // best-effort text keeps "ours" so nothing is blank, and never emits markers
    expect(r.merged).toContain("MY version");
    expect(r.merged).not.toContain("<<<<");
    expect(r.merged).not.toContain(">>>>");
  });

  it("flags edit-vs-delete of the same line as a conflict", () => {
    const b = "a\nb\nc";
    const ours = "a\nB\nc"; // we edited line b
    const theirs = "a\nc"; // they deleted line b
    const r = merge3(b, ours, theirs);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toBe(1);
    expect(r.merged).toBe("a\nB\nc"); // ours preserved best-effort
  });

  it("counts multiple independent conflicts", () => {
    const b = "l1\nl2\nl3\nl4\nl5";
    const ours = "l1\nAA\nl3\nBB\nl5"; // changed l2 and l4
    const theirs = "l1\nXX\nl3\nYY\nl5"; // changed l2 and l4 differently
    const r = merge3(b, ours, theirs);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toBe(2);
  });

  // ── deletions ──────────────────────────────────────────────────────────────
  it("applies a one-sided middle-line deletion", () => {
    const r = merge3("a\nb\nc", "a\nc", "a\nb\nc");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("a\nc");
  });

  it("applies the same deletion made on both sides once", () => {
    const r = merge3("a\nb\nc", "a\nc", "a\nc");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("a\nc");
  });

  it("keeps a one-sided deletion while accepting the other side's append", () => {
    // ours removes Item 1; theirs appends Item 3. Both changes should apply.
    const ours = `#TODO\n\n- [ ] Item 2`;
    const theirs = `${base}\n- [ ] Item 3`;
    const r = merge3(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged).not.toContain("Item 1");
    expect(r.merged).toContain("Item 2");
    expect(r.merged).toContain("Item 3");
  });

  // ── insertions at different positions ───────────────────────────────────────
  it("merges an insertion at the top on one side and the bottom on the other", () => {
    const r = merge3("mid", "top\nmid", "mid\nbottom");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("top\nmid\nbottom");
  });

  it("unions two different insertions in the same gap (ours then theirs)", () => {
    const r = merge3("a\nz", "a\nX\nz", "a\nY\nz");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("a\nX\nY\nz");
  });

  it("does not duplicate a line both sides inserted in the same gap", () => {
    const r = merge3("a\nz", "a\nSHARED\nz", "a\nSHARED\nz");
    expect(r.clean).toBe(true);
    expect(r.merged.match(/SHARED/g)?.length).toBe(1);
  });

  // ── whitespace / newline handling ───────────────────────────────────────────
  it("handles CRLF vs LF without spurious conflicts", () => {
    const b = "line1\nline2";
    const ours = "line1\r\nline2\r\nline3";
    const theirs = "line1\nline2\nline4";
    const r = merge3(b, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged).toContain("line3");
    expect(r.merged).toContain("line4");
  });

  it("treats a whitespace-only change on one side as that side's edit", () => {
    const b = "a\nb";
    const ours = "a\n  b"; // indented b
    const theirs = "a\nb";
    const r = merge3(b, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("a\n  b");
  });

  // ── no-op / identical ───────────────────────────────────────────────────────
  it("returns the base unchanged when neither side changed anything", () => {
    const r = merge3("a\nb", "a\nb", "a\nb");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("a\nb");
    expect(r.conflicts).toBe(0);
  });

  // ── ancestor-less fallback (2-way union) ────────────────────────────────────
  it("falls back to a 2-way union when the ancestor is null", () => {
    const r = merge3(null, "a\nb", "a\nc");
    expect(r.clean).toBe(true);
    expect(r.merged).toContain("a");
    expect(r.merged).toContain("b");
    expect(r.merged).toContain("c");
  });

  it("falls back to a 2-way union when the ancestor is undefined", () => {
    const r = merge3(undefined, "keep me", "keep me\nand this");
    expect(r.clean).toBe(true);
    expect(r.merged).toContain("keep me");
    expect(r.merged).toContain("and this");
  });

  it("2-way union skips blank-only novel lines and existing duplicates", () => {
    const r = merge3(null, "x\ny", "x\n\n\ny\nz");
    // Only the genuinely-new non-blank line "z" is appended; x/y not duplicated.
    expect(r.merged).toBe("x\ny\nz");
  });

  it("2-way union returns ours verbatim when theirs adds nothing new", () => {
    const r = merge3(null, "same\ncontent", "same");
    expect(r.merged).toBe("same\ncontent");
  });

  // ── degenerate inputs ───────────────────────────────────────────────────────
  it("handles both sides emptying the note (no leftover text)", () => {
    const r = merge3("a\nb", "", "");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("");
  });

  it("keeps additions when one side clears and the other appends (flagged)", () => {
    // ours cleared everything; theirs appended. These overlap on the same region,
    // so it is reported as a conflict for the user to review — not silently lost.
    const r = merge3("a\nb", "", "a\nb\nc");
    expect(r.clean).toBe(false);
    expect(r.conflicts).toBeGreaterThan(0);
  });

  it("does not emit git-style conflict markers in any output", () => {
    const b = "shared\nline";
    const r = merge3(b, "shared\nMINE", "shared\nTHEIRS");
    expect(r.merged).not.toMatch(/[<>=]{7}/);
  });
});
