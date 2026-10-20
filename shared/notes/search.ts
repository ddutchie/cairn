/**
 * Shared note-search primitives — pure, no platform deps.
 *
 * Query syntax (kept deliberately small):
 *   foo bar       every term must appear (AND, case-insensitive substring)
 *   "foo bar"     exact phrase
 *   -foo, -"a b"  exclude notes containing the term / phrase
 *
 * Used by the main-process snippet search, the renderer's local matcher and
 * the in-note find bar, so all three agree on what "matches" means.
 */

export interface ParsedQuery {
  /** Lowercased terms/phrases that must all be present. */
  include: string[];
  /** Lowercased terms/phrases that must be absent. */
  exclude: string[];
}

const TOKEN_RE = /(-?)"([^"]*)"|(-?)(\S+)/g;

export function parseSearchQuery(query: string): ParsedQuery {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const m of query.toLowerCase().matchAll(TOKEN_RE)) {
    const negated = (m[1] ?? m[3]) === "-";
    const text = (m[2] ?? m[4] ?? "").trim();
    if (!text || text === "-") continue;
    (negated ? exclude : include).push(text);
  }
  return { include, exclude };
}

/** True when `haystack` satisfies a parsed query. No include terms → no match. */
export function matchesParsed(parsed: ParsedQuery, haystack: string): boolean {
  if (parsed.include.length === 0) return false;
  const hay = haystack.toLowerCase();
  return parsed.include.every((t) => hay.includes(t)) && !parsed.exclude.some((t) => hay.includes(t));
}

export interface NoteSnippet {
  /** Single-line excerpt around the first match. */
  text: string;
  /** [start, end) ranges inside `text` to highlight. */
  ranges: Array<[number, number]>;
  /** The query term that produced the first match (prefills the find bar). */
  term: string;
  /** 1-based line of the first body match, or 0 when only the title matched. */
  line: number;
  /** Total body occurrences of all include terms. */
  count: number;
}

/**
 * Excerpt of `body` around its first match of any include term, with the
 * highlight ranges re-based into the excerpt. Returns null when the body has no
 * occurrence (title-only match).
 */
export function buildSnippet(body: string, include: string[], radius = 60): NoteSnippet | null {
  if (!body || include.length === 0) return null;
  const lower = body.toLowerCase();

  let first = -1;
  let firstTerm = "";
  let count = 0;
  for (const t of include) {
    let i = lower.indexOf(t);
    if (i !== -1 && (first === -1 || i < first)) { first = i; firstTerm = t; }
    while (i !== -1) { count++; i = lower.indexOf(t, i + t.length); }
  }
  if (first === -1) return null;

  let start = Math.max(0, first - radius);
  let end = Math.min(body.length, first + firstTerm.length + radius);
  // Don't cut words in half when there is room to move to a boundary.
  if (start > 0) { const sp = body.indexOf(" ", start); if (sp !== -1 && sp < first) start = sp + 1; }
  if (end < body.length) { const sp = body.lastIndexOf(" ", end); if (sp > first + firstTerm.length) end = sp; }

  const slice = body.slice(start, end);
  // Collapse whitespace to one line while keeping ranges aligned: map per char.
  let text = "";
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < slice.length; i++) {
    const isSpace = /\s/.test(slice[i]);
    if (isSpace && prevSpace) { map[i] = text.length - 1; continue; }
    map[i] = text.length;
    text += isSpace ? " " : slice[i];
    prevSpace = isSpace;
  }
  const lowerSlice = slice.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const t of include) {
    let i = lowerSlice.indexOf(t);
    while (i !== -1) {
      ranges.push([map[i], map[i + t.length - 1] + 1]);
      i = lowerSlice.indexOf(t, i + t.length);
    }
  }
  ranges.sort((x, y) => x[0] - y[0]);
  // Merge overlaps so highlighting never double-wraps.
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  const lead = start > 0 ? "…" : "";
  const trail = end < body.length ? "…" : "";
  const shift = lead.length;
  return {
    text: lead + text + trail,
    ranges: merged.map(([a, b]) => [a + shift, b + shift] as [number, number]),
    term: firstTerm,
    line: body.slice(0, first).split("\n").length,
    count,
  };
}

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface FindMatch { from: number; to: number }

/** Literal (non-regex) find over plain text. Used by both editor modes. */
export function findMatches(text: string, query: string, opts: FindOptions = {}, limit = 5000): FindMatch[] {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = opts.wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
  const re = new RegExp(word, opts.caseSensitive ? "gu" : "giu");
  const out: FindMatch[] = [];
  for (const m of text.matchAll(re)) {
    out.push({ from: m.index!, to: m.index! + m[0].length });
    if (out.length >= limit) break;
  }
  return out;
}
