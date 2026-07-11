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
