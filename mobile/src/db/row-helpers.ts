/**
 * Tiny pure row helpers shared across the mobile query modules, extracted so
 * both queries.ts and graph-queries.ts can use them without an import cycle.
 */

/** Parse a JSON `tag_ids` / `linked_note_ids` column into an id array (tolerant of bad data). */
export function parseIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
