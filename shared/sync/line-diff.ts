/**
 * Unified line diff — pure logic shared by the desktop + mobile conflict UIs.
 *
 * ⚠️ CANONICAL COPY. A byte-identical renderer copy lives at
 * `src/lib/line-diff.ts` because the renderer tsconfig excludes `shared/`.
 * Keep the two in lockstep — the logic is pure and dependency-free. Both are
 * covered by `shared/sync/line-diff.test.ts`.
 *
 * Produces a git-style unified diff between two texts, line by line:
 *   - "equal"   — line present unchanged in both
 *   - "remove"  — line only in `left` (the current note)   → shown red / "−"
 *   - "add"     — line only in `right` (the conflicted copy) → shown green / "+"
 *
 * The alignment is a standard longest-common-subsequence over lines (same
 * approach as merge3's alignToBase), so unchanged runs stay anchored and only
 * the genuinely differing lines are marked. This lets the conflict dialog show
 * exactly what differs instead of two opaque blobs of text.
 */

export type DiffOp = "equal" | "add" | "remove";

export interface DiffRow {
  op: DiffOp;
  /** The line text (without trailing newline). */
  text: string;
}

function splitLines(s: string): string[] {
  // Normalise CRLF so cross-platform (Windows/iOS) bodies diff cleanly.
  return s.replace(/\r\n/g, "\n").split("\n");
}

/** Longest-common-subsequence length table between two line arrays. */
function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/**
 * Diff `left` (current) → `right` (conflicted copy) into a flat list of rows.
 * Removed lines (in left only) are emitted before the added lines (in right
 * only) at each divergence point, mirroring a standard unified diff.
 */
export function diffLines(left: string, right: string): DiffRow[] {
  const a = splitLines(left);
  const b = splitLines(right);
  const dp = lcsTable(a, b);
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ op: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ op: "remove", text: a[i] });
      i++;
    } else {
      rows.push({ op: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) { rows.push({ op: "remove", text: a[i] }); i++; }
  while (j < b.length) { rows.push({ op: "add", text: b[j] }); j++; }
  return rows;
}

/** Convenience counts for a summary line ("3 added, 1 removed"). */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.op === "add") added++;
    else if (r.op === "remove") removed++;
  }
  return { added, removed };
}
