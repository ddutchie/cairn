/**
 * Pure WIP-limit logic for Kanban columns, extracted from column.tsx so the
 * parse and "at limit" boundary checks are tested once and can't diverge
 * between the two dialog call sites that previously duplicated the parse.
 */

/**
 * Parse a raw WIP-limit input string into a positive integer, or null to clear.
 *
 * - Blank/whitespace → null (no limit).
 * - Non-numeric or < 1 → null (invalid limits are treated as "no limit").
 * - Otherwise the parsed integer.
 */
export function parseWipLimit(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // Only accept a whole positive integer string in its entirety — parseInt
  // would silently truncate "3.5" → 3 or "1e3" → 1, saving a value the user
  // never typed.
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (n < 1) return null;
  return n;
}

/**
 * Whether a column is at or over its WIP limit (gates the add-card button and
 * the over-limit banner). A limit of null or <= 0 means "no limit".
 */
export function isAtWipLimit(cardLimit: number | null | undefined, cardCount: number): boolean {
  return cardLimit != null && cardLimit > 0 && cardCount >= cardLimit;
}
