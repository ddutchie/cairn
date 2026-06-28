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
    if (!seen.has(s.id)) merged.push(s);
  }
  return merged;
}
