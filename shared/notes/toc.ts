/**
 * Table-of-contents helpers shared by desktop and mobile: heading slugging and
 * heading extraction from raw markdown source. Pure functions, no DOM/React —
 * safe to import anywhere (renderer, Electron, Expo, tests).
 */

/**
 * GitHub-style heading slug: lowercase, spaces → hyphens, strip everything
 * except alphanumerics and hyphens.
 */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface Heading {
  level: 1 | 2 | 3;
  text: string;
  id: string;
}

/** Parse h1/h2/h3 headings from raw markdown source (skips fenced code). */
export function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,3})\s+(.+)/);
    if (m) {
      const level = m[1].length as 1 | 2 | 3;
      const text = m[2].trim();
      headings.push({ level, text, id: headingSlug(text) });
    }
  }
  return headings;
}

export interface OutlineEntry {
  level: 1 | 2 | 3;
  text: string;
  /** 1-based line number of the heading in the source. */
  line: number;
}

/**
 * A line-numbered outline of a note, for token-cheap "table of contents" tool
 * responses: the model gets the structure + where each section starts, then
 * fetches a specific line range instead of the whole document.
 */
export interface NoteOutline {
  totalLines: number;
  headings: OutlineEntry[];
}

/** Build a line-numbered outline (h1–h3, skipping fenced code). Lines 1-based. */
export function buildNoteOutline(markdown: string): NoteOutline {
  const lines = markdown.split("\n");
  const headings: OutlineEntry[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,3})\s+(.+)/);
    if (m) headings.push({ level: m[1].length as 1 | 2 | 3, text: m[2].trim(), line: i + 1 });
  }
  return { totalLines: lines.length, headings };
}

/**
 * Return an inclusive 1-based line range of a markdown source. Clamps to bounds;
 * `endLine` omitted or <= 0 means "to the end". Used by a get_note_range tool so
 * the model reads only the slice it needs after seeing the outline.
 */
export function sliceLines(markdown: string, startLine: number, endLine?: number): string {
  const lines = markdown.split("\n");
  const start = Math.max(1, Math.floor(startLine || 1));
  const end = endLine && endLine > 0 ? Math.min(lines.length, Math.floor(endLine)) : lines.length;
  if (start > lines.length) return "";
  return lines.slice(start - 1, end).join("\n");
}

/**
 * A compact, token-cheap representation of a note for context-pack style tool
 * responses. When the note has headings, its OUTLINE (heading texts) is a
 * structured semantic summary that conveys the whole note's shape in fewer
 * tokens than a raw prose excerpt — and with more signal. When the note is flat
 * (no headings), fall back to a short excerpt. This is the practical answer to
 * "return the note's meaning, not a raw excerpt" — embeddings are one-way and
 * can't be decoded to text, but human-authored headings already are the summary.
 */
export function noteDigest(content: string, excerptChars = 300): { outline: string[] } | { excerpt: string } {
  const src = content ?? "";
  const { headings } = buildNoteOutline(src);
  // Only worthwhile when there's real structure (>1 heading, or 1 non-title heading).
  const meaningful = headings.filter((h) => h.level >= 2);
  if (meaningful.length >= 1) {
    return { outline: headings.map((h) => h.text) };
  }
  const excerpt = src.length > excerptChars ? src.slice(0, excerptChars) + "…" : src;
  return { excerpt };
}
