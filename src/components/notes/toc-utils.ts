/**
 * Pure utility functions for TableOfContents — extracted so they can be
 * unit-tested in a Node/vitest environment without pulling in React or
 * CSS-in-JS imports.
 */

import { parseWikilinks } from "../../lib/wikilink-parser";

// ── Slug + heading extraction (shared with mobile) ────────────────────────────

export { headingSlug, extractHeadings } from "../../../shared/notes/toc";
export type { Heading } from "../../../shared/notes/toc";

/**
 * Given raw markdown and a character offset, return the title of the
 * `#`/`##` section the cursor is inside. Matches the splitting logic
 * used by the embeddings service (only `#`/`##` are section boundaries).
 * If cursor is before the first heading, returns `noteTitle`.
 */
export function findSectionTitleAtOffset(
  noteTitle: string,
  content: string,
  offset: number,
): string {
  const lines = content.split("\n");
  let pos = 0;
  let currentTitle = noteTitle || "Untitled";
  for (const line of lines) {
    const lineEnd = pos + line.length + 1;
    const m = line.match(/^(#{1,2})\s+(.+)$/);
    if (m) {
      currentTitle = m[2].trim();
    }
    if (offset < lineEnd) break;
    pos = lineEnd;
  }
  return currentTitle;
}

/**
 * Extract the text content of the `#`/`##` section at the given offset.
 * Returns the body text (excluding the heading line itself) plus the
 * note title as context prefix.
 */
export function extractSectionTextAtOffset(
  noteTitle: string,
  content: string,
  offset: number,
): { title: string; text: string } | null {
  const lines = content.split("\n");
  let pos = 0;
  let sectionStart = -1;
  let sectionTitle = noteTitle || "Untitled";
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = pos + lines[i].length + 1;
    const m = lines[i].match(/^(#{1,2})\s+(.+)$/);
    if (m) {
      sectionTitle = m[2].trim();
    }
    if (offset < lineEnd) {
      sectionStart = i;
      break;
    }
    pos = lineEnd;
  }
  if (sectionStart === -1) return null;

  const body: string[] = [];
  for (let i = sectionStart; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,2})\s+(.+)$/);
    if (i > sectionStart && m) break;
    if (m) continue;
    body.push(lines[i]);
  }
  const text = body.join("\n").trim();
  if (text.length < 4) return null;
  return { title: sectionTitle, text };
}

// ── Wikilink extraction ───────────────────────────────────────────────────────

export interface WikiLink {
  title: string;
  noteId: string | null;
}

/** Extract unique wikilinks from raw markdown, deduplicated by title. */
export function extractWikiLinks(
  markdown: string,
  notes: { id: string; title: string }[]
): WikiLink[] {
  const titleIndex = new Map(notes.map((n) => [n.title.toLowerCase().trim(), n.id]));
  const seen = new Set<string>();
  const links: WikiLink[] = [];
  for (const { title } of parseWikilinks(markdown)) {
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ title, noteId: titleIndex.get(key) ?? null });
  }
  return links;
}
