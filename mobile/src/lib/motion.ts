/**
 * Pure motion maths, kept free of react-native so it can be unit-tested in plain Node.
 * The hook that feeds it the OS reduce-motion flag is `use-motion.ts`.
 */

/** Multiplier applied to every animation duration. Reduce motion collapses them to nothing. */
export function durationScale(reduced: boolean): number {
  return reduced ? 0 : 1;
}

/** A duration in ms after the reduce-motion scale. */
export function scaleDuration(ms: number, reduced: boolean): number {
  return Math.round(ms * durationScale(reduced));
}

/**
 * Delay for the nth row of a staggered entrance, or null when the row should not animate
 * (past the cap, or reduce motion is on). Rows past `cap` appear instantly so a long list
 * never waits on its own animation.
 */
export function staggerDelay(index: number, opts: { stepMs?: number; cap?: number; reduced?: boolean } = {}): number | null {
  const { stepMs = 40, cap = 8, reduced = false } = opts;
  if (reduced || index < 0 || index >= cap) return null;
  return index * stepMs;
}

/**
 * The next index in a cycling list. Returns 0 for an empty or single-item list so callers
 * never index out of range.
 */
export function nextIndex(current: number, length: number): number {
  if (length <= 1) return 0;
  return (current + 1) % length;
}

/** The digits of a non-negative integer, most significant first. Negative and NaN clamp to 0. */
export function digitsOf(value: number): number[] {
  const n = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return String(n).split("").map(Number);
}

export interface RollToken {
  /** Stable across renders: counted from the right, so a number that gains a digit keeps its other digits. */
  key: string;
  ch: string;
  /** The digit 0-9 for a reel, or null for punctuation/letters that stay put. */
  digit: number | null;
}

/** Splits display text ("1,204", "$0.42", "12.3k") into reel digits and static characters. */
export function rollTokens(text: string): RollToken[] {
  const chars = [...text];
  return chars.map((ch, i) => ({
    key: `r${chars.length - 1 - i}`,
    ch,
    digit: /^[0-9]$/.test(ch) ? Number(ch) : null,
  }));
}
