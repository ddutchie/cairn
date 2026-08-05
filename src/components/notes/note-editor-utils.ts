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

// ── Editor-mode migration (Write/Raw/Read → Edit/Read + Live Preview toggle) ──

/**
 * Migrate a persisted editor mode to the current two-mode model. The legacy
 * value could be "write" | "raw" | "read"; "write"/"raw" both become "edit"
 * (raw was just "edit with Live Preview off", now a separate toggle).
 */
export function migrateEditorMode(saved: string | null | undefined): "edit" | "read" {
  return saved === "read" ? "read" : "edit";
}

/**
 * Initial Live Preview on/off. An explicit stored preference always wins.
 * Otherwise default on — EXCEPT when the user's legacy mode was "raw" (Live
 * Preview off), which we honour so their raw-editing preference isn't lost.
 */
export function initialLivePreviewOn(
  savedPref: boolean | null | undefined,
  savedMode: string | null | undefined,
): boolean {
  if (savedPref != null) return savedPref;
  return savedMode !== "raw";
}

// ── Structured-block extraction (for the live "current block" preview) ────────

/** Kinds of structured markdown block worth previewing live while editing. */
export type StructuredBlockKind = "table" | "callout" | "code" | "math";

export interface StructuredBlock {
  kind: StructuredBlockKind;
  /** The raw markdown of the whole block (all its lines). */
  text: string;
}

/** Which line index (0-based) contains the given character offset. */
function lineIndexAtOffset(lines: string[], offset: number): number {
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const end = pos + lines[i].length + 1; // +1 for the newline
    if (offset < end) return i;
    pos = end;
  }
  return Math.max(0, lines.length - 1);
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

/**
 * Given the note's raw markdown and a cursor offset, return the STRUCTURED block
 * enclosing the cursor (table / callout / fenced code / math), or null when the
 * cursor is in plain prose (paragraph, heading, list). Used to drive a live
 * "current block" preview so a user editing e.g. a table can see it render — and
 * immediately notice when the markdown is broken — without a selection.
 *
 * This is a line scanner on the raw text (not the lezer tree), deliberately
 * independent of the editor so it's pure and unit-testable. It errs toward
 * returning a block only when the cursor is clearly inside one.
 */
export function extractStructuredBlockAtOffset(
  content: string,
  offset: number,
): StructuredBlock | null {
  if (!content) return null;
  const lines = content.split("\n");
  const cur = lineIndexAtOffset(lines, offset);

  // 1) Fenced code (``` or ~~~). Walk fences top-down; if the cursor line falls
  //    within an open/close pair (or after an unclosed opener), it's code.
  {
    let openIdx = -1;
    let openFence = "";
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(FENCE_RE);
      if (!m) continue;
      const fence = m[2][0];
      if (openIdx === -1) {
        openIdx = i;
        openFence = fence;
      } else if (fence === openFence) {
        // Closing fence at i — the block spans [openIdx, i].
        if (cur >= openIdx && cur <= i) {
          return { kind: "code", text: lines.slice(openIdx, i + 1).join("\n") };
        }
        openIdx = -1;
        openFence = "";
      }
    }
    // Unclosed opener that reaches the cursor.
    if (openIdx !== -1 && cur >= openIdx) {
      return { kind: "code", text: lines.slice(openIdx).join("\n") };
    }
  }

  // 2) Math block ($$ … $$). Same paired-delimiter logic on lines that are just `$$`.
  {
    const isMathFence = (l: string) => l.trim() === "$$";
    let openIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!isMathFence(lines[i])) continue;
      if (openIdx === -1) openIdx = i;
      else {
        if (cur >= openIdx && cur <= i) {
          return { kind: "math", text: lines.slice(openIdx, i + 1).join("\n") };
        }
        openIdx = -1;
      }
    }
  }

  const line = lines[cur] ?? "";

  // 3) Callout — a blockquote run (contiguous `>` lines) whose first line is a
  //    `[!type]` directive. Only when the cursor is on a `>` line.
  if (/^\s*>/.test(line)) {
    let start = cur;
    while (start > 0 && /^\s*>/.test(lines[start - 1])) start--;
    let end = cur;
    while (end < lines.length - 1 && /^\s*>/.test(lines[end + 1])) end++;
    const first = lines[start].replace(/^\s*>\s?/, "");
    if (/^\[![^\]]+\]/.test(first)) {
      return { kind: "callout", text: lines.slice(start, end + 1).join("\n") };
    }
  }

  // 4) Table — a contiguous run of pipe-containing lines that includes a
  //    separator row (`|---|`). Only when the cursor line is part of the run.
  if (line.includes("|")) {
    let start = cur;
    while (start > 0 && lines[start - 1].includes("|") && lines[start - 1].trim() !== "") start--;
    let end = cur;
    while (end < lines.length - 1 && lines[end + 1].includes("|") && lines[end + 1].trim() !== "") end++;
    const block = lines.slice(start, end + 1);
    if (block.some((l) => TABLE_SEP_RE.test(l))) {
      return { kind: "table", text: block.join("\n") };
    }
  }

  return null;
}
