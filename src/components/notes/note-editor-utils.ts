/** Pure helpers for the note editor. */

export function countWords(md: string): number {
  const text = md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Toggle the Nth task-list checkbox in raw markdown source.
 *
 * Handles both contexts that render a clickable checkbox in the preview:
 *   1. List-marker task items — `- [ ]` / `* [x]` / `1. [ ]` at line start.
 *   2. Checkboxes embedded inside GFM table cells — `| [x] | … |`.
 *      (remark-gfm does not natively turn these into checkbox nodes, so the
 *       preview injects them via a custom td/th renderer; this keeps the
 *       source-toggle mapping in sync.)
 *
 * Checkboxes are matched in document order so the index lines up with the
 * top-to-bottom DOM order react-markdown produces. Returns the source
 * unchanged if `index` is out of range.
 */
export function toggleCheckboxInSource(source: string, index: number): string {
  if (index < 0) return source;

  // Matches a `[ ]`, `[x]` or `[X]` checkbox. We scan line-by-line so that we
  // can distinguish list-marker checkboxes (one per line, at the start) from
  // table-cell checkboxes (potentially several per line, inside `| … |`).
  const listLineRe = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/;
  const tableRowRe = /^\s*\|.*\|/;
  // A cell renders a checkbox only when the task token leads the cell (mirrors
  // renderCellWithCheckboxes in note-editor.tsx: `first.match(/^\s*\[…\]\s?/)`).
  const cellLeadingRe = /^(\s*)\[([ xX])\]/;

  let seen = 0;
  let changed = false;

  const lines = source.split("\n").map((line) => {
    if (changed) return line;

    if (listLineRe.test(line)) {
      // Exactly one task checkbox at the marker position.
      if (seen === index) {
        changed = true;
        // Toggle ONLY the marker checkbox, not any literal `[x]` text later on
        // the line. listLineRe is non-global, so it matches just the leading
        // marker + box; the inner non-global replace flips that single box.
        return line.replace(listLineRe, (full) =>
          full.replace(/\[([ xX])\]/, (_m, state: string) =>
            state === " " ? "[x]" : "[ ]"
          )
        );
      }
      seen += 1;
      return line;
    }

    if (tableRowRe.test(line)) {
      // A table row may contain several cells; only cell-leading task tokens
      // render as checkboxes, so only those count toward the index. Splitting
      // on `|` preserves the cell boundaries we rejoin with afterwards.
      const cells = line.split("|");
      let lineChanged = false;
      const newCells = cells.map((cell) => {
        if (changed) return cell;
        const cm = cell.match(cellLeadingRe);
        if (!cm) return cell;
        if (seen === index) {
          seen += 1;
          changed = true;
          lineChanged = true;
          const next = cm[2] === " " ? "[x]" : "[ ]";
          return cell.replace(cellLeadingRe, `${cm[1]}${next}`);
        }
        seen += 1;
        return cell;
      });
      return lineChanged ? newCells.join("|") : line;
    }

    return line;
  });

  return changed ? lines.join("\n") : source;
}

export function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/\|/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
