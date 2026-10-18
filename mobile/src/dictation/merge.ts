/**
 * Pure text helpers for dictation: how spoken text joins what was already typed,
 * and how streamed recognition results accumulate. No framework imports, so this is
 * unit-testable in plain Node.
 */

/** Append `spoken` to `base` with one separating space (none when `base` already ends in whitespace). */
export function mergeDictation(base: string, spoken: string): string {
  const s = spoken.trim();
  if (!s) return base;
  if (!base) return s;
  return /\s$/.test(base) ? `${base}${s}` : `${base} ${s}`;
}

/**
 * Fold one recognition result into the dictated text so far.
 *
 * Interim results are provisional and replace each other, so they are shown on top of
 * what has been `committed` without changing it. A final result is committed: the
 * recognizer then starts a new phrase (Android continuous mode delivers one final per
 * phrase; iOS delivers one cumulative final when you stop).
 */
export function applyResult(
  committed: string,
  transcript: string,
  isFinal: boolean,
): { committed: string; spoken: string } {
  const spoken = mergeDictation(committed, transcript);
  return { committed: isFinal ? spoken : committed, spoken };
}

const MAX_VOCAB = 100;
const MAX_TERM_LEN = 60;

/**
 * Words to bias recognition toward (project and note titles), so names Cairn knows are
 * heard correctly. Trims, drops empty or very long entries, de-duplicates ignoring
 * case, keeps first-seen order, and caps the list.
 */
export function buildContextualStrings(terms: readonly string[], max = MAX_VOCAB): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, " ").trim();
    if (!term || term.length > MAX_TERM_LEN) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}

/** Normalise the microphone level the recognizer reports (about -2…10) to 0…1; below 0 is silence. */
export function normalizeLevel(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value / 10);
}
