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
