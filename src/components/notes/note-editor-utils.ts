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
 * The implementation now lives in `shared/notes/markdown.ts` so the mobile
 * renderer shares the exact same source-toggle logic. Re-exported here to keep
 * the desktop import site (`./note-editor-utils`) stable. Handles both list
 * markers (`- [ ]`) and GFM table-cell checkboxes.
 */
export { toggleCheckboxInSource } from "../../../shared/notes/markdown";

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

/**
 * Compute which 1-indexed line numbers in `next` are new or changed relative to
 * `prev`, using a line-level longest-common-subsequence. Lines present in `prev`
 * but deleted don't map to a line in `next`, so only additions/modifications are
 * returned (the set the editor can visibly highlight). Returns an empty array
 * when the content is identical.
 *
 * Kept intentionally simple (O(n·m) LCS on line arrays) — notes are small, and
 * this only runs once when a changed note is opened.
 */
export function diffChangedLines(prev: string, next: string): number[] {
  if (prev === next) return [];
  const a = prev.split("\n");
  const b = next.split("\n");
  const n = a.length;
  const m = b.length;

  // If there was no prior content, every line is "new".
  if (prev.length === 0) return b.map((_, i) => i + 1);

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Walk the table; any b-line that isn't part of the common subsequence is a
  // new/changed line in `next`.
  const changed: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      // a[i] was removed — advances the old side only, no b-line to mark.
      i++;
    } else {
      // b[j] is an addition/modification.
      changed.push(j + 1);
      j++;
    }
  }
  // Any trailing new lines in b.
  while (j < m) {
    changed.push(j + 1);
    j++;
  }
  return changed;
}
