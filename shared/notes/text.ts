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

/**
 * Split a search query into lowercased terms (whitespace-separated).
 *
 * Used by keyword search so a multi-word query matches records that contain
 * every term SOMEWHERE — not only records containing the exact contiguous
 * phrase. Empty/whitespace query → no terms.
 */
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True when `haystack` matches the search `query` using AND-of-terms semantics:
 * every whitespace-separated term in the query must appear as a case-insensitive
 * substring somewhere in the haystack. This replaces the old whole-query
 * substring match, which under-matched multi-word queries — e.g. "auth flow"
 * previously matched only the literal phrase "auth flow", missing "Authentication
 * flow" and "flow for auth". Callers pass the combined searchable text (e.g.
 * title + body) as the haystack so terms may be spread across fields.
 *
 * An empty query matches nothing (callers already guard on a blank query; this
 * keeps the "empty search returns no rows" contract explicit).
 */
export function matchesQuery(query: string, haystack: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return false;
  const hay = haystack.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/**
 * Convert a user search query into an FTS5 MATCH expression.
 *
 * Each whitespace term becomes a quoted prefix phrase (`"term"*`), joined with
 * spaces — FTS5's implicit AND. Quoting treats user input as literal text rather
 * than FTS query syntax, and the `*` suffix recovers the prefix-substring
 * behaviour of the old LIKE '%term%' search ("auth" still matches
 * "authentication"). An empty/whitespace query returns "" (no terms), which
 * callers must guard against before issuing a MATCH (FTS rejects an empty
 * expression).
 */
export function ftsMatchQuery(query: string): string {
  return queryTerms(query)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(" ");
}
