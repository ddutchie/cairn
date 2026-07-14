/**
 * 3-way line merge — pure logic shared by desktop and mobile conflict UIs.
 *
 * Note bodies are last-writer-wins with a preserved conflict copy (see
 * engine.ts). When both devices edited a note offline we keep the losing side
 * as a copy so nothing is lost — but the two edits often DON'T actually
 * overlap (e.g. each device appended a different checklist item). In that case
 * a 3-way merge against the common ancestor (sync_row_base) can reconstruct a
 * single body that contains BOTH changes, with no manual work.
 *
 * The algorithm is a line-level diff3:
 *   - Split ancestor (base), "ours" (the current/original note) and "theirs"
 *     (the conflict copy) into lines.
 *   - Walk regions that are stable in all three, and regions that changed.
 *   - A region changed on only ONE side → take that side (clean).
 *   - A region changed on BOTH sides identically → take it once (clean).
 *   - A region changed on BOTH sides differently → CONFLICT (not auto-mergeable).
 *
 * We deliberately never emit `<<<<<<<`/`>>>>>>>` markers into a user's note.
 * When a real conflict exists, `clean` is false and the UI opens a manual
 * editor instead of silently corrupting the body.
 */

export interface Merge3Result {
  /** True if every changed region was resolvable without overlap. */
  clean: boolean;
  /** The merged text (best-effort even when not clean — ours wins ties). */
  merged: string;
  /** Number of regions that changed on both sides incompatibly. */
  conflicts: number;
}

function splitLines(s: string): string[] {
  // Normalise CRLF so cross-platform (Windows/iOS) bodies diff cleanly.
  return s.replace(/\r\n/g, "\n").split("\n");
}

/** Longest-common-subsequence table between two line arrays. */
function lcs(a: string[], b: string[]): number[][] {
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
 * Diff `base` → `other`, returning matched-index pairs: for each line in base
 * that is unchanged in `other`, the index it maps to. Lines not present are
 * omitted. Used to align both sides against the common ancestor.
 */
function alignToBase(base: string[], other: string[]): Map<number, number> {
  const dp = lcs(base, other);
  const map = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < base.length && j < other.length) {
    if (base[i] === other[j]) {
      map.set(i, j);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return map;
}

/**
 * 3-way merge of note bodies. `base` is the common ancestor (may be null/unknown
 * — then we fall back to a 2-way union). `ours` is the current note, `theirs`
 * is the conflict copy.
 */
export function merge3(base: string | null | undefined, ours: string, theirs: string): Merge3Result {
  // No ancestor → we can't tell who changed what. Fall back to a 2-way union:
  // keep ours, then append any of theirs' lines we don't already have.
  if (base == null) {
    return union2(ours, theirs);
  }

  const baseL = splitLines(base);
  const oursL = splitLines(ours);
  const theirsL = splitLines(theirs);

  const oursMap = alignToBase(baseL, oursL); // baseIdx -> oursIdx (unchanged lines)
  const theirsMap = alignToBase(baseL, theirsL);

  // Walk the base line by line, emitting the merged output. Between two
  // consecutive "anchor" lines (present in base + both sides) we compare the
  // segments each side inserted.
  const out: string[] = [];
  let conflicts = 0;

  // Build anchors: base indices that survive unchanged in BOTH sides.
  const anchors: number[] = [];
  for (let b = 0; b < baseL.length; b++) {
    if (oursMap.has(b) && theirsMap.has(b)) anchors.push(b);
  }

  let prevBase = -1;
  let prevOurs = -1;
  let prevTheirs = -1;

  const emitSegment = (
    baseFrom: number,
    baseTo: number,
    oursFrom: number,
    oursTo: number,
    theirsFrom: number,
    theirsTo: number,
  ) => {
    const baseSeg = baseL.slice(baseFrom + 1, baseTo);
    const oursSeg = oursL.slice(oursFrom + 1, oursTo);
    const theirsSeg = theirsL.slice(theirsFrom + 1, theirsTo);
    const oursChanged = !arrEq(baseSeg, oursSeg);
    const theirsChanged = !arrEq(baseSeg, theirsSeg);

    if (!oursChanged && !theirsChanged) {
      out.push(...baseSeg); // untouched region
    } else if (oursChanged && !theirsChanged) {
      out.push(...oursSeg); // only we changed it
    } else if (!oursChanged && theirsChanged) {
      out.push(...theirsSeg); // only they changed it
    } else if (arrEq(oursSeg, theirsSeg)) {
      out.push(...oursSeg); // both made the same change
    } else {
      // Both changed the same region differently. If the changes are pure
      // insertions relative to base (base segment empty), union them — the
      // common "both appended different lines" case is not a real conflict.
      if (baseSeg.length === 0) {
        out.push(...oursSeg);
        for (const line of theirsSeg) if (!oursSeg.includes(line)) out.push(line);
      } else {
        // Genuinely overlapping edit — not auto-mergeable. Keep ours in the
        // best-effort text; the UI flags this and offers manual editing.
        conflicts++;
        out.push(...oursSeg);
      }
    }
  };

  for (const b of anchors) {
    emitSegment(prevBase, b, prevOurs, oursMap.get(b)!, prevTheirs, theirsMap.get(b)!);
    out.push(baseL[b]); // the anchor line itself
    prevBase = b;
    prevOurs = oursMap.get(b)!;
    prevTheirs = theirsMap.get(b)!;
  }
  // Trailing segment after the last anchor.
  emitSegment(prevBase, baseL.length, prevOurs, oursL.length, prevTheirs, theirsL.length);

  return { clean: conflicts === 0, merged: out.join("\n"), conflicts };
}

/** 2-way fallback when no ancestor: ours, then theirs' novel lines appended. */
function union2(ours: string, theirs: string): Merge3Result {
  const oursL = splitLines(ours);
  const theirsL = splitLines(theirs);
  const have = new Set(oursL);
  const extra = theirsL.filter((l) => l.trim().length > 0 && !have.has(l));
  const merged = extra.length ? [...oursL, ...extra].join("\n") : ours;
  // A 2-way union can't detect true conflicts, so it's always "clean" but the
  // UI should still let the user review since we lacked an ancestor.
  return { clean: true, merged, conflicts: 0 };
}

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
