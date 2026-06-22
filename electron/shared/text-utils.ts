/**
 * Pure text utilities shared between the Electron main process and the MCP
 * server binary. These have no native dependencies (no better-sqlite3, no
 * Electron APIs) so they can be imported by both without ABI concerns.
 */

/**
 * Convert a string to a filesystem-safe slug.
 * Preserves spaces as hyphens, strips characters illegal on any major OS.
 */
export function toSlug(str: string): string {
  return str
    .trim()
    .replace(/[/\\:*?"<>|]/g, "")   // strip filesystem-illegal chars
    .replace(/\s+/g, " ")           // normalise whitespace
    .slice(0, 100)                  // cap length
    .trim()
    || "Untitled";
}

/**
 * Normalize a note title for deduplication matching.
 *
 * Same semantics as today (case-sensitive), but insensitive to leading/trailing
 * whitespace and to internal whitespace runs — a model that emits `"Foo  Bar"`
 * or `"Foo\nBar"` should match an existing `"Foo Bar"`. Stored title remains
 * the model-supplied literal; this is only used for the lookup predicate.
 *
 * Both `notes.ts:ensure_note` and `chat-executor.ts`'s wrapper call this, so
 * they cannot disagree on the matching key (which would let the wrapper mint
 * a fresh id while the canonical function matches an existing row, producing
 * the parallel-write duplicate bug).
 */
export function normalizeNoteTitle(title: string): string {
  if (typeof title !== "string") return "";
  return title.trim().replace(/\s+/g, " ");
}

/**
 * Strip markdown syntax from a string, returning plain text.
 * Used to populate the SQLite `content_text` search column.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")      // headings
    .replace(/\*\*(.+?)\*\*/g, "$1")   // bold
    .replace(/\*(.+?)\*/g, "$1")       // italic
    .replace(/`{1,3}[^`]*`{1,3}/g, "") // inline + fenced code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/^[-*+]\s+/gm, "")        // list bullets
    .replace(/^\d+\.\s+/gm, "")        // ordered lists
    .replace(/^>\s+/gm, "")            // blockquotes
    .replace(/\n{2,}/g, "\n")
    .trim();
}
