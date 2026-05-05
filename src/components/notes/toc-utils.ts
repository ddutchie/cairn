/**
 * Pure utility functions for TableOfContents — extracted so they can be
 * unit-tested in a Node/vitest environment without pulling in React or
 * CSS-in-JS imports.
 */

import { parseWikilinks } from "../../lib/wikilink-parser";

// ── Slug ──────────────────────────────────────────────────────────────────────

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

// ── Heading extraction ────────────────────────────────────────────────────────

export interface Heading {
  level: 1 | 2 | 3;
  text: string;
  id: string;
}

/** Parse h1/h2/h3 headings from raw markdown source. */
export function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) { inFence = !inFence; continue; }
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
