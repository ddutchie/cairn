import type { SearchResult } from "@/store";

/**
 * Pure search-result logic extracted from search-panel.tsx so the type/project
 * filtering, two-list keyboard-navigation index translation, and semantic-hit
 * merge/dedupe can be unit-tested without the panel or the embeddings worker.
 */

export type SearchFilterType = "all" | "notes" | "tasks";

/**
 * Apply the type filter ("all" | "notes" | "tasks") and an optional project
 * filter. Note the mapping: the "tasks" tab matches results of type "card".
 */
export function filterSearchResults(
  results: SearchResult[],
  filterType: SearchFilterType,
  filterProject: string | null,
): SearchResult[] {
  return results
    .filter((r) =>
      filterType === "all" || (filterType === "notes" ? r.type === "note" : r.type === "card"),
    )
    .filter((r) => !filterProject || r.projectId === filterProject);
}

/**
 * Translate a flat keyboard-focus index into the actual result, given the UI
 * order: notes first, then tasks. Returns null if the index is out of range.
 *
 * This is the canonical subtle keyboard-nav bug surface — getting the
 * notes/tasks boundary wrong selects the wrong row on Enter.
 */
export function resolveFocusedResult(
  focused: number,
  noteResults: SearchResult[],
  taskResults: SearchResult[],
): SearchResult | null {
  if (focused < 0) return null;
  if (focused < noteResults.length) return noteResults[focused] ?? null;
  const taskIdx = focused - noteResults.length;
  return taskResults[taskIdx] ?? null;
}

/** Clamp a focus index to the combined results length (min 0). */
export function clampFocus(focused: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(focused, total - 1));
}

/**
 * Merge semantic hits into the existing keyword results: append only hits whose
 * id isn't already present (keyword results win and keep their position).
 */
export function mergeSemanticResults(
  keyword: SearchResult[],
  semantic: SearchResult[],
): SearchResult[] {
  const seen = new Set(keyword.map((r) => r.id));
  const merged = [...keyword];
  for (const s of semantic) {
    if (seen.has(s.id)) continue;
    // Track each semantic id as it's accepted so a later semantic hit with the
    // same id is deduped against earlier semantic ones, not just the keyword set.
    seen.add(s.id);
    merged.push(s);
  }
  return merged;
}

export interface NoteSnippetHit {
  id: string;
  score: number;
  snippet: { text: string; ranges: Array<[number, number]>; term: string } | null;
}

/**
 * Overlay main-process note hits on the local keyword results: matched notes get
 * their excerpt + highlight ranges and are ranked by score (best first); notes
 * only the local matcher found keep their order after them. Cards are untouched.
 */
export function applyNoteHits(results: SearchResult[], hits: NoteSnippetHit[]): SearchResult[] {
  const byId = new Map(hits.map((h, rank) => [h.id, { h, rank }]));
  const notes = results.filter((r) => r.type === "note").map((r) => {
    const hit = byId.get(r.id);
    const snip = hit?.h.snippet;
    const merged = snip ? { ...r, snippet: snip.text, ranges: snip.ranges, findTerm: snip.term } : r;
    return { r: merged, rank: hit ? hit.rank : Number.MAX_SAFE_INTEGER };
  });
  notes.sort((a, b) => a.rank - b.rank);
  return [...notes.map((n) => n.r), ...results.filter((r) => r.type !== "note")];
}
