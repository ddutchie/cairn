/**
 * Shared plain-text extraction from markdown — pure, no platform deps.
 *
 * This is the lightweight strip used for search indexing and single-line
 * previews (NOT a full markdown parse). It removes the common inline/structural
 * markdown punctuation and collapses whitespace to a single line.
 *
 * Mobile previously inlined this regex in several places (note create, search
 * indexing, context packs); this is now the single source of truth.
 */
export function stripMarkdown(md: string): string {
  if (!md) return "";
  return md
    // Replace markdown punctuation with a SPACE (not "") so adjacent words
    // don't merge (e.g. "[a](b)c" must not become "abc"). Whitespace is
    // collapsed next, so extra spaces are harmless.
    .replace(/[#*_`>[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
